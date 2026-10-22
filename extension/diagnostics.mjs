// Metadata only. Shared by the service worker and native connector.
export const DIAGNOSTIC_LIMIT = 500;
export const DIAGNOSTIC_TTL = 7 * 86400000;
export const DIAGNOSTIC_OPERATIONS = new Set(['SENTENCE_GROUPS_BATCH','HISTORY_SUMMARY','PERSONALIZATION_ANALYZE','ASSIST_COMMIT','ASSIST','SUPPORT_BATCH','PASSAGE_TRANSLATE','EMERGENCY_TRANSLATE','RESOLVE_DOMAIN','PROVIDER_TEST','CONNECTION','ANALYZE','PREPARED_ASSIST','PREPARED_SUPPORT']);
export const DIAGNOSTIC_CODES = new Set(['STARTUP_FAILED','CODEX_EXIT','RPC_TIMEOUT','TURN_FAILED','UNKNOWN','OK','LOCAL_RESULT','CACHE_HIT','TIMEOUT','NETWORK','AUTH','RATE_LIMIT','QUOTA','MODEL_INVALID','OUTPUT_LIMIT','PROVIDER_ERROR','INVALID_RESPONSE','INCOMPATIBLE_REQUEST','SCHEMA_UNSUPPORTED','THINKING_REQUIRED','HTTP','JSON_INVALID','OUTPUT_INVALID','BATCH_SHAPE','BATCH_COUNT','ITEM_FIELDS','ITEM_ID','ITEM_DUPLICATE','TRANSLATION_TYPE','TRANSLATION_EMPTY','TRANSLATION_WHITESPACE','TRANSLATION_LENGTH','TRANSLATION_NO_HAN','STALE','CANCELLED','NOT_READY','DISCONNECTED','NATIVE_START','NATIVE_EXIT','NATIVE_RPC','NATIVE_STDERR','STDERR_AUTH','STDERR_RATE_LIMIT','STDERR_TIMEOUT','STDERR_UNKNOWN','STORAGE_ERROR','RENDER_INVALID','NOT_DISPLAYED','INTERRUPTED','SLOW_REQUEST','REPEATED_FAILURE','FAILOVER','LOCAL_FALLBACK']);
const STAGES = new Set(['request','provider','first_content','validation','render','connection','rpc','stderr']);
const STATUSES = new Set(['start','ok','error','cancelled']);
const COUNTS = ['durationMs','batchSize','inputChars','outputChars','itemIndex','expectedCount','actualCount','fieldCount','translationLength','httpStatus','stderrBytes','exitCode'];
export const validTraceId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const ITEM_ID=/^[epbs]\d{1,10}(?:[.:_-]s?\d{1,10})?$/;
const FIELDS=new Set(['items','id','translation','level','hint','sense','details','meaning','sentenceTranslation','target','text','start','end','first','last','focus','en','zh']);
export function sanitizeDiagnostic(value) {
  if (!value || !DIAGNOSTIC_OPERATIONS.has(value.operation) || !STAGES.has(value.stage) || !STATUSES.has(value.status)) return null;
  const record = {at:Number.isFinite(value.at) && value.at > 0 ? Math.min(value.at,Date.now()) : Date.now(),operation:value.operation,stage:value.stage,status:value.status};
  if (validTraceId(value.traceId)) record.traceId = value.traceId.toLowerCase();
  if (DIAGNOSTIC_CODES.has(value.code)) record.code = value.code;
  for (const key of COUNTS) if (Number.isSafeInteger(value[key]) && value[key] >= 0) record[key] = Math.min(value[key],100000000);
  for (const key of ['inputLengths','outputLengths']) if (Array.isArray(value[key])) record[key] = value[key].slice(0,8).map(length=>Number.isSafeInteger(length)&&length>=0?Math.min(length,1000000):0);
  for(const key of ['inputIds','outputIds'])if(Array.isArray(value[key]))record[key]=value[key].slice(0,8).map(id=>typeof id==='string'&&ITEM_ID.test(id)?id:'<other>');
  if(Array.isArray(value.fields))record.fields=value.fields.slice(0,12).map(field=>FIELDS.has(field)?field:'<other>');
  if(['word','phrase','passage'].includes(value.kind))record.kind=value.kind;
  if(['hint','rescue'].includes(value.level))record.level=value.level;
  for (const key of ['modelRef','providerRef']) if (typeof value[key] === 'string' && /^[a-f0-9]{64}$/.test(value[key])) record[key] = value[key];
  if (['api','chatgpt','grok','antigravity'].includes(value.provider)) record.provider = value.provider;
  if (typeof value.expectsRender === 'boolean') record.expectsRender = value.expectsRender;
  return record;
}
export function diagnosticError(error) {
  let code = DIAGNOSTIC_CODES.has(error?.code) ? error.code : null;
  const message = typeof error?.message === 'string' ? error.message : '';
  if (!code) {
    if (error?.name === 'AbortError' || /超时|超过.*秒|没有及时响应|timed? ?out/i.test(message)) code='TIMEOUT';
    else if (/JSON/i.test(message)) code='JSON_INVALID';
    else if (/额度|请求过快|rate.?limit/i.test(message)) code='RATE_LIMIT';
    else if (/拒绝访问|未授权|unauthor|forbidden/i.test(message)) code='AUTH';
    else if (/断开|连接已失效|disconnected/i.test(message)) code='DISCONNECTED';
    else if (/已变化|已改变|已过期|已被新的|已切换|未活动|当前未活动|暂停|已取消/.test(message)) code='STALE';
    else if (/尚未准备|没有已准备|请先连接|仅在需要时/.test(message)) code='NOT_READY';
    else if (/网络|无法连接|fetch/i.test(message)) code='NETWORK';
    else if (/HTTP/.test(message)) code='HTTP';
    else if (/返回|格式|字段|词项|三段/.test(message)) code='OUTPUT_INVALID';
    else code='UNKNOWN';
  }
  const safe=sanitizeDiagnostic({...error?.detail,operation:'CONNECTION',stage:'validation',status:'error',code});
  const result={code};for(const key of [...COUNTS,'inputIds','outputIds','fields'])if(safe?.[key]!==undefined)result[key]=safe[key];
  return result;
}
export function summarizeDiagnostics(events,now=Date.now()) {
  const traces=new Map(),issues=new Map();
  const issue=(code,operation,count=1)=>{const key=code+':'+operation;const row=issues.get(key)||{code,operation,count:0};row.count+=count;issues.set(key,row);};
  for(const event of events){
    if(!event.traceId){if(event.status==='error')issue(event.code||'UNKNOWN',event.operation);continue;}
    let trace=traces.get(event.traceId);if(!trace){trace={operation:event.operation};traces.set(event.traceId,trace);}
    if(event.stage==='request'){if(event.status==='start')trace.start=event;else trace.end=event;}
    if(event.stage==='render'&&event.status!=='start')trace.render=event;
    if(event.status==='error')trace.error=event;
  }
  let requests=0,failures=0,slow=0,pending=0;
  const failuresByOperation=new Map();
  for(const trace of traces.values()){
    if(trace.start||trace.end)requests++;
    if(trace.error){failures++;issue(trace.error.code||'UNKNOWN',trace.operation);failuresByOperation.set(trace.operation,(failuresByOperation.get(trace.operation)||0)+1);}
    if(trace.end?.durationMs>=10000){slow++;issue('SLOW_REQUEST',trace.operation);}
    if(trace.start&&!trace.end){pending++;if(now-trace.start.at>150000)issue('INTERRUPTED',trace.operation);}
    if(trace.start?.expectsRender&&trace.end?.status==='ok'&&!trace.render&&now-trace.end.at>15000)issue('NOT_DISPLAYED',trace.operation);
  }
  for(const [operation,count] of failuresByOperation)if(count>=3)issue('REPEATED_FAILURE',operation,count);
  return {requests,failures,slow,pending,issues:[...issues.values()].sort((a,b)=>b.count-a.count)};
}
export function createDiagnosticStore(storage,{now=Date.now}={}) {
  let events=[],enabled=false,storageError=false,epoch=0;
  let queue=Promise.resolve();
  const enqueue=operation=>{const work=queue.then(operation);queue=work.catch(()=>{storageError=true;});return work;};
  const prune=()=>{events=events.filter(event=>event.at>=now()-DIAGNOSTIC_TTL).slice(-DIAGNOSTIC_LIMIT);};
  const ready=enqueue(async()=>{
    const data=await storage.get('diagnostics');enabled=data.diagnostics?.enabled!==false;
    events=Array.isArray(data.diagnostics?.events)?data.diagnostics.events.map(sanitizeDiagnostic).filter(Boolean):[];prune();await persist();
  });
  void ready.catch(()=>{});
  const persist=async()=>{await storage.set({diagnostics:{version:1,enabled,events}});storageError=false;};
  return {
    get epoch(){return epoch;},
    async record(value,expectedEpoch=epoch){
      const event=sanitizeDiagnostic(value);if(!event)return false;
      return enqueue(async()=>{if(!enabled||expectedEpoch!==epoch)return false;events.push(event);prune();await persist();return true;}).catch(()=>false);
    },
    async snapshot(){await queue;await enqueue(async()=>{const before=events.length;prune();if(before!==events.length)await persist();}).catch(()=>{});return {version:1,enabled,events:events.map(event=>({...event})),summary:summarizeDiagnostics(events,now()),storageError};},
    async configure(value){if(typeof value!=='boolean')throw new Error('诊断开关无效。');epoch++;await enqueue(async()=>{enabled=value;await persist();});return this.snapshot();},
    async clear(){epoch++;await enqueue(async()=>{events=[];await persist();});return this.snapshot();},
  };
}
