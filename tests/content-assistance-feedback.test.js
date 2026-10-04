import {expect,test} from 'bun:test';
import {Window} from 'happy-dom';
import {readFileSync} from 'node:fs';

const source=name=>readFileSync(new URL('../extension/'+name,import.meta.url),'utf8');
const waitFor=async predicate=>{const deadline=Date.now()+1200;while(!predicate()){if(Date.now()>deadline)throw new Error('Assistance did not settle');await new Promise(resolve=>setTimeout(resolve,5));}};

async function withContent(run,{structure=false}={}){
  const window=new Window({url:'https://example.test/article'}),original=new Map(),handlers=new Map(),pending=[],shadows=new WeakMap();
  const rect={left:40,top:80,right:340,bottom:100,width:300,height:20,x:40,y:80};
  const globals={window,document:window.document,location:window.location,Node:window.Node,NodeFilter:window.NodeFilter,HTMLElement:window.HTMLElement,MutationObserver:window.MutationObserver,
    getComputedStyle:element=>({opacity:'1',display:element.tagName==='SPAN'?'inline':'block',visibility:'visible',contentVisibility:'visible',clip:'auto',clipPath:'none',overflowX:'visible',overflowY:'visible'}),
    matchMedia:()=>({addEventListener(){},removeEventListener(){}}),innerWidth:1000,innerHeight:800,scrollX:0,scrollY:0,
    requestAnimationFrame:callback=>setTimeout(callback,1),cancelAnimationFrame:clearTimeout,IntersectionObserver:class{observe(){}disconnect(){}},
    CSS:{supports:()=>false,highlights:new Map()},Highlight:class{},getSelection:()=>window.getSelection(),scrollTo:()=>{},
    ShisuiDesign:{cssFor:()=>'',structureRoles:{},structureColors:{}},ShisuiReadingStyle:{normalize:()=>({}),css:()=>''},
    ShisuiReview:{hide(){},refresh:()=>Promise.resolve()},ShisuiCopy:{onPointerTrack(){},copyParagraph(){}},ShisuiConversation:{openConversation:()=>Promise.resolve()}};
  for(const [key,value]of Object.entries(globals)){original.set(key,globalThis[key]);globalThis[key]=value;}
  for(const key of ['chrome','ShisuiContent'])original.set(key,globalThis[key]);
  const settings={assistanceMode:'on-demand',domain:'general',helpLanguage:'en',lookupDisplay:'annotation',hintDisplay:'direct',rulePacks:[]};
  let listener;
  globalThis.chrome={runtime:{id:'abc',getURL:path=>'chrome-extension://abc/'+path,sendMessage:(message,callback)=>{
    if(['ASSIST','WORD_PREFERENCE_SET','SENTENCE_GROUPS_BATCH'].includes(message.type)){pending.push({message,reply:callback});return;}
    callback({ok:true,data:message.type==='STATE_GET'?{settings,providerConfigured:true}:message.type==='SENTENCE_GROUPS_GET'?{enabled:structure,density:'medium',lineStyle:'solid'}:{}});
  },onMessage:{addListener:callback=>listener=callback,removeListener(){}}}};
  const capture=target=>{const add=target.addEventListener.bind(target);target.addEventListener=(type,callback,options)=>{handlers.set(callback.name,callback);add(type,callback,options);};};
  capture(window);capture(document);document.fonts||={addEventListener(){},removeEventListener(){}};
  window.HTMLElement.prototype.getClientRects=()=>[rect];window.HTMLElement.prototype.getBoundingClientRect=()=>rect;
  window.Range.prototype.getClientRects=()=>[rect];window.Range.prototype.getBoundingClientRect=()=>rect;
  const attach=window.HTMLElement.prototype.attachShadow;window.HTMLElement.prototype.attachShadow=function(options){const root=attach.call(this,options);shadows.set(this,root);return root;};
  const elementListeners=new WeakMap(),addElementListener=window.HTMLElement.prototype.addEventListener;window.HTMLElement.prototype.addEventListener=function(type,callback,options){let events=elementListeners.get(this);if(!events)elementListeners.set(this,events=new Map());events.set(type,callback);addElementListener.call(this,type,callback,options);};
  document.body.innerHTML='<main><p>The client retries with backoff.</p><nav><a href="/docs">Documentation</a></nav></main>';
  const paragraph=document.querySelector('p');
  document.caretRangeFromPoint=()=>{const mapping=ShisuiContent.textMap(paragraph),entry=mapping.nodes.find(item=>item.end>12),range=document.createRange();range.setStart(entry.node,12-entry.start);range.collapse(true);return range;};
  const event=(target=paragraph,extra={})=>({isTrusted:true,type:'click',button:0,detail:1,pointerId:1,clientX:80,clientY:90,target,preventDefault(){},stopImmediatePropagation(){},composedPath:()=>[target,document.body,document,window],...extra});
  const lookup=(target=paragraph)=>{handlers.get('onLookupKey')(event(target,{type:'keydown',key:'D',code:'KeyD'}));handlers.get('onHelpPointerDown')(event(target,{type:'pointerdown'}));handlers.get('onHelpClick')(event(target));handlers.get('onLookupKey')(event(target,{type:'keyup',key:'D',code:'KeyD'}));};
  try{
    delete globalThis.ShisuiContent;new Function(source('content/kernel.js'))();
    const state=ShisuiContent.state;state.enabled=true;state.settings=settings;state.providerConfigured=true;state.domainResolved=true;
    new Function(source('content.js'))();await new Promise(resolve=>setTimeout(resolve,0));
    await run({window,state,paragraph,pending,handlers,event,lookup,shadows,click:button=>{if(button.onclick)button.onclick(event(button));else{const action=elementListeners.get(button)?.get('click');if(action)action(event(button));else button.click();}},send:message=>new Promise(resolve=>listener(message,{id:'abc'},resolve))});
  }finally{
    for(const item of pending)item.reply({ok:false,error:'Test request cancelled'});
    for(const host of document.querySelectorAll('[data-shisui-ui="known-feedback"]'))[...shadows.get(host).querySelectorAll('button')].find(button=>button.textContent==='关闭')?.click();
    await new Promise(resolve=>setTimeout(resolve,0));window.__SHISUI_CONTENT__?.dispose();window.happyDOM.abort();
    for(const [key,value]of original){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}
  }
}

test('annotation lookup shows temporary loading and a retryable error without an unconfirmed hint',async()=>{
  await withContent(async({state,paragraph,pending,lookup})=>{
    lookup();expect(state.card.answer.textContent).toContain('正在查词');expect(paragraph.querySelector('.shisui-term-hint')).toBeNull();
    await waitFor(()=>pending.length===1);pending.shift().reply({ok:false,error:'服务额度不足。'});
    await waitFor(()=>state.card?.answer.classList.contains('error'));
    expect(state.card.answer.textContent).toContain('服务额度不足');expect(state.card.retry.hidden).toBe(false);
    expect(paragraph.querySelector('.shisui-term-hint')).toBeNull();
    state.card.retry.click();await waitFor(()=>pending.length===1);expect(state.card.answer.textContent).toContain('正在查词');
    state.card.card.querySelector('.dismiss').click();pending.shift().reply({ok:false,error:'迟到的服务错误'});await new Promise(resolve=>setTimeout(resolve,200));
    expect(state.card).toBeNull();expect(document.querySelector('[data-shisui-ui="card"]')).toBeNull();
  });
});

test('a late annotation failure after generation invalidation cannot create error UI',async()=>{
  await withContent(async({state,pending,lookup})=>{
    lookup();await waitFor(()=>pending.length===1);state.generation++;pending.shift().reply({ok:false,error:'迟到的服务错误'});
    await waitFor(()=>state.card===null);expect(document.querySelector('[data-shisui-ui="card"]')).toBeNull();
  });
});

test('the first over-limit body lookup error is visible beside its target',async()=>{
  await withContent(async({state,paragraph,lookup,pending})=>{
    paragraph.textContent=('The client retries with backoff. ').repeat(25);const range=document.createRange();range.selectNodeContents(paragraph);getSelection().addRange(range);
    lookup();expect(state.card.answer.textContent).toContain('600');expect(state.card.answer.classList.contains('error')).toBe(true);expect(state.card.host.style.left).toBe('80px');expect(pending.length).toBe(0);
  });
});

test('selection decomposition keeps loading and retryable failure local, and drops a dismissed retry',async()=>{
  await withContent(async({state,paragraph,pending,handlers,event,click})=>{
    const range=document.createRange();range.selectNodeContents(paragraph);getSelection().addRange(range);handlers.get('showPassageAction')(event(paragraph,{type:'pointerup'}));
    const button=[...document.querySelectorAll('[data-shisui-ui="passage-action"] button')].find(item=>item.textContent==='解构所选');expect(button).toBeDefined();click(button);
    expect(state.card.answer.textContent).toContain('正在解构');await waitFor(()=>pending.length===1);pending.shift().reply({ok:false,error:'解构服务不可用。'});
    await waitFor(()=>state.card?.answer.classList.contains('error'));expect(state.card.answer.textContent).toContain('解构服务不可用');expect(state.card.retry.hidden).toBe(false);
    state.card.retry.click();await waitFor(()=>pending.length===1);state.card.card.querySelector('.dismiss').click();pending.shift().reply({ok:false,error:'迟到的解构错误'});await new Promise(resolve=>setTimeout(resolve,0));expect(state.card).toBeNull();
  },{structure:true});
});

test('known save errors stay beside the originating button and do not change source text',async()=>{
  await withContent(async({state,paragraph,pending,lookup})=>{
    state.settings.lookupDisplay='card';lookup();await waitFor(()=>pending.length===1);
    pending.shift().reply({ok:true,data:{hint:'try again',sense:'repeat an attempt',source:'provider',support:{wordId:'retry-word',senseKey:'retry-sense'}}});
    await waitFor(()=>state.card?.confirmedDisplayed&&state.card.knownWordId());const view=state.card;view.known.click();await waitFor(()=>pending.length===1);pending.shift().reply({ok:false,error:'词条保存失败。'});
    await waitFor(()=>view.card.querySelector('[data-shisui-ui="known-error"]'));expect(view.known.disabled).toBe(false);expect(view.answer.textContent).toBe('try again');expect(view.card.querySelector('[role="alert"]').textContent).toContain('词条保存失败');
    expect(ShisuiContent.blockText(paragraph)).toBe('The client retries with backoff.');view.known.click();await waitFor(()=>pending.length===1);view.card.querySelector('.dismiss').click();pending.shift().reply({ok:false,error:'迟到的保存错误'});await new Promise(resolve=>setTimeout(resolve,0));expect(state.card).toBeNull();expect(document.querySelector('[data-shisui-ui="known-feedback"]')).toBeNull();
  });
});

test('known undo failure remains in its own feedback with retry, and dismissal suppresses late errors',async()=>{
  await withContent(async({state,pending,lookup,shadows})=>{
    state.settings.lookupDisplay='card';lookup();await waitFor(()=>pending.length===1);pending.shift().reply({ok:true,data:{hint:'try again',sense:'repeat an attempt',source:'provider',support:{wordId:'retry-word',senseKey:'retry-sense'}}});
    await waitFor(()=>state.card?.confirmedDisplayed&&state.card.knownWordId());state.card.known.click();await waitFor(()=>pending.length===1);pending.shift().reply({ok:true,data:{wordId:'retry-word',term:'retry'}});
    await waitFor(()=>document.querySelector('[data-shisui-ui="known-feedback"]'));const host=document.querySelector('[data-shisui-ui="known-feedback"]'),root=shadows.get(host),undo=[...root.querySelectorAll('button')].find(button=>button.textContent==='撤销');
    undo.click();await waitFor(()=>pending.length===1);pending.shift().reply({ok:false,error:'恢复失败测试。'});await waitFor(()=>!undo.disabled);expect(root.textContent).toContain('恢复失败测试');expect(host.isConnected).toBe(true);
    undo.click();await waitFor(()=>pending.length===1);[...root.querySelectorAll('button')].find(button=>button.textContent==='关闭').click();pending.shift().reply({ok:false,error:'迟到的恢复错误'});await new Promise(resolve=>setTimeout(resolve,0));expect(document.querySelector('[data-shisui-ui="known-feedback"]')).toBeNull();
  });
});

test('the first invalid navigation translation shows a closable error at the link',async()=>{
  await withContent(async({state,pending,lookup})=>{
    const link=document.querySelector('nav a');link.textContent='Documentation '.repeat(20);document.caretRangeFromPoint=()=>{const range=document.createRange();range.setStart(link.firstChild,5);range.collapse(true);return range;};
    lookup(link);expect(state.card.answer.textContent).toContain('链接文字超过 200 字符');expect(state.card.answer.classList.contains('error')).toBe(true);expect(pending.length).toBe(0);state.card.card.querySelector('.dismiss').click();expect(state.card).toBeNull();
  });
});

test('an invalid lookup gesture cannot show its first error after the captured generation changes',async()=>{
  await withContent(async({state,paragraph,handlers,event})=>{
    paragraph.textContent='123';handlers.get('onLookupKey')(event(paragraph,{type:'keydown',key:'D',code:'KeyD'}));handlers.get('onHelpPointerDown')(event(paragraph,{type:'pointerdown'}));state.generation++;handlers.get('onHelpClick')(event());expect(state.card).toBeNull();
  });
});

test('inline known save failure stays by its button and is removed when assistance is disabled',async()=>{
  await withContent(async({window,state,paragraph,pending,lookup})=>{
    state.settings.lookupDisplay='card';lookup();await waitFor(()=>pending.length===1);pending.shift().reply({ok:true,data:{hint:'try again',sense:'repeat an attempt',source:'provider',support:{wordId:'retry-word',senseKey:'retry-sense'}}});
    await waitFor(()=>state.card?.confirmedDisplayed&&state.card.knownWordId());const view=state.card,record=state.records[0],button=view.known;button.remove();view.card.querySelector('.dismiss').click();
    // Mount the existing action on its source annotation to exercise the inline save branch without passive analysis.
    record.wrapper.append(button);record.knownAction=button;button.click();await waitFor(()=>pending.length===1);pending.shift().reply({ok:false,error:'词条保存失败。'});
    await waitFor(()=>paragraph.querySelector('[data-shisui-ui="known-error"]'));expect(button.disabled).toBe(false);expect(button.nextElementSibling.textContent).toContain('词条保存失败');expect(ShisuiContent.blockText(paragraph)).toBe('The client retries with backoff.');
    window.__SHISUI_CONTENT__.dispose();expect(paragraph.querySelector('[data-shisui-ui="known-error"]')).toBeNull();expect(paragraph.textContent).toBe('The client retries with backoff.');
  });
});
