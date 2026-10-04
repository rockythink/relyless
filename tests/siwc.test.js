import {test,expect} from 'bun:test';
import {generateKeyPairSync,sign} from 'node:crypto';
import {chmod,mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {spawn,spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {SiwcClient} from '../connector/siwc.mjs';

const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk=publicKey.export({format:'jwk'});
const clientId='oaiapp_fixture123';
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const idToken=(nonce,sub='user-1')=>{
  const head=encode({alg:'RS256',kid:'fixture'});
  const body=encode({iss:'https://auth.openai.com',aud:clientId,nonce,sub,email:'user@example.test',exp:Math.floor(Date.now()/1000)+3600});
  return `${head}.${body}.${sign('RSA-SHA256',Buffer.from(`${head}.${body}`),privateKey).toString('base64url')}`;
};
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const sse=(value,{terminal='response.completed',lineEnd='\r\n',split=false}={})=>{
  const text=JSON.stringify(value),middle=Math.ceil(text.length/2);
  const events=[...(!split?[{type:'response.output_text.delta',delta:text}]:[{type:'response.output_text.delta',delta:text.slice(0,middle)},{type:'response.output_text.delta',delta:text.slice(middle)}]),{type:terminal,response:terminal==='response.failed'?{error:{code:'subscription_sharing_usage_limit_exceeded'}}:{}}];
  return new Response(events.map(item=>`data: ${JSON.stringify(item)}${lineEnd}${lineEnd}`).join(''),{headers:{'Content-Type':'text/event-stream'}});
};
async function fixture({reply=()=>({domain:'tech'}),tokenScope='openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',identityNonce=null,override}={}){
  const dir=await mkdtemp(join(tmpdir(),'relyless-siwc-'));
  const requests=[];let tokenCount=0;
  const fetchImpl=async(url,init={})=>{
    const target=new URL(url);requests.push({url:target.pathname,init});
    const custom=await override?.(target,init);if(custom!==undefined)return custom;
    if(target.pathname==='/.well-known/openid-configuration')return json({issuer:'https://auth.openai.com',jwks_uri:'https://auth.openai.com/keys',revocation_endpoint:'https://auth.openai.com/revoke'});
    if(target.pathname==='/keys')return json({keys:[{...jwk,kid:'fixture',use:'sig'}]});
    if(target.pathname==='/api/accounts/oauth/token'){
      tokenCount++;
      return json({access_token:`access-${tokenCount}`,refresh_token:`refresh-${tokenCount}`,id_token:idToken(identityNonce??fixture.nonce),expires_in:3600,scope:tokenScope});
    }
    if(target.pathname==='/revoke')return new Response(null,{status:200});
    if(target.pathname==='/v1/models')return json({models:[{slug:'fixture-model',display_name:'Fixture',visibility:'list'},{slug:'hidden',display_name:'Hidden',visibility:'hidden'}]});
    if(target.pathname==='/v1/responses')return sse(reply(JSON.parse(init.body)),{split:true});
    throw new Error('Unexpected route');
  };
  const client=new SiwcClient({dataDir:dir,fetchImpl});await client.start();
  const authorize=async()=>{
    const login=await client.login(),url=new URL(login.authUrl);
    fixture.nonce=url.searchParams.get('nonce');
    const callback=new URL(url.searchParams.get('redirect_uri'));
    callback.searchParams.set('state',url.searchParams.get('state'));
    callback.searchParams.set('client_id',clientId);
    callback.searchParams.set('code','fixture-code');
    const response=await fetch(callback);
    return {response,url};
  };
  return{client,dir,requests,authorize,close:async()=>{await client.close();await rm(dir,{recursive:true,force:true});}};
}

test('OAuth loopback validates state and identity before storing credentials; inference uses plan bearer',async()=>{
  const f=await fixture();
  try{
    const login=await f.client.login(),url=new URL(login.authUrl),redirect=new URL(url.searchParams.get('redirect_uri'));
    expect(url.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(url.searchParams.get('scope')).toContain('chatgpt.tokens.use.direct');
    expect(redirect.hostname).toBe('127.0.0.1');
    expect((await fetch(redirect+'?state=wrong&code=forged&client_id='+clientId)).status).toBe(400);
    expect(f.client.status().authenticated).toBe(false);
    fixture.nonce=url.searchParams.get('nonce');
    redirect.searchParams.set('state',url.searchParams.get('state'));
    redirect.searchParams.set('client_id',clientId);
    redirect.searchParams.set('code','fixture-code');
    expect((await fetch(redirect)).status).toBe(200);
    expect(f.client.status().authenticated).toBe(true);
    const saved=JSON.parse(await readFile(join(f.dir,'siwc.json'),'utf8'));
    expect(saved.accounts[clientId].refresh_token).toBe('refresh-1');
    if(process.platform!=='win32')expect((await stat(join(f.dir,'siwc.json'))).mode&0o777).toBe(0o600);
    expect(await f.client.classify({text:'Apache Flink processes streams.',model:'fixture-model'})).toEqual({domain:'tech',source:'chatgpt'});
    const inference=f.requests.find(item=>item.url==='/v1/responses');
    expect(inference.init.headers.Authorization).toBe('Bearer access-1');
    const body=JSON.parse(inference.init.body);
    expect(body).toMatchObject({store:false,stream:true,model:'fixture-model'});
    expect(body.input).toEqual([{role:'user',content:JSON.stringify({title:'',source:'Apache Flink processes streams.'})}]);
    expect(body).not.toHaveProperty('previous_response_id');
    expect(await f.client.listModels()).toEqual([{id:'fixture-model',name:'Fixture',isDefault:true}]);
  }finally{await f.close();}
});

test('missing plan permission cannot be treated as authenticated',async()=>{
  const f=await fixture({tokenScope:'openid profile email offline_access resource.invoke'});
  try{
    expect((await f.authorize()).response.status).toBe(400);
    expect(f.client.status().authenticated).toBe(false);
    await expect(f.client.listModels()).rejects.toThrow('授权');
  }finally{await f.close();}
});

test('a mismatched OIDC nonce rejects the callback without saving tokens',async()=>{
  const f=await fixture({identityNonce:'forged-nonce'});
  try{
    expect((await f.authorize()).response.status).toBe(400);
    expect(f.client.status().authenticated).toBe(false);
    expect(JSON.parse(await readFile(join(f.dir,'siwc.json'),'utf8')).accounts).toEqual({});
  }finally{await f.close();}
});

test('completed stream is required; failed plan usage is not shown as a translation',async()=>{
  const f=await fixture();
  try{
    await f.authorize();
    let calls=0;
    const previousFetch=f.client.fetch;
    f.client.fetch=async(url,init)=>{
      if(new URL(url).pathname==='/v1/responses'){
        calls++;
        return calls===1?sse({domain:'tech'},{terminal:'response.failed'}):sse({domain:'tech'},{terminal:'response.incomplete'});
      }
      return previousFetch(url,init);
    };
    await f.client.listModels();
    await expect(f.client.classify({text:'A valid excerpt.'})).rejects.toMatchObject({code:'RATE_LIMIT'});
    await expect(f.client.classify({text:'A valid excerpt.'})).rejects.toThrow('未完成');
  }finally{await f.close();}
});

test('a second conversation turn sends bounded prior context rather than a server response id',async()=>{
  const payloads=[];
  const f=await fixture({reply:body=>{payloads.push(JSON.parse(body.input[0].content));return{answer:'本句表示条件。'};}});
  try{
    await f.authorize();
    const setup={text:'unless',context:'Retry unless expired.',domain:'tech',kind:'word',level:'hint',history:[]};
    const first=await f.client.conversationTurn({conversationId:'face-0001',question:'什么意思？',setup});
    const second=await f.client.conversationTurn({conversationId:'face-0001',question:'再解释一次'});
    expect(first).toEqual({answer:'本句表示条件。'});
    expect(second).toEqual(first);
    expect(payloads[1].history).toEqual([{question:'什么意思？',answer:'本句表示条件。'}]);
    expect(payloads[1].context).toBe(setup.context);
  }finally{await f.close();}
});


test('expired credentials refresh once and persist rotated tokens before parallel inference',async()=>{
  const f=await fixture();
  try{
    await f.authorize();
    await f.client.listModels();
    const path=join(f.dir,'siwc.json'),saved=JSON.parse(await readFile(path,'utf8'));
    saved.accounts[clientId].expires_at=0;
    await writeFile(path,JSON.stringify(saved),{mode:0o600});
    f.client.state.accounts[clientId].expires_at=0;
    const answers=await Promise.all([f.client.classify({text:'Flink streams.'}),f.client.classify({text:'Spark batches.'})]);
    expect(answers).toEqual([{domain:'tech',source:'chatgpt'},{domain:'tech',source:'chatgpt'}]);
    expect(f.requests.filter(item=>item.url==='/api/accounts/oauth/token')).toHaveLength(2);
    expect(f.requests.filter(item=>item.url==='/v1/responses').map(item=>item.init.headers.Authorization)).toEqual(['Bearer access-2','Bearer access-2']);
    expect(JSON.parse(await readFile(path,'utf8')).accounts[clientId].refresh_token).toBe('refresh-2');
  }finally{await f.close();}
});

test('logout clears local credentials and the in-memory conversation after revocation',async()=>{
  const f=await fixture({reply:()=>({answer:'解释'})});
  try{
    await f.authorize();
    await f.client.conversationTurn({conversationId:'face-0002',question:'为什么？',setup:{text:'unless'}});
    expect(f.client.conversations.size).toBe(1);
    await f.client.logout();
    expect(f.client.status().authenticated).toBe(false);
    expect(f.client.conversations.size).toBe(0);
    expect(f.requests.some(item=>item.url==='/revoke')).toBe(true);
    expect(JSON.parse(await readFile(join(f.dir,'siwc.json'),'utf8')).accounts[clientId].refresh_token).toBeUndefined();
    await expect(f.client.classify({text:'A valid excerpt.'})).rejects.toThrow('登录');
  }finally{await f.close();}
});

test('page translation keeps per-item shape errors after a completed malformed response',async()=>{
  const f=await fixture({reply:()=> 'not json'});
  try{
    await f.authorize();
    const result=await f.client.emergencyTranslate({scope:'page',items:[{id:'p1',text:'A sentence.',context:{title:'',heading:'',before:'',after:''}}]});
    expect(result).toEqual({items:[],errors:[{id:'p1',code:'BATCH_SHAPE'}]});
  }finally{await f.close();}
});

test('a valid-looking delta without response.completed is never accepted',async()=>{
  const f=await fixture();
  try{
    await f.authorize();
    const before=f.client.fetch;
    f.client.fetch=(url,init)=>new URL(url).pathname==='/v1/responses'?new Response('data: '+JSON.stringify({type:'response.output_text.delta',delta:'{"domain":"tech"}'})+'\n\n',{headers:{'Content-Type':'text/event-stream'}}):before(url,init);
    await expect(f.client.classify({text:'Flink streams.'})).rejects.toMatchObject({code:'OUTPUT_INVALID'});
  }finally{await f.close();}
});

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const remainsPending=async promise=>expect(await Promise.race([promise.then(()=>false,()=>false),new Promise(done=>setTimeout(()=>done(true),40))])).toBe(true);
for(const action of ['cancelLogin','logout','close'])for(const revokeStatus of [200,503])test('owned callback cleanup '+action+' waits for revocation '+revokeStatus+' without retaining login ownership',async()=>{
  let paused=false;const entered=deferred(),gate=deferred(),revoking=deferred(),revokeGate=deferred();
  const f=await fixture({override:async(target,init)=>{if(paused&&target.pathname==='/keys'){entered.resolve();await gate.promise;}if(paused&&target.pathname==='/revoke'&&new URLSearchParams(init.body).get('token')==='refresh-2'){revoking.resolve();await revokeGate.promise;return new Response(null,{status:revokeStatus});}}});let outcome;
  try{await f.authorize();await f.client.cancelLogin();paused=true;const authorization=f.authorize();await entered.promise;outcome=f.client[action]().then(value=>({value}),error=>({error}));await remainsPending(outcome);expect(f.client.status().loginPending).toBe(false);
    gate.resolve();await revoking.promise;await remainsPending(outcome);if(action==='logout')expect(JSON.parse(await readFile(join(f.dir,'siwc.json'),'utf8')).accounts[clientId].refresh_token).toBeUndefined();
    revokeGate.resolve();const result=await outcome;expect((await authorization).response.status).toBe(400);
    if(revokeStatus===503)expect(result.error?.message).toContain('远程撤销未确认');else expect(result.error).toBeUndefined();
    if(action==='logout')expect(f.client.status().authenticated).toBe(false);
  }finally{gate.resolve();revokeGate.resolve();await outcome;await f.close();}
});

test('cancelLogin does not await an unrelated credential lock after its callback is discarded',async()=>{
  const entered=deferred(),gate=deferred();const f=await fixture({override:async target=>{if(target.pathname==='/keys'){entered.resolve();await gate.promise;}}});let outcome;
  const lock=join(f.dir,'siwc.json.lock');
  try{const authorization=f.authorize();await entered.promise;await writeFile(lock,JSON.stringify({pid:process.pid}),{mode:0o600});outcome=f.client.cancelLogin();await remainsPending(outcome);gate.resolve();await outcome;expect((await authorization).response.status).toBe(400);expect(JSON.parse(await readFile(lock,'utf8')).pid).toBe(process.pid);expect(f.requests.some(item=>item.url==='/revoke')).toBe(true);}
  finally{gate.resolve();await rm(lock,{force:true});await outcome;await f.close();}
});

test('close waits for detached cleanup and old revocation failure cannot overwrite a newer completed login',async()=>{
  const entered=deferred(),gate=deferred();let paused=true;const f=await fixture({override:async(target,init)=>{if(target.pathname==='/keys'&&paused){entered.resolve();await gate.promise;}if(target.pathname==='/revoke'&&new URLSearchParams(init.body).get('token')==='refresh-1')return new Response(null,{status:503});}});let cancelled,closing;
  try{const authorization=f.authorize();await entered.promise;cancelled=f.client.cancelLogin().then(value=>({value}),error=>({error}));await remainsPending(cancelled);paused=false;expect((await f.authorize()).response.status).toBe(200);await f.client.pending?.completion;expect(f.client.status().error).toBeNull();closing=f.client.close().then(value=>({value}),error=>({error}));await remainsPending(closing);gate.resolve();expect((await authorization).response.status).toBe(400);expect((await cancelled).error?.message).toContain('远程撤销未确认');expect((await closing).error?.message).toContain('远程撤销未确认');expect(f.client.status()).toMatchObject({authenticated:true,error:null});}
  finally{gate.resolve();await cancelled;await closing;await f.close();}
});

test('an expired login timer waits for cleanup failure without overwriting a fresh completed login',async()=>{
  const entered=deferred(),gate=deferred();let paused=true,expireLogin;const f=await fixture({override:async(target,init)=>{if(paused&&target.pathname==='/keys'){entered.resolve();await gate.promise;}if(target.pathname==='/revoke'&&new URLSearchParams(init.body).get('token')==='refresh-1')return new Response(null,{status:503});}}),timeout=globalThis.setTimeout;let oldCompletion;
  try{globalThis.setTimeout=(callback,ms,...args)=>{if(ms===5*60_000)expireLogin=callback;return timeout(callback,ms,...args);};const authorization=f.authorize();await entered.promise;globalThis.setTimeout=timeout;expect(typeof expireLogin).toBe('function');oldCompletion=f.client.pending.completion;expireLogin();await remainsPending(oldCompletion);expect(f.client.status().loginPending).toBe(false);paused=false;expect((await f.authorize()).response.status).toBe(200);await f.client.pending?.completion;gate.resolve();expect((await authorization).response.status).toBe(400);expect((await oldCompletion).unconfirmed).toBe(true);await new Promise(done=>timeout(done,0));expect(f.client.status()).toMatchObject({authenticated:true,error:null,loginPending:false});}
  finally{globalThis.setTimeout=timeout;gate.resolve();await oldCompletion;await f.close();}
});

test('callback completion settles when finishing the HTTP response throws',async()=>{
  const entered=deferred(),gate=deferred();const f=await fixture({override:async target=>{if(target.pathname==='/keys'){entered.resolve();await gate.promise;}}});const create=f.client.serverFactory;let outcome;
  f.client.serverFactory=callback=>create((request,response)=>{const write=response.writeHead.bind(response);let thrown=false;response.writeHead=(...args)=>{if(!thrown&&args[0]===400){thrown=true;throw new Error('Fixture response failure');}return write(...args);};callback(request,response);});
  try{const authorization=f.authorize();await entered.promise;outcome=f.client.cancelLogin();await remainsPending(outcome);gate.resolve();await outcome;expect((await authorization).response.status).toBe(400);expect(f.client.status().loginPending).toBe(false);expect(f.client.callbackCleanups.size).toBe(0);}
  finally{gate.resolve();await outcome;await f.close();}
});

test('callback cleanup deadline reports unconfirmed without retaining the cancelled attempt',async()=>{
  const entered=deferred(),gate=deferred();const f=await fixture({override:async target=>{if(target.pathname==='/keys'){entered.resolve();await gate.promise;}}});let outcome;
  try{const authorization=f.authorize();await entered.promise;outcome=f.client.cancelLogin(AbortSignal.timeout(80)).then(value=>({value}),error=>({error}));await remainsPending(outcome);expect((await outcome).error?.message).toContain('远程撤销未确认');expect(f.client.status().loginPending).toBe(false);gate.resolve();expect((await authorization).response.status).toBe(400);}
  finally{gate.resolve();await outcome;await f.close();}
});

test('logout preserves local sign-out when its overall callback cleanup budget expires',async()=>{
  let paused=false;const entered=deferred(),gate=deferred();const f=await fixture({override:async(target,init)=>{if(paused&&target.pathname==='/keys'){entered.resolve();await gate.promise;}if(init.signal?.aborted)throw init.signal.reason;}});let outcome;
  try{await f.authorize();await f.client.cancelLogin();paused=true;const authorization=f.authorize();await entered.promise;
    // Compress only this operation's overall deadline; restore before any asynchronous continuation.
    const timeout=AbortSignal.timeout;try{AbortSignal.timeout=ms=>timeout(ms===35_000?120:ms);outcome=f.client.logout().then(value=>({value}),error=>({error}));}finally{AbortSignal.timeout=timeout;}
    await remainsPending(outcome);const result=await outcome;expect(result.error?.message).toContain('本机已退出');expect(result.error?.message).toContain('远程撤销未确认');expect(f.client.status()).toMatchObject({authenticated:false,loginPending:false});expect(JSON.parse(await readFile(join(f.dir,'siwc.json'),'utf8')).accounts[clientId].refresh_token).toBeUndefined();gate.resolve();expect((await authorization).response.status).toBe(400);
  }finally{gate.resolve();await outcome;await f.close();}
});
async function expire(f){const path=join(f.dir,'siwc.json'),saved=JSON.parse(await readFile(path,'utf8'));saved.accounts[clientId].expires_at=0;await writeFile(path,JSON.stringify(saved),{mode:0o600});f.client.state.accounts[clientId].expires_at=0;}
for(const revokeStatus of [200,503])test('shared logout revokes discarded late grants and reports remote '+revokeStatus,async()=>{
  const entered=deferred(),gate=deferred();let paused=true,other;
  const f=await fixture({override:async target=>{if(target.pathname==='/keys'&&paused){entered.resolve();await gate.promise;}if(target.pathname==='/revoke')return new Response(null,{status:revokeStatus});}});
  try{const authorization=f.authorize();await entered.promise;other=new SiwcClient({dataDir:f.dir,fetchImpl:f.client.fetch});await other.start();await other.logout();paused=false;gate.resolve();
    const response=(await authorization).response;expect(response.status).toBe(400);expect(f.requests.filter(item=>item.url==='/revoke').map(item=>new URLSearchParams(item.init.body).get('token'))).toContain('refresh-1');
    expect(f.client.status().authenticated).toBe(false);expect(Object.values(JSON.parse(await readFile(join(f.dir,'siwc.json'),'utf8')).accounts).every(account=>!account.refresh_token&&!account.access_token)).toBe(true);
    if(revokeStatus===200)expect(f.client.status().error).toBeNull();else{expect(f.client.status().error).toContain('远程撤销未确认');expect(await response.text()).toContain('revocation was not confirmed');}
  }finally{gate.resolve();await other?.close();await f.close();}
});


for(const existing of [false,true])for(const stage of ['/api/accounts/oauth/token','/keys'])test('shared logout cancels an older '+(existing?'registered':'initial')+' OAuth callback at '+stage+' and permits a fresh login',async()=>{
  let paused=false;const entered=deferred(),gate=deferred();
  const f=await fixture({override:async target=>{if(paused&&target.pathname===stage){entered.resolve();await gate.promise;}}});let other,restored;
  try{
    if(existing)await f.authorize();paused=true;
    other=new SiwcClient({dataDir:f.dir,fetchImpl:f.client.fetch});await other.start();
    const authorization=f.authorize();await entered.promise;await other.logout();paused=false;gate.resolve();
    const response=(await authorization).response;expect(response.status).toBe(400);expect(await response.text()).toBe('Authorization cancelled.');
    expect(f.client.status()).toMatchObject({authenticated:false,loginPending:false});
    const saved=JSON.parse(await readFile(join(f.dir,'siwc.json'),'utf8'));expect(Object.values(saved.accounts).every(account=>!account.access_token&&!account.refresh_token)).toBe(true);
    restored=new SiwcClient({dataDir:f.dir,fetchImpl:f.client.fetch});await restored.start();expect(restored.status().authenticated).toBe(false);
    expect((await f.authorize()).response.status).toBe(200);expect(f.client.status().authenticated).toBe(true);
    expect(JSON.parse(await readFile(join(f.dir,'siwc.json'),'utf8')).accounts[clientId].refresh_token).toBe(existing?'refresh-3':'refresh-2');
  }finally{gate.resolve();await restored?.close();await other?.close();await f.close();}
});

test('a shared logout tombstone survives concurrent first startup in a real Node process',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'relyless-siwc-start-'));let child,exit,timer;const client=new SiwcClient({dataDir:dir});
  try{
    child=spawn('node',['-e',`const fs=require('node:fs/promises');const read=fs.readFile.bind(fs);let release;const gate=new Promise(r=>release=r);process.on('message',()=>release());fs.readFile=async(...args)=>{try{return await read(...args);}catch(error){if(String(args[0]).endsWith('siwc.json')&&error.code==='ENOENT'){process.send('missing');await gate;}throw error;}};(async()=>{const {SiwcClient}=await import(process.argv[1]);const client=new SiwcClient({dataDir:process.argv[2]});await client.start();process.send({hostId:client.state.hostId});await client.close();process.disconnect();})().catch(error=>{console.error(error);process.exit(1);});`,pathToFileURL(resolve('connector/siwc.mjs')).href,dir],{stdio:['ignore','ignore','pipe','ipc']});
    let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});exit=new Promise(done=>child.once('exit',done));
    await new Promise((done,fail)=>{timer=setTimeout(()=>fail(new Error('Startup did not pause')),5000);child.once('message',value=>{clearTimeout(timer);expect(value).toBe('missing');done();});});
    const childState=new Promise(done=>child.once('message',done));const logout=client.logout();
    await new Promise(done=>setTimeout(done,100));child.send('release');await logout;
    expect((await childState).hostId).toBe(client.state.hostId);expect(await exit).toBe(0);expect(stderr).toBe('');
    const saved=JSON.parse(await readFile(join(dir,'siwc.json'),'utf8'));expect(saved.hostId).toBe(client.state.hostId);expect(saved.authorizationEpoch).toBe(client.state.authorizationEpoch);expect(typeof saved.authorizationEpoch).toBe('string');
    const restored=new SiwcClient({dataDir:dir});try{await restored.start();expect(restored.state.authorizationEpoch).toBe(saved.authorizationEpoch);expect(restored.status().authenticated).toBe(false);}finally{await restored.close();}
  }finally{clearTimeout(timer);if(child?.exitCode===null){child.kill();await exit;}await client.close();await rm(dir,{recursive:true,force:true});}
},15000);

test('legacy SIWC startup migrates once without replacing identity, tokens or unknown fields',async()=>{
  const f=await fixture();let first,second;
  try{await f.authorize();const path=join(f.dir,'siwc.json'),legacy=JSON.parse(await readFile(path,'utf8'));delete legacy.authorizationEpoch;legacy.extensionMetadata={retained:true};await writeFile(path,JSON.stringify(legacy),{mode:0o600});
    first=new SiwcClient({dataDir:f.dir,fetchImpl:f.client.fetch});second=new SiwcClient({dataDir:f.dir,fetchImpl:f.client.fetch});await Promise.all([first.start(),second.start()]);
    const migrated=JSON.parse(await readFile(path,'utf8'));expect({...migrated,authorizationEpoch:undefined}).toEqual({...legacy,authorizationEpoch:undefined});expect(first.state.authorizationEpoch).toBe(migrated.authorizationEpoch);expect(second.state.authorizationEpoch).toBe(migrated.authorizationEpoch);expect(first.status().authenticated).toBe(true);
  }finally{await first?.close();await second?.close();await f.close();}
});

for(const invalid of ['broken JSON',{version:99,refreshToken:'future'},{hostId:'urn:uuid:00000000-0000-0000-0000-000000000000',active:'',accounts:{},authorizationEpoch:null}])test('unsupported SIWC records are not rewritten during startup: '+JSON.stringify(invalid),async()=>{
  const dir=await mkdtemp(join(tmpdir(),'relyless-siwc-invalid-')),path=join(dir,'siwc.json'),text=typeof invalid==='string'?invalid:JSON.stringify(invalid),client=new SiwcClient({dataDir:dir});
  try{await writeFile(path,text,{mode:0o600});await expect(client.start()).rejects.toThrow();expect(await readFile(path,'utf8')).toBe(text);}finally{await client.close();await rm(dir,{recursive:true,force:true});}
});

test('refresh preserves the shared logout epoch and rejects an older process after fresh login',async()=>{
  const f=await fixture();let stale,other;
  try{await f.authorize();await expire(f);const epoch=f.client.state.authorizationEpoch;await f.client.listModels();expect(JSON.parse(await readFile(join(f.dir,'siwc.json'),'utf8')).authorizationEpoch).toBe(epoch);await expire(f);
    stale=new SiwcClient({dataDir:f.dir,fetchImpl:f.client.fetch});other=new SiwcClient({dataDir:f.dir,fetchImpl:f.client.fetch});await Promise.all([stale.start(),other.start()]);await other.logout();
    expect((await f.authorize()).response.status).toBe(200);const path=join(f.dir,'siwc.json'),fresh=await readFile(path,'utf8'),tokens=f.requests.filter(item=>item.url==='/api/accounts/oauth/token').length;
    await expect(stale.listModels()).rejects.toMatchObject({code:'CANCELLED'});expect(f.requests.filter(item=>item.url==='/api/accounts/oauth/token')).toHaveLength(tokens);expect(await readFile(path,'utf8')).toBe(fresh);expect(stale.state.authorizationEpoch).toBe(JSON.parse(fresh).authorizationEpoch);
  }finally{await stale?.close();await other?.close();await f.close();}
});
for(const surface of ['cached-models','inference','status'])test('shared logout blocks unexpired authorization on '+surface,async()=>{
  const f=await fixture();let other;
  try{await f.authorize();await f.client.listModels();expect(f.client.state.accounts[clientId].expires_at).toBeGreaterThan(Date.now()+60000);
    other=new SiwcClient({dataDir:f.dir,fetchImpl:f.client.fetch});await other.start();await other.logout();const calls=f.requests.filter(item=>item.url.startsWith('/v1/')).length;
    if(surface==='status')expect((await f.client.refreshStatus()).authenticated).toBe(false);
    else await expect(surface==='cached-models'?f.client.listModels():f.client.classify({text:'Flink streams.'})).rejects.toMatchObject({code:'CANCELLED'});
    expect(f.requests.filter(item=>item.url.startsWith('/v1/'))).toHaveLength(calls);expect(f.client.status().authenticated).toBe(false);expect(f.client.modelCache).toBeNull();
  }finally{await other?.close();await f.close();}
});

test('logout revokes captured grants concurrently before completing local sign-out',async()=>{
  const entered=deferred(),gate=deferred(),tokens=[];const f=await fixture({override:async(target,init)=>{if(target.pathname==='/revoke'){tokens.push(new URLSearchParams(init.body).get('token'));entered.resolve();await gate.promise;return new Response(null,{status:200});}}});let outcome;
  try{await f.authorize();const path=join(f.dir,'siwc.json'),saved=JSON.parse(await readFile(path,'utf8'));saved.accounts[clientId].refresh_token='replacement-refresh';await writeFile(path,JSON.stringify(saved),{mode:0o600});
    outcome=f.client.logout().then(value=>({value}),error=>({error}));await entered.promise;
    expect(new Set(tokens)).toEqual(new Set(['refresh-1','replacement-refresh']));expect(JSON.parse(await readFile(path,'utf8')).accounts[clientId].refresh_token).toBeUndefined();
    gate.resolve();const result=await outcome;expect(result.error).toBeUndefined();expect(result.value.authenticated).toBe(false);
  }finally{gate.resolve();await outcome;await f.close();}
});


for(const stage of ['/api/accounts/oauth/token','/keys'])for(const action of ['cancelLogin','logout','close'])test('SIWC '+action+' during '+stage+' cannot persist a late login',async()=>{
  const entered=deferred(),gate=deferred();const f=await fixture({override:async target=>{if(target.pathname===stage){entered.resolve();await gate.promise;}}});
  try{const authorization=f.authorize();await entered.promise;const actionResult=f.client[action]();await remainsPending(actionResult);gate.resolve();await actionResult;expect((await authorization).response.status).toBe(400);expect(f.client.status().authenticated).toBe(false);expect(JSON.parse(await readFile(join(f.dir,'siwc.json'),'utf8')).accounts[clientId]?.access_token).toBeUndefined();}
  finally{gate.resolve();await f.close();}
});

test('a cancelled callback cannot close a newer login attempt',async()=>{
  const entered=deferred(),gate=deferred();const f=await fixture({override:async target=>{if(target.pathname==='/api/accounts/oauth/token'){entered.resolve();await gate.promise;}}});
  try{const authorization=f.authorize();await entered.promise;const cancelled=f.client.cancelLogin();await remainsPending(cancelled);await f.client.login();gate.resolve();await cancelled;expect((await authorization).response.status).toBe(400);expect(f.client.status()).toMatchObject({authenticated:false,loginPending:true});}
  finally{gate.resolve();await f.close();}
});

for(const stage of ['/api/accounts/oauth/token','/keys'])for(const revokeStatus of [200,503])test('shared logout completes before gated refresh '+stage+' and rejects late grant '+revokeStatus,async()=>{
  let refreshing=false,other,outcome,logout;const entered=deferred(),gate=deferred();
  const f=await fixture({override:async target=>{if(refreshing&&target.pathname===stage){entered.resolve();await gate.promise;}if(target.pathname==='/revoke')return new Response(null,{status:revokeStatus});}});
  try{await f.authorize();await expire(f);other=new SiwcClient({dataDir:f.dir,fetchImpl:f.client.fetch});await other.start();refreshing=true;
    outcome=f.client.classify({text:'Flink streams.'}).then(value=>({value}),error=>({error}));await entered.promise;
    logout=other.logout().then(value=>({value}),error=>({error}));let timer;
    try{const result=await Promise.race([logout,new Promise(done=>{timer=setTimeout(()=>done({blocked:true}),250);})]);expect(result.blocked).toBeUndefined();if(revokeStatus===200)expect(result.value.authenticated).toBe(false);else expect(result.error.message).toContain('远程撤销未确认');}finally{clearTimeout(timer);}
    expect(JSON.parse(await readFile(join(f.dir,'siwc.json'),'utf8')).accounts[clientId].refresh_token).toBeUndefined();
    gate.resolve();const result=await outcome;expect(result.error?.code).toBe('CANCELLED');
    expect(f.requests.filter(item=>item.url==='/revoke').map(item=>new URLSearchParams(item.init.body).get('token'))).toContain('refresh-2');
    if(revokeStatus===503){expect(result.error.message).toContain('远程撤销未确认');expect(f.client.status().error).toContain('远程撤销未确认');}
    expect(f.client.status().authenticated).toBe(false);expect(JSON.parse(await readFile(join(f.dir,'siwc.json'),'utf8')).accounts[clientId].access_token).toBeUndefined();
    const restored=new SiwcClient({dataDir:f.dir});try{await restored.start();expect(restored.status().authenticated).toBe(false);}finally{await restored.close();}
  }finally{gate.resolve();await logout;await outcome;await other?.close();await f.close();}
});

test('terminal refresh failure cannot erase a newer authorization for the same client',async()=>{
  const entered=deferred(),gate=deferred();let paused=false,other,outcome;
  const f=await fixture({override:async(target,init)=>{if(paused&&target.pathname==='/api/accounts/oauth/token'&&new URLSearchParams(init.body).get('grant_type')==='refresh_token'){entered.resolve();await gate.promise;return json({error:'invalid_grant'},400);}}});
  try{await f.authorize();await expire(f);other=new SiwcClient({dataDir:f.dir,fetchImpl:f.client.fetch});await other.start();paused=true;
    outcome=f.client.listModels().then(value=>({value}),error=>({error}));await entered.promise;
    const url=new URL((await other.login()).authUrl),callback=new URL(url.searchParams.get('redirect_uri'));fixture.nonce=url.searchParams.get('nonce');
    for(const [key,value] of [['state',url.searchParams.get('state')],['client_id',clientId],['code','fresh-code']])callback.searchParams.set(key,value);
    let timer;try{expect(await Promise.race([fetch(callback).then(response=>response.status),new Promise(done=>{timer=setTimeout(()=>done('blocked'),250);})])).toBe(200);}finally{clearTimeout(timer);}const path=join(f.dir,'siwc.json'),fresh=await readFile(path,'utf8');
    gate.resolve();expect((await outcome).error?.code).toBe('CANCELLED');expect(await readFile(path,'utf8')).toBe(fresh);expect(JSON.parse(fresh).accounts[clientId].refresh_token).toBe('refresh-2');expect(other.status().authenticated).toBe(true);
  }finally{gate.resolve();await outcome;await other?.close();await f.close();}
});

for(const stage of ['/api/accounts/oauth/token','/keys'])test('local logout does not wait for a gated refresh '+stage,async()=>{
  const entered=deferred(),gate=deferred();let paused=false,outcome,logout;
  const f=await fixture({override:async target=>{if(paused&&target.pathname===stage){entered.resolve();await gate.promise;}}});
  try{await f.authorize();await expire(f);paused=true;outcome=f.client.listModels().then(value=>({value}),error=>({error}));await entered.promise;
    logout=f.client.logout();await logout;expect(f.client.status().authenticated).toBe(false);
    gate.resolve();expect((await outcome).error?.code).toBe('CANCELLED');expect(f.requests.filter(item=>item.url==='/revoke').map(item=>new URLSearchParams(item.init.body).get('token'))).toContain('refresh-2');
    expect(JSON.parse(await readFile(join(f.dir,'siwc.json'),'utf8')).accounts[clientId].refresh_token).toBeUndefined();
  }finally{gate.resolve();await logout;await outcome;await f.close();}
});

test('logout cancels a refresh-lock waiter before the other client releases its network gate',async()=>{
  const entered=deferred(),gate=deferred();let paused=false,other,first,second;
  const f=await fixture({override:async(target,init)=>{if(paused&&target.pathname==='/api/accounts/oauth/token'&&new URLSearchParams(init.body).get('grant_type')==='refresh_token'){entered.resolve();await gate.promise;}}});
  try{await f.authorize();await expire(f);other=new SiwcClient({dataDir:f.dir,fetchImpl:f.client.fetch});await other.start();paused=true;
    first=f.client.listModels().then(value=>({value}),error=>({error}));await entered.promise;second=other.listModels().then(value=>({value}),error=>({error}));
    await new Promise(done=>setTimeout(done,100));await other.logout();expect((await second).error?.code).toBe('CANCELLED');
    gate.resolve();expect((await first).error?.code).toBe('CANCELLED');expect(JSON.parse(await readFile(join(f.dir,'siwc.json'),'utf8')).accounts[clientId].refresh_token).toBeUndefined();
  }finally{gate.resolve();await first;await second;await other?.close();await f.close();}
});

test('invalid refresh grants clear tokens but retain the issued registration for explicit login',async()=>{
  let invalid=false;const f=await fixture({override:(target,init)=>invalid&&target.pathname==='/api/accounts/oauth/token'?json({error:'invalid_grant'},400):undefined});
  try{await f.authorize();await expire(f);invalid=true;await expect(f.client.classify({text:'Flink streams.'})).rejects.toMatchObject({code:'AUTH'});expect(f.client.status().authenticated).toBe(false);const saved=JSON.parse(await readFile(join(f.dir,'siwc.json'),'utf8'));expect(saved.accounts[clientId]).toEqual({client_id:clientId,subject:'user-1',email:'user@example.test'});expect(new URL((await f.client.login()).authUrl).searchParams.get('client_id')).toBe(clientId);}
  finally{await f.close();}
});

test('transient refresh failure preserves credentials and allows a later request',async()=>{
  let unavailable=false;const f=await fixture({override:target=>unavailable&&target.pathname==='/api/accounts/oauth/token'?new Response('',{status:503}):undefined});
  try{await f.authorize();await expire(f);unavailable=true;await expect(f.client.classify({text:'Flink streams.'})).rejects.toMatchObject({code:'HTTP'});expect(f.client.status().authenticated).toBe(true);expect(JSON.parse(await readFile(join(f.dir,'siwc.json'),'utf8')).accounts[clientId].refresh_token).toBe('refresh-1');unavailable=false;expect(await f.client.classify({text:'Flink streams.'})).toEqual({domain:'tech',source:'chatgpt'});}
  finally{await f.close();}
});

test('refresh recovers a dead owner lock without manual credential changes',async()=>{
  const f=await fixture();try{await f.authorize();await expire(f);const owner=spawnSync('node',['-e','process.exit(0)']);expect(owner.status).toBe(0);await writeFile(join(f.dir,'siwc.json.lock'),JSON.stringify({pid:owner.pid}),{mode:0o600});expect(await f.client.classify({text:'Flink streams.'})).toEqual({domain:'tech',source:'chatgpt'});expect(JSON.parse(await readFile(join(f.dir,'siwc.json'),'utf8')).accounts[clientId].refresh_token).toBe('refresh-2');}finally{await f.close();}
},15000);

test('two independent SIWC clients serialize a gated rotating refresh',async()=>{
  const entered=deferred(),gate=deferred();let paused=false,other,outcomes;
  const f=await fixture({override:async(target,init)=>{if(paused&&target.pathname==='/api/accounts/oauth/token'&&new URLSearchParams(init.body).get('grant_type')==='refresh_token'){entered.resolve();await gate.promise;}}});
  try{await f.authorize();await expire(f);other=new SiwcClient({dataDir:f.dir,fetchImpl:f.client.fetch});await other.start();paused=true;
    const first=f.client.listModels();await entered.promise;const second=other.listModels();outcomes=Promise.all([first,second]);
    await new Promise(done=>setTimeout(done,100));expect(f.requests.filter(item=>item.url==='/api/accounts/oauth/token')).toHaveLength(2);
    gate.resolve();expect((await outcomes).map(models=>models[0].id)).toEqual(['fixture-model','fixture-model']);
    expect(f.requests.filter(item=>item.url==='/api/accounts/oauth/token')).toHaveLength(2);expect(JSON.parse(await readFile(join(f.dir,'siwc.json'),'utf8')).accounts[clientId].refresh_token).toBe('refresh-2');
  }finally{gate.resolve();await outcomes;await other?.close();await f.close();}
});

for(const [status,code] of [[401,'AUTH'],[403,'AUTH'],[429,'RATE_LIMIT'],[503,'HTTP']])test('SIWC HTTP '+status+' keeps its failure category for non-JSON bodies',async()=>{
  for(const route of ['/v1/models','/v1/responses']){const f=await fixture({override:target=>target.pathname===route?new Response(route.endsWith('models')?'':'<html>private upstream detail</html>',{status}):undefined});try{await f.authorize();await expect(f.client.classify({text:'Flink streams.'})).rejects.toMatchObject({code});}finally{await f.close();}}
});

test.skipIf(process.platform==='win32'||process.getuid?.()===0)('credential storage failure cannot disclose the local path or authenticate the account',async()=>{
  const f=await fixture();try{await chmod(f.dir,0o500);let failure;try{await f.authorize();}catch(error){failure=error;}expect(failure?.code).toBe('STORAGE_ERROR');expect(failure?.message).not.toContain(f.dir);expect(f.client.status()).toMatchObject({authenticated:false,loginPending:false});expect(JSON.parse(await readFile(join(f.dir,'siwc.json'),'utf8')).accounts[clientId]).toBeUndefined();}finally{await chmod(f.dir,0o700);await f.close();}
});

test('startup directory failure is a safe STORAGE_ERROR',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'relyless-storage-'));const path=join(dir,'private-user');await writeFile(path,'not a directory');const client=new SiwcClient({dataDir:join(path,'oauth')});try{let failure;try{await client.start();}catch(error){failure=error;}expect(failure?.code).toBe('STORAGE_ERROR');expect(failure?.message).not.toContain(dir);}finally{await client.close();await rm(dir,{recursive:true,force:true});}
});


for(const action of ['cancelLogin','logout','close'])test('SIWC '+action+' while the callback server starts cannot create a late login',async()=>{
  const f=await fixture(),entered=deferred(),gate=deferred();let server;
  const create=f.client.serverFactory;
  f.client.serverFactory=callback=>{server=create(callback);const listen=server.listen.bind(server);server.listen=(port,host,done)=>listen(port,host,()=>{entered.resolve();void gate.promise.then(done);});return server;};
  try{const outcome=f.client.login().then(value=>({value}),error=>({error}));await entered.promise;await f.client[action]();gate.resolve();expect((await outcome).error?.code).toBe('CANCELLED');expect(f.client.status()).toMatchObject({authenticated:false,loginPending:false});expect(server.listening).toBe(false);}
  finally{gate.resolve();server?.close();await f.close();}
});

test('logout resolves the shared active account under the credential lock',async()=>{
  const f=await fixture();let restored;
  try{await f.authorize();const path=join(f.dir,'siwc.json'),saved=JSON.parse(await readFile(path,'utf8')),otherId='oaiapp_other456';saved.accounts[otherId]={...saved.accounts[clientId],client_id:otherId,subject:'user-2',email:'other@example.test',access_token:'other-access',refresh_token:'other-refresh'};saved.active=otherId;await writeFile(path,JSON.stringify(saved),{mode:0o600});expect((await f.client.logout()).authenticated).toBe(false);const after=JSON.parse(await readFile(path,'utf8'));expect(after.accounts[otherId].access_token).toBeUndefined();expect(after.accounts[clientId].access_token).toBeUndefined();expect(after.accounts[clientId].refresh_token).toBeUndefined();expect(new Set(f.requests.filter(item=>item.url==='/revoke').map(item=>item.init.body.get('client_id')))).toEqual(new Set([otherId,clientId]));expect(after.accounts[otherId].client_id).toBe(otherId);expect(f.requests.find(item=>item.url==='/revoke').init.body.get('client_id')).toBe(otherId);restored=new SiwcClient({dataDir:f.dir});await restored.start();expect(restored.status().authenticated).toBe(false);}
  finally{await restored?.close();await f.close();}
});

test('logout revokes a stale captured grant as well as a replacement for the same client',async()=>{
  const f=await fixture();
  try{
    await f.authorize();const path=join(f.dir,'siwc.json'),saved=JSON.parse(await readFile(path,'utf8'));
    saved.accounts[clientId]={...saved.accounts[clientId],subject:'user-2',access_token:'replacement-access',refresh_token:'replacement-refresh'};
    await writeFile(path,JSON.stringify(saved),{mode:0o600});
    expect((await f.client.logout()).authenticated).toBe(false);
    const after=JSON.parse(await readFile(path,'utf8'));
    expect(after.accounts[clientId].access_token).toBeUndefined();expect(after.accounts[clientId].refresh_token).toBeUndefined();
    expect(new Set(f.requests.filter(item=>item.url==='/revoke').map(item=>new URLSearchParams(item.init.body).get('token')))).toEqual(new Set(['refresh-1','replacement-refresh']));
  }finally{await f.close();}
});

test('a suspended ownership write is never published or reclaimed as a live lock',async()=>{
  const f=await fixture();let child,exit,timer;
  try{await f.authorize();await expire(f);child=spawn('node',['-e',"const fs=require('node:fs/promises');const open=fs.open.bind(fs);let release;const gate=new Promise(r=>release=r);process.on('message',()=>release());fs.open=async(...args)=>{const handle=await open(...args);if(String(args[0]).includes('siwc.json.lock')){const write=handle.writeFile.bind(handle);handle.writeFile=async(...values)=>{process.send('paused');await gate;return write(...values);};}return handle;};(async()=>{const {SiwcClient}=await import(process.argv[1]);const client=new SiwcClient({dataDir:process.argv[2],fetchImpl:async url=>new URL(url).pathname==='/.well-known/openid-configuration'?Response.json({issuer:'https://auth.openai.com',jwks_uri:'https://auth.openai.com/keys',revocation_endpoint:'https://auth.openai.com/revoke'}):new Response(null,{status:200})});try{await client.start();await client.logout();}finally{await client.close();process.disconnect();}})().catch(error=>{console.error(error);process.exit(1);});",pathToFileURL(resolve('connector/siwc.mjs')).href,f.dir],{stdio:['ignore','ignore','pipe','ipc']});let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});exit=new Promise(done=>child.once('exit',done));
    await new Promise((done,fail)=>{timer=setTimeout(()=>fail(new Error('Ownership writer did not pause')),5000);child.once('message',value=>{clearTimeout(timer);expect(value).toBe('paused');done();});});
    let published;try{published=JSON.parse(await readFile(join(f.dir,'siwc.json.lock'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
    if(published)expect(Number.isSafeInteger(published.pid)&&published.pid>0).toBe(true);
    expect(await f.client.classify({text:'Flink streams.'})).toEqual({domain:'tech',source:'chatgpt'});
    child.send('release');expect(await exit).toBe(0);expect(stderr).toBe('');expect(JSON.parse(await readFile(join(f.dir,'siwc.json'),'utf8')).accounts[clientId].refresh_token).toBeUndefined();
  }finally{clearTimeout(timer);if(child?.exitCode===null){child.kill();await exit;}await f.close();}
},15000);

