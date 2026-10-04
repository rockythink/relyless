import {afterAll,beforeAll,expect,test} from 'bun:test';

const event = () => ({listeners:[],addListener(listener) { this.listeners.push(listener); }});
const runtimeMessage = event();
const stored = {wordSchemaVersion:4,productSchemaVersion:1,words:[],supportDataGeneration:0,settings:{providerKind:'api',provider:{baseUrl:'https://api.example/v1',model:'fixture',apiKey:'key'}}};
const session = {};
const granted = new Set();
const registrations = [];
const tab = {id:11,windowId:7,url:'https://docs.example/article',title:'Fixture',active:true};
const privateWindows=[];
let tabGetBarrier = null;
const tabMessages = [];
const badgeCalls = [];
let getFrameCalls = 0;
let currentDocumentId='activation-document',frameUrl=null,frameAvailable=true;
const fetchBefore = globalThis.fetch;
globalThis.fetch = async()=>{throw new Error('unexpected model call');};
const pick = (source,keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => Object.hasOwn(source,key)).map(key => [key,source[key]]));
const covered = requested => [...granted].some(pattern => {
  if (pattern === requested) return true;
  if (pattern === 'https://*/*') return requested.startsWith('https://');
  if (pattern === 'http://*/*') return requested.startsWith('http://');
  return false;
});
const chromeBefore = globalThis.chrome;

globalThis.chrome = {
  runtime:{id:'activation-fixture',getURL:path => `chrome-extension://activation-fixture/${path}`,lastError:null,onMessage:runtimeMessage,onConnect:event(),onInstalled:event(),onStartup:event(),sendMessage:async()=>{},openOptionsPage:async()=>{}},
  storage:{
    local:{setAccessLevel:async()=>{},get:async keys=>pick(stored,keys),set:async value=>Object.assign(stored,value),remove:async keys=>{for(const key of Array.isArray(keys)?keys:[keys])delete stored[key];}},
    session:{get:async keys=>keys===null?{...session}:pick(session,keys),set:async value=>Object.assign(session,value),remove:async keys=>{for(const key of Array.isArray(keys)?keys:[keys])delete session[key];}},
  },
  permissions:{
    contains:async ({origins})=>origins.every(covered),
    remove:async ({origins})=>{origins.forEach(origin=>granted.delete(origin));return true;},
    onAdded:event(),onRemoved:event(),
  },
  tabs:{
    onRemoved:event(),onUpdated:event(),query:async query=>query?.active ? [tab] : [tab],get:async id=>{if(tabGetBarrier) await tabGetBarrier;return id === tab.id ? {...tab} : null;},
    sendMessage:async (tabId,message)=>{tabMessages.push({tabId,message});return {ok:true,data:{enabled:false}};},
  },
  windows:{getAll:async()=>[{id:7,incognito:false},...privateWindows],onRemoved:event()},
  scripting:{
    executeScript:async options=>options.func ? [{result:true}] : [],
    getRegisteredContentScripts:async()=>registrations.map(value=>({...value})),
    unregisterContentScripts:async ({ids})=>{for (const id of ids) {const index=registrations.findIndex(item=>item.id===id);if(index>=0) registrations.splice(index,1);}},
    registerContentScripts:async scripts=>{registrations.push(...scripts);},
  },
  webNavigation:{onCommitted:event(),onHistoryStateUpdated:event(),onReferenceFragmentUpdated:event(),getFrame:async({tabId})=>{getFrameCalls++;return tabId===tab.id&&frameAvailable?{documentId:currentDocumentId,url:frameUrl??tab.url}:null;}},
  contextMenus:{onClicked:event(),removeAll:async()=>{},create:(_options,callback)=>callback()},
  commands:{onCommand:event()},action:{setBadgeText:async options=>{badgeCalls.push({call:'text',...options});},setTitle:async options=>{badgeCalls.push({call:'title',...options});},setBadgeBackgroundColor:async options=>{badgeCalls.push({call:'color',...options});}},
};

await import(`../extension/background.js?activation=${Date.now()}`);
const extensionSender = {id:'activation-fixture',url:'chrome-extension://activation-fixture/ui/popup.html'};
const pageSender = {id:'activation-fixture',url:tab.url,tab,frameId:0};
const send = (message,sender=extensionSender) => new Promise((resolve,reject) => {
  runtimeMessage.listeners[0](message,sender,response => response.ok ? resolve(response.data) : reject(new Error(response.error)));
});

beforeAll(async()=>{await new Promise(resolve=>setTimeout(resolve,0));});
afterAll(()=>{globalThis.chrome=chromeBefore;globalThis.fetch=fetchBefore;});

test('automation is not persisted until its exact host permission exists',async()=>{
  await expect(send({type:'AUTOMATION_PATCH',tabId:tab.id,patch:{sites:[{origin:'https://docs.example',enabled:true}]}})).rejects.toThrow('权限');
  expect(stored.settings.automation).toEqual({allSites:false,sentenceGroupsAllSites:false,sites:[],videoSites:false,keywordHints:{badge:false,keywords:['docs','developer','developers','learn','wiki'],dismissed:[]}});

  granted.add('https://docs.example/*');
  const result = await send({type:'AUTOMATION_PATCH',tabId:tab.id,patch:{sites:[{origin:'https://docs.example',enabled:true}]}});
  expect(result).toMatchObject({origin:'https://docs.example',siteRule:true,effective:true,paused:false});
  expect(registrations).toEqual([{id:'ss-auto-start',matches:['https://docs.example/*'],js:['auto-start.js'],runAt:'document_start',allFrames:false,persistAcrossSessions:true}]);
  expect(tabMessages.at(-1).message).toEqual({type:'SS_AUTO_START',origin:'https://docs.example',reading:true,video:false,sentenceGroups:false,paused:false,assistanceMode:'ambient'});
  granted.delete('https://docs.example/*');
  globalThis.chrome.permissions.onRemoved.listeners.forEach(listener=>listener({origins:['https://docs.example/*']}));
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(tabMessages.at(-1).message).toEqual({type:'SS_AUTO_START',origin:'https://docs.example',reading:false,video:false,sentenceGroups:false,paused:false,assistanceMode:'ambient'});

  granted.add('https://docs.example/*');
  globalThis.chrome.permissions.onAdded.listeners.forEach(listener=>listener({origins:['https://docs.example/*']}));
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(tabMessages.at(-1).message.reading).toBe(true);
});

test('manual page pause survives in session and does not recursively broadcast a policy',async()=>{
  const before = tabMessages.length;
  expect(await send({type:'PAGE_ACTIVITY_SET',enabled:false},pageSender)).toEqual({paused:true});
  expect(tabMessages.length).toBe(before);
  expect(session['automationPaused:'+tab.id]).toBe(true);
  expect(await send({type:'AUTOMATION_GET',tabId:tab.id})).toMatchObject({effective:false,paused:true,siteRule:true});
  expect(await send({type:'PAGE_ACTIVITY_SET',enabled:true},pageSender)).toEqual({paused:false});
  expect(session['automationPaused:'+tab.id]).toBeUndefined();
});
test('concurrent pause writes use independent tab session keys',async()=>{
  const other = {id:12,url:'https://other.example/page'};
  await Promise.all([
    send({type:'PAGE_ACTIVITY_SET',enabled:false},pageSender),
    send({type:'PAGE_ACTIVITY_SET',enabled:false},{id:'activation-fixture',url:other.url,tab:other,frameId:0}),
  ]);
  expect(session).toMatchObject({['automationPaused:'+tab.id]:true,['automationPaused:'+other.id]:true});
  await Promise.all([
    send({type:'PAGE_ACTIVITY_SET',enabled:true},pageSender),
    send({type:'PAGE_ACTIVITY_SET',enabled:true},{id:'activation-fixture',url:other.url,tab:other,frameId:0}),
  ]);
});

test('concurrent partial automation patches merge against serialized state and revoked rules may shrink',async()=>{
  granted.add('https://www.youtube.com/*');
  granted.add('https://m.youtube.com/*');
  await Promise.all([
    send({type:'AUTOMATION_PATCH',tabId:tab.id,patch:{allSites:false}}),
    send({type:'AUTOMATION_PATCH',tabId:tab.id,patch:{videoSites:true}}),
  ]);
  await Promise.all([
    send({type:'AUTOMATION_PATCH',tabId:tab.id,patch:{sites:[]}}),
    send({type:'AUTOMATION_PATCH',tabId:tab.id,patch:{sites:[{origin:'https://docs.example',enabled:true}]}}),
  ]);
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(stored.settings.automation.sites).toEqual([{origin:'https://docs.example',enabled:true}]);
  expect(granted.has('https://docs.example/*')).toBe(true);
  expect(stored.settings.automation).toMatchObject({videoSites:true,sites:[{origin:'https://docs.example',enabled:true}]});

  granted.delete('https://docs.example/*');
  await expect(send({type:'AUTOMATION_PATCH',tabId:tab.id,patch:{sites:[]}})).resolves.toMatchObject({siteRule:null,effective:false});
  granted.add('https://docs.example/*');
  await send({type:'AUTOMATION_PATCH',tabId:tab.id,patch:{sites:[{origin:'https://docs.example',enabled:true}]}});
});
test('stale activation work cannot send a policy across an origin navigation',async()=>{
  let release;
  tabGetBarrier = new Promise(resolve=>{release=resolve;});
  const before = tabMessages.length;
  globalThis.chrome.tabs.onUpdated.listeners[0](tab.id,{status:'complete'},{...tab});
  tab.url = 'https://excluded.example/page';
  tabGetBarrier = null;
  release();
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(tabMessages.length).toBe(before);
  tab.url = 'https://docs.example/article';
});

test('main-frame video patches deep merge, persist, and use the dedicated broadcast',async()=>{
  const [first,second] = await Promise.all([
    send({type:'VIDEO_SETTINGS_PATCH',patch:{fontSize:24}},pageSender),
    send({type:'VIDEO_SETTINGS_PATCH',patch:{theme:'dark'}},pageSender),
  ]);
  expect(first).toEqual({video:{fontSize:24,theme:'auto'}});
  expect(second).toEqual({video:{fontSize:24,theme:'dark'}});
  expect(stored.settings.video).toEqual(second.video);
  expect(tabMessages.at(-1).message).toEqual({type:'SS_VIDEO_SETTINGS',video:second.video});
  await expect(send({type:'VIDEO_SETTINGS_PATCH',patch:{fontSize:22}},pageSender)).rejects.toThrow('字号');
});

test('sentence groups automation honors exclusions, pause, permission, manual override, and navigation boundaries',async()=>{
  granted.add('http://*/*');granted.add('https://*/*');
  let result=await send({type:'AUTOMATION_PATCH',tabId:tab.id,patch:{sentenceGroupsAllSites:true,sites:[]}});
  expect(result).toMatchObject({sentenceGroups:true,sentenceGroupsEffective:true});
  expect(session['sentenceGroupsMode:'+tab.id]).toMatchObject({enabled:true,source:'auto'});
  expect(tabMessages.at(-1).message).toMatchObject({reading:true,sentenceGroups:true,paused:false});

  await send({type:'PAGE_ACTIVITY_SET',enabled:false},pageSender);
  await send({type:'AUTO_BOOTSTRAP_CHECK'},pageSender);
  expect(await send({type:'AUTOMATION_GET',tabId:tab.id})).toMatchObject({sentenceGroups:false,paused:true});
  expect(tabMessages.at(-1).message).toMatchObject({reading:false,sentenceGroups:false,paused:true});
  expect(session['sentenceGroupsMode:'+tab.id]).toMatchObject({enabled:true,source:'auto'});
  await send({type:'PAGE_ACTIVITY_SET',enabled:true},pageSender);

  await send({type:'AUTOMATION_PATCH',tabId:tab.id,patch:{sites:[{origin:'https://docs.example',enabled:false}]}});
  expect(await send({type:'AUTOMATION_GET',tabId:tab.id})).toMatchObject({siteRule:false,sentenceGroups:false});
  expect(session['sentenceGroupsMode:'+tab.id]).toBeUndefined();
  await send({type:'AUTOMATION_PATCH',tabId:tab.id,patch:{sites:[]}});
  expect(session['sentenceGroupsMode:'+tab.id]).toMatchObject({source:'auto'});
  await send({type:'AUTOMATION_PATCH',tabId:tab.id,patch:{sentenceGroupsAllSites:false}});
  expect(session['sentenceGroupsMode:'+tab.id]).toBeUndefined();
  granted.add('http://*/*');granted.add('https://*/*');
  await send({type:'AUTOMATION_PATCH',tabId:tab.id,patch:{sentenceGroupsAllSites:true}});

  await send({type:'PAGE_UI_INJECT',tabId:tab.id});
  await send({type:'SENTENCE_GROUPS_SET',tabId:tab.id,enabled:false});
  await send({type:'AUTOMATION_PATCH',tabId:tab.id,patch:{sentenceGroupsAllSites:true}});
  expect(await send({type:'AUTOMATION_GET',tabId:tab.id})).toMatchObject({sentenceGroups:false,sentenceGroupsEffective:true});
  expect(session['sentenceGroupsMode:'+tab.id]).toMatchObject({enabled:false,source:'manual'});

  tab.url='https://docs.example/next';
  globalThis.chrome.tabs.onUpdated.listeners[0](tab.id,{status:'complete'},{...tab});
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(session['sentenceGroupsMode:'+tab.id]).toMatchObject({enabled:true,source:'auto'});
  expect(tabMessages.at(-1).message).toMatchObject({reading:true,sentenceGroups:true});

  await send({type:'PAGE_UI_INJECT',tabId:tab.id});
  await send({type:'SENTENCE_GROUPS_SET',tabId:tab.id,enabled:true});
  await send({type:'AUTOMATION_PATCH',tabId:tab.id,patch:{sentenceGroupsAllSites:false}});
  expect(session['sentenceGroupsMode:'+tab.id]).toMatchObject({enabled:true,source:'manual'});
  expect(await send({type:'AUTOMATION_GET',tabId:tab.id})).toMatchObject({sentenceGroups:true,sentenceGroupsEffective:false});

  await send({type:'PAGE_ACTIVITY_SET',enabled:false},pageSender);
  await send({type:'AUTO_BOOTSTRAP_CHECK'},pageSender);
  expect(tabMessages.at(-1).message).toMatchObject({reading:false,sentenceGroups:false,paused:true});
  await send({type:'PAGE_ACTIVITY_SET',enabled:true},pageSender);
  await send({type:'AUTO_BOOTSTRAP_CHECK'},pageSender);
  expect(tabMessages.at(-1).message).toMatchObject({reading:true,sentenceGroups:true,paused:false});

  granted.add('http://*/*');granted.add('https://*/*');
  await send({type:'AUTOMATION_PATCH',tabId:tab.id,patch:{sentenceGroupsAllSites:true}});
  tab.url='https://docs.example/revoked';
  globalThis.chrome.tabs.onUpdated.listeners[0](tab.id,{status:'complete'},{...tab});
  await new Promise(resolve=>setTimeout(resolve,0));
  granted.delete('http://*/*');granted.delete('https://*/*');granted.delete('https://docs.example/*');
  globalThis.chrome.permissions.onRemoved.listeners.forEach(listener=>listener({origins:['http://*/*','https://*/*','https://docs.example/*']}));
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(tabMessages.at(-1).message).toMatchObject({reading:false,sentenceGroups:false});
  expect(session['sentenceGroupsMode:'+tab.id]).toBeUndefined();

  granted.add('http://*/*');granted.add('https://*/*');
  globalThis.chrome.permissions.onAdded.listeners.forEach(listener=>listener({origins:['http://*/*','https://*/*']}));
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(session['sentenceGroupsMode:'+tab.id]).toMatchObject({source:'auto'});
  tab.url='chrome://settings';
  globalThis.chrome.tabs.onUpdated.listeners[0](tab.id,{url:tab.url,status:'loading'},{...tab});
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(session['sentenceGroupsMode:'+tab.id]).toBeUndefined();
  tab.url='https://docs.example/article';
  await send({type:'AUTOMATION_PATCH',tabId:tab.id,patch:{sentenceGroupsAllSites:false}});
});
test('page request cancellation is restricted to the armed main frame',async()=>{
  await send({type:'PAGE_UI_INJECT',tabId:tab.id});
  const {token}=await send({type:'EMERGENCY_BEGIN',tabId:tab.id,url:tab.url});
  expect(session['emergencySession:'+tab.id]).toMatchObject({token,cancelledThrough:0});
  await expect(send({type:'EMERGENCY_CANCEL_REQUEST',token,through:2},{...pageSender,frameId:1})).rejects.toThrow();
  await send({type:'EMERGENCY_CANCEL_REQUEST',token,through:2},pageSender);
  expect(session['emergencySession:'+tab.id]).toMatchObject({token,cancelledThrough:2});
  await send({type:'EMERGENCY_END',tabId:tab.id,token});
});
test('explicit reader translation remains available on a paused page',async()=>{
  await send({type:'PAGE_UI_INJECT',tabId:tab.id});
  await send({type:'PAGE_ACTIVITY_SET',enabled:false},pageSender);
  try{
    expect(await send({type:'READER_TRANSLATION_ESTIMATE'},pageSender)).toHaveProperty('estimate');
    const started=await send({type:'READER_TRANSLATION_BEGIN',confirmed:false},pageSender);
    expect(started.token).toBeTruthy();
    await send({type:'EMERGENCY_END',token:started.token},pageSender);
  }finally{await send({type:'PAGE_ACTIVITY_SET',enabled:true},pageSender);}
});

test('keyword hint badge appears on matching main-frame commits and clears on non-matches',async()=>{
  badgeCalls.length=0;getFrameCalls=0;
  await send({type:'AUTOMATION_PATCH',tabId:tab.id,patch:{keywordHints:{badge:true,keywords:['docs'],dismissed:[]}}});
  expect(getFrameCalls).toBeGreaterThan(0);
  expect(badgeCalls).toContainEqual({call:'text',tabId:tab.id,text:'+'});
  expect(badgeCalls.some(call=>call.call==='title'&&call.tabId===tab.id&&call.title.includes('docs'))).toBe(true);
  expect(session['keywordHint:'+tab.id]).toBe(true);

  badgeCalls.length=0;
  globalThis.chrome.webNavigation.onCommitted.listeners.forEach(listener=>listener({tabId:tab.id,url:'https://wiki.example.org/p',frameId:1}));
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(badgeCalls).toEqual([]);

  globalThis.chrome.webNavigation.onCommitted.listeners.forEach(listener=>listener({tabId:tab.id,url:'https://example.com/',frameId:0}));
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(badgeCalls).toContainEqual({call:'text',tabId:tab.id,text:''});
  expect(session['keywordHint:'+tab.id]).toBeUndefined();

  badgeCalls.length=0;
  globalThis.chrome.webNavigation.onCommitted.listeners.forEach(listener=>listener({tabId:tab.id,url:'https://example.com/other',frameId:0}));
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(badgeCalls.some(call=>call.call==='text')).toBe(false);
});

test('badge off: no badge writes, no getFrame reads, and stale markers clear without touching the url',async()=>{
  session['keywordHint:'+tab.id]=true;
  badgeCalls.length=0;getFrameCalls=0;
  await send({type:'AUTOMATION_PATCH',tabId:tab.id,patch:{keywordHints:{badge:false,keywords:['docs'],dismissed:[]}}});
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(getFrameCalls).toBe(0);
  expect(session['keywordHint:'+tab.id]).toBeUndefined();
  expect(badgeCalls).toContainEqual({call:'text',tabId:tab.id,text:''});
  badgeCalls.length=0;
  globalThis.chrome.webNavigation.onCommitted.listeners.forEach(listener=>listener({tabId:tab.id,url:'https://docs.example.com/x',frameId:0}));
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(badgeCalls).toEqual([]);
});

const flushBadgeQueue=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setTimeout(resolve,0));};
const commitMainFrame=(url)=>{globalThis.chrome.webNavigation.onCommitted.listeners.forEach(listener=>listener({tabId:tab.id,url,frameId:0}));};
const clickMenu=(menuItemId,info={})=>{globalThis.chrome.contextMenus.onClicked.listeners.forEach(listener=>listener({menuItemId,frameId:0,...info},tab));};
const failTabSend=()=>{const real=globalThis.chrome.tabs.sendMessage;globalThis.chrome.tabs.sendMessage=async()=>({ok:false,error:'fixture failure'});return()=>{globalThis.chrome.tabs.sendMessage=real;};};
const lastText=()=>badgeCalls.filter(call=>call.call==='text'&&call.tabId===tab.id).at(-1)?.text;
const enableDocsBadge=()=>send({type:'AUTOMATION_PATCH',tabId:tab.id,patch:{keywordHints:{badge:true,keywords:['docs'],dismissed:[]}}});

test('error badge wins over hint: matching reconcile keeps ! and skips +',async()=>{
  badgeCalls.length=0;
  const restore=failTabSend();
  clickMenu('ss-toggle-reading');
  await flushBadgeQueue();
  restore();
  expect(lastText()).toBe('!');
  expect(session['tabError:'+tab.id]).toBe(true);
  badgeCalls.length=0;
  await enableDocsBadge();
  await flushBadgeQueue();
  expect(badgeCalls.some(call=>call.call==='text'&&call.text==='+')).toBe(false);
  expect(session['keywordHint:'+tab.id]).toBeUndefined();
  expect(session['tabError:'+tab.id]).toBe(true);
  delete session['tabError:'+tab.id];
});

test('hint then error then non-matching reconcile: ! persists, no clear call',async()=>{
  await enableDocsBadge();
  badgeCalls.length=0;
  commitMainFrame('https://docs.example.com/x');
  await flushBadgeQueue();
  expect(lastText()).toBe('+');
  const restore=failTabSend();
  clickMenu('ss-toggle-reading');
  await flushBadgeQueue();
  restore();
  expect(lastText()).toBe('!');
  expect(session['keywordHint:'+tab.id]).toBeUndefined();
  badgeCalls.length=0;
  await send({type:'AUTOMATION_PATCH',tabId:tab.id,patch:{keywordHints:{badge:true,keywords:['wiki'],dismissed:[]}}});
  await flushBadgeQueue();
  expect(badgeCalls.some(call=>call.call==='text'&&call.text==='')).toBe(false);
  expect(lastText()).toBeUndefined();
  expect(session['tabError:'+tab.id]).toBe(true);
  delete session['tabError:'+tab.id];
  await enableDocsBadge();
});

test('successful action after error restores + on matching tab, plain clear when badge off',async()=>{
  await enableDocsBadge();
  const restore=failTabSend();
  clickMenu('ss-toggle-reading');
  await flushBadgeQueue();
  restore();
  expect(lastText()).toBe('!');
  badgeCalls.length=0;
  clickMenu('ss-toggle-reading');
  await flushBadgeQueue();
  expect(session['tabError:'+tab.id]).toBeUndefined();
  expect(session['keywordHint:'+tab.id]).toBe(true);
  expect(lastText()).toBe('+');

  session['keywordHint:'+tab.id]=undefined;delete session['keywordHint:'+tab.id];
  await send({type:'AUTOMATION_PATCH',tabId:tab.id,patch:{keywordHints:{badge:false,keywords:['docs'],dismissed:[]}}});
  await flushBadgeQueue();
  badgeCalls.length=0;getFrameCalls=0;
  const restore2=failTabSend();
  clickMenu('ss-toggle-reading');
  await flushBadgeQueue();
  restore2();
  expect(lastText()).toBe('!');
  badgeCalls.length=0;
  clickMenu('ss-toggle-reading');
  await flushBadgeQueue();
  expect(lastText()).toBe('');
  expect(getFrameCalls).toBe(0);
  expect(session['tabError:'+tab.id]).toBeUndefined();
  expect(session['keywordHint:'+tab.id]).toBeUndefined();
});

test('successful action with no prior error leaves + untouched',async()=>{
  await enableDocsBadge();
  badgeCalls.length=0;
  commitMainFrame('https://docs.example.com/x');
  await flushBadgeQueue();
  expect(lastText()).toBe('+');
  badgeCalls.length=0;
  clickMenu('ss-toggle-reading');
  await flushBadgeQueue();
  expect(badgeCalls.some(call=>call.call==='text')).toBe(false);
  expect(session['keywordHint:'+tab.id]).toBe(true);
});

test('main-frame commit clears error state and applies matching hint',async()=>{
  await enableDocsBadge();
  const restore=failTabSend();
  clickMenu('ss-toggle-reading');
  await flushBadgeQueue();
  restore();
  expect(session['tabError:'+tab.id]).toBe(true);
  badgeCalls.length=0;
  commitMainFrame('https://docs.example.com/x');
  await flushBadgeQueue();
  expect(session['tabError:'+tab.id]).toBeUndefined();
  expect(lastText()).toBe('+');
  expect(session['keywordHint:'+tab.id]).toBe(true);
});

test('navigation suppresses an older context error even when its result arrives later',async()=>{
  await enableDocsBadge();
  badgeCalls.length=0;
  const restore=failTabSend();
  clickMenu('ss-toggle-reading');
  commitMainFrame('https://docs.example.com/x');
  await flushBadgeQueue();
  restore();
  expect(lastText()).toBe('+');
  expect(session['keywordHint:'+tab.id]).toBe(true);
  expect(session['tabError:'+tab.id]).toBeUndefined();
});

test('dismissal removes the current + badge and title immediately',async()=>{
  await enableDocsBadge();badgeCalls.length=0;
  commitMainFrame(tab.url);await flushBadgeQueue();
  expect(lastText()).toBe('+');
  const result=await send({type:'KEYWORD_HINT_DISMISS',tabId:tab.id});
  expect(result.keywordHint).toBe(null);
  expect(lastText()).toBe('');
  expect(badgeCalls.some(call=>call.call==='title'&&call.tabId===tab.id&&call.title==='RelyLess')).toBe(true);
  expect(session['keywordHint:'+tab.id]).toBeUndefined();
});
test('keyword hint dismissal evicts the oldest entry at the cap and stays session-only in incognito',async()=>{
  const hintsBefore=stored.settings.automation.keywordHints;
  stored.settings.automation.keywordHints={badge:true,keywords:['docs','learn'],dismissed:Array.from({length:500},(_v,i)=>'https://old-'+i+'.example')};
  try{
    // 普通窗口：持久化忽略，满 500 条时回收最早条目，最新点击必然生效。
    const result=await send({type:'KEYWORD_HINT_DISMISS',tabId:tab.id});
    expect(result.keywordHint).toBe(null);
    const dismissed=stored.settings.automation.keywordHints.dismissed;
    expect(dismissed).toHaveLength(500);
    expect(dismissed[0]).toBe('https://old-1.example');
    expect(dismissed.at(-1)).toBe('https://docs.example');
    const persisted=JSON.stringify(dismissed);

    // 无痕窗口：只写会话存储，本机设置不携带无痕站点 origin。
    const privateTab={id:13,windowId:9,url:'https://learn.private.example/page',incognito:true,active:true};
    privateWindows.push({id:9,incognito:true},{id:10,incognito:true});
    const privateSender={id:'activation-fixture',url:'chrome-extension://activation-fixture/ui/popup.html',tab:privateTab};
    const incognitoResult=await send({type:'KEYWORD_HINT_DISMISS'},privateSender);
    expect(incognitoResult.keywordHint).toBe(null);
    expect(session['keywordHintDismissed']).toEqual(['https://learn.private.example']);
    expect(JSON.stringify(stored.settings.automation.keywordHints.dismissed)).toBe(persisted);

    // 会话忽略只作用于无痕上下文：普通窗口访问同站点仍收到提示，无痕浏览不泄漏到常规判定。
    const realUrl=tab.url;
    tab.url='https://learn.private.example/page';
    const regularResult=await send({type:'AUTOMATION_GET',tabId:tab.id});
    tab.url=realUrl;
    expect(regularResult.keywordHint).toBe('learn');
    privateWindows.shift();globalThis.chrome.windows.onRemoved.listeners.forEach(listener=>listener(9));
    await flushBadgeQueue();expect(session['keywordHintDismissed']).toEqual(['https://learn.private.example']);
    privateWindows.shift();globalThis.chrome.windows.onRemoved.listeners.forEach(listener=>listener(10));
    await flushBadgeQueue();expect(session['keywordHintDismissed']).toBeUndefined();
    privateWindows.push({id:11,incognito:true});
    const reopened=await send({type:'AUTOMATION_GET'},privateSender);
    expect(reopened.keywordHint).toBe('learn');
  }finally{
    stored.settings.automation.keywordHints=hintsBefore;
    privateWindows.length=0;
    delete session['keywordHintDismissed'];
  }
});

const taskSender=()=>({id:'activation-fixture',url:tab.url,tab:{...tab},frameId:0,documentId:currentDocumentId});
const reportTask=(error,sequence,sender=taskSender(),pageUrl=sender.url)=>send({type:'PAGE_TASK_STATUS',error,sequence,pageUrl},sender);
const taskKey='pageTaskStatus:'+tab.id;
async function resetTaskPage(){
  tab.url='https://docs.example/article';tab.incognito=false;
  currentDocumentId='activation-document';frameUrl=null;frameAvailable=true;
  commitMainFrame(tab.url);await flushBadgeQueue();await enableDocsBadge();
  badgeCalls.length=0;
}

test('page task failures replace +; a later clear restores the hint without persisting page data',async()=>{
  await resetTaskPage();
  await reportTask(true,1);
  expect(lastText()).toBe('!');
  expect(session['keywordHint:'+tab.id]).toBeUndefined();
  expect(session[taskKey]).toEqual({documentId:currentDocumentId,sequence:1,error:true});
  expect(JSON.stringify(session[taskKey])).not.toContain(tab.url);
  expect(stored[taskKey]).toBeUndefined();
  badgeCalls.length=0;
  await enableDocsBadge();
  expect(badgeCalls.some(call=>call.call==='text'&&call.text==='+')).toBe(false);
  await reportTask(false,2);
  expect(lastText()).toBe('+');
  expect(session[taskKey]).toEqual({documentId:currentDocumentId,sequence:2,error:false});
});

test('task and context error channels clear independently, and ! wins until both recover',async()=>{
  await resetTaskPage();
  await reportTask(true,1);
  let restore=failTabSend();clickMenu('ss-toggle-reading');await flushBadgeQueue();restore();
  expect(session['tabError:'+tab.id]).toBe(true);
  badgeCalls.length=0;
  await reportTask(false,2);
  expect(lastText()).toBeUndefined();
  expect(session['tabError:'+tab.id]).toBe(true);
  expect(session[taskKey].error).toBe(false);
  clickMenu('ss-toggle-reading');await flushBadgeQueue();
  expect(lastText()).toBe('+');

  await reportTask(true,3);
  restore=failTabSend();clickMenu('ss-toggle-reading');await flushBadgeQueue();restore();
  badgeCalls.length=0;
  clickMenu('ss-toggle-reading');await flushBadgeQueue();
  expect(lastText()).toBe('!');
  expect(session['tabError:'+tab.id]).toBeUndefined();
  expect(session[taskKey].error).toBe(true);
  expect(badgeCalls.some(call=>call.call==='text'&&call.text!== '!')).toBe(false);
  await reportTask(false,4);
  expect(lastText()).toBe('+');
});

test('sequence ordering covers errors and clears, and restarts for a new native document',async()=>{
  await resetTaskPage();
  await reportTask(true,9);await reportTask(false,10);
  badgeCalls.length=0;
  expect(await reportTask(true,9)).toEqual({accepted:false});
  expect(await reportTask(true,10)).toEqual({accepted:false});
  expect(badgeCalls).toEqual([]);
  expect(session[taskKey].error).toBe(false);
  currentDocumentId='new-native-document';
  expect(await reportTask(true,1)).toEqual({accepted:true});
  expect(lastText()).toBe('!');
  expect(session[taskKey].sequence).toBe(1);
  await reportTask(false,2);
});

test('native extension identity, main frame, document, exact URL and bounded fields are required',async()=>{
  await resetTaskPage();
  await reportTask(true,4);badgeCalls.length=0;
  const sender=taskSender(),message={type:'PAGE_TASK_STATUS',error:false,sequence:5,pageUrl:tab.url};
  const senders=[{...sender,id:'foreign-extension'},{...sender,frameId:1},{...sender,frameId:undefined},{...sender,documentId:undefined},{...sender,documentId:'old-document'},{...sender,documentId:'x'.repeat(129)},{...sender,url:'https://docs.example/old'},{...sender,tab:{id:-1}},{...sender,tab:undefined},extensionSender];
  for(const invalid of senders)await expect(send(message,invalid)).rejects.toThrow();
  for(const sequence of [0,-1,1.5,Infinity,NaN,Number.MAX_SAFE_INTEGER+1,'5',null])await expect(send({...message,sequence},sender)).rejects.toThrow();
  for(const error of ['false',0,null])await expect(send({...message,error},sender)).rejects.toThrow();
  for(const pageUrl of [null,'','https://docs.example/other','https://docs.example/?'+ 'x'.repeat(8192),'chrome://settings'])await expect(send({...message,pageUrl},{...sender,url:pageUrl})).rejects.toThrow();
  frameUrl=tab.url+'?different=1';await expect(send(message,sender)).rejects.toThrow();frameUrl=null;
  frameAvailable=false;await expect(send(message,sender)).rejects.toThrow();frameAvailable=true;
  expect(badgeCalls).toEqual([]);
  expect(session[taskKey]).toEqual({documentId:currentDocumentId,sequence:4,error:true});
  await reportTask(false,5);
});

test('loading, non-matching and unsupported navigation clear all old error badges and titles',async()=>{
  await resetTaskPage();
  await reportTask(true,1);
  const restore=failTabSend();clickMenu('ss-toggle-reading');await flushBadgeQueue();restore();
  tab.url='https://plain.example/next';badgeCalls.length=0;
  globalThis.chrome.tabs.onUpdated.listeners.forEach(listener=>listener(tab.id,{status:'loading',url:tab.url},{...tab}));
  await flushBadgeQueue();
  expect(lastText()).toBe('');
  expect(session[taskKey]).toBeUndefined();
  expect(session['tabError:'+tab.id]).toBeUndefined();
  expect(badgeCalls.filter(call=>call.call==='title').at(-1)?.title).toBe('RelyLess');
  currentDocumentId='plain-document';commitMainFrame(tab.url);await flushBadgeQueue();
  await reportTask(true,1);
  tab.url='chrome://settings';commitMainFrame(tab.url);await flushBadgeQueue();
  expect(lastText()).toBe('');expect(session[taskKey]).toBeUndefined();

  await resetTaskPage();await reportTask(true,1);
  currentDocumentId='matching-document';tab.url='https://docs.example/new';
  commitMainFrame(tab.url);await flushBadgeQueue();
  expect(lastText()).toBe('+');expect(session[taskKey]).toBeUndefined();
  expect(await reportTask(false,1)).toEqual({accepted:true});
});

test('SPA and fragment navigation clear errors but retain sequence ordering for the same document',async()=>{
  await resetTaskPage();await reportTask(true,7);
  const oldSender=taskSender();
  tab.url='https://docs.example/route-two';
  globalThis.chrome.webNavigation.onHistoryStateUpdated.listeners.forEach(listener=>listener({tabId:tab.id,frameId:0,url:tab.url,documentId:currentDocumentId}));
  await flushBadgeQueue();
  expect(lastText()).toBe('+');
  expect(session[taskKey]).toEqual({documentId:currentDocumentId,sequence:7,error:false});
  await expect(reportTask(true,8,oldSender)).rejects.toThrow();
  await reportTask(true,8);
  tab.url+='#part';
  globalThis.chrome.webNavigation.onReferenceFragmentUpdated.listeners.forEach(listener=>listener({tabId:tab.id,frameId:0,url:tab.url,documentId:currentDocumentId}));
  await flushBadgeQueue();expect(lastText()).toBe('+');
  tab.url=oldSender.url;
  globalThis.chrome.tabs.onUpdated.listeners.forEach(listener=>listener(tab.id,{url:tab.url},{...tab}));
  await flushBadgeQueue();badgeCalls.length=0;
  expect(await reportTask(true,7,oldSender)).toEqual({accepted:false});
  expect(await reportTask(true,8,oldSender)).toEqual({accepted:false});
  expect(badgeCalls).toEqual([]);
  await reportTask(true,9);expect(lastText()).toBe('!');await reportTask(false,10);
});

test('a delayed report revalidates current URL and document after asynchronous frame lookup',async()=>{
  await resetTaskPage();
  const original=globalThis.chrome.webNavigation.getFrame;
  let entered,release;
  const ready=new Promise(resolve=>{entered=resolve;}),barrier=new Promise(resolve=>{release=resolve;});
  let once=true;
  globalThis.chrome.webNavigation.getFrame=async options=>{
    const frame=await original(options);
    if(once){once=false;entered();await barrier;}
    return frame;
  };
  const pending=reportTask(true,1);
  const rejected=pending.then(()=>null,error=>error);
  try{
    await ready;tab.url='https://docs.example/new-route';currentDocumentId='replacement-document';
    release();expect(await rejected).toBeInstanceOf(Error);
    expect(session[taskKey]).toBeUndefined();
    expect(badgeCalls.some(call=>call.call==='text'&&call.text==='!')).toBe(false);
  }finally{release();globalThis.chrome.webNavigation.getFrame=original;}
});

test('navigation during a session write cannot leave a late task error on the replacement document',async()=>{
  await resetTaskPage();
  const original=globalThis.chrome.storage.session.set;
  let entered,release;
  const ready=new Promise(resolve=>{entered=resolve;}),barrier=new Promise(resolve=>{release=resolve;});
  let once=true;
  globalThis.chrome.storage.session.set=async value=>{
    if(once&&value[taskKey]){once=false;entered();await barrier;}
    return original(value);
  };
  const pending=reportTask(true,1),rejected=pending.then(()=>null,error=>error);
  try{
    await ready;currentDocumentId='replacement-document';tab.url='https://plain.example/new';
    commitMainFrame(tab.url);release();expect(await rejected).toBeInstanceOf(Error);await flushBadgeQueue();
    expect(session[taskKey]).toBeUndefined();expect(session['tabError:'+tab.id]).toBeUndefined();
    expect(badgeCalls.some(call=>call.call==='text'&&call.text==='!')).toBe(false);
    expect(lastText()).toBe('');
  }finally{release();globalThis.chrome.storage.session.set=original;}
});

test('a queued newer clear wins and a stale document cannot clear a current failure',async()=>{
  await resetTaskPage();
  const previous=taskSender();
  currentDocumentId='current-document';
  const results=await Promise.all([reportTask(true,3),reportTask(false,4),reportTask(true,2)]);
  expect(results.at(-1)).toEqual({accepted:false});
  expect(lastText()).toBe('+');
  await reportTask(true,5);badgeCalls.length=0;
  await expect(reportTask(false,100,previous)).rejects.toThrow();
  expect(badgeCalls).toEqual([]);expect(session[taskKey].error).toBe(true);
  await reportTask(false,6);
});

test('task metadata stays session-only in incognito and is removed with a closed tab',async()=>{
  await resetTaskPage();tab.incognito=true;
  await reportTask(true,1);
  expect(stored[taskKey]).toBeUndefined();
  globalThis.chrome.tabs.onRemoved.listeners.forEach(listener=>listener(tab.id));
  await flushBadgeQueue();
  expect(session[taskKey]).toBeUndefined();expect(session['tabError:'+tab.id]).toBeUndefined();
  tab.incognito=false;
});


test('task recovery clears the toolbar when keyword hints are disabled',async()=>{
  await resetTaskPage();
  await send({type:'AUTOMATION_PATCH',tabId:tab.id,patch:{keywordHints:{badge:false,keywords:['docs'],dismissed:[]}}});
  await reportTask(true,Number.MAX_SAFE_INTEGER-1);
  expect(lastText()).toBe('!');
  await reportTask(false,Number.MAX_SAFE_INTEGER);
  expect(lastText()).toBe('');
  expect(badgeCalls.filter(call=>call.call==='title').at(-1)?.title).toBe('RelyLess');
  expect(session[taskKey].sequence).toBe(Number.MAX_SAFE_INTEGER);
});

test('navigation while an action write is pending removes the old task badge and metadata',async()=>{
  await resetTaskPage();
  const original=globalThis.chrome.action.setBadgeText;
  let entered,release;
  const ready=new Promise(resolve=>{entered=resolve;}),barrier=new Promise(resolve=>{release=resolve;});
  globalThis.chrome.action.setBadgeText=async options=>{
    if(options.text==='!'){entered();await barrier;}
    return original(options);
  };
  const pending=reportTask(true,1),rejected=pending.then(()=>null,error=>error);
  try{
    await ready;tab.url='https://plain.example/replaced';currentDocumentId='replacement-document';
    commitMainFrame(tab.url);release();expect(await rejected).toBeInstanceOf(Error);await flushBadgeQueue();
    expect(lastText()).toBe('');expect(session[taskKey]).toBeUndefined();
    expect(badgeCalls.filter(call=>call.call==='title').at(-1)?.title).toBe('RelyLess');
  }finally{release();globalThis.chrome.action.setBadgeText=original;}
});

test('overlapping navigations cannot strand ! after the first cleanup removed its metadata',async()=>{
  await resetTaskPage();await reportTask(true,1);
  const original=globalThis.chrome.storage.session.remove;
  let entered,release;
  const ready=new Promise(resolve=>{entered=resolve;}),barrier=new Promise(resolve=>{release=resolve;});
  let once=true;
  globalThis.chrome.storage.session.remove=async keys=>{
    await original(keys);
    if(once&&keys===taskKey){once=false;entered();await barrier;}
  };
  try{
    tab.url='https://plain.example/first';commitMainFrame(tab.url);await ready;
    tab.url='https://plain.example/second';commitMainFrame(tab.url);release();await flushBadgeQueue();
    expect(lastText()).toBe('');expect(session[taskKey]).toBeUndefined();
    expect(badgeCalls.filter(call=>call.call==='title').at(-1)?.title).toBe('RelyLess');
  }finally{release();globalThis.chrome.storage.session.remove=original;}
});


test('same-URL document replacement during session lookup cannot overwrite the previous task state',async()=>{
  await resetTaskPage();await reportTask(true,3);badgeCalls.length=0;
  const original=globalThis.chrome.storage.session.get;
  let entered,release;
  const ready=new Promise(resolve=>{entered=resolve;}),barrier=new Promise(resolve=>{release=resolve;});
  let once=true;
  globalThis.chrome.storage.session.get=async keys=>{
    const value=await original(keys);
    if(once&&keys===taskKey){once=false;entered();await barrier;}
    return value;
  };
  const pending=reportTask(false,4),rejected=pending.then(()=>null,error=>error);
  try{
    await ready;currentDocumentId='replacement-at-same-url';release();expect(await rejected).toBeInstanceOf(Error);
    expect(badgeCalls).toEqual([]);
    expect(session[taskKey]).toEqual({documentId:'activation-document',sequence:3,error:true});
  }finally{release();globalThis.chrome.storage.session.get=original;}
  await reportTask(false,1);
});

