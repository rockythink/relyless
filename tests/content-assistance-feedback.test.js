import {expect,test} from 'bun:test';
import {Window} from 'happy-dom';
import {readFileSync} from 'node:fs';

const source=name=>readFileSync(new URL('../extension/'+name,import.meta.url),'utf8');
const waitFor=async predicate=>{const deadline=Date.now()+1200;while(!await predicate()){if(Date.now()>deadline)throw new Error('Assistance did not settle');await new Promise(resolve=>setTimeout(resolve,5));}};

async function withContent(run,{structure=false,lookupDisplay='annotation',observe=false}={}){
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
  const settings={assistanceMode:'on-demand',domain:'general',helpLanguage:'en',lookupDisplay,hintDisplay:'direct',rulePacks:[]};
  let listener;
  globalThis.chrome={runtime:{id:'abc',getURL:path=>'chrome-extension://abc/'+path,sendMessage:(message,callback)=>{
    if(['ASSIST','WORD_PREFERENCE_SET','PASSAGE_TRANSLATE','SENTENCE_GROUPS_BATCH','EMERGENCY_TRANSLATE'].includes(message.type)){pending.push({message,reply:callback});return;}
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
  const event=(target=paragraph,extra={})=>({isTrusted:true,type:'click',button:0,detail:1,pointerId:1,clientX:80,clientY:90,target,preventDefault(){},stopImmediatePropagation(){},stopPropagation(){},composedPath:()=>[target,document.body,document,window],...extra});
  const lookup=(target=paragraph)=>{handlers.get('onLookupKey')(event(target,{type:'keydown',key:'D',code:'KeyD'}));handlers.get('onHelpPointerDown')(event(target,{type:'pointerdown'}));handlers.get('onHelpClick')(event(target));handlers.get('onLookupKey')(event(target,{type:'keyup',key:'D',code:'KeyD'}));};
  try{
    delete globalThis.ShisuiContent;new Function(source('content/kernel.js'))();
    const state=ShisuiContent.state;state.enabled=true;state.settings=settings;state.providerConfigured=true;state.domainResolved=true;
    new Function(source('content.js'))();await new Promise(resolve=>setTimeout(resolve,0));
    if(observe){state.enabled=false;await new Promise(resolve=>listener({type:'SS_SET_ENABLED',enabled:true},{id:'abc'},resolve));}
    await run({window,state,paragraph,pending,handlers,event,lookup,shadows,click:button=>{if(button.onclick)button.onclick(event(button));else{const action=elementListeners.get(button)?.get('click');if(action)action(event(button));else button.click();}},send:(message,sender={id:'abc'})=>new Promise(resolve=>{if(listener(message,sender,resolve)!==true)resolve();})});
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

test('closing a pending help card clears its task before a late result and preserves a newer lookup',async()=>{
  await withContent(async({state,pending,lookup,send})=>{
    lookup();await waitFor(()=>pending.length===1);const old=pending.shift();
    expect((await send({type:'SS_STATUS'})).data.tasks).toContainEqual({key:'lookup',text:'正在获取帮助',error:false,busy:true});
    state.card.card.querySelector('.dismiss').click();
    expect((await send({type:'SS_STATUS'})).data.tasks.some(task=>task.key==='lookup')).toBe(false);
    state.settings.lookupDisplay='annotation';lookup();await waitFor(()=>pending.length===1);const current=state.card;
    old.reply({ok:false,error:'迟到的卡片错误'});await new Promise(resolve=>setTimeout(resolve,200));
    expect(state.card).toBe(current);expect((await send({type:'SS_STATUS'})).data.tasks.find(task=>task.key==='lookup')?.busy).toBe(true);
    pending.shift().reply({ok:false,error:'当前查词失败'});await waitFor(()=>state.card.answer.classList.contains('error'));
    expect((await send({type:'SS_STATUS'})).data.tasks.find(task=>task.key==='lookup')?.error).toBe(true);
  },{lookupDisplay:'card'});
});

test('a late dismissed annotation cannot clear a newer help card task',async()=>{
  await withContent(async({state,pending,lookup,send})=>{
    lookup();await waitFor(()=>pending.length===1);const old=pending.shift();state.card.card.querySelector('.dismiss').click();
    state.settings.lookupDisplay='card';lookup();await waitFor(()=>pending.length===1);const current=state.card;
    old.reply({ok:false,error:'迟到的词注错误'});await new Promise(resolve=>setTimeout(resolve,200));
    expect(state.card).toBe(current);expect((await send({type:'SS_STATUS'})).data.tasks.find(task=>task.key==='lookup')?.busy).toBe(true);
  });
});

test('partial page translation failures retain successes and retry controls while reporting an error until recovery',async()=>{
  await withContent(async({paragraph,pending,send,click})=>{
    const second=document.createElement('p');second.textContent='The server preserves the original reading context.';paragraph.after(second);
    expect((await send({type:'SS_EMERGENCY_START',token:'token',resume:false})).ok).toBe(true);await waitFor(()=>pending.length===1);
    const batch=pending.shift(),[success,failure]=batch.message.items;expect(batch.message.items.length).toBe(2);
    batch.reply({ok:true,data:{items:[{id:success.id,translation:'已确认的译文。'}],errors:[{id:failure.id,code:'MODEL_FORMAT'}]}});
    await waitFor(()=>!ShisuiContent.state.emergency.running);
    const status=(await send({type:'SS_STATUS'})).data;expect(status.emergency.phase).toBe('partial');expect(status.emergency.completed).toBe(1);expect(status.emergency.failed).toBe(1);
    expect(status.tasks.find(task=>task.key==='emergency')?.error).toBe(true);
    const translated=paragraph.querySelector('[data-shisui-ui="emergency-translation"]');expect(translated.textContent).toContain('已确认的译文');
    const retry=second.querySelector('button');expect(retry.textContent).toBe('重试这一段');click(retry);await waitFor(()=>pending.length===1);
    const resumed=pending.shift();expect(resumed.message.items.map(item=>item.text)).toEqual([second.firstChild.textContent]);
    resumed.reply({ok:true,data:{items:resumed.message.items.map(item=>({id:item.id,translation:'重试成功的译文。'})),errors:[]}});await waitFor(()=>!ShisuiContent.state.emergency.running);
    expect(paragraph.querySelector('[data-shisui-ui="emergency-translation"]')).toBe(translated);expect(second.querySelector('button')).toBeNull();
    const recovered=(await send({type:'SS_STATUS'})).data;expect(recovered.emergency.phase).toBe('complete');expect(recovered.tasks.find(task=>task.key==='emergency')?.error).toBe(false);
  });
});

test('trusted same-document navigation clears old tasks and rejects late help results without new passive work',async()=>{
  await withContent(async({window,state,pending,lookup,send})=>{
    lookup();await waitFor(()=>pending.length===1);const old=pending.shift(),generation=state.generation,sequence=state.taskSequence;
    window.history.pushState({},'', '/next');await send({type:'SS_PAGE_NAVIGATION',pageUrl:location.href});
    expect(Boolean(state.card)).toBe(false);expect(state.generation).toBeGreaterThan(generation);expect(state.page).toBe(location.href);
    expect((await send({type:'SS_STATUS'})).data.tasks).toEqual([]);expect(state.taskSequence).toBeGreaterThan(sequence);
    const reconciledGeneration=state.generation;await send({type:'SS_PAGE_NAVIGATION',pageUrl:location.href});expect(state.generation).toBe(reconciledGeneration);
    old.reply({ok:false,error:'旧页面迟到错误'});await new Promise(resolve=>setTimeout(resolve,200));
    expect((await send({type:'SS_STATUS'})).data.tasks).toEqual([]);expect(state.card).toBeNull();expect(pending).toEqual([]);
  },{lookupDisplay:'card'});
});

test('stale, oversized, and untrusted navigation messages cannot invalidate current assistance',async()=>{
  await withContent(async({window,state,pending,lookup,send})=>{
    lookup();await waitFor(()=>pending.length===1);const card=state.card,generation=state.generation,oldPage=location.href;
    window.history.replaceState({},'', '/next');
    for(const [message,sender]of [
      [{type:'SS_PAGE_NAVIGATION',pageUrl:oldPage},{id:'abc'}],
      [{type:'SS_PAGE_NAVIGATION',pageUrl:location.href},{id:'other'}],
      [{type:'SS_PAGE_NAVIGATION',pageUrl:location.href},{id:'abc',tab:{id:1}}],
      [{type:'SS_PAGE_NAVIGATION',pageUrl:'x'.repeat(8193)},{id:'abc'}],
      [{type:'SS_PAGE_NAVIGATION',pageUrl:42},{id:'abc'}],
    ]){await send(message,sender);expect(state.card).toBe(card);expect(state.generation).toBe(generation);}
    window.history.replaceState({},'',oldPage);
    expect((await send({type:'SS_STATUS'})).data.tasks.find(task=>task.key==='lookup')?.busy).toBe(true);
  },{lookupDisplay:'card'});
});

test('an immediate status request reconciles a changed URL before returning old page failures',async()=>{
  await withContent(async({window,state,pending,lookup,send})=>{
    lookup();await waitFor(()=>pending.length===1);pending.shift().reply({ok:false,error:'旧页面帮助失败'});await waitFor(()=>state.card.answer.classList.contains('error'));
    const generation=state.generation;window.history.pushState({},'', '/next');const status=(await send({type:'SS_STATUS'})).data;
    expect(status.tasks).toEqual([]);expect(state.card).toBeNull();expect(state.generation).toBeGreaterThan(generation);expect(state.page).toBe(location.href);expect(pending).toEqual([]);
  },{lookupDisplay:'card'});
});

test('model help failures persist beyond informational timers and clear through retry or dismissal',async()=>{
  await withContent(async({state,pending,lookup,send})=>{
    lookup();await waitFor(()=>pending.length===1);pending.shift().reply({ok:false,error:'服务额度不足。'});await waitFor(()=>state.card.answer.classList.contains('error'));
    const now=Date.now;Date.now=()=>now()+86400000;
    try{
      ShisuiContent.hooks.setTaskStatus('copy','复制失败',{error:true,duration:1});
      await waitFor(async()=>!(await send({type:'SS_STATUS'})).data.tasks.some(task=>task.key==='copy'));
      expect((await send({type:'SS_STATUS'})).data.tasks.find(task=>task.key==='lookup')?.error).toBe(true);expect(state.card.retry.hidden).toBe(false);
    }finally{Date.now=now;}
    state.card.retry.click();await waitFor(()=>pending.length===1);const retrying=(await send({type:'SS_STATUS'})).data.tasks.find(task=>task.key==='lookup');expect(retrying.error).toBe(false);expect(retrying.busy).toBe(true);
    state.card.card.querySelector('.dismiss').click();expect((await send({type:'SS_STATUS'})).data.tasks.some(task=>task.key==='lookup')).toBe(false);
    pending.shift().reply({ok:false,error:'已关闭的重试失败'});await new Promise(resolve=>setTimeout(resolve,200));expect((await send({type:'SS_STATUS'})).data.tasks).toEqual([]);
  },{lookupDisplay:'card'});
});

test('closing a failed passage panel clears its error task',async()=>{
  await withContent(async({paragraph,pending,send,click})=>{
    const range=document.createRange();range.selectNodeContents(paragraph);
    const operation=ShisuiContent.hooks.translatePassage(ShisuiContent.hooks.passageTarget(range));
    await waitFor(()=>pending.length===1);pending.shift().reply({ok:false,error:'段落翻译失败'});await operation;
    const panel=document.querySelector('[data-shisui-ui="passage-translation"]');
    expect((await send({type:'SS_STATUS'})).data.tasks.find(task=>task.key==='passage')?.error).toBe(true);
    click(panel.querySelector('button'));expect(panel.isConnected).toBe(false);
    expect((await send({type:'SS_STATUS'})).data.tasks.some(task=>task.key==='passage')).toBe(false);
  });
});

for(const phase of ['pending','failed'])test('closing an older failed passage preserves a newer '+phase+' translation',async()=>{
  await withContent(async({paragraph,pending,send,click})=>{
    const translate=()=>{const range=document.createRange();range.selectNodeContents(paragraph);return ShisuiContent.hooks.translatePassage(ShisuiContent.hooks.passageTarget(range));};
    const first=translate();await waitFor(()=>pending.length===1);pending.shift().reply({ok:false,error:'第一次翻译失败'});await first;
    const old=document.querySelector('[data-shisui-ui="passage-translation"]');
    const second=translate();await waitFor(()=>pending.length===1);const request=pending.shift();
    if(phase==='failed'){request.reply({ok:false,error:'当前翻译失败'});await second;}
    click(old.querySelector('button'));
    const active=(await send({type:'SS_STATUS'})).data.tasks.find(task=>task.key==='passage');
    expect(phase==='pending'?active?.busy:active?.error).toBe(true);
    if(phase==='pending'){request.reply({ok:false,error:'当前翻译失败'});await second;}
    click(document.querySelector('[data-shisui-ui="passage-translation"] button'));
    expect((await send({type:'SS_STATUS'})).data.tasks.some(task=>task.key==='passage')).toBe(false);
  });
});

test('dismissing failed known-word undo clears its task',async()=>{
  await withContent(async({state,pending,lookup,send,shadows})=>{
    lookup();await waitFor(()=>pending.length===1);pending.shift().reply({ok:true,data:{hint:'try again',sense:'repeat an attempt',source:'provider',support:{wordId:'retry-word',senseKey:'retry-sense'}}});
    await waitFor(()=>state.card?.knownWordId());state.card.known.click();await waitFor(()=>pending.length===1);pending.shift().reply({ok:true,data:{wordId:'retry-word',term:'retries'}});
    await waitFor(()=>document.querySelector('[data-shisui-ui="known-feedback"]'));
    const host=document.querySelector('[data-shisui-ui="known-feedback"]'),shadow=shadows.get(host);
    [...shadow.querySelectorAll('button')].find(button=>button.textContent==='撤销').click();
    await waitFor(()=>pending.length===1);pending.shift().reply({ok:false,error:'撤销保存失败'});
    await waitFor(()=>shadow.querySelector('[role="alert"]'));
    expect((await send({type:'SS_STATUS'})).data.tasks.find(task=>task.key==='known')?.error).toBe(true);
    [...shadow.querySelectorAll('button')].find(button=>button.textContent==='关闭').click();expect(host.isConnected).toBe(false);
    expect((await send({type:'SS_STATUS'})).data.tasks.some(task=>task.key==='known')).toBe(false);
  },{lookupDisplay:'card'});
});

test('repeating a transient notice restarts its expiry without discarding its error',async()=>{
  await withContent(async({send})=>{
    const now=Date.now,base=now();let elapsed=0;Date.now=()=>base+elapsed;
    try{
      ShisuiContent.hooks.setTaskStatus('lookup','请点击英文词语',{error:true,duration:3000});elapsed=2000;
      ShisuiContent.hooks.setTaskStatus('lookup','请点击英文词语',{error:true,duration:3000});elapsed=3100;
      ShisuiContent.hooks.setTaskStatus('copy','原文已复制',{duration:1});
      expect((await send({type:'SS_STATUS'})).data.tasks.find(task=>task.key==='lookup')?.error).toBe(true);
      elapsed=5100;ShisuiContent.hooks.setTaskStatus('copy','再次复制',{duration:1});
      expect((await send({type:'SS_STATUS'})).data.tasks.some(task=>task.key==='lookup')).toBe(false);
    }finally{Date.now=now;}
  });
});

test("a failed passage remains an error while another translation is pending and after it succeeds",async()=>{
  await withContent(async({paragraph,pending,send,click})=>{
    const translate=()=>{const range=document.createRange();range.selectNodeContents(paragraph);return ShisuiContent.hooks.translatePassage(ShisuiContent.hooks.passageTarget(range));};
    const first=translate();await waitFor(()=>pending.length===1);const failed=pending.shift(),failedPanel=document.querySelector("[data-shisui-ui=passage-translation]");
    const second=translate();await waitFor(()=>pending.length===1);const successful=pending.shift();
    failed.reply({ok:false,error:"第一段失败"});await first;
    expect((await send({type:"SS_STATUS"})).data.tasks.find(task=>task.key==="passage")?.error).toBe(true);
    successful.reply({ok:true,data:{items:[{id:"p1",translation:"客户端使用退避重试。"}]}});await second;
    expect((await send({type:"SS_STATUS"})).data.tasks.find(task=>task.key==="passage")?.error).toBe(true);
    click(failedPanel.querySelector("button"));
    expect((await send({type:"SS_STATUS"})).data.tasks.some(task=>task.key==="passage")).toBe(false);
  });
});

for(const newer of [false,true])test("closing a failed known-word save "+(newer?"preserves a newer error":"clears its error"),async()=>{
  await withContent(async({state,pending,lookup,send})=>{
    lookup();await waitFor(()=>pending.length===1);pending.shift().reply({ok:true,data:{hint:"try again",sense:"repeat an attempt",source:"provider",support:{wordId:"retry-word",senseKey:"retry-sense"}}});
    await waitFor(()=>state.card?.knownWordId());const view=state.card;view.known.click();
    await waitFor(()=>pending.length===1);pending.shift().reply({ok:false,error:"保存失败"});
    await waitFor(()=>view.card.querySelector("[data-shisui-ui=known-error]"));
    expect((await send({type:"SS_STATUS"})).data.tasks.find(task=>task.key==="known")?.error).toBe(true);
    if(newer)ShisuiContent.hooks.setTaskStatus("known","较新的保存错误",{error:true});
    view.card.querySelector(".dismiss").click();
    const remaining=(await send({type:"SS_STATUS"})).data.tasks.find(task=>task.key==="known");
    if(newer)expect(remaining?.text).toBe("较新的保存错误");else expect(remaining).toBeUndefined();
  },{lookupDisplay:"card"});
});

for(const secondFails of [false,true])test("a different inline known-word save "+(secondFails?"can be retried without hiding the first failure":"succeeds without hiding the first failure"),async()=>{
  await withContent(async({state,paragraph,pending,lookup,send})=>{
    const prepare=async(wordId)=>{state.settings.lookupDisplay="card";lookup();await waitFor(()=>pending.length===1);pending.shift().reply({ok:true,data:{hint:"try again",sense:"current use",source:"provider",support:{wordId,senseKey:wordId+"-sense"}}});await waitFor(()=>state.card?.knownWordId()===wordId);const view=state.card,record=state.records.find(record=>record.target.wordId===wordId),button=view.known;button.remove();view.card.querySelector(".dismiss").click();record.wrapper.append(button);record.knownAction=button;return button;};
    const first=await prepare("retry-word");first.click();await waitFor(()=>pending.length===1);pending.shift().reply({ok:false,error:"第一个词保存失败"});await waitFor(()=>first.parentElement.querySelector("[data-shisui-ui=known-error]"));
    document.caretRangeFromPoint=()=>{const map=ShisuiContent.textMap(paragraph),entry=map.nodes.find(item=>item.end>24),range=document.createRange();range.setStart(entry.node,24-entry.start);range.collapse(true);return range;};
    const second=await prepare("backoff-word");second.click();await waitFor(()=>pending.length===1);
    expect((await send({type:"SS_STATUS"})).data.tasks.find(task=>task.key==="known")?.error).toBe(true);
    if(secondFails){pending.shift().reply({ok:false,error:"第二个词保存失败"});await waitFor(()=>second.parentElement.querySelector("[data-shisui-ui=known-error]"));second.click();await waitFor(()=>pending.length===1);expect((await send({type:"SS_STATUS"})).data.tasks.find(task=>task.key==="known")?.text).toContain("第一个词保存失败");}
    pending.shift().reply({ok:true,data:{wordId:"backoff-word",term:"backoff"}});await waitFor(()=>state.knownWords.has("backoff-word"));
    expect(first.parentElement.querySelector("[data-shisui-ui=known-error]").textContent).toContain("第一个词保存失败");
    expect((await send({type:"SS_STATUS"})).data.tasks.find(task=>task.key==="known")?.text).toContain("第一个词保存失败");
    window.__SHISUI_CONTENT__.dispose();expect(document.querySelector("[data-shisui-ui=known-feedback]")).toBeNull();expect(document.querySelector("[data-shisui-ui=known-error]")).toBeNull();
  });
});

for(const keepOther of [false,true])test('host removal of a failed passage '+(keepOther?'preserves another visible failure':'clears its vanished error'),async()=>{
  await withContent(async({paragraph,pending,send})=>{
    const translate=()=>{const range=document.createRange();range.selectNodeContents(paragraph);return ShisuiContent.hooks.translatePassage(ShisuiContent.hooks.passageTarget(range));};
    const first=translate();await waitFor(()=>pending.length===1);pending.shift().reply({ok:false,error:'第一处失败'});await first;const panel=document.querySelector('[data-shisui-ui=passage-translation]');
    if(keepOther){const second=translate();await waitFor(()=>pending.length===1);pending.shift().reply({ok:false,error:'第二处失败'});await second;}
    panel.remove();await new Promise(resolve=>setTimeout(resolve,20));expect(ShisuiContent.blockText(paragraph)).toBe('The client retries with backoff.');expect((await send({type:'SS_STATUS'})).data.tasks.some(task=>task.key==='passage'&&task.error)).toBe(keepOther);
  },{observe:true});
});

for(const retry of [false,true])test('failed navigation translation can be '+(retry?'retried locally':'closed locally'),async()=>{
  await withContent(async({state,pending,send,click})=>{
    const link=document.querySelector('nav a'),range=document.createRange();range.selectNodeContents(link);const operation=ShisuiContent.hooks.translatePassage(ShisuiContent.hooks.passageTarget(range));
    await waitFor(()=>pending.length===1);pending.shift().reply({ok:false,error:'导航翻译失败'});await operation;await waitFor(()=>state.card?.answer.classList.contains('error'));
    expect(state.card.answer.textContent).toContain('导航翻译失败');expect((await send({type:'SS_STATUS'})).data.tasks.find(task=>task.key==='passage')?.error).toBe(true);
    if(retry){click(state.card.retry);await waitFor(()=>pending.length===1);expect((await send({type:'SS_STATUS'})).data.tasks.find(task=>task.key==='passage')?.busy).toBe(true);pending.shift().reply({ok:true,data:{items:[{id:'p1',translation:'文档'}]}});await waitFor(()=>link.querySelector('[data-shisui-ui=passage-translation]')?.textContent==='文档');expect((await send({type:'SS_STATUS'})).data.tasks.some(task=>task.error)).toBe(false);}
    else{click(state.card.card.querySelector('.dismiss'));expect(document.querySelector('[data-shisui-ui=passage-translation]')).toBeNull();expect((await send({type:'SS_STATUS'})).data.tasks.some(task=>task.key==='passage')).toBe(false);}
    expect(link.getAttribute('href')).toBe('/docs');expect(ShisuiContent.blockText(link)).toBe('Documentation');
  });
});

test('host removal of a failed inline known-word action clears its vanished error',async()=>{
  await withContent(async({state,pending,lookup,send})=>{
    state.settings.lookupDisplay='card';lookup();await waitFor(()=>pending.length===1);pending.shift().reply({ok:true,data:{hint:'try again',sense:'repeat',source:'provider',support:{wordId:'retry-word',senseKey:'retry-sense'}}});await waitFor(()=>state.card?.knownWordId());
    const view=state.card,record=state.records[0],button=view.known;button.remove();view.card.querySelector('.dismiss').click();record.wrapper.append(button);record.knownAction=button;button.click();await waitFor(()=>pending.length===1);pending.shift().reply({ok:false,error:'保存失败'});await waitFor(()=>record.wrapper.querySelector('[data-shisui-ui=known-error]'));
    record.wrapper.remove();await new Promise(resolve=>setTimeout(resolve,20));expect((await send({type:'SS_STATUS'})).data.tasks.some(task=>task.key==='known')).toBe(false);
  },{observe:true});
});

test("host removal of a navigation failure removes its recovery card and error",async()=>{
  await withContent(async({state,pending,send})=>{
    const link=document.querySelector("nav a"),range=document.createRange();range.selectNodeContents(link);const operation=ShisuiContent.hooks.translatePassage(ShisuiContent.hooks.passageTarget(range));await waitFor(()=>pending.length===1);pending.shift().reply({ok:false,error:"导航失败"});await operation;expect(state.card?.answer.textContent).toBe("导航失败");
    link.querySelector("[data-shisui-ui=passage-translation]").remove();await waitFor(()=>state.card===null);expect((await send({type:"SS_STATUS"})).data.tasks.some(task=>task.key==="passage")).toBe(false);expect(link.textContent).toBe("Documentation");
  },{observe:true});
});
