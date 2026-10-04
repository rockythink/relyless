import {test,expect} from 'bun:test';
import {generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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
async function fixture({reply=()=>({domain:'tech'}),tokenScope='openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',identityNonce=null}={}){
  const dir=await mkdtemp(join(tmpdir(),'relyless-siwc-'));
  const requests=[];let tokenCount=0;
  const fetchImpl=async(url,init={})=>{
    const target=new URL(url);requests.push({url:target.pathname,init});
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
