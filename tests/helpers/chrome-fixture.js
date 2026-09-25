// 后台测试共用的 chrome 隔离夹具：从 background-explanation.test.js 原样抽出，
// 供多个测试文件复用（模型路由等后台路径都靠它发起真实消息）。

export const event=()=>({listeners:[],addListener(listener){this.listeners.push(listener);}});

export const pick=(source,keys)=>keys===null?{...source}:Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(key=>Object.hasOwn(source,key)).map(key=>[key,source[key]]));

export const remove=(source,keys)=>{for(const key of Array.isArray(keys)?keys:[keys])delete source[key];};

export function isolatedChrome(data,{failMigration=false,id='isolated-fixture'}={}){
  const messages=event(),local=data,isolatedSession={};let failed=false;const select=(source,keys)=>keys===null?{...source}:pick(source,keys);
  const api={runtime:{id,getURL:path=>'chrome-extension://'+id+'/'+path,lastError:null,onMessage:messages,onConnect:event(),onInstalled:event(),onStartup:event(),sendMessage:async()=>{},openOptionsPage:async()=>{}},storage:{local:{QUOTA_BYTES:10_000_000,setAccessLevel:async()=>{},get:async keys=>select(local,keys),set:async values=>{if(failMigration&&!failed&&values.wordSchemaVersion===5){failed=true;throw new Error('quota');}Object.assign(local,structuredClone(values));},remove:async keys=>remove(local,keys),getBytesInUse:async()=>JSON.stringify(local).length},session:{get:async keys=>select(isolatedSession,keys),set:async values=>Object.assign(isolatedSession,structuredClone(values)),remove:async keys=>remove(isolatedSession,keys)}},permissions:{contains:async()=>true,remove:async()=>true,onAdded:event(),onRemoved:event()},tabs:{onRemoved:event(),onUpdated:event(),query:async()=>[],sendMessage:async()=>{},get:async()=>({id:91,url:'https://isolated.example/read',active:true,title:'Never stored'})},webNavigation:{onCommitted:event()},contextMenus:{onClicked:event(),removeAll:async()=>{},create:(_o,cb)=>cb()},scripting:{executeScript:async()=>[{result:true}],getRegisteredContentScripts:async()=>[],unregisterContentScripts:async()=>{},registerContentScripts:async()=>{}},commands:{onCommand:event()},action:{setBadgeText:async()=>{},setTitle:async()=>{},setBadgeBackgroundColor:async()=>{}}};
  return {api,messages,local,session:isolatedSession,id};
}

export const isolatedSend=(fixture,message,sender={})=>new Promise((resolve,reject)=>fixture.messages.listeners.at(-1)(message,{id:fixture.id,url:'chrome-extension://'+fixture.id+'/ui/options.html',...sender},response=>response.ok?resolve(response.data):reject(new Error(response.error))));
