import {
  normalizeSupportProviderItems,normalizeSupportAttempt,normalizeSupportCorrections,normalizePreparationContext,
  normalizeAssistanceRequest,normalizeAssistanceResult,
  normalizeEmergencyItems,normalizeEmergencyResult,normalizePageTranslationItems,normalizePageTranslationResult,
  normalizeConversationResult,
} from './gloss.mjs';
import {sanitizeDiagnostic,diagnosticError,validTraceId} from './diagnostics.mjs';
import {normalizeSentenceGroupItems,normalizeSentenceGroupsResult} from './sentence-groups.mjs';
import {normalizeTranslationProgress} from './assistance-stream.mjs';

export const SUBSCRIPTION_KINDS = Object.freeze(['chatgpt','grok','antigravity']);
export function isSubscriptionKind(kind) { return kind === 'chatgpt' || kind === 'grok' || kind === 'antigravity'; }
export function nativeKind(settings) { return settings?.providerKind === 'grok' ? 'grok' : settings?.providerKind === 'antigravity' ? 'antigravity' : 'chatgpt'; }

const diagnosticListeners=new Set();
export function onNativeDiagnostic(listener){diagnosticListeners.add(listener);}
export async function syncNativeDiagnostics(payload,kind){
  const targets=kind? [connector(kind)] : [connectors.chatgpt, connectors.grok, connectors.antigravity].filter(item=>item.state.port);
  if(!targets.length)return false;
  const results=await Promise.all(targets.map(item=>item.send('diagnostics',payload).then(result=>typeof result?.enabled==='boolean'&&result.storageError===false).catch(()=>false)));
  return results.every(Boolean);
}

const DISCONNECTED = {connected:false,authenticated:false,email:null,plan:null,loginPending:false,userCode:null,error:null,features:[]};

function createConnector({host,label,cliName,loginHosts}) {
  const state = {
    status:{...DISCONNECTED},
    port:null,
    sequence:0,
    attempted:false,
    initialStatus:null,
    refreshInFlight:null,
    pending:new Map(),
    listeners:new Set(),
  };
  function snapshot() { return {...state.status}; }
  function update(value) {
    const next = {
      connected:value?.connected === true,
      authenticated:value?.connected === true && value?.authenticated === true,
      email:typeof value?.email === 'string' ? value.email.slice(0,320) : null,
      plan:typeof value?.plan === 'string' ? value.plan.slice(0,100) : null,
      loginPending:value?.loginPending === true,
      userCode:typeof value?.userCode === 'string' ? value.userCode.replace(/[^A-Za-z0-9-]/g,'').slice(0,32) : null,
      error:typeof value?.error === 'string' ? value.error.slice(0,600) : null,
      features:Array.isArray(value?.features) ? value.features.filter(item=>typeof item==='string').slice(0,16) : [],
    };
    if (JSON.stringify(next) === JSON.stringify(state.status)) return;
    state.status = next;
    for (const listener of state.listeners) listener(snapshot());
  }
  function disconnect(connection, error) {
    if (state.port !== connection) return;
    state.port = null;
    for (const {reject,timer} of state.pending.values()) { clearTimeout(timer); reject(error); }
    state.pending.clear();
    update({...DISCONNECTED,error:error.message});
  }
  function connection() {
    if (state.port) return state.port;
    state.attempted = true;
    const current = chrome.runtime.connectNative(host);
    state.port = current;
    current.onDisconnect.addListener(() => {
      const reason = chrome.runtime.lastError?.message || '';
      const missing = /not found|not registered|forbidden/i.test(reason);
      disconnect(current,new Error(missing
        ? `未找到或未授权本地 ${label} 连接器。请按安装说明安装，然后点击“刷新连接”。`
        : `本地 ${label} 连接器已断开。请确认 Node.js${cliName ? ` 和 ${cliName}` : ''} 可用，再点击“刷新连接”。`));
    });
    current.onMessage.addListener(message => {
      if (state.port !== current) return;
      if (message?.event === 'status') { update(message.data); return; }
      if(message?.event==='diagnostic'){const record=sanitizeDiagnostic(message.data);if(record)for(const listener of diagnosticListeners)listener(record);return;}
      const request = state.pending.get(message?.id);
      if (!request) return;
      if(message?.event==='assistProgress'||message?.event==='translationProgress'||message?.event==='conversationProgress'){
        const expected=message.event==='assistProgress'?'assist':message.event==='conversationProgress'?'conversationTurn':'emergencyTranslate';
        if(request.type!==expected||typeof request.onProgress!=='function')return;
        Promise.resolve().then(()=>{if(state.pending.get(message.id)===request)return request.onProgress(message.data);}).catch(()=>{});
        return;
      }
      clearTimeout(request.timer);
      state.pending.delete(message.id);
      if (message.ok === true) request.resolve(message.data);
      else {
        const error = typeof message.error === 'string' ? message.error.slice(0,600) : '本地连接器返回了无效响应。';
        const reported=new Error(/不支持的连接器请求|unsupported request/i.test(error)?'本地连接器版本过旧，请重新运行安装命令后刷新连接。':error);
        const detail=diagnosticError({code:message.code,detail:message.detail,message:error});reported.code=detail.code;reported.detail=detail;request.reject(reported);
      }
    });
    return current;
  }
  function send(type,payload = {},traceId,onProgress) {
    return new Promise((resolve,reject) => {
      if (state.pending.size >= 16) { reject(new Error(`本地 ${label} 连接器正忙，请稍后再试。`)); return; }
      let current;
      try { current = connection(); } catch { reject(new Error(`无法启动本地 ${label} 连接器，请检查安装。`)); return; }
      const id = ++state.sequence;
      const timer = setTimeout(() => {
        disconnect(current,new Error(type === 'assist' ? `${label} 订阅帮助超时，已断开连接并停止请求。请刷新连接后重试。` : type === 'emergencyTranslate' ? `${label} 订阅翻译超时，已断开连接并停止请求。请刷新连接后重试。` : `本地 ${label} 连接器没有及时响应，请刷新连接后重试。`));
        current.disconnect();
      },['assist','emergencyTranslate','conversationTurn'].includes(type) ? 120000 : 45000);
      state.pending.set(id,{resolve,reject,timer,type,onProgress});
      try { current.postMessage({id,type,payload,...(validTraceId(traceId)?{traceId}:{})}); }
      catch {
        disconnect(current,new Error(`无法向本地 ${label} 连接器发送消息，请刷新连接后重试。`));
        current.disconnect();
      }
    });
  }
  function refresh() {
    if (state.refreshInFlight) return state.refreshInFlight;
    state.attempted = true;
    state.refreshInFlight = (async () => {
      const previous = state.port;
      if (previous) {
        disconnect(previous,new Error('连接已刷新，请重新求助。'));
        previous.disconnect();
      }
      try { update(await send('status')); }
      catch (error) { update({...DISCONNECTED,error:error.message}); }
      return snapshot();
    })().finally(() => { state.refreshInFlight = null; });
    return state.refreshInFlight;
  }
  async function ensure() {
    if (!state.attempted) state.initialStatus = refresh();
    if (state.initialStatus) { await state.initialStatus; state.initialStatus = null; }
    return snapshot();
  }
  async function login() {
    const result = await send('login');
    let url;
    try { url = new URL(result?.authUrl); } catch { throw new Error('连接器未返回有效的官方登录地址。'); }
    if (url.protocol !== 'https:' || !loginHosts.has(url.hostname) || url.port || url.username || url.password) {
      await send('cancel');
      throw new Error('已拒绝非官方登录地址。');
    }
    try { await chrome.tabs.create({url:url.href}); }
    catch { await send('cancel'); throw new Error('无法打开登录页面，请重试。'); }
    if (typeof result?.userCode === 'string' && result.userCode) update({...state.status, loginPending:true, userCode:result.userCode});
    return snapshot();
  }
  async function cancel() {
    update(await send('cancel'));
    return snapshot();
  }
  async function logout() {
    update(await send('logout'));
    return snapshot();
  }
  return {state, snapshot, update, send, refresh, ensure, login, cancel, logout};
}

const connectors = {
  chatgpt: createConnector({
    host:'cc.ss_data.shisui_translate',
    label:'ChatGPT',
    loginHosts:new Set(['auth.openai.com']),
  }),
  grok: createConnector({
    host:'cc.ss_data.shisui_grok',
    label:'Grok',
    loginHosts:new Set(['auth.x.ai','accounts.x.ai']),
  }),
  antigravity: createConnector({
    host:'cc.ss_data.shisui_antigravity',
    label:'Google',
    cliName:'Antigravity CLI',
    loginHosts:new Set(['accounts.google.com','auth.google.com','antigravity.google']),
  }),
};

function connector(kind) {
  return kind === 'grok' ? connectors.grok : kind === 'antigravity' ? connectors.antigravity : connectors.chatgpt;
}

export function subscriptionStatus(kind) { return connector(kind).snapshot(); }
export function onSubscriptionStatus(listener,kind) { connector(kind).state.listeners.add(listener); }
export function refreshSubscription(kind) { return connector(kind).refresh(); }
export async function ensureSubscription(kind) { return connector(kind).ensure(); }
export async function loginSubscription(kind) { return connector(kind).login(); }
export async function cancelSubscription(kind) { return connector(kind).cancel(); }
export async function logoutSubscription(kind) { return connector(kind).logout(); }

export async function listSubscriptionModels(refresh = false, kind) {
  const result = await connector(kind).send('models',{refresh:refresh === true});
  if (!Array.isArray(result?.models) || result.models.length > 256) throw new Error('订阅服务没有返回有效模型列表。');
  return result.models.map(model => {
    if (!model || typeof model.id !== 'string' || !model.id || typeof model.name !== 'string' || !model.name) throw new Error('订阅服务返回的模型信息无效。');
    const item = {id:model.id,name:model.name,isDefault:model.isDefault === true};
    if (model.supportedReasoningEfforts !== undefined) {
      if (!Array.isArray(model.supportedReasoningEfforts) || model.supportedReasoningEfforts.some(value => typeof value !== 'string')) throw new Error('订阅服务返回的模型信息无效。');
      item.supportedReasoningEfforts = [...model.supportedReasoningEfforts];
    }
    return item;
  });
}
export async function classifySubscription(text,title,model,traceId,kind) {
  const expected = kind === 'grok' ? 'grok' : kind === 'antigravity' ? 'antigravity' : 'chatgpt';
  const result = await connector(kind).send('classify',{text,title,model},traceId);
  if (!['general','tech','data','finance','medical','legal','design'].includes(result?.domain) || result?.source !== expected) throw new Error('订阅服务没有返回有效领域分类。');
  return {domain:result.domain,source:expected};
}
function normalizePreferences(value){
  if(value===undefined||value===null)return null;
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==3||!['detail','terminology','focus'].every(key=>Object.hasOwn(value,key))||!['concise','standard'].includes(value.detail)||!['consistent','contextual'].includes(value.terminology)||!['meaning','usage'].includes(value.focus))throw new Error('个性化翻译偏好无效。');
  return {detail:value.detail,terminology:value.terminology,focus:value.focus};
}
export async function supportSubscription(items,model='',article,traceId,preferences,corrections=[],kind) {
  const selected=normalizeSupportProviderItems(items),context=normalizePreparationContext(article),personalization=normalizePreferences(preferences),issues=normalizeSupportCorrections(corrections,selected);
  return normalizeSupportAttempt(await connector(kind).send('supportBatch',{items:selected,model,article:context,corrections:issues,...(personalization?{personalization}:{})},traceId),selected,context);
}
function normalizedAssistProgress(value,request){
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const han=/[\u3400-\u9fff\uf900-\ufaff]/u,english=/[A-Za-z]/,result={};
  const validEnglish=(item,max,words=Infinity)=>typeof item==='string'&&item===item.trim()&&item.length>0&&item.length<=max&&english.test(item)&&!han.test(item)&&item.split(/\s+/).length<=words;
  const validChinese=(item,max)=>typeof item==='string'&&item===item.trim()&&item.length>0&&item.length<=max&&han.test(item);
  const definitionValid=request.level==='hint'?validEnglish(value.definition,request.kind==='passage'?240:80,request.kind==='passage'?30:8):validChinese(value.definition,1200);
  if(definitionValid)result.definition=value.definition;
  if(request.kind!=='passage'){
    if(request.level==='hint'?validEnglish(value.meaning,600):validChinese(value.meaning,400))result.meaning=value.meaning;
    if(validChinese(value.sentenceTranslation,2000))result.sentenceTranslation=value.sentenceTranslation;
  }
  return Object.keys(result).length?result:null;
}
export async function assistSubscription(request,model='',traceId,preferences,onProgress,kind) {
  const selected=normalizeAssistanceRequest(request),personalization=normalizePreferences(preferences);
  const progress=typeof onProgress==='function'?value=>{const normalized=normalizedAssistProgress(value,selected);if(normalized)return onProgress(normalized);}:undefined;
  return normalizeAssistanceResult(await connector(kind).send('assist',{...selected,model,...(personalization?{personalization}:{})},traceId,progress),selected);
}
export async function emergencyTranslateSubscription({scope,items,model='',traceId,preferences,onProgress,kind}) {
  if(scope!=='page'&&scope!=='passage')throw new Error('翻译范围无效。');
  const selected=scope==='page'?normalizePageTranslationItems(items):normalizeEmergencyItems(items),personalization=normalizePreferences(preferences);
  const progress=scope==='passage'&&typeof onProgress==='function'?value=>{const normalized=normalizeTranslationProgress(value,selected);if(normalized)return onProgress(normalized);}:undefined;
  const result=await connector(kind).send('emergencyTranslate',{scope,items:selected,model,...(personalization?{personalization}:{})},traceId,progress);
  return scope==='page'?normalizePageTranslationResult(result,selected):normalizeEmergencyResult(result,selected);
}
export async function sentenceGroupsSubscription(items,model='',traceId,kind) { const selected=normalizeSentenceGroupItems(items); const value=await connector(kind).send('sentenceGroups',{items:selected,model},traceId); return normalizeSentenceGroupsResult(value,selected); }
// 订阅追问：ChatGPT 主机只在内存保留有界历史；重启后由 setup 中的有限已完成回合重建。
export async function conversationTurnSubscription({conversationId,question,setup,model='',traceId,kind,onProgress}) {
  if(typeof conversationId!=='string'||!/^[0-9a-f-]{8,80}$/i.test(conversationId))throw new Error('追问会话无效。');
  if(typeof question!=='string'||!question.trim()||question.length>300)throw new Error('追问内容无效。');
  const progress=typeof onProgress==='function'?value=>{if(value&&typeof value.answer==='string'&&value.answer.length<=1200)return onProgress({answer:value.answer});}:undefined;
  const result=await connector(kind).send('conversationTurn',{conversationId,question:question.trim(),setup:setup||null,model},traceId,progress);
  return normalizeConversationResult(result);
}
export async function historyModelSubscription(kind,payload,model='',traceId,backend) { if(!['summary','personalization'].includes(kind)||!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error('历史模型请求无效。');
const result=await connector(backend).send('historyModel',{kind,payload,model},traceId);
if(!result||typeof result!=='object'||Array.isArray(result))throw new Error('历史模型没有返回有效对象。');
return result; }
