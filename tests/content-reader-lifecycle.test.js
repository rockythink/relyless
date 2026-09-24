import {expect,test} from 'bun:test';
import {Window} from 'happy-dom';
import {readFileSync} from 'node:fs';

const source=name=>readFileSync(new URL('../extension/'+name,import.meta.url),'utf8');

test('a late initial state cannot reopen a reader after an explicit exit',async()=>{
  const window=new Window({url:'https://example.test/article'});
  const original=new Map();
  const globals={window,document:window.document,location:window.location,Node:window.Node,NodeFilter:window.NodeFilter,HTMLElement:window.HTMLElement,MutationObserver:window.MutationObserver,
    getComputedStyle:()=>({opacity:'1',display:'block',visibility:'visible',contentVisibility:'visible',clip:'auto',clipPath:'none',overflowX:'visible',overflowY:'visible'}),
    matchMedia:()=>({addEventListener(){},removeEventListener(){}}),innerWidth:1000,innerHeight:800,scrollX:0,scrollY:0,
    requestAnimationFrame:callback=>setTimeout(callback,1),cancelAnimationFrame:clearTimeout,
    IntersectionObserver:class{observe(){}disconnect(){}},CSS:{highlights:new Map()},Highlight:class{},getSelection:()=>window.getSelection(),scrollTo:()=>{},
    ShisuiDesign:{cssFor:()=>'',structureRoles:{},structureColors:{}},ShisuiReadingStyle:{normalize:()=>({}),css:()=>''},
    ShisuiReview:{hide(){},refresh(){return Promise.resolve()}},ShisuiCopy:{onPointerTrack(){},copyParagraph(){}},ShisuiConversation:{}};
  for(const [key,value] of Object.entries(globals)){original.set(key,globalThis[key]);globalThis[key]=value;}
  for(const key of ['chrome','ShisuiContent','ShisuiReader'])original.set(key,globalThis[key]);
  let reply,releaseState;const pendingState=new Promise(resolve=>releaseState=resolve),messages=[];
  let listener;document.fonts||={addEventListener(){},removeEventListener(){}};
  globalThis.chrome={runtime:{id:'abc',getURL:path=>'chrome-extension://abc/'+path,
    sendMessage:(message,callback)=>{messages.push(message.type);if(message.type==='STATE_GET')pendingState.then(()=>callback({ok:true,data:{settings:{assistanceMode:'on-demand',domain:'auto',rulePacks:[]},providerConfigured:false,emergencyActive:false}}));else if(message.type==='READER_TRANSLATION_ESTIMATE')callback({ok:true,data:{estimate:120}});else if(message.type==='READER_TRANSLATION_BEGIN')callback({ok:true,data:{token:'reader-token'}});else if(message.type==='EMERGENCY_TRANSLATE')callback({ok:true,data:{items:message.items.map(item=>({id:item.id,translation:'这是对应的中文译文。'})),errors:[]}});else callback({ok:true,data:{enabled:false}});},
    onMessage:{addListener:callback=>listener=callback,removeListener(){}}}};
  try{
    window.HTMLElement.prototype.getClientRects=function(){return [{width:100,height:20}]};
    window.HTMLElement.prototype.showPopover=function(){};
    window.HTMLElement.prototype.hidePopover=function(){};
    document.body.innerHTML='<main><article><h1>Original article</h1><p>'+('The original prose remains on the page. ').repeat(30)+'</p><p>'+('A second paragraph preserves the author’s words. ').repeat(30)+'</p></article></main>';
    for(const name of ['content/kernel.js','content/reader.js','content.js'])new Function(source(name))();
    const send=(message,sender={id:'abc',url:'chrome-extension://abc/ui/popup.html'})=>new Promise(resolve=>listener(message,sender,resolve));
    const enter=send({type:'SS_READER_SET',enabled:true,pageUrl:location.href});
    const exit=await send({type:'SS_READER_SET',enabled:false,pageUrl:location.href});
    releaseState();
    reply=await enter;
    expect(reply.data.reader.active).toBe(false);
    expect(exit.data.reader.active).toBe(false);
    expect(ShisuiReader.active()).toBe(false);
    const active=await send({type:'SS_READER_SET',enabled:true,pageUrl:location.href});
    expect(active.data.reader.active).toBe(true);
    expect(document.querySelector('main').inert).toBe(true);
    const count=await send({type:'SS_EMERGENCY_COUNT'});expect(count.data.chars).toBeGreaterThan(200);
    const toolbar=document.querySelector('[data-shisui-ui="reader"] .reader-toolbar'),button=[...toolbar.querySelectorAll('button')].find(item=>item.textContent==='翻译本页');
    button.click();await new Promise(resolve=>setTimeout(resolve,0));expect(button.textContent).toBe('确认并翻译');expect(messages).not.toContain('EMERGENCY_TRANSLATE');
    button.click();await new Promise(resolve=>setTimeout(resolve,20));expect(button.textContent).toBe('停止翻译');expect(messages).toContain('READER_TRANSLATION_BEGIN');
    expect(document.querySelector('[data-shisui-ui="emergency-translation"]')?.textContent).toContain('中文译文');
    await send({type:'SS_READER_SET',enabled:false,pageUrl:location.href});
    expect(document.querySelector('main').inert).toBe(false);
    expect(messages.some(type=>['ANALYZE','SUPPORT_BATCH','PREPARED_SUPPORT','HISTORY_BEGIN','SENTENCE_GROUPS_BATCH'].includes(type))).toBe(false);
    const original=await send({type:'SS_EMERGENCY_START',token:'original-token',resume:false});
    expect(original.ok).toBe(true);await new Promise(resolve=>setTimeout(resolve,20));
    const sourceTranslations=document.querySelectorAll('main [data-shisui-ui="emergency-translation"]');
    expect(sourceTranslations.length).toBeGreaterThan(0);
    const withPageTranslation=await send({type:'SS_READER_SET',enabled:true,pageUrl:location.href});
    expect(withPageTranslation.data.reader.active).toBe(true);
    expect(document.querySelectorAll('main [data-shisui-ui="emergency-translation"]').length).toBe(sourceTranslations.length);
    const readerButton=[...document.querySelectorAll('[data-shisui-ui="reader"] .reader-toolbar button')].find(item=>item.textContent==='翻译本页');
    readerButton.click();await new Promise(resolve=>setTimeout(resolve,0));readerButton.click();await new Promise(resolve=>setTimeout(resolve,20));
    expect(document.querySelector('[data-shisui-ui="reader"] [data-shisui-ui="emergency-translation"]')?.textContent).toContain('中文译文');
    [...document.querySelectorAll('[data-shisui-ui="reader"] .reader-toolbar button')].find(item=>item.textContent==='返回原文').click();
    expect(document.querySelectorAll('main [data-shisui-ui="emergency-translation"]').length).toBe(sourceTranslations.length);
    await send({type:'SS_READER_SET',enabled:false,pageUrl:location.href});
    expect(document.querySelector('main [data-shisui-ui="emergency-translation"]')?.textContent).toContain('中文译文');
    expect((await send({type:'SS_STATUS'})).data.emergency.phase).toBe('stopped');
    const firstTranslation=document.querySelector('main [data-shisui-ui="emergency-translation"]');
    await send({type:'SS_REFRESH'});
    expect(document.querySelector('main [data-shisui-ui="emergency-translation"]')).toBe(firstTranslation);
    const resumed=await send({type:'SS_EMERGENCY_START',token:'resumed-token',resume:true});
    expect(resumed.data.emergency.active).toBe(true);
    expect(document.querySelector('main [data-shisui-ui="emergency-translation"]')).toBe(firstTranslation);
    await send({type:'SS_EMERGENCY_END'});
    const reopened=await send({type:'SS_READER_SET',enabled:true,pageUrl:location.href});
    expect(reopened.data.reader.active).toBe(true);
    document.querySelector('[data-shisui-ui="reader"]').remove();
    await new Promise(resolve=>setTimeout(resolve,20));
    expect((await send({type:'SS_STATUS'})).data.reader.active).toBe(false);
    expect(document.querySelector('main').inert).toBe(false);
  }finally{
    releaseState();window.__SHISUI_CONTENT__?.dispose();window.happyDOM.abort();
    for(const [key,value] of original){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}
  }
});
