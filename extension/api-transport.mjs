import {apiProviderBaseUrl,getApiProvider} from './api-providers.mjs';

const CONTENT_LIMIT=24_000;
const STREAM_BUFFER_LIMIT=64*1024;
const MAX_REPLICATE_POLLS=120;
const OUTPUT_CAPABILITY_TTL=60*60*1000;
const outputCapabilities=new Map();
const outputProbes=new Map();
const JSON_SUFFIX='\nReturn one JSON object matching this JSON Schema directly, without Markdown or any extra wrapper:\n';

function schemaFormat(schema,name='result'){return {type:'json_schema',name,strict:true,schema};}
function aborted(signal){if(signal?.aborted)throw signal.reason||new DOMException('Aborted','AbortError');}

// Error bodies are read only for the public canary, bounded, and never escape as diagnostics.
async function rejectsSchemaFormat(response){
  if(![400,422].includes(response.status)||!response.body?.getReader)return false;
  const reader=response.body.getReader(),decoder=new TextDecoder();let text='',size=0;
  try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>8192)return false;text+=decoder.decode(next.value,{stream:true});}text+=decoder.decode();}
  catch{return false;}finally{try{await reader.cancel();}catch{}reader.releaseLock();}
  let error;try{const value=JSON.parse(text);error=value.error||value;}catch{return false;}
  const message=typeof error.message==='string'?error.message:'',param=typeof error.param==='string'?error.param:'';
  if(/invalid.{0,20}schema|schema.{0,20}(invalid|keyword)|additionalProperties|\b(pattern|minItems|maxItems|minLength|maxLength|anyOf|required)\b/i.test(message)||/\.schema(?:\.|$)/.test(param)||error.code==='invalid_json_schema')return false;
  const namesFormat=/json_schema|response_format|text\.format/i.test(message)||['response_format','response_format.type','text.format','text.format.type'].includes(param);
  return namesFormat&&(/not supported|unsupported|does not support|not available|unavailable|only supports?|must be (?:one of|json_object)|supported (?:values|types)|not one of/i.test(message)||error.code==='unsupported_parameter'||error.code==='unsupported_value');
}

async function probeOutputMode(service,protocol,signal,onUsage){
  aborted(signal);
  const expected=crypto.randomUUID(),schema={type:'object',additionalProperties:false,required:['probe'],properties:{probe:{type:'string',enum:[expected]}}};
  // The expected value appears ONLY in response_format/text.format, not in the prompt.
  const prompt='Return exactly this JSON object: {"probe":"unsupported"}';
  const format=schemaFormat(schema,'relyless_capability');
  const body=protocol==='chat'
    ?{model:service.model,max_tokens:128,...chatThinking(service),response_format:{type:'json_schema',json_schema:{name:format.name,strict:true,schema}},messages:[{role:'user',content:prompt}]}
    :{model:service.model,max_output_tokens:128,...responsesThinking(service),text:{format},input:prompt};
  let response;
  try{response=await checkedFetch(endpointFor(service,protocol),{method:'POST',signal,body:JSON.stringify(body)},service,protocol,true);}
  catch(error){if(error.code==='SCHEMA_UNSUPPORTED')return 'json_object';throw error;}
  const value=await jsonResponse(response);responseError(value);emitUsage({onUsage},usageExtractors[protocol==='chat'?'chat':'responses'](value));let text;
  if(protocol==='chat'){
    const choice=value.choices?.[0];if(choice?.message?.refusal)throw transportError('结构化输出检测未完成，请稍后重试。','INVALID_RESPONSE');
    if(choice?.finish_reason==='length')return 'json_object';
    if(choice?.finish_reason!=='stop')throw transportError('结构化输出检测未完成，请稍后重试。','INVALID_RESPONSE');
    text=choice.message?.content;
  }else{
    if(value.status==='incomplete'&&value.incomplete_details?.reason==='max_output_tokens')return 'json_object';
    if(value.status!=='completed')throw transportError('结构化输出检测未完成，请稍后重试。','INVALID_RESPONSE');
    text=typeof value.output_text==='string'?value.output_text:(value.output||[]).flatMap(item=>item?.content||[]).filter(item=>item?.type==='output_text').map(item=>item.text||'').join('');
  }
  const result=parseObject(text);
  return Object.keys(result).length===1&&result.probe===expected?'json_schema':'json_object';
}

function waitForOutputProbe(entry,signal){
  entry.users++;
  return new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(fn,value)=>{if(settled)return;settled=true;signal?.removeEventListener('abort',cancel);if(--entry.users===0&&!entry.settled)entry.controller.abort();fn(value);};
    const cancel=()=>finish(reject,signal.reason||new DOMException('Aborted','AbortError'));
    entry.promise.then(value=>finish(resolve,value),error=>finish(reject,error));
    if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
  });
}

async function outputMode(service,protocol,signal,onUsage){
  aborted(signal);
  // 恒思考模型在严格 json_schema 约束解码下产出退化字段（语言混杂、字段截断），直接走 json_object；schema 仍在系统提示中，结果照常过归一化校验。
  if(alwaysReasoningChat(service))return 'json_object';
  const identity=JSON.stringify([service.providerId,endpointFor(service,protocol).href,service.model,service.apiKey||'',protocol==='chat'?chatThinking(service):responsesThinking(service)]);
  const key=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(identity))),byte=>byte.toString(16).padStart(2,'0')).join('');
  aborted(signal);
  const cached=outputCapabilities.get(key);
  if(cached&&Date.now()-cached.at<OUTPUT_CAPABILITY_TTL)return cached.mode;
  outputCapabilities.delete(key);
  let entry=outputProbes.get(key);
  if(!entry||entry.controller.signal.aborted){
    entry={controller:new AbortController(),users:0,settled:false,promise:null};
    entry.promise=probeOutputMode(service,protocol,entry.controller.signal,onUsage).then(mode=>{
      if(!entry.controller.signal.aborted){outputCapabilities.delete(key);outputCapabilities.set(key,{mode,at:Date.now()});while(outputCapabilities.size>64)outputCapabilities.delete(outputCapabilities.keys().next().value);}
      return mode;
    }).finally(()=>{entry.settled=true;if(outputProbes.get(key)===entry)outputProbes.delete(key);});
    outputProbes.set(key,entry);
  }
  return waitForOutputProbe(entry,signal);
}


function transportError(message,code,detail){const error=new Error(message);if(code)error.code=code;if(detail)error.detail=detail;return error;}
// 用量上报：各协议把自家 usage 字段归一化为 {input,output} 后经 options.onUsage 抛出；缺失则保持 null 由调用方估算。
function tokenNumber(value){if(value===null||value===undefined||value==='')return null;const n=Number(value);return Number.isFinite(n)&&n>=0?Math.floor(n):null;}
function emitUsage(options,usage){if(typeof options?.onUsage!=='function'||!usage)return;const input=tokenNumber(usage.input),output=tokenNumber(usage.output);if(input===null&&output===null)return;try{options.onUsage({input,output});}catch{}}
const usageExtractors={
  chat:value=>value?.usage?{input:value.usage.prompt_tokens,output:value.usage.completion_tokens}:null,
  responses:value=>value?.usage?{input:value.usage.input_tokens,output:value.usage.output_tokens}:null,
  anthropic:value=>value?.usage?{input:value.usage.input_tokens,output:value.usage.output_tokens}:null,
  google:value=>value?.usageMetadata?{input:value.usageMetadata.promptTokenCount,output:value.usageMetadata.candidatesTokenCount}:null,
  bedrock:value=>value?.usage?{input:value.usage.inputTokens,output:value.usage.outputTokens}:null,
  cohere:value=>{const units=value?.usage?.billed_units||value?.usage?.tokens||value?.usage;return units?{input:units.input_tokens,output:units.output_tokens}:null;},
  ollama:value=>value&&(value.prompt_eval_count!=null||value.eval_count!=null)?{input:value.prompt_eval_count,output:value.eval_count}:null,
  jev:value=>value?.usage?{input:value.usage.prompt_tokens,output:value.usage.completion_tokens}:null,
  systemone:value=>{const usage=value?.usage;return usage?{input:usage.input_tokens??usage.prompt_tokens??null,output:usage.output_tokens??usage.completion_tokens??null}:null;},
};
function unsupportedModels(){throw transportError('此服务不提供可安全使用的模型目录，请手动填写模型 ID。','MODELS_UNSUPPORTED');}
function providerFor(service){const provider=getApiProvider(service?.providerId);if(!provider)throw transportError('不支持的 API 服务商。','PROVIDER_UNSUPPORTED');return provider;}
function serviceBase(service){const raw=service?.baseUrl||apiProviderBaseUrl(service?.providerId,service?.options||{});let url;try{url=new URL(raw);}catch{throw transportError('API 地址无效。','INVALID_URL');}if(url.username||url.password||url.search||url.hash)throw transportError('API 地址不能包含用户名、密码、查询参数或片段。','INVALID_URL');return url;}
function cleanPath(path){return path.replace(/\/+$/,'');}
function appendPath(base,suffix){const url=new URL(base.href);const current=cleanPath(url.pathname);const wanted='/'+suffix.replace(/^\/+/, '');if(!current.endsWith(wanted))url.pathname=(current||'')+wanted;return url;}
function endpointFor(service,kind){const base=serviceBase(service),model=encodeURIComponent(service.model||'');const path=cleanPath(base.pathname);
  if(service.providerId==='azure'){
    const mode=service.options?.apiMode==='chat'?'chat':'responses',v1=service.options?.apiVersion?.toLowerCase()==='v1'||/\/openai\/v1$/i.test(path);
    if(mode==='chat'){
      if(!model)throw transportError('模型 ID 不能为空。','MODEL_REQUIRED');
      if(/\/chat\/completions$/i.test(path))return withAzureVersion(base,service);
      if(/\/openai\/deployments\/[^/]+$/i.test(path))return withAzureVersion(appendPath(base,'chat/completions'),service);
      if(/\/openai\/v1$/i.test(path))return withAzureVersion(appendPath(base,'chat/completions'),service);
      if(v1)return withAzureVersion(appendPath(base,'openai/v1/chat/completions'),service);
      return withAzureVersion(appendPath(base,`openai/deployments/${model}/chat/completions`),service);
    }
    if(/\/responses$/i.test(path))return withAzureVersion(base,service);
    if(/\/openai\/v1$/i.test(path))return withAzureVersion(appendPath(base,'responses'),service);
    return withAzureVersion(appendPath(base,v1?'openai/v1/responses':'openai/responses'),service);
  }
  if(kind==='chat')return /\/chat\/completions$/i.test(path)?base:appendPath(base,'chat/completions');
  if(kind==='responses')return /\/responses$/i.test(path)?base:appendPath(base,'responses');
  if(kind==='anthropic')return /\/messages$/i.test(path)?base:appendPath(base,'messages');
  if(kind==='google'){const id=model.replace(/^models%2F/i,'');return appendPath(base,`models/${id}:${arguments[2]?'streamGenerateContent':'generateContent'}`);}
  if(kind==='bedrock')return appendPath(base,`model/${model}/converse`);
  if(kind==='cohere')return /\/v2\/chat$/i.test(path)?base:appendPath(base,/\/v2$/i.test(path)?'chat':'v2/chat');
  if(kind==='ollama')return /\/api\/chat$/i.test(path)?base:appendPath(base,/\/api$/i.test(path)?'chat':'api/chat');
  return base;
}
function withAzureVersion(url,service){const result=new URL(url.href);const version=service.options?.apiVersion;if(version&&version.toLowerCase()!=='v1'&&!/\/openai\/v1(?:\/|$)/i.test(result.pathname))result.searchParams.set('api-version',version);return result;}
function assertSameOrigin(base,target){let url;try{url=new URL(target,base);}catch{throw transportError('服务返回了无效的后续请求地址。','UNSAFE_URL');}if(url.origin!==base.origin||url.username||url.password)throw transportError('服务要求向未授权地址发送凭据，已停止请求。','UNSAFE_URL');return url;}
function authHeaders(service,protocol){const headers={'Content-Type':'application/json','Accept':'application/json'};if(!service.apiKey)return headers;
  if(service.providerId==='azure')headers['api-key']=service.apiKey;
  else if(protocol==='anthropic'){headers['x-api-key']=service.apiKey;headers['anthropic-version']='2023-06-01';}
  else if(protocol==='google')headers['x-goog-api-key']=service.apiKey;
  else headers.Authorization='Bearer '+service.apiKey;
  return headers;
}
async function checkedFetch(url,init,service,protocol,detectSchemaSupport=false){const base=serviceBase(service);assertSameOrigin(base,url);let response;try{response=await fetch(url,{...init,redirect:'error',credentials:'omit',headers:{...authHeaders(service,protocol),...init.headers}});}catch(error){if(error?.name==='AbortError')throw error;throw transportError('无法连接服务，请检查网络、API 地址与服务跨域支持。','NETWORK');}
  if(response.ok)return response;
  if(detectSchemaSupport&&await rejectsSchemaFormat(response))throw transportError('此服务或模型不支持严格 JSON Schema。','SCHEMA_UNSUPPORTED');
  const incompatible=[400,404,405,422].includes(response.status);
  const message=[401,403].includes(response.status)?'服务拒绝访问，请检查 API Key、模型权限与账户状态。':response.status===429?'服务额度不足或请求过快，请稍后重试或检查账户。':incompatible?'服务或模型不兼容无思考模式、结构化输出或当前原生协议，已停止且不会删除参数重试。':`服务返回 HTTP ${response.status}，请检查 API 地址和模型。`;
  throw transportError(message,[401,403].includes(response.status)?'AUTH':response.status===429?'RATE_LIMIT':incompatible?'INCOMPATIBLE_REQUEST':'HTTP',{httpStatus:response.status});
}
function systemPrompt(instructions,schema){return instructions+JSON_SUFFIX+JSON.stringify(schema);}
function isHybridChatModel(model){return /(?:deepseek-(?:v3|v4)|glm-5\.2|kimi-k2\.6|kimi-k3|qwen3\.(?:5|6|8)|minimax-m3|gemini-2\.5-(?:flash|flash-lite)|grok-4\.3)/i.test(model||'');}
function ensureNoForcedReasoning(service){const model=(service.model||'').toLowerCase();if(/(?:^|[\/_-])(?:deepseek-r1|deepseek-reasoner)(?:$|[\/_:.-])/i.test(model))throw transportError('该模型始终使用推理，无法关闭思考；请选择支持无思考模式的模型。','THINKING_REQUIRED');
  if(/gemini-2\.5-pro(?:$|[-_:])/i.test(model)||/gemini-(?:3|[4-9]|[1-9]\d)(?:\.|-|$)/i.test(model))throw transportError('该 Gemini 模型不支持完全关闭思考；请选择支持无思考模式的模型。','THINKING_REQUIRED');
  if(/(^|\/)(?:o1|o3|o4)(?:$|[-_:])/i.test(model))throw transportError('该 OpenAI 推理模型无法可靠关闭思考；请选择非推理模型。','THINKING_REQUIRED');
  if(/(?:^|[\/_-])minimax-m2(?:$|[.\/_:-])/i.test(model))throw transportError('该 MiniMax 模型始终使用推理，无法关闭思考；请选择 MiniMax-M3。','THINKING_REQUIRED');
  if(/(?:^|[\/.])claude-(?:opus-5|sonnet-5|fable-5|mythos)/i.test(model))throw transportError('该 Claude 模型始终使用推理，无法关闭思考；请选择支持无思考模式的模型。','THINKING_REQUIRED');
  if(/(?:^|\/)grok-(?:4\.(?:5|6)(?:$|-)|4\.20-multi-agent|4-1-fast-reasoning)/i.test(model)||/(?:^|\/)grok-4(?:-|$)/i.test(model)&&!model.includes('non-reasoning'))throw transportError('该 Grok 模型始终使用推理，无法关闭思考；请选择无推理版本。','THINKING_REQUIRED');
  if(/(?:^|[\/_-])(?:gpt-oss|qwq)(?:$|[\/_:.-])|sonar-(?:reasoning|deep-research)|glm-5\.3|(?:^|[\/_-])thinking(?:$|[\/_:.-])/i.test(model))throw transportError('该模型无法关闭思考；请选择支持无思考模式的模型。','THINKING_REQUIRED');
}
function alwaysReasoningChat(service){return service.providerId==='stepfun'&&/^step-(?:3\.\d|5)/i.test(service.model||'');}
function chatThinking(service){const id=service.providerId,model=service.model||'',base=service.baseUrl||'';
  if(['deepseek','moonshotai','volcengine','minimax'].includes(id))return {thinking:{type:'disabled'}};
  if(alwaysReasoningChat(service))return {reasoning_effort:'low'};
  if((id==='jalapenocloud'||id==='atlascloud')&&isHybridChatModel(model))return {thinking:{type:'disabled'}};
  if(id==='openai-compatible'){const host=new URL(base).hostname;if((host==='api.openai.com'||host.endsWith('.openai.com'))&&/^(?:chatgpt-4o|gpt-(?:3\.5|4o?))(?:[-_.]|$)/i.test(model))return {};return /deepseek/i.test(model)||/deepseek/i.test(base)?{thinking:{type:'disabled'}}:{reasoning_effort:'none'};}
  if(id==='azure')return /^(?:chatgpt-4o|gpt-(?:3\.5|4o?))(?:[-_.]|$)/i.test(model)?{}:{reasoning_effort:'none'};
  if(id==='alibaba'||id==='siliconflow')return {enable_thinking:false};
  if(id==='openrouter'&&isHybridChatModel(model))return {reasoning:{effort:'none'}};
  if(id==='togetherai'&&isHybridChatModel(model))return {reasoning:{enabled:false}};
  if((id==='deepinfra'||id==='huggingface')&&isHybridChatModel(model))return {reasoning_effort:'none'};
  if(id==='cerebras'&&/qwen-?3\.8/i.test(model))return {reasoning_effort:'none'};
  return {};
}
function responsesThinking(service){const model=service.model||'';if(service.providerId==='open-responses')return {reasoning:{effort:'none'}};if(service.providerId==='xai'&&/^grok-4\.3(?:$|-)/i.test(model))return {reasoning:{effort:'none'}};return (service.providerId==='openai'||service.providerId==='azure')&&/^gpt-(?:[5-9]|[1-9]\d)/i.test(model)?{reasoning:{effort:'none'}}:{};}
function googleThinking(service){return /gemini-2\.5-(?:flash|flash-lite)(?:$|[-_:])/i.test(service.model||'')?{thinkingConfig:{thinkingBudget:0}}:{};}
function parseObject(text){if(typeof text!=='string'||!text.trim())throw transportError('服务返回内容无效。','INVALID_RESPONSE');if(text.length>CONTENT_LIMIT)throw transportError('服务返回内容过长。','INVALID_RESPONSE');let value;try{value=JSON.parse(text);}catch{throw transportError('服务未返回有效 JSON。','INVALID_JSON');}if(!value||typeof value!=='object'||Array.isArray(value))throw transportError('服务未返回 JSON 对象。','INVALID_JSON');return value;}
function textParts(parts){if(!Array.isArray(parts))return '';return parts.map(part=>typeof part?.text==='string'?part.text:'').join('');}
async function jsonResponse(response){try{return await response.json();}catch{throw transportError('服务返回了无效数据。','INVALID_RESPONSE');}}
const streamingResponse=response=>/\btext\/event-stream\b/i.test(response.headers?.get?.('content-type')||'');
function responseError(value){if(value?.error||value?.type==='error')throw transportError('服务返回错误，已停止请求。','PROVIDER_ERROR');}

async function readSSE(response,eventHandler,{onContent,signal}={}){if(!response.body?.getReader)throw transportError('流式服务没有可读取的响应体。','INVALID_RESPONSE');const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',lines=[],size=0,content='',done=false,ended=false;
  const emit=async delta=>{if(!delta)return;if(content.length+delta.length>CONTENT_LIMIT)throw transportError('服务返回内容过长。','INVALID_RESPONSE');content+=delta;if(onContent)await onContent(content);};
  const dispatch=async()=>{if(!lines.length)return;let event='',data=[];for(const line of lines){if(!line||line.startsWith(':'))continue;const at=line.indexOf(':'),field=at<0?line:line.slice(0,at);let value=at<0?'':line.slice(at+1);if(value.startsWith(' '))value=value.slice(1);if(field==='event')event=value;else if(field==='data')data.push(value);}lines=[];size=0;if(!data.length)return;const raw=data.join('\n');if(raw.trim()==='[DONE]'){ended=true;return;}let value;try{value=JSON.parse(raw);}catch{throw transportError('流式服务返回了无效数据。','INVALID_RESPONSE');}responseError(value);const result=eventHandler(event,value)||{};if(result.error)throw transportError('服务生成失败，已停止请求。','PROVIDER_ERROR');await emit(result.delta);if(result.done){done=true;ended=true;}};
  const consume=async(final=false)=>{let start=0;for(let i=0;i<buffer.length;i++){const code=buffer.charCodeAt(i);if(code!==10&&code!==13)continue;if(!final&&code===13&&i+1===buffer.length)break;const line=buffer.slice(start,i);if(code===13&&buffer.charCodeAt(i+1)===10)i++;start=i+1;if(line==='')await dispatch();else{lines.push(line);size+=line.length+1;if(size>STREAM_BUFFER_LIMIT)throw transportError('流式服务缓冲区过大。','INVALID_RESPONSE');}if(ended)break;}buffer=buffer.slice(start);if(size+buffer.length>STREAM_BUFFER_LIMIT)throw transportError('流式服务缓冲区过大。','INVALID_RESPONSE');if(final&&!ended){if(buffer)lines.push(buffer);buffer='';await dispatch();}};
  try{while(!ended){if(signal?.aborted)throw signal.reason||new DOMException('Aborted','AbortError');const next=await reader.read();if(next.done){buffer+=decoder.decode();await consume(true);break;}buffer+=decoder.decode(next.value,{stream:true});await consume();}if(!done)throw transportError('流式服务意外中断。','INVALID_RESPONSE');return content;}finally{try{await reader.cancel();}catch{}try{reader.releaseLock();}catch{}}
}
async function readNDJSON(response,eventHandler,{onContent,signal}={}){if(!response.body?.getReader)throw transportError('流式服务没有可读取的响应体。','INVALID_RESPONSE');const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',content='',done=false;const handle=async line=>{if(!line.trim())return;let value;try{value=JSON.parse(line);}catch{throw transportError('流式服务返回了无效数据。','INVALID_RESPONSE');}responseError(value);const result=eventHandler(value)||{};if(result.error)throw transportError('服务生成失败，已停止请求。','PROVIDER_ERROR');if(result.delta){if(content.length+result.delta.length>CONTENT_LIMIT)throw transportError('服务返回内容过长。','INVALID_RESPONSE');content+=result.delta;if(onContent)await onContent(content);}if(result.done)done=true;};try{while(!done){if(signal?.aborted)throw signal.reason||new DOMException('Aborted','AbortError');const next=await reader.read();if(next.done){buffer+=decoder.decode();if(buffer)await handle(buffer);break;}buffer+=decoder.decode(next.value,{stream:true});let at;while((at=buffer.indexOf('\n'))>=0&&!done){const line=buffer.slice(0,at).replace(/\r$/,'');buffer=buffer.slice(at+1);await handle(line);}if(buffer.length>STREAM_BUFFER_LIMIT)throw transportError('流式服务缓冲区过大。','INVALID_RESPONSE');}if(!done)throw transportError('流式服务意外中断。','INVALID_RESPONSE');return content;}finally{try{await reader.cancel();}catch{}try{reader.releaseLock();}catch{}}}

async function performChat(service,payload,instructions,schema,options){const url=endpointFor(service,'chat');const body={model:service.model,temperature:0.2,max_tokens:8192,response_format:options.outputMode==='json_schema'?{type:'json_schema',json_schema:{name:'result',strict:true,schema}}:{type:'json_object'},...chatThinking(service),...(options.onContent?{stream:true}:{}),messages:[{role:'system',content:systemPrompt(instructions,schema)},{role:'user',content:JSON.stringify(payload)}]};const response=await checkedFetch(url,{method:'POST',signal:options.signal,body:JSON.stringify(body)},service,'chat');if(streamingResponse(response)){let usage=null;const text=await readSSE(response,(_event,value)=>{if(value?.usage)usage=value.usage;const choice=value.choices?.[0],reason=choice?.finish_reason;if(reason==='length')return {error:true};if(reason!=null&&reason!=='stop')return {error:true};return {delta:typeof choice?.delta?.content==='string'?choice.delta.content:'',done:reason==='stop'};},options);emitUsage(options,usageExtractors.chat({usage}));return parseObject(text);}const value=await jsonResponse(response);responseError(value);emitUsage(options,usageExtractors.chat(value));const choice=value.choices?.[0],reason=choice?.finish_reason;if(reason==='length')throw transportError('服务输出达到长度上限。','OUTPUT_LIMIT');if(reason!=null&&reason!=='stop')throw transportError('服务生成异常终止。','PROVIDER_ERROR');return parseObject(choice?.message?.content);}
async function performResponses(service,payload,instructions,schema,options){const url=endpointFor(service,'responses');const body={model:service.model,instructions:systemPrompt(instructions,schema),input:JSON.stringify(payload),temperature:0.2,max_output_tokens:8192,text:{format:options.outputMode==='json_schema'?schemaFormat(schema):{type:'json_object'}},...responsesThinking(service),...(options.onContent?{stream:true}:{})};const response=await checkedFetch(url,{method:'POST',signal:options.signal,body:JSON.stringify(body)},service,'responses');if(streamingResponse(response)){let usage=null;const text=await readSSE(response,(event,value)=>{if(event==='response.output_text.delta'||value.type==='response.output_text.delta')return {delta:value.delta||''};if(event==='response.completed'||value.type==='response.completed'){usage=value.response?.usage||usage;return {done:value.response?.status!=='incomplete'};}if(event==='response.incomplete'||value.type==='response.incomplete'||event==='response.failed'||value.type==='response.failed')return {error:true};return {};},options);emitUsage(options,{input:usage?.input_tokens,output:usage?.output_tokens});return parseObject(text);}const value=await jsonResponse(response);responseError(value);emitUsage(options,usageExtractors.responses(value));if(value.status==='incomplete')throw transportError(value.incomplete_details?.reason==='max_output_tokens'?'服务输出达到长度上限。':'服务生成异常终止。','PROVIDER_ERROR');if(value.status&&value.status!=='completed')throw transportError('服务生成异常终止。','PROVIDER_ERROR');const text=typeof value.output_text==='string'?value.output_text:(value.output||[]).flatMap(item=>item?.content||[]).filter(item=>item?.type==='output_text').map(item=>item.text||'').join('');return parseObject(text);}
async function performAnthropic(service,payload,instructions,schema,options){const url=endpointFor(service,'anthropic');const body={model:service.model,max_tokens:8192,temperature:0.2,...(/^claude-(?:haiku|sonnet|opus)-4/i.test(service.model||'')?{thinking:{type:'disabled'}}:{}),system:systemPrompt(instructions,schema),messages:[{role:'user',content:JSON.stringify(payload)}],...(options.onContent?{stream:true}:{})};const response=await checkedFetch(url,{method:'POST',signal:options.signal,body:JSON.stringify(body)},service,'anthropic');if(streamingResponse(response)){let usage=null;const text=await readSSE(response,(event,value)=>{if(event==='message_start'&&value.message?.usage)usage={input:value.message.usage.input_tokens,output:value.message.usage.output_tokens};if(event==='message_delta'&&value.usage){usage=usage||{};if(value.usage.output_tokens!=null)usage.output=value.usage.output_tokens;if(value.usage.input_tokens!=null)usage.input=value.usage.input_tokens;}if(event==='content_block_delta'&&value.delta?.type==='text_delta')return {delta:value.delta.text||''};if(event==='message_delta'){const reason=value.delta?.stop_reason;if(reason==='max_tokens')return {error:true};if(reason&&reason!=='end_turn'&&reason!=='stop_sequence')return {error:true};return {};}if(event==='message_stop')return {done:true};if(event==='error')return {error:true};return {};},options);emitUsage(options,usage);return parseObject(text);}const value=await jsonResponse(response);responseError(value);emitUsage(options,usageExtractors.anthropic(value));if(value.stop_reason==='max_tokens')throw transportError('服务输出达到长度上限。','OUTPUT_LIMIT');if(value.stop_reason&&value.stop_reason!=='end_turn'&&value.stop_reason!=='stop_sequence')throw transportError('服务生成异常终止。','PROVIDER_ERROR');return parseObject(textParts(value.content));}
async function performGoogle(service,payload,instructions,schema,options){const url=endpointFor(service,'google',Boolean(options.onContent));if(options.onContent)url.searchParams.set('alt','sse');const body={systemInstruction:{parts:[{text:systemPrompt(instructions,schema)}]},contents:[{role:'user',parts:[{text:JSON.stringify(payload)}]}],generationConfig:{temperature:0.2,maxOutputTokens:8192,responseMimeType:'application/json',responseJsonSchema:schema,...googleThinking(service)}};const response=await checkedFetch(url,{method:'POST',signal:options.signal,body:JSON.stringify(body)},service,'google');if(streamingResponse(response)){let usage=null;const text=await readSSE(response,(_event,value)=>{if(value?.usageMetadata)usage=value.usageMetadata;const candidate=value.candidates?.[0],reason=candidate?.finishReason;if(reason&&reason!=='STOP')return {error:reason==='MAX_TOKENS'?'服务输出达到长度上限。':'服务生成异常终止。'};return {delta:textParts(candidate?.content?.parts),done:reason==='STOP'};},options);emitUsage(options,{input:usage?.promptTokenCount,output:usage?.candidatesTokenCount});return parseObject(text);}const value=await jsonResponse(response);responseError(value);emitUsage(options,usageExtractors.google(value));const candidate=value.candidates?.[0];if(candidate?.finishReason&&candidate.finishReason!=='STOP')throw transportError(candidate.finishReason==='MAX_TOKENS'?'服务输出达到长度上限。':'服务生成异常终止。','PROVIDER_ERROR');return parseObject(textParts(candidate?.content?.parts));}
async function performBedrock(service,payload,instructions,schema,options){const url=endpointFor(service,'bedrock');const body={system:[{text:systemPrompt(instructions,schema)}],messages:[{role:'user',content:[{text:JSON.stringify(payload)}]}],inferenceConfig:{maxTokens:8192,temperature:0.2},...(/anthropic\.claude-(?:haiku|sonnet|opus)-4/i.test(service.model||'')?{additionalModelRequestFields:{thinking:{type:'disabled'}}}:{})};const response=await checkedFetch(url,{method:'POST',signal:options.signal,body:JSON.stringify(body)},service,'bedrock');const value=await jsonResponse(response);responseError(value);emitUsage(options,usageExtractors.bedrock(value));if(value.stopReason&&value.stopReason!=='end_turn'&&value.stopReason!=='stop_sequence')throw transportError(value.stopReason==='max_tokens'?'服务输出达到长度上限。':'服务生成异常终止。','PROVIDER_ERROR');const text=textParts(value.output?.message?.content);if(options.onContent)await options.onContent(text);return parseObject(text);}
async function performCohere(service,payload,instructions,schema,options){const url=endpointFor(service,'cohere');const body={model:service.model,temperature:0.2,max_tokens:8192,...(/reasoning/i.test(service.model||'')?{thinking:{type:'disabled'}}:{}),response_format:{type:'json_object',schema},messages:[{role:'system',content:systemPrompt(instructions,schema)},{role:'user',content:JSON.stringify(payload)}],...(options.onContent?{stream:true}:{})};const response=await checkedFetch(url,{method:'POST',signal:options.signal,body:JSON.stringify(body)},service,'cohere');if(streamingResponse(response)){let usage=null;const text=await readSSE(response,(_event,value)=>{if(value.type==='content-delta')return {delta:value.delta?.message?.content?.text||''};if(value.type==='message-end'){usage=value.delta?.usage||value.usage||usage;const reason=value.delta?.finish_reason;if(reason==='MAX_TOKENS')return {error:true};return {done:!reason||reason==='COMPLETE'||reason==='STOP_SEQUENCE',error:Boolean(reason&&reason!=='COMPLETE'&&reason!=='STOP_SEQUENCE')};}return {};},options);emitUsage(options,usageExtractors.cohere({usage}));return parseObject(text);}const value=await jsonResponse(response);responseError(value);emitUsage(options,usageExtractors.cohere(value));if(value.finish_reason==='MAX_TOKENS')throw transportError('服务输出达到长度上限。','OUTPUT_LIMIT');if(value.finish_reason&&value.finish_reason!=='COMPLETE'&&value.finish_reason!=='STOP_SEQUENCE')throw transportError('服务生成异常终止。','PROVIDER_ERROR');return parseObject(typeof value.message?.content?.[0]?.text==='string'?value.message.content[0].text:'');}
async function performOllama(service,payload,instructions,schema,options){const url=endpointFor(service,'ollama');const body={model:service.model,think:false,format:schema,stream:Boolean(options.onContent),options:{temperature:0.2,num_predict:8192},messages:[{role:'system',content:systemPrompt(instructions,schema)},{role:'user',content:JSON.stringify(payload)}]};const response=await checkedFetch(url,{method:'POST',signal:options.signal,body:JSON.stringify(body)},service,'ollama');if(options.onContent){let usage=null;const text=await readNDJSON(response,value=>{if(value.prompt_eval_count!=null||value.eval_count!=null)usage=value;return {delta:value.message?.content||'',done:value.done===true&&value.done_reason!=='length',error:value.done===true&&value.done_reason==='length'};},options);emitUsage(options,usageExtractors.ollama(usage));return parseObject(text);}const value=await jsonResponse(response);responseError(value);emitUsage(options,usageExtractors.ollama(value));if(value.done_reason==='length')throw transportError('服务输出达到长度上限。','OUTPUT_LIMIT');return parseObject(value.message?.content);}
function replicateCreateURL(service){const base=serviceBase(service),model=service.model||'',prefix=/\/v1$/i.test(cleanPath(base.pathname))?'':'v1/';if(/^https?:/i.test(model))throw transportError('Replicate 模型 ID 必须是 owner/name 或版本 ID。','MODEL_REQUIRED');if(model.includes('/'))return appendPath(base,`${prefix}models/${model.split('/').map(encodeURIComponent).join('/')}/predictions`);return appendPath(base,`${prefix}predictions`);}
async function performReplicate(service,payload,instructions,schema,options){const base=serviceBase(service),url=replicateCreateURL(service),isVersion=!service.model.includes('/');const input={prompt:JSON.stringify(payload),system_prompt:systemPrompt(instructions,schema),temperature:0.2,max_tokens:8192};const response=await checkedFetch(url,{method:'POST',signal:options.signal,headers:{Prefer:'wait=25'},body:JSON.stringify(isVersion?{version:service.model,input}:{input})},service,'replicate');let prediction=await jsonResponse(response);responseError(prediction);for(let count=0;!['succeeded','failed','canceled'].includes(prediction.status)&&count<MAX_REPLICATE_POLLS;count++){if(typeof prediction.urls?.get!=='string'||!prediction.urls.get)throw transportError('Replicate 未返回有效的预测状态地址。','INVALID_RESPONSE');const poll=assertSameOrigin(base,prediction.urls.get);await abortableDelay(250,options.signal);prediction=await jsonResponse(await checkedFetch(poll,{method:'GET',signal:options.signal},service,'replicate'));responseError(prediction);}if(prediction.status!=='succeeded')throw transportError('Replicate 预测未成功完成。','PROVIDER_ERROR');const output=Array.isArray(prediction.output)?prediction.output.join(''):prediction.output;if(options.onContent&&typeof output==='string')await options.onContent(output);return parseObject(output);}
function abortableDelay(ms,signal){return new Promise((resolve,reject)=>{if(signal?.aborted){reject(signal.reason||new DOMException('Aborted','AbortError'));return;}const timer=setTimeout(done,ms);function done(){signal?.removeEventListener('abort',abort);resolve();}function abort(){clearTimeout(timer);signal.removeEventListener('abort',abort);reject(signal.reason||new DOMException('Aborted','AbortError'));}signal?.addEventListener('abort',abort,{once:true});});}

// 单次请求超时预算：慢速推理服务给更长的时间，其余用默认值。按服务商覆盖，不暴露给页面。
const PROVIDER_TIMEOUT_MS = Object.freeze({stepfun: 300_000});
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;
export function providerRequestTimeoutMs(service) {
  return PROVIDER_TIMEOUT_MS[service?.providerId] || DEFAULT_REQUEST_TIMEOUT_MS;
}

function jevNumber(value){const n=typeof value==='string'&&value.trim()?Number(value):value;return typeof n==='number'&&Number.isFinite(n)?n:null;}
function normalizeJevAnswer(name,question,raw){
  const kind=question.type;
  if(kind==='noul'){
    const p=raw&&typeof raw==='object'&&!Array.isArray(raw)?jevNumber(raw.noul??raw.probability??raw.p??raw.value??raw.score):jevNumber(raw);
    if(p===null||p<0||p>1)throw transportError(`判定 ${name} 未返回有效概率。`,'JEV_ANSWER');
    return {kind,probability:p};
  }
  if(kind==='score'){
    const s=raw&&typeof raw==='object'&&!Array.isArray(raw)?jevNumber(raw.score??raw.value??raw.probability):jevNumber(raw);
    if(s===null)throw transportError(`判定 ${name} 未返回有效分数。`,'JEV_ANSWER');
    const out={kind,score:s};
    if(raw&&typeof raw==='object'&&!Array.isArray(raw)){const c=jevNumber(raw.confidence);if(c!==null)out.confidence=c;}
    return out;
  }
  let selected=null,confidence=null,probabilities=null;
  if(typeof raw==='string')selected=raw.trim()||null;
  else if(raw&&typeof raw==='object'&&!Array.isArray(raw)){
    const cand=[raw.answer,raw.selected,raw.value,raw.choice,raw.label,raw.option,raw.result].find(v=>typeof v==='string'&&v.trim());
    selected=cand||null;confidence=jevNumber(raw.confidence);
    if(raw.probabilities&&typeof raw.probabilities==='object'&&!Array.isArray(raw.probabilities))probabilities=raw.probabilities;
  }
  if(!selected)throw transportError(`判定 ${name} 未返回有效选项。`,'JEV_ANSWER');
  return {kind,selected,confidence,probabilities};
}
// 判定请求校验：state 为非空字符串，questions 为 1–16 个 {类型,instructions} 映射；jev 与 systemone 共用同一份入参契约。
function jevPayload(payload){
  const state=typeof payload?.state==='string'?payload.state:'';
  const questions=payload?.questions;
  if(!state.trim())throw transportError('判定上下文不能为空。','JEV_EMPTY');
  if(!questions||typeof questions!=='object'||Array.isArray(questions))throw transportError('判定问题无效。','JEV_QUESTIONS');
  const names=Object.keys(questions);
  if(!names.length||names.length>16)throw transportError('判定问题须为 1–16 个。','JEV_QUESTIONS');
  for(const name of names){const q=questions[name];if(!q||typeof q!=='object'||Array.isArray(q)||!['choice','score','noul'].includes(q.type)||typeof q.instructions!=='string'||!q.instructions.trim())throw transportError(`判定问题 ${name} 无效。`,'JEV_QUESTIONS');}
  return {state,questions,names};
}
function jevAnswers(names,questions,raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw transportError('判定服务返回结构无效。','JEV_FORMAT');
  const answers={};
  for(const name of names)answers[name]=normalizeJevAnswer(name,questions[name],raw[name]);
  return {answers};
}
// Jev（Requesty）判定协议：一次请求带 1–16 个问题，回答为 {问题名: 答案}；答案形状按问题类型校验。
async function performJev(service,payload,options={}){
  const {signal}=options;
  const {state,questions,names}=jevPayload(payload);
  const body={model:service.model,messages:[{role:'user',content:state}],response_format:{type:'questions',questions},stream:false};
  const url=appendPath(serviceBase(service),'chat/completions');
  const response=await checkedFetch(url,{method:'POST',signal,body:JSON.stringify(body)},service,'jev');
  const value=await jsonResponse(response);responseError(value);
  emitUsage(options,usageExtractors.jev(value));
  const content=value?.choices?.[0]?.message?.content;
  const text=typeof content==='string'?content:Array.isArray(content)?content.map(part=>typeof part==='string'?part:part?.text||'').join(''):'';
  let parsed;try{parsed=JSON.parse(text);}catch{throw transportError('判定服务返回了无效 JSON。','JEV_FORMAT');}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw transportError('判定服务返回结构无效。','JEV_FORMAT');
  return jevAnswers(names,questions,parsed);
}
// System One（SiliconFlow）判定端点：TypeSafe 原生形状，state 直传、answers 按键回填类型化结果。
async function performSystemOne(service,payload,options={}){
  const {signal}=options;
  const {state,questions,names}=jevPayload(payload);
  const body={model:service.model,state,questions};
  const url=appendPath(serviceBase(service),'systemone');
  const response=await checkedFetch(url,{method:'POST',signal,body:JSON.stringify(body)},service,'systemone');
  const value=await jsonResponse(response);responseError(value);
  emitUsage(options,usageExtractors.systemone(value));
  return jevAnswers(names,questions,value?.answers);
}
export async function performProviderRequest(service,payload,instructions,schema,{signal,onContent,beforeRequest,onUsage}={}){const provider=providerFor(service);if(!service?.model?.trim())throw transportError('模型 ID 不能为空。','MODEL_REQUIRED');ensureNoForcedReasoning(service);const options={signal,onContent,onUsage};const protocol=service.providerId==='azure'?(service.options?.apiMode==='chat'?'chat':'responses'):provider.protocol;if(protocol==='chat'||protocol==='responses'){await beforeRequest?.();aborted(signal);options.outputMode=await outputMode(service,protocol,signal,onUsage);}await beforeRequest?.();aborted(signal);switch(protocol){case 'chat':return performChat(service,payload,instructions,schema,options);case 'responses':return performResponses(service,payload,instructions,schema,options);case 'anthropic':return performAnthropic(service,payload,instructions,schema,options);case 'google':return performGoogle(service,payload,instructions,schema,options);case 'bedrock':return performBedrock(service,payload,instructions,schema,options);case 'cohere':return performCohere(service,payload,instructions,schema,options);case 'ollama':return performOllama(service,payload,instructions,schema,options);case 'replicate':return performReplicate(service,payload,instructions,schema,options);case 'jev':return performJev(service,payload,options);case 'systemone':return performSystemOne(service,payload,options);default:throw transportError('不支持的 API 协议。','PROVIDER_UNSUPPORTED');}}

function modelsBase(service){const base=serviceBase(service),url=new URL(base.href);url.search='';url.hash='';url.pathname=cleanPath(url.pathname).replace(/\/(?:chat\/completions|responses|messages|v2\/chat|api\/chat)$/i,'');return url;}
function normalizedModels(items,idOf,nameOf=idOf){const seen=new Set(),models=[];for(const item of items||[]){const id=idOf(item);if(typeof id!=='string'||!id.trim()||seen.has(id))continue;seen.add(id);const name=nameOf(item);models.push({id,name:typeof name==='string'&&name.trim()?name:id});}return models.sort((a,b)=>a.name.localeCompare(b.name));}
export async function listProviderModels(service,{signal}={}){const provider=providerFor(service),protocol=service.providerId==='azure'?(service.options?.apiMode==='chat'?'chat':'responses'):provider.protocol;if(service.providerId==='azure'||protocol==='bedrock'||protocol==='responses'&&service.providerId==='open-responses')unsupportedModels();let url,parse;
  if(protocol==='google'){url=appendPath(modelsBase(service),'models');parse=value=>normalizedModels(value.models,item=>(item.name||'').replace(/^models\//,''),item=>item.displayName||item.name);}
  else if(protocol==='anthropic'){url=appendPath(modelsBase(service),'models');parse=value=>normalizedModels(value.data,item=>item.id,item=>item.display_name||item.id);}
  else if(protocol==='cohere'){url=new URL('/v1/models',serviceBase(service));parse=value=>normalizedModels(value.models,item=>item.name,item=>item.name);}
  else if(protocol==='ollama'){url=appendPath(modelsBase(service),/\/api$/i.test(cleanPath(modelsBase(service).pathname))?'tags':'api/tags');parse=value=>normalizedModels(value.models,item=>item.model||item.name,item=>item.name||item.model);}
  else if(protocol==='replicate'){url=appendPath(modelsBase(service),/\/v1$/i.test(cleanPath(modelsBase(service).pathname))?'models':'v1/models');parse=value=>normalizedModels(value.results,item=>item.owner&&item.name?`${item.owner}/${item.name}`:item.name,item=>item.owner&&item.name?`${item.owner}/${item.name}`:item.name);}
  else {url=appendPath(modelsBase(service),'models');parse=value=>normalizedModels(value.data,item=>item.id,item=>item.name||item.id);}
  const response=await checkedFetch(url,{method:'GET',signal},service,protocol),value=await jsonResponse(response);responseError(value);return parse(value);
}
