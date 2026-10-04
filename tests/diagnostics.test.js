import {expect,test} from 'bun:test';
import {createDiagnosticStore,sanitizeDiagnostic,diagnosticError,summarizeDiagnostics,DIAGNOSTIC_LIMIT,DIAGNOSTIC_TTL} from '../extension/diagnostics.mjs';
import {createDiagnostics} from '../extension/diagnostic-service.js';
import {normalizeSupportResult} from '../extension/gloss.mjs';
const traceId='12345678-1234-1234-1234-123456789abc';
const event=(patch={})=>({at:Date.now(),traceId,operation:'EMERGENCY_TRANSLATE',stage:'request',status:'error',code:'ITEM_ID',...patch});
function memory(initial={}){const data=structuredClone(initial);return {data,async get(key){return key===null?structuredClone(data):{[key]:structuredClone(data[key])};},async set(value){Object.assign(data,structuredClone(value));},async remove(key){delete data[key];}};}

test('diagnostic whitelist excludes source, responses, credentials, arbitrary errors and identifiers',()=>{
  const record=sanitizeDiagnostic(event({message:'secret-message',stack:'secret-stack',url:'https://private.example?q=token',input:'private source',response:'private response',apiKey:'sk-secret',model:'private-model',traceId:'sk-secret',code:'SECRET_ERROR',detail:{message:'private'},itemIndex:1,translationLength:5}));
  expect(record).toEqual({at:record.at,operation:'EMERGENCY_TRANSLATE',stage:'request',status:'error',itemIndex:1,translationLength:5});
  expect(diagnosticError({code:'TRANSLATION_NO_HAN',message:'sk-secret',detail:{itemIndex:2,translationLength:5,input:'private',expectedCount:4}})).toEqual({code:'TRANSLATION_NO_HAN',itemIndex:2,expectedCount:4,translationLength:5});
  expect(sanitizeDiagnostic({...event(),operation:'SECRET_OPERATION'})).toBeNull();
  const ids=sanitizeDiagnostic(event({inputIds:['e1','secret-input'],outputIds:['p2','secret-output'],fields:['id','translation','private-field']}));
  expect(ids.inputIds).toEqual(['e1','<other>']);expect(ids.outputIds).toEqual(['p2','<other>']);expect(ids.fields).toEqual(['id','translation','<other>']);
});

test('diagnostic retention is bounded, expires on read and survives a worker restart',async()=>{
  let now=Date.now();const storage=memory(),store=createDiagnosticStore(storage,{now:()=>now});
  for(let i=0;i<DIAGNOSTIC_LIMIT+3;i++)await store.record(event({itemIndex:i}));
  const restarted=createDiagnosticStore(storage,{now:()=>now});
  expect((await restarted.snapshot()).events[0].itemIndex).toBe(3);
  expect((await restarted.snapshot()).events).toHaveLength(DIAGNOSTIC_LIMIT);
  now+=DIAGNOSTIC_TTL+1000;
  expect((await restarted.snapshot()).events).toEqual([]);
  expect(storage.data.diagnostics.events).toEqual([]);
});

test('disable and clear are barriers against late request events and never delete reading data',async()=>{
  const storage=memory({words:[{term:'private-history'}]}),store=createDiagnosticStore(storage);
  await store.record(event());const oldEpoch=store.epoch;
  await store.configure(false);await store.record(event({code:'AUTH'}));
  expect((await createDiagnosticStore(storage).snapshot()).enabled).toBe(false);
  await store.configure(true);await store.clear();
  expect(await store.record(event(),oldEpoch)).toBe(false);
  expect((await store.snapshot()).events).toEqual([]);
  expect(storage.data.words).toEqual([{term:'private-history'}]);
});

test('incognito requests leave no diagnostic events',async()=>{
  const service=createDiagnostics({storage:memory(),session:memory(),sync:async()=>false,nativeStatus:()=>({connected:false})});
  const value={items:[{id:'p1',translation:'译文'}]};
  expect(await service.run({type:'PASSAGE_TRANSLATE',items:[{id:'p1',text:'private'}]},{tab:{id:17,incognito:true}},async()=>value)).toEqual(value);
  expect((await service.snapshot()).events).toEqual([]);
});

test('storage failures remain visible and do not fail the reading operation',async()=>{
  const storage=memory();storage.set=async()=>{throw Error('quota-secret');};
  const service=createDiagnostics({storage,session:memory(),sync:async()=>false,nativeStatus:()=>({connected:false})});
  const command={type:'PASSAGE_TRANSLATE',items:[{id:'p1',text:'private'}]};
  expect(await service.run(command,{},async()=>({items:[{id:'p1',translation:'译文'}]}))).toEqual({items:[{id:'p1',translation:'译文'}]});
  const snapshot=await service.snapshot();expect(snapshot.storageError).toBe(true);expect(JSON.stringify(snapshot)).not.toContain('quota-secret');
});

test('summary deduplicates stages and detects repeated failures, slow requests and missing completion',()=>{
  const now=Date.now(),rows=[];
  for(let i=0;i<3;i++){const id=traceId.slice(0,-1)+i;rows.push(event({traceId:id,status:'start',at:now-20000}),event({traceId:id,stage:'provider'}),event({traceId:id,durationMs:12000}));}
  rows.push(event({traceId:traceId.slice(0,-1)+'a',status:'start',at:now-160000}));
  rows.push(event({traceId:traceId.slice(0,-1)+'b',status:'start',expectsRender:true,at:now-30000}),event({traceId:traceId.slice(0,-1)+'b',status:'ok',code:'OK',at:now-20000}));
  const summary=summarizeDiagnostics(rows,now);
  expect(summary).toMatchObject({requests:5,failures:3,slow:3,pending:1});
  expect(summary.issues).toEqual(expect.arrayContaining([{code:'REPEATED_FAILURE',operation:'EMERGENCY_TRANSLATE',count:3},{code:'NOT_DISPLAYED',operation:'EMERGENCY_TRANSLATE',count:1},{code:'INTERRUPTED',operation:'EMERGENCY_TRANSLATE',count:1}]));
});

test('overlapping requests keep separate trace IDs and rendering is bound to the originating document',async()=>{
  const storage=memory(),session=memory(),service=createDiagnostics({storage,session,sync:async()=>false,nativeStatus:()=>({connected:false})});
  const page={tab:{id:17},frameId:0,documentId:'document-A'},a={type:'PASSAGE_TRANSLATE',items:[{id:'p1',text:'private-A'}]},b={type:'PASSAGE_TRANSLATE',items:[{id:'p1',text:'private-B'}]};
  let release,started;const running=new Promise(resolve=>{started=resolve;});
  const one=service.run(a,page,async()=>{started();await new Promise(resolve=>{release=resolve;});return {items:[{id:'p1',translation:'甲'}]};});
  await running;await service.run(b,page,async()=>({items:[{id:'p1',translation:'乙'}]}));release();await one;
  expect(service.trace(a).traceId).not.toBe(service.trace(b).traceId);
  await expect(service.render({traceId:service.trace(a).traceId,status:'ok'},{...page,documentId:'document-B'})).rejects.toThrow();
  const restarted=createDiagnostics({storage,session,sync:async()=>false,nativeStatus:()=>({connected:false})});
  await restarted.render({traceId:service.trace(a).traceId,status:'ok'},page);
  await expect(restarted.render({traceId:service.trace(a).traceId,status:'ok'},page)).rejects.toThrow();
  const events=(await restarted.snapshot()).events;
  expect(events.filter(row=>row.stage==='render').map(row=>row.traceId)).toEqual([service.trace(a).traceId]);
  expect(JSON.stringify(events)).not.toMatch(/private-A|private-B|document-A/);
});

test('offline inspection never starts native messaging and a queued clear survives restart',async()=>{
  const storage=memory(),session=memory(),calls=[];let connected=false;
  const options={storage,session,sync:async payload=>{calls.push(payload);return true;},nativeStatus:()=>({connected})};
  const service=createDiagnostics(options);await service.snapshot();await service.clear();await service.configure(false);
  expect(calls).toEqual([]);expect((await service.snapshot()).native.pendingClear).toBe(true);
  const restarted=createDiagnostics(options);connected=true;await restarted.connected();
  expect(calls).toEqual([{action:'configure',enabled:false},{action:'clear'}]);
  expect((await restarted.snapshot()).native.pendingClear).toBe(false);
});

test('sentence analysis failures are recorded without source text or false missing-render alarms',async()=>{
  const service=createDiagnostics({storage:memory(),session:memory(),sync:async()=>false,nativeStatus:()=>({connected:false})});
  const command={type:'SENTENCE_GROUPS_BATCH',items:[{id:'s1',sentence:'Private sentence.'}]};
  const failure=Object.assign(new Error('private response'),{code:'OUTPUT_INVALID'});
  await expect(service.run(command,{tab:{id:1}},()=>service.provider(service.trace(command),'api','model','https://private.example',async()=>{throw failure;}))).rejects.toBe(failure);
  const snapshot=await service.snapshot();
  expect(snapshot.summary).toMatchObject({requests:1,failures:1,pending:0});
  expect(snapshot.events.map(row=>[row.stage,row.status])).toEqual([['request','start'],['provider','start'],['provider','error'],['request','error']]);
  expect(snapshot.events[0].expectsRender).toBe(false);
  expect(JSON.stringify(snapshot)).not.toMatch(/Private sentence|private response|private.example/);
});

test('support validation identifies the failing item and field without retaining its content',async()=>{
  const service=createDiagnostics({storage:memory(),session:memory(),sync:async()=>false,nativeStatus:()=>({connected:false})});
  const items=[{id:'s1',sentence:'Private source.',domain:'general',candidates:[]},{id:'s2',sentence:'Another private source.',domain:'general',candidates:[{text:'private'}]}];
  const result={items:[{id:'s1',target:null,meaning:{en:null,zh:null},sentenceTranslation:null},{id:'s2',target:{text:'private',start:8,end:15,hint:'秘密',translation:'私密',sense:'not public'},meaning:{en:'Not public.',zh:'不公开。'},sentenceTranslation:'另一个私密来源。'}]};
  await expect(service.run({type:'SUPPORT_BATCH',items},{},async()=>normalizeSupportResult(result,items))).rejects.toThrow();
  const snapshot=await service.snapshot(),failure=snapshot.events.find(row=>row.status==='error');
  expect(failure).toMatchObject({code:'OUTPUT_INVALID',itemIndex:1,fields:['target','hint']});
  expect(JSON.stringify(snapshot)).not.toMatch(/Private source|Another private|秘密|私密|not public/);
});


test('a failed native opt-out is not confirmed and preserves the desired setting for reconnection',async()=>{
  const storage=memory(),session=memory();let fail=true;
  const options={storage,session,nativeStatus:()=>({connected:true}),sync:async()=>!fail};
  const service=createDiagnostics(options);
  await expect(service.configure(false)).rejects.toMatchObject({code:'NATIVE_RPC'});
  expect((await service.snapshot()).enabled).toBe(false);
  const restarted=createDiagnostics(options);expect((await restarted.snapshot()).enabled).toBe(false);
  fail=false;await restarted.connected();expect((await restarted.snapshot()).native.mirror).toBe(true);
});

test('diagnostic deletion stays pending until every connected host acknowledges cleanup',async()=>{
  const previousChrome=globalThis.chrome,logs={chatgpt:['old-chatgpt'],grok:['old-grok']};let fail=true;
  globalThis.chrome={runtime:{lastError:null,connectNative:host=>{const kind=host.endsWith('grok')?'grok':'chatgpt';let listener;return{onDisconnect:{addListener:()=>{}},onMessage:{addListener:fn=>{listener=fn;}},postMessage:message=>queueMicrotask(()=>{
    if(message.type==='diagnostics'&&message.payload.action==='clear'){
      if(kind==='chatgpt'&&fail)return listener({id:message.id,ok:false,code:'STORAGE_ERROR',error:'无法清空连接器诊断。'});
      logs[kind]=[];
    }
    listener({id:message.id,ok:true,data:message.type==='diagnostics'?{enabled:true,storageError:false}:{connected:true,authenticated:false}});
  })};}}};
  try{
    const subscription=await import('../extension/subscription.js?diagnostics-all-hosts');
    await subscription.ensureSubscription('chatgpt');await subscription.ensureSubscription('grok');
    const storage=memory(),session=memory(),options={storage,session,sync:subscription.syncNativeDiagnostics,nativeStatus:()=>subscription.subscriptionStatus('chatgpt')};
    const service=createDiagnostics(options);
    await expect(service.clear()).rejects.toMatchObject({code:'NATIVE_RPC'});
    expect(logs).toEqual({chatgpt:['old-chatgpt'],grok:[]});
    expect((await service.snapshot()).native.pendingClear).toBe(true);
    const restarted=createDiagnostics(options);expect((await restarted.snapshot()).native.pendingClear).toBe(true);
    fail=false;await restarted.connected();expect(logs).toEqual({chatgpt:[],grok:[]});expect((await restarted.snapshot()).native.pendingClear).toBe(false);
  }finally{if(previousChrome===undefined)delete globalThis.chrome;else globalThis.chrome=previousChrome;}
});
