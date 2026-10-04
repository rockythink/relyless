import {EventEmitter} from 'node:events';
import {createHash,createPublicKey,randomBytes,randomUUID,verify} from 'node:crypto';
import {createServer} from 'node:http';
import {chmod,mkdir,open,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {
  SOURCE_DATA_INSTRUCTIONS,SUPPORT_INSTRUCTIONS,SUPPORT_CORRECTION_INSTRUCTIONS,normalizeSupportProviderItems,inspectSupportResponse,normalizeSupportCorrections,normalizePreparationContext,
  ASSISTANCE_INSTRUCTIONS,normalizeAssistanceRequest,normalizeAssistanceResult,
  EMERGENCY_INSTRUCTIONS,PAGE_TRANSLATION_INSTRUCTIONS,normalizeEmergencyItems,normalizeEmergencyResult,normalizePageTranslationItems,inspectPageTranslationResult,
  CONVERSATION_INSTRUCTIONS,normalizeConversationResult,
} from '../extension/gloss.mjs';
import {SENTENCE_GROUPS_INSTRUCTIONS,normalizeSentenceGroupItems,prepareSentenceGroupItems,normalizeSentenceGroupResponse} from '../extension/sentence-groups.mjs';
import {SUMMARY_INSTRUCTIONS,PERSONALIZATION_INSTRUCTIONS} from '../extension/personalization.mjs';
import {assistanceProgress,translationProgress,conversationProgress} from '../extension/assistance-stream.mjs';
import {diagnosticError} from '../extension/diagnostics.mjs';

const AUTH='https://auth.openai.com';
const API='https://api.openai.com/v1';
const SCOPES='openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const MAX_OUTPUT=24_000;
const MAX_STREAM=2_000_000;
const CONVERSATION_LIMIT=50;
const CONVERSATION_TTL=30*60_000;
const DOMAINS=new Set(['general','tech','data','finance','medical','legal','design']);
const base64url=value=>Buffer.from(value).toString('base64url');
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const authError=(message,code='AUTH')=>Object.assign(new Error(message),{code});
const requestError=(message,code,status)=>Object.assign(new Error(message),{code,detail:status?{httpStatus:status}:{}});
const CLASSIFIER_INSTRUCTIONS=`${SOURCE_DATA_INSTRUCTIONS}\nClassify the supplied page title and excerpt as exactly one of general, tech, data, finance, medical, legal, design. Return only JSON {"domain":"..."}.`;

async function jsonResponse(response,limit=1_000_000) {
  const text=await response.text();
  if(text.length>limit)throw requestError('服务响应过大。','OUTPUT_INVALID',response.status);
  try{return JSON.parse(text);}catch{throw requestError('服务返回无效 JSON。','OUTPUT_INVALID',response.status);}
}
function errorFor(response,body) {
  const code=typeof body?.error?.code==='string'?body.error.code:'';
  if(code==='subscription_sharing_usage_limit_exceeded'||response.status===429)return requestError('ChatGPT 订阅在此应用的使用额度已达上限，请在 ChatGPT 设置中查看用量。','RATE_LIMIT',response.status);
  if(code==='subscription_sharing_user_not_eligible')return requestError('此 ChatGPT 账户或工作区无法使用订阅共享。','AUTH',response.status);
  if(response.status===401||code==='subscription_sharing_invalid_user')return authError('ChatGPT 授权已失效，请重新登录。');
  if(response.status===403)return requestError('ChatGPT 订阅授权或地区策略拒绝了请求。','AUTH',response.status);
  if(response.status===400)return requestError('ChatGPT 不支持此请求或模型，请刷新模型列表。','OUTPUT_INVALID',response.status);
  return requestError('ChatGPT 服务暂时不可用，请稍后重试。',response.status>=500?'HTTP':'NATIVE_RPC',response.status);
}
function preferences(value){
  if(value==null)return null;
  if(!object(value)||Object.keys(value).length!==3||!['concise','standard'].includes(value.detail)||!['consistent','contextual'].includes(value.terminology)||!['meaning','usage'].includes(value.focus))throw new Error('个性化翻译偏好无效。');
  return value;
}
async function savePrivate(path,value){
  const temporary=`${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {await writeFile(temporary,JSON.stringify(value),{mode:0o600});await chmod(temporary,0o600);await rename(temporary,path);}catch(error){await rm(temporary,{force:true}).catch(()=>{});throw error;}
}
function decodeJwtPart(value){try{return JSON.parse(Buffer.from(value,'base64url').toString('utf8'));}catch{throw authError('ChatGPT 身份令牌格式无效。');}}

export class SiwcClient extends EventEmitter {
  constructor({dataDir,fetchImpl=fetch,timeoutMs=90_000,diagnostic=null,serverFactory=createServer}={}){
    super();
    if(!dataDir)throw new TypeError('dataDir 为必填项');
    this.dataDir=resolve(dataDir);this.credentialsPath=join(this.dataDir,'siwc.json');
    this.fetch=fetchImpl;this.timeoutMs=timeoutMs;this.diagnostic=diagnostic;this.serverFactory=serverFactory;
    this.state=null;this.started=null;this.pending=null;this.refreshing=null;this.generation=0;
    this.activeRequests=new Set();this.conversations=new Map();this.modelCache=null;this.stopping=false;this.loginError=null;
  }
  #record(operation,stage,status,code,detail={}){try{Promise.resolve(this.diagnostic?.({at:Date.now(),provider:'chatgpt',operation,stage,status,code,...detail})).catch(()=>{});}catch{}}
  async start(){
    if(this.started)return this.started;
    this.started=(async()=>{
      await mkdir(this.dataDir,{recursive:true,mode:0o700});
      let saved;
      try{saved=JSON.parse(await readFile(this.credentialsPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw authError('本机 ChatGPT 授权记录不可读取；请检查连接器数据。');}
      if(saved!==undefined&&(!object(saved)||!/^urn:uuid:[0-9a-f-]{36}$/.test(saved.hostId)||!object(saved.accounts)||typeof saved.active!=='string'))throw authError('本机 ChatGPT 授权记录无效；请检查连接器数据。');
      this.state=saved??{hostId:`urn:uuid:${randomUUID()}`,active:'',accounts:{}};
      if(!saved)await savePrivate(this.credentialsPath,this.state);
      this.emit('status',this.status());
    })();
    try{await this.started;}catch(error){this.started=null;throw error;}
  }
  #account(){return this.state?.accounts?.[this.state.active]??null;}
  status(){const account=this.#account();return{connected:!this.stopping,authenticated:Boolean(account?.access_token&&account?.scopes?.includes('chatgpt.tokens.use.direct')),email:account?.email??null,plan:null,loginPending:Boolean(this.pending),error:this.loginError,features:['conversation']};}
  async refreshStatus(){await this.start();this.emit('status',this.status());return this.status();}
  async #request(url,options={}){return this.fetch(url,{redirect:'error',...options});}
  async #discovery(){
    const response=await this.#request(`${AUTH}/.well-known/openid-configuration`,{signal:AbortSignal.timeout(15_000)});
    if(!response.ok)throw authError('无法验证 ChatGPT 身份服务。');
    const doc=await jsonResponse(response);
    if(doc.issuer!==AUTH||typeof doc.jwks_uri!=='string'||!doc.jwks_uri.startsWith(AUTH+'/')||doc.revocation_endpoint!=null&&(typeof doc.revocation_endpoint!=='string'||!doc.revocation_endpoint.startsWith(AUTH+'/')))throw authError('ChatGPT 身份服务配置无效。');
    return doc;
  }
  async #identity(token,clientId,nonce){
    if(typeof token!=='string'||token.length>20_000)throw authError('ChatGPT 身份令牌无效。');
    const parts=token.split('.');if(parts.length!==3)throw authError('ChatGPT 身份令牌无效。');
    const header=decodeJwtPart(parts[0]),claims=decodeJwtPart(parts[1]);
    if(header.alg!=='RS256'||typeof header.kid!=='string'||!header.kid||claims.iss!==AUTH||!(claims.aud===clientId||Array.isArray(claims.aud)&&claims.aud.includes(clientId))||nonce!=null&&claims.nonce!==nonce||typeof claims.sub!=='string'||!claims.sub||!Number.isSafeInteger(claims.exp)||claims.exp<=Date.now()/1000-60)throw authError('ChatGPT 身份验证失败。');
    const discovery=await this.#discovery();
    const response=await this.#request(discovery.jwks_uri,{signal:AbortSignal.timeout(15_000)});
    if(!response.ok)throw authError('无法获取 ChatGPT 身份公钥。');
    const jwks=await jsonResponse(response),jwk=jwks.keys?.find(key=>key.kid===header.kid&&key.kty==='RSA'&&(!key.use||key.use==='sig'));
    if(!jwk||!verify('RSA-SHA256',Buffer.from(`${parts[0]}.${parts[1]}`),createPublicKey({key:jwk,format:'jwk'}),Buffer.from(parts[2],'base64url')))throw authError('ChatGPT 身份签名无效。');
    return claims;
  }
  async #token(form){
    const response=await this.#request(`${AUTH}/api/accounts/oauth/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(form),signal:AbortSignal.timeout(20_000)});
    const body=await jsonResponse(response);
    if(!response.ok)throw authError(response.status===400?'ChatGPT 授权已过期，请重新登录。':'ChatGPT 授权服务暂不可用。');
    if(typeof body.access_token!=='string'||typeof body.refresh_token!=='string'||typeof body.id_token!=='string'||!Number.isSafeInteger(body.expires_in)||body.expires_in<1||typeof body.scope!=='string')throw authError('ChatGPT 授权响应无效。');
    return body;
  }
  async login(){
    await this.start();
    if(this.pending)throw authError('ChatGPT 登录正在进行中。');
    const previous=this.#account(),clientId=previous?.client_id??'dynamic_agent_client';
    const state=base64url(randomBytes(32)),nonce=base64url(randomBytes(32)),verifier=base64url(randomBytes(32));
    const server=this.serverFactory((request,response)=>{void this.#callback(request,response).catch(()=>{response.writeHead(400,{'Content-Type':'text/plain; charset=utf-8'}).end('Authorization failed.');});});
    try{await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok);});}catch{throw authError('无法启动本机 ChatGPT 登录回调。');}
    const port=server.address().port,redirectUri=`http://127.0.0.1:${port}/auth/callback`;
    const timer=setTimeout(()=>void this.cancelLogin(),5*60_000);timer.unref?.();
    this.pending={server,timer,state,nonce,verifier,redirectUri,clientId,previous};
    const url=new URL(`${AUTH}/api/accounts/authorize`);
    const values={client_id:clientId,ext_agent_host_id:this.state.hostId,response_type:'code',redirect_uri:redirectUri,scope:SCOPES,resource:API,state,nonce,code_challenge_method:'S256',code_challenge:base64url(createHash('sha256').update(verifier).digest())};
    if(previous?.email)values.login_hint=previous.email;
    else values.agent_name_hint='RelyLess';
    for(const [key,value] of Object.entries(values))url.searchParams.set(key,value);
    this.emit('status',this.status());
    return{authUrl:url.href};
  }
  async #callback(request,response){
    const pending=this.pending;
    if(!pending||pending.processing||request.socket.remoteAddress!=='127.0.0.1'||request.headers.host!==`127.0.0.1:${new URL(pending.redirectUri).port}`||request.method!=='GET')return response.writeHead(404).end();
    let url;try{url=new URL(request.url,pending.redirectUri);}catch{return response.writeHead(400).end();}
    if(url.pathname!=='/auth/callback'||url.searchParams.get('state')!==pending.state)return response.writeHead(400).end('Authorization rejected.');
    const finish=(status,text)=>{response.writeHead(status,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer'}).end(text);};
    if(url.searchParams.has('error')){this.loginError='ChatGPT 授权未完成。';await this.cancelLogin();return finish(400,'Authorization cancelled.');}
    const issued=url.searchParams.get('client_id')||pending.previous?.client_id;
    if(!url.searchParams.get('code')||!/^oaiapp_[A-Za-z0-9_-]{3,256}$/.test(issued||'')||pending.previous&&issued!==pending.previous.client_id){await this.cancelLogin();return finish(400,'Authorization invalid.');}
    pending.processing=true;
    try{
      const tokens=await this.#token({grant_type:'authorization_code',client_id:issued,code:url.searchParams.get('code'),code_verifier:pending.verifier,redirect_uri:pending.redirectUri,resource:API});
      const identity=await this.#identity(tokens.id_token,issued,pending.nonce);
      if(pending.previous&&identity.sub!==pending.previous.subject)throw authError('ChatGPT 账户与原授权不一致。');
      const granted=tokens.scope.split(' ');
      if(!granted.includes('chatgpt.tokens.use.direct'))throw authError('ChatGPT 未授权订阅用量，请重新授权。');
      const account={client_id:issued,subject:identity.sub,email:typeof identity.email==='string'?identity.email.slice(0,320):'',id_token:tokens.id_token,access_token:tokens.access_token,refresh_token:tokens.refresh_token,scopes:granted,expires_at:Date.now()+tokens.expires_in*1000};
      const next={...this.state,active:issued,accounts:{...this.state.accounts,[issued]:account}};
      await savePrivate(this.credentialsPath,next);
      this.state=next;this.generation++;this.modelCache=null;this.conversations.clear();this.loginError=null;
      this.emit('status',this.status());
      finish(200,'RelyLess ChatGPT authorization complete. You may close this tab.');
    }catch(error){this.loginError=error.message;finish(400,'Authorization failed. Return to RelyLess and try again.');}
    finally{await this.cancelLogin();}
  }
  async cancelLogin(){
    const pending=this.pending;this.pending=null;
    if(pending){clearTimeout(pending.timer);pending.server.close();}
    this.emit('status',this.status());return this.status();
  }
  async logout(){
    await this.start();await this.cancelLogin();
    const account=this.#account();
    let revoked=true;
    if(account?.refresh_token){try{const doc=await this.#discovery();if(!doc.revocation_endpoint)throw new Error('No revocation endpoint');const response=await this.#request(doc.revocation_endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:account.refresh_token,token_type_hint:'refresh_token',client_id:account.client_id}),signal:AbortSignal.timeout(15_000)});revoked=response.ok;}catch{revoked=false;}}
    if(account){const next={...this.state,accounts:{...this.state.accounts,[account.client_id]:{client_id:account.client_id,subject:account.subject,email:account.email}}};await savePrivate(this.credentialsPath,next);this.state=next;}
    this.generation++;this.conversations.clear();this.modelCache=null;
    for(const controller of this.activeRequests)controller.abort();
    this.emit('status',this.status());
    if(!revoked)throw authError('本机已退出 ChatGPT；远程撤销未确认。请在 ChatGPT 设置中断开此应用。');
    return this.status();
  }
  async #accessToken(){
    await this.start();let account=this.#account();
    if(!account?.scopes?.includes('chatgpt.tokens.use.direct')||!account.access_token)throw authError('请先登录并授权 ChatGPT 订阅用量。');
    if(account.expires_at>Date.now()+60_000)return account.access_token;
    if(!this.refreshing)this.refreshing=(async()=>{
      const clientId=account.client_id,lockPath=this.credentialsPath+'.lock';
      let lock;
      for(let attempt=0;attempt<100;attempt++){
        try{lock=await open(lockPath,'wx',0o600);break;}
        catch(error){if(error.code!=='EEXIST')throw error;await new Promise(done=>setTimeout(done,100));}
      }
      if(!lock)throw authError('ChatGPT 登录数据正由另一连接器更新，请稍后重试。');
      try{
        const saved=JSON.parse(await readFile(this.credentialsPath,'utf8'));
        account=saved?.accounts?.[clientId];
        if(saved.active!==clientId||!account?.refresh_token)throw authError('账户已切换，请重新请求。');
        if(account.expires_at>Date.now()+60_000){this.state=saved;return account.access_token;}
        const tokens=await this.#token({grant_type:'refresh_token',client_id:clientId,refresh_token:account.refresh_token,resource:API});
        if(this.#account()?.client_id!==clientId)throw authError('账户已切换，请重新请求。');
        const identity=await this.#identity(tokens.id_token,clientId,null);
        if(identity.sub!==account.subject||!tokens.scope.split(' ').includes('chatgpt.tokens.use.direct'))throw authError('ChatGPT 账户或订阅授权已变化，请重新登录。');
        const nextAccount={...account,access_token:tokens.access_token,refresh_token:tokens.refresh_token,id_token:tokens.id_token,scopes:tokens.scope.split(' '),expires_at:Date.now()+tokens.expires_in*1000};
        const next={...saved,accounts:{...saved.accounts,[clientId]:nextAccount}};
        await savePrivate(this.credentialsPath,next);this.state=next;this.emit('status',this.status());
        return nextAccount.access_token;
      }finally{await lock.close();await rm(lockPath,{force:true});}
    })().finally(()=>{this.refreshing=null;});
    return this.refreshing;
  }
  async listModels({refresh=false}={}){
    if(!refresh&&this.modelCache)return this.modelCache.map(item=>({...item}));
    const token=await this.#accessToken();
    const response=await this.#request(`${API}/models`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(20_000)});
    const body=await jsonResponse(response);
    if(!response.ok)throw errorFor(response,body);
    if(!Array.isArray(body.models))throw requestError('ChatGPT 模型列表无效。','OUTPUT_INVALID');
    const models=body.models.filter(item=>item?.visibility==='list'&&typeof item.slug==='string'&&item.slug.length<=200&&typeof item.display_name==='string').slice(0,256).map((item,index)=>({id:item.slug,name:item.display_name.slice(0,200),isDefault:index===0}));
    if(!models.length)throw authError('此 ChatGPT 账户没有可用的订阅模型。');
    this.modelCache=models;return models.map(item=>({...item}));
  }
  async #model(model){const models=await this.listModels();const selected=model?models.find(item=>item.id===model):models[0];if(!selected)throw requestError('所选 ChatGPT 模型不可用，请刷新模型列表。','OUTPUT_INVALID');return selected.id;}
  async #infer({operation,traceId,model,instructions,input,parse,raw=false,onProgress,progress}){
    const selected=await this.#model(model),token=await this.#accessToken(),generation=this.generation,controller=new AbortController();
    this.activeRequests.add(controller);
    const timer=setTimeout(()=>controller.abort(),this.timeoutMs);timer.unref?.();
    const started=Date.now();this.#record(operation,'provider','start','NATIVE_START');
    try{
      const response=await this.#request(`${API}/responses`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({model:selected,instructions,input:Array.isArray(input)?input:[{role:'user',content:JSON.stringify(input)}],store:false,stream:true}),signal:controller.signal});
      if(!response.ok)throw errorFor(response,await jsonResponse(response));
      if(!response.body)throw requestError('ChatGPT 未返回响应流。','OUTPUT_INVALID');
      const decoder=new TextDecoder();let buffer='',text='',total=0,completed=false;
      for await(const chunk of response.body){
        if(generation!==this.generation)throw authError('账户已切换，请重新请求。');
        total+=chunk.byteLength;if(total>MAX_STREAM)throw requestError('ChatGPT 响应流过大。','OUTPUT_INVALID');
        buffer+=decoder.decode(chunk,{stream:true});
        for(let boundary;(boundary=buffer.search(/\r?\n\r?\n/))>=0;){
          const separator=buffer.slice(boundary).match(/^\r?\n\r?\n/)[0];
          const block=buffer.slice(0,boundary);buffer=buffer.slice(boundary+separator.length);
          const data=block.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
          if(!data||data==='[DONE]')continue;
          let event;try{event=JSON.parse(data);}catch{throw requestError('ChatGPT 响应流格式无效。','OUTPUT_INVALID');}
          if(event.type==='response.output_text.delta'){
            if(typeof event.delta!=='string'||text.length+event.delta.length>MAX_OUTPUT)throw requestError('ChatGPT 返回内容过长。','OUTPUT_INVALID');
            text+=event.delta;
            if(onProgress&&progress){const partial=progress(text);if(partial&&Object.keys(partial).length)try{onProgress(partial);}catch{}}
          }else if(event.type==='response.failed')throw errorFor({status:typeof event.response?.error?.status==='number'?event.response.error.status:503},{error:event.response?.error});
          else if(event.type==='response.incomplete')throw requestError('ChatGPT 响应未完成，请重试。','OUTPUT_INVALID');
          else if(event.type==='response.completed')completed=true;
        }
      }
      if(!completed||!text)throw requestError('ChatGPT 响应中断或为空，请重试。','OUTPUT_INVALID');
      let value=text;
      if(!raw)try{value=JSON.parse(text);}catch{throw requestError('ChatGPT 返回的结构化结果无效。','OUTPUT_INVALID');}
      const result=parse(value,text);
      this.#record(operation,'provider','ok','OK',{durationMs:Date.now()-started,...(traceId?{traceId}:{})});
      return result;
    }catch(error){this.#record(operation,'provider','error',diagnosticError(error).code,{durationMs:Date.now()-started});if(error.name==='AbortError')throw requestError('ChatGPT 请求超时或已取消。','TIMEOUT');throw error;}
    finally{clearTimeout(timer);this.activeRequests.delete(controller);}
  }
  async classify({text,title='',model=''},{traceId}={}){
    if(typeof text!=='string'||!text.trim()||text.length>6000||typeof title!=='string'||title.length>1000)throw new Error('分类内容无效。');
    return this.#infer({operation:'RESOLVE_DOMAIN',traceId,model,instructions:CLASSIFIER_INSTRUCTIONS,input:{title,source:text},parse:value=>{if(!DOMAINS.has(value?.domain))throw new Error('分类格式无效。');return{domain:value.domain,source:'chatgpt'};}});
  }
  async supportBatch({items,model='',article,personalization,corrections=[]},{traceId}={}){
    const selected=normalizeSupportProviderItems(items),context=normalizePreparationContext(article),prefs=preferences(personalization),issues=normalizeSupportCorrections(corrections,selected);
    const prepared=selected.map(item=>({...item,candidates:item.candidates.map(({text,evidence,knownSenses})=>({text,...(evidence?{evidence}:{}),...(knownSenses?{knownSenses}:{})}))}));
    return this.#infer({operation:'SUPPORT_BATCH',traceId,model,instructions:issues.length?SUPPORT_CORRECTION_INSTRUCTIONS:SUPPORT_INSTRUCTIONS,input:{items:prepared,article:context,...(issues.length?{corrections:issues}:{}),...(prefs?{personalization:prefs}:{})},parse:value=>inspectSupportResponse(value,selected,context)});
  }
  async assist({model='',personalization,...request},{traceId,onProgress}={}){
    const selected=normalizeAssistanceRequest(request),prefs=preferences(personalization);
    return this.#infer({operation:'ASSIST',traceId,model,instructions:ASSISTANCE_INSTRUCTIONS+'\nReturn only JSON with the assistance object in result.',input:{...selected,...(prefs?{personalization:prefs}:{})},parse:value=>{if(!object(value)||Object.keys(value).length!==1||!object(value.result))throw new Error('帮助结果格式无效。');return normalizeAssistanceResult(value.result,selected);},onProgress,progress:text=>assistanceProgress(text,selected,{envelope:'result'})});
  }
  async sentenceGroups({items,model=''},{traceId}={}){
    const selected=normalizeSentenceGroupItems(items);
    return this.#infer({operation:'SENTENCE_GROUPS_BATCH',traceId,model,instructions:SENTENCE_GROUPS_INSTRUCTIONS,input:{items:prepareSentenceGroupItems(selected)},parse:value=>normalizeSentenceGroupResponse(value,selected)});
  }
  async emergencyTranslate({scope,items,model='',personalization},{traceId,onProgress}={}){
    if(scope!=='page'&&scope!=='passage')throw new Error('翻译范围无效。');
    const page=scope==='page',selected=page?normalizePageTranslationItems(items):normalizeEmergencyItems(items),prefs=preferences(personalization);
    return this.#infer({operation:'EMERGENCY_TRANSLATE',traceId,model,instructions:page?PAGE_TRANSLATION_INSTRUCTIONS:EMERGENCY_INSTRUCTIONS,input:{items:selected,...(prefs?{personalization:prefs}:{})},raw:page,parse:(value,text)=>page?inspectPageTranslationResult(text,selected):normalizeEmergencyResult(value,selected),onProgress:page?null:onProgress,progress:text=>translationProgress(text,selected)});
  }
  async historyModel({kind,payload,model=''},{traceId}={}){
    if(!['summary','personalization'].includes(kind)||!object(payload))throw new Error('历史模型请求无效。');
    return this.#infer({operation:kind==='summary'?'HISTORY_SUMMARY':'PERSONALIZATION_ANALYZE',traceId,model,instructions:kind==='summary'?SUMMARY_INSTRUCTIONS:PERSONALIZATION_INSTRUCTIONS,input:payload,parse:value=>{if(!object(value))throw new Error('历史模型结果无效。');return value;}});
  }
  async conversationTurn({conversationId,question,setup,model=''},{traceId,onProgress}={}){
    if(typeof conversationId!=='string'||!/^[0-9a-f-]{8,80}$/i.test(conversationId)||typeof question!=='string'||!question.trim()||question.length>300||setup!=null&&!object(setup))throw new Error('追问请求无效。');
    const now=Date.now();for(const [id,entry] of this.conversations)if(now-entry.at>CONVERSATION_TTL)this.conversations.delete(id);
    const previous=this.conversations.get(conversationId);
    const original=previous?.setup??setup;
    if(!original)throw new Error('追问会话已过期，请重新发起。');
    const turns=previous?.turns??[];
    const payload={...original,question:question.trim(),history:[...(Array.isArray(original.history)?original.history:[]),...turns].slice(-12)};
    const result=await this.#infer({operation:'CONVERSATION_ASK',traceId,model,instructions:CONVERSATION_INSTRUCTIONS,input:payload,parse:value=>normalizeConversationResult(value),onProgress,progress:conversationProgress});
    this.conversations.delete(conversationId);
    this.conversations.set(conversationId,{setup:original,turns:[...turns,{question:question.trim(),answer:result.answer}].slice(-12),at:Date.now()});
    while(this.conversations.size>CONVERSATION_LIMIT)this.conversations.delete(this.conversations.keys().next().value);
    return result;
  }
  async close(){this.stopping=true;await this.cancelLogin();for(const controller of this.activeRequests)controller.abort();this.conversations.clear();}
}
