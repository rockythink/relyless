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
async function expire(f){const path=join(f.dir,'siwc.json'),saved=JSON.parse(await readFile(path,'utf8'));saved.accounts[clientId].expires_at=0;await writeFile(path,JSON.stringify(saved),{mode:0o600});f.client.state.accounts[clientId].expires_at=0;}

for(const stage of ['/api/accounts/oauth/token','/keys'])for(const action of ['cancelLogin','logout','close'])test('SIWC '+action+' during '+stage+' cannot persist a late login',async()=>{
  const entered=deferred(),gate=deferred();const f=await fixture({override:async target=>{if(target.pathname===stage){entered.resolve();await gate.promise;}}});
  try{const authorization=f.authorize();await entered.promise;await f.client[action]();gate.resolve();expect((await authorization).response.status).toBe(400);expect(f.client.status().authenticated).toBe(false);expect(JSON.parse(await readFile(join(f.dir,'siwc.json'),'utf8')).accounts[clientId]?.access_token).toBeUndefined();}
  finally{gate.resolve();await f.close();}
});

test('a cancelled callback cannot close a newer login attempt',async()=>{
  const entered=deferred(),gate=deferred();const f=await fixture({override:async target=>{if(target.pathname==='/api/accounts/oauth/token'){entered.resolve();await gate.promise;}}});
  try{const authorization=f.authorize();await entered.promise;await f.client.cancelLogin();await f.client.login();gate.resolve();expect((await authorization).response.status).toBe(400);expect(f.client.status()).toMatchObject({authenticated:false,loginPending:true});}
  finally{gate.resolve();await f.close();}
});

for(const stage of ['/api/accounts/oauth/token','/keys'])test('SIWC logout during refresh '+stage+' stays logged out on disk and restart',async()=>{
  let refreshing=false;const entered=deferred(),gate=deferred();const f=await fixture({override:async target=>{if(refreshing&&target.pathname===stage){entered.resolve();await gate.promise;}}});
  try{await f.authorize();await expire(f);refreshing=true;const outcome=f.client.classify({text:'Flink streams.'}).then(value=>({value}),error=>({error}));await entered.promise;const logout=f.client.logout();gate.resolve();await logout;expect((await outcome).error?.code).toBe('CANCELLED');expect(f.client.status().authenticated).toBe(false);const saved=JSON.parse(await readFile(join(f.dir,'siwc.json'),'utf8'));expect(saved.accounts[clientId].refresh_token).toBeUndefined();const restored=new SiwcClient({dataDir:f.dir});await restored.start();expect(restored.status().authenticated).toBe(false);await restored.close();}
  finally{gate.resolve();await f.close();}
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

test('two independent SIWC clients serialize a rotating refresh',async()=>{
  const f=await fixture();let other;try{await f.authorize();await expire(f);other=new SiwcClient({dataDir:f.dir,fetchImpl:f.client.fetch});await other.start();await Promise.all([f.client.listModels(),other.listModels()]);expect(f.requests.filter(item=>item.url==='/api/accounts/oauth/token')).toHaveLength(2);expect(JSON.parse(await readFile(join(f.dir,'siwc.json'),'utf8')).accounts[clientId].refresh_token).toBe('refresh-2');}finally{await other?.close();await f.close();}
});

for(const [status,code] of [[401,'AUTH'],[403,'AUTH'],[429,'RATE_LIMIT'],[503,'HTTP']])test('SIWC HTTP '+status+' keeps its failure category for non-JSON bodies',async()=>{
  for(const route of ['/v1/models','/v1/responses']){const f=await fixture({override:target=>target.pathname===route?new Response(route.endsWith('models')?'':'<html>private upstream detail</html>',{status}):undefined});try{await f.authorize();await expect(f.client.classify({text:'Flink streams.'})).rejects.toMatchObject({code});}finally{await f.close();}}
});

test.skipIf(process.platform==='win32'||process.getuid?.()===0)('credential storage failure cannot disclose the local path or authenticate the account',async()=>{
  const f=await fixture();try{await chmod(f.dir,0o500);expect((await f.authorize()).response.status).toBe(400);expect(f.client.status().authenticated).toBe(false);expect(f.client.status().error).not.toContain(f.dir);expect(JSON.parse(await readFile(join(f.dir,'siwc.json'),'utf8')).accounts[clientId]).toBeUndefined();}finally{await chmod(f.dir,0o700);await f.close();}
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

