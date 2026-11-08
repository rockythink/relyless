import {expect,test} from 'bun:test';
import {Window} from 'happy-dom';
import {readFileSync} from 'node:fs';
import {serviceSetupNeeded} from '../extension/api-providers.mjs';
import {serviceCatalog} from '../extension/ui/options-service-catalog.js';
import {isolatedChrome,isolatedSend} from './helpers/chrome-fixture.js';

const fresh=()=>({settings:{providerKind:'chatgpt',apiServices:[],activeApiServiceId:''},providerConfigured:false,subscription:{connected:false,authenticated:false}});
const saved={id:'first',name:'DeepSeek',providerId:'deepseek',baseUrl:'https://api.deepseek.com',model:'fixture',apiKey:'fixture-key'};

test('only a user with nothing set up gets the first-run path',()=>{
  expect(serviceSetupNeeded(fresh())).toBe(true);
  expect(serviceSetupNeeded({...fresh(),providerConfigured:true})).toBe(false);
  // Someone who already chose a service sees a repair notice, not a welcome.
  expect(serviceSetupNeeded({...fresh(),settings:{providerKind:'api',apiServices:[{...saved,apiKey:''}]}})).toBe(false);
  expect(serviceSetupNeeded({...fresh(),settings:{providerKind:'grok',apiServices:[]}})).toBe(false);
  expect(serviceSetupNeeded({...fresh(),subscription:{connected:true,authenticated:false}})).toBe(false);
  expect(serviceSetupNeeded(null)).toBe(false);
});

function withCatalog(state,run){
  const browser=new Window({url:'chrome-extension://example/ui/options.html'});
  const previous={document:globalThis.document,optionsState:globalThis.optionsState,draft:globalThis.optionsStartDraftProvider,catalog:{...serviceCatalog}};
  browser.document.write(readFileSync('extension/ui/options.html','utf8'));
  globalThis.document=browser.document;globalThis.optionsState=state;
  const drafts=[];globalThis.optionsStartDraftProvider=id=>drafts.push(id);
  const restore=()=>{globalThis.document=previous.document;globalThis.optionsState=previous.optionsState;globalThis.optionsStartDraftProvider=previous.draft;Object.assign(serviceCatalog,previous.catalog);browser.close();};
  try{serviceCatalog.initialized=false;serviceCatalog.selectedKey='';serviceCatalog.userSelected=false;serviceCatalog.sync();run(browser.document,drafts);}finally{restore();}
}

test('first run opens on the connection choices instead of a connector error',()=>{
  withCatalog(fresh(),(document,drafts)=>{
    expect(document.querySelector('#service-start').hidden).toBe(false);
    expect(document.querySelector('.service-badge.is-default')).toBeNull();
    document.querySelector('[data-start-service="deepseek"]').click();
    expect(drafts).toEqual(['deepseek']);
    expect(document.querySelector('#service-start').hidden).toBe(true);
    // An unsaved provider has nothing to make default, and the user can still go back.
    expect(document.querySelector('#catalog-hero-set-default').hidden).toBe(true);
    expect(document.querySelector('#catalog-back-to-start').hidden).toBe(false);
    document.querySelector('#catalog-back-to-start').click();
    expect(document.querySelector('#service-start').hidden).toBe(false);
  });
});

test('a configured user never sees the connection choices',()=>{
  withCatalog({settings:{providerKind:'api',apiServices:[saved],activeApiServiceId:'first'},providerConfigured:true},document=>{
    expect(document.querySelector('#service-start').hidden).toBe(true);
    expect(document.querySelector('.service-badge.is-default')).not.toBeNull();
    expect(document.querySelector('#catalog-back-to-start').hidden).toBe(true);
  });
});

async function openPopup(state,tag){
  const previous={chrome:globalThis.chrome,document:globalThis.document};
  const window=new Window({url:'https://popup.example/',settings:{disableJavaScriptFileLoading:true,disableCSSFileLoading:true}});
  window.document.body.innerHTML=readFileSync(new URL('../extension/ui/popup.html',import.meta.url),'utf8');
  const sent=[];
  globalThis.document=window.document;
  globalThis.chrome={runtime:{async sendMessage(message){sent.push(message);return message.type==='STATE_GET'?{ok:true,data:state}:{ok:true,data:{automation:{allSites:false,sites:[]},siteRule:null}};}},storage:{onChanged:{addListener(){}}},tabs:{query:async()=>[{id:7,url:'https://docs.example/read'}],sendMessage:async()=>({ok:true,data:{enabled:false}})}};
  await import('../extension/ui/popup.js?first-run-'+tag);
  await new Promise(resolve=>setTimeout(resolve,0));
  return {document:window.document,sent,restore(){globalThis.chrome=previous.chrome;globalThis.document=previous.document;}};
}

test('popup leads a new user to connect a model and does not report a connector failure',async()=>{
  const popup=await openPopup({...fresh(),subscription:{connected:false,authenticated:false,error:'未找到或未授权本地 ChatGPT 连接器。'}},'new-user');
  try{
    expect(popup.document.querySelector('#setup-card').hidden).toBe(false);
    expect(popup.document.querySelector('#service-warning').hidden).toBe(true);
    popup.document.querySelector('#setup-connect').click();
    expect(popup.sent.at(-1)).toEqual({type:'OPEN_OPTIONS',section:'service'});
  }finally{popup.restore();}
});

test('popup shows the repair notice when a chosen service stops working',async()=>{
  const popup=await openPopup({settings:{providerKind:'api',apiServices:[{...saved,apiKey:''}],assistanceMode:'ambient'},providerConfigured:false,providerError:'服务拒绝访问。'},'repair');
  try{
    expect(popup.document.querySelector('#setup-card').hidden).toBe(true);
    expect(popup.document.querySelector('#service-warning').hidden).toBe(false);
    expect(popup.document.querySelector('#service-warning-copy').textContent).toBe('服务拒绝访问。');
  }finally{popup.restore();}
});

async function background(tag,contexts=[]){
  const fixture=isolatedChrome({wordSchemaVersion:5,productSchemaVersion:1,words:[]},{id:'first-run-'+tag});
  const opened=[],updated=[],optionsOpened=[];
  fixture.api.runtime.getContexts=async()=>contexts;
  fixture.api.runtime.openOptionsPage=async()=>{optionsOpened.push(true);};
  fixture.api.tabs.create=async value=>{opened.push(value.url);};
  fixture.api.tabs.update=async(id,value)=>{updated.push([id,value.url]);};
  fixture.api.windows={update:async()=>{}};
  const previous=globalThis.chrome;globalThis.chrome=fixture.api;
  await import('../extension/background.js?first-run-'+tag);
  return {fixture,opened,updated,optionsOpened,restore(){globalThis.chrome=previous;}};
}
const serviceUrl=id=>'chrome-extension://first-run-'+id+'/ui/options.html#service';

test('a fresh install opens model setup once; updates stay quiet',async()=>{
  const run=await background('install');
  try{
    const listeners=run.fixture.api.runtime.onInstalled.listeners;
    for(const listener of listeners)await listener({reason:'update'});
    await new Promise(resolve=>setTimeout(resolve,0));
    expect(run.opened).toEqual([]);
    for(const listener of listeners)await listener({reason:'install'});
    await new Promise(resolve=>setTimeout(resolve,0));
    expect(run.opened).toEqual([serviceUrl('install')]);
  }finally{run.restore();}
});

test('connect links reuse an open settings tab and only accept the known section',async()=>{
  const url='chrome-extension://first-run-reuse/ui/options.html#assistance';
  const run=await background('reuse',[{tabId:12,windowId:3,documentUrl:url},{tabId:13,windowId:3,documentUrl:'chrome-extension://first-run-reuse/ui/history.html'}]);
  try{
    await isolatedSend(run.fixture,{type:'OPEN_OPTIONS',section:'service'});
    expect(run.updated).toEqual([[12,serviceUrl('reuse')]]);
    expect(run.opened).toEqual([]);
    await isolatedSend(run.fixture,{type:'OPEN_OPTIONS',section:'privacy'});
    expect(run.updated).toHaveLength(1);
    expect(run.optionsOpened).toHaveLength(1);
  }finally{run.restore();}
});

test('asking for help with no model reports a distinct state without a diagnostic failure id',async()=>{
  const run=await background('unconfigured');
  try{
    const response=await new Promise(resolve=>run.fixture.messages.listeners.at(-1)({type:'PROVIDER_TEST'},{id:run.fixture.id,url:'chrome-extension://first-run-unconfigured/ui/options.html'},resolve));
    expect(response.ok).toBe(false);
    expect(response.code).toBe('NOT_CONFIGURED');
    expect(response.error).toContain('还没有连接模型');
  }finally{run.restore();}
});
