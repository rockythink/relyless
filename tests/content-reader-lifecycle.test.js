import {expect,test} from 'bun:test';
import {Window} from 'happy-dom';
import {readFileSync} from 'node:fs';

const source=name=>readFileSync(new URL('../extension/'+name,import.meta.url),'utf8');
const waitFor=async(predicate)=>{const deadline=Date.now()+1000;while(!predicate()){if(Date.now()>=deadline)throw new Error('Reader state did not settle');await new Promise(resolve=>setTimeout(resolve,5));}};
test('a late initial state cannot reopen a reader after an explicit exit',async()=>{
  const window=new Window({url:'https://example.test/article'});
  const original=new Map();
  const globals={window,document:window.document,location:window.location,Node:window.Node,NodeFilter:window.NodeFilter,HTMLElement:window.HTMLElement,MutationObserver:window.MutationObserver,
    getComputedStyle:element=>({opacity:'1',display:element.tagName==='SPAN'?'inline':'block',visibility:'visible',contentVisibility:'visible',clip:'auto',clipPath:'none',overflowX:'visible',overflowY:'visible'}),
    matchMedia:()=>({addEventListener(){},removeEventListener(){}}),innerWidth:1000,innerHeight:800,scrollX:0,scrollY:0,
    requestAnimationFrame:callback=>setTimeout(callback,1),cancelAnimationFrame:clearTimeout,
    IntersectionObserver:class{observe(){}disconnect(){}},CSS:{highlights:new Map()},Highlight:class{},getSelection:()=>window.getSelection(),scrollTo:()=>{},
    ShisuiDesign:{cssFor:()=>'',structureRoles:{},structureColors:{}},ShisuiReadingStyle:{normalize:()=>({}),css:()=>''},
    ShisuiReview:{hide(){},refresh(){return Promise.resolve()}},ShisuiCopy:{onPointerTrack(){},copyParagraph(){}},ShisuiConversation:{}};
  for(const [key,value] of Object.entries(globals)){original.set(key,globalThis[key]);globalThis[key]=value;}
  for(const key of ['chrome','ShisuiContent','ShisuiReader'])original.set(key,globalThis[key]);
  let reply,releaseState,holdTranslations=false,requestConcurrency=2;const pendingState=new Promise(resolve=>releaseState=resolve),messages=[],pendingBatches=[];
  let listener;document.fonts||={addEventListener(){},removeEventListener(){}};
  globalThis.chrome={runtime:{id:'abc',getURL:path=>'chrome-extension://abc/'+path,
    sendMessage:(message,callback)=>{
      messages.push(message.type);
      if(message.type==='STATE_GET')pendingState.then(()=>callback({ok:true,data:{settings:{assistanceMode:'on-demand',domain:'auto',rulePacks:[],requestConcurrency},providerConfigured:false,emergencyActive:false}}));
      else if(message.type==='READER_TRANSLATION_ESTIMATE')callback({ok:true,data:{estimate:120}});
      else if(message.type==='READER_TRANSLATION_BEGIN')callback({ok:true,data:{token:'reader-token'}});
      else if(message.type==='EMERGENCY_TRANSLATE'){
        expect(message.items.length).toBeLessThanOrEqual(4);
        expect(message.items.reduce((size,item)=>size+item.text.length,0)).toBeLessThanOrEqual(4000);
        expect(message.items.reduce((size,item)=>size+item.text.length+Object.values(item.context).reduce((length,value)=>length+value.length,0),0)).toBeLessThanOrEqual(12000);
        let replied=false;
        const respond=()=>{if(replied)return;replied=true;callback({ok:true,data:{items:message.items.map(item=>({id:item.id,translation:'这是对应的中文译文。'})),errors:[]}});};
        if(holdTranslations)pendingBatches.push({message,respond,reject:()=>{if(replied)return;replied=true;callback({ok:false,error:'上游限流'});}});else respond();
      }else callback({ok:true,data:{enabled:false}});
    },
    onMessage:{addListener:callback=>listener=callback,removeListener(){}}}};
  try{
    window.HTMLElement.prototype.getClientRects=function(){return [{width:100,height:20}]};
    window.HTMLElement.prototype.showPopover=function(){};
    window.HTMLElement.prototype.hidePopover=function(){};
    document.body.innerHTML='<main><article><h1>Original article</h1>'+Array.from({length:8},(_,i)=>'<p>'+('The paragraph '+(i+1)+' preserves its English source and reading context. ').repeat(18)+'</p>').join('')+'</article></main>';
    delete globalThis.ShisuiContent;delete globalThis.ShisuiReader;for(const name of ['content/kernel.js','content/reader.js','content.js'])new Function(source(name))();
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
    holdTranslations=true;button.click();await waitFor(()=>pendingBatches.length===2);expect(pendingBatches[0].message.items.every(item=>item.text.length<4000)).toBe(true);
    pendingBatches[0].respond();await waitFor(()=>document.querySelectorAll('[data-shisui-ui="reader"] article p [data-shisui-ui="emergency-translation"]').length>0);expect(document.querySelectorAll('[data-shisui-ui="reader"] article p [data-shisui-ui="emergency-translation"]').length).toBeLessThan(8);
    await waitFor(()=>pendingBatches.length===3); // Refill the freed slot while the second batch stays pending.
    await new Promise(resolve=>setTimeout(resolve,10));expect(pendingBatches.length).toBe(3);
    holdTranslations=false;pendingBatches[1].respond();pendingBatches[2].respond();await waitFor(()=>document.querySelectorAll('[data-shisui-ui="reader"] article p [data-shisui-ui="emergency-translation"]').length===8);expect(button.textContent).toBe('停止翻译');expect(messages).toContain('READER_TRANSLATION_BEGIN');
    expect(document.querySelector('[data-shisui-ui="emergency-translation"]')?.textContent).toContain('中文译文');
    expect([...document.querySelectorAll('[data-shisui-ui="reader"] article p')].every(p=>p.querySelector('[data-shisui-ui="emergency-translation"]')?.textContent.includes('中文译文'))).toBe(true);
    await send({type:'SS_READER_SET',enabled:false,pageUrl:location.href});
    expect(document.querySelector('main').inert).toBe(false);
    expect(messages.some(type=>['ANALYZE','SUPPORT_BATCH','PREPARED_SUPPORT','HISTORY_BEGIN','SENTENCE_GROUPS_BATCH'].includes(type))).toBe(false);
    const original=await send({type:'SS_EMERGENCY_START',token:'original-token',resume:false});
    expect(original.ok).toBe(true);await waitFor(()=>document.querySelectorAll('main article p [data-shisui-ui="emergency-translation"]').length===8);
    const sourceTranslations=document.querySelectorAll('main [data-shisui-ui="emergency-translation"]');
    expect(sourceTranslations.length).toBeGreaterThan(0);
    const withPageTranslation=await send({type:'SS_READER_SET',enabled:true,pageUrl:location.href});
    expect(withPageTranslation.data.reader.active).toBe(true);
    expect(document.querySelectorAll('main [data-shisui-ui="emergency-translation"]').length).toBe(sourceTranslations.length);
    const readerButton=[...document.querySelectorAll('[data-shisui-ui="reader"] .reader-toolbar button')].find(item=>item.textContent==='翻译本页');
    readerButton.click();await new Promise(resolve=>setTimeout(resolve,0));readerButton.click();await waitFor(()=>document.querySelector('[data-shisui-ui="reader"] [data-shisui-ui="emergency-translation"]')?.textContent.includes('中文译文'));
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
    pendingBatches.length=0;holdTranslations=true;
    const failingButton=[...document.querySelectorAll('[data-shisui-ui="reader"] .reader-toolbar button')].find(item=>item.textContent==='翻译本页');
    failingButton.click();await new Promise(resolve=>setTimeout(resolve,0));failingButton.click();
    await waitFor(()=>pendingBatches.length===2);
    pendingBatches[0].reject();await new Promise(resolve=>setTimeout(resolve,10));expect(pendingBatches.length).toBe(2);
    pendingBatches[1].respond();holdTranslations=false;
    await waitFor(()=>document.querySelectorAll('[data-shisui-ui="reader"] article p [data-shisui-ui="emergency-translation"]').length>0);
    expect((await send({type:'SS_STATUS'})).data.emergency.phase).toBe('error');
    expect(document.querySelector('[data-shisui-ui="reader"] article p [data-shisui-ui="emergency-translation"]')?.textContent).toContain('中文译文');
    document.querySelector('[data-shisui-ui="reader"]').remove();
    await waitFor(()=>!document.querySelector('main').inert);
    expect((await send({type:'SS_STATUS'})).data.reader.active).toBe(false);
    expect(document.querySelector('main').inert).toBe(false);
    await send({type:'SS_EMERGENCY_END'});
    requestConcurrency=1;pendingBatches.length=0;holdTranslations=true;
    const before='The preceding paragraph introduces the subject and its surrounding evidence. '.repeat(3),after='The following paragraph draws conclusions from that evidence and the article. '.repeat(3);
    const longText=Array.from({length:160},(_,index)=>'Sentence '+index+' describes the evidence from this long paragraph and preserves its narrative. ').join('');
    document.querySelector('main article').innerHTML='<h1>Chunk context article</h1><p>'+before+'</p><p>'+longText+'</p><p>'+after+'</p>';
    await send({type:'SS_EMERGENCY_START',token:'chunk-token',resume:false});await waitFor(()=>pendingBatches.length===1);
    await new Promise(resolve=>setTimeout(resolve,10));expect(pendingBatches.length).toBe(1);
    pendingBatches[0].respond();await waitFor(()=>pendingBatches.length===2);
    const chunks=[];
    for(let batchIndex=1;chunks.map(item=>item.text).join('').length<longText.length;batchIndex++){
      await waitFor(()=>pendingBatches.length===batchIndex+1);
      expect(pendingBatches[batchIndex].message.items.length).toBe(1);
      chunks.push(pendingBatches[batchIndex].message.items[0]);
      pendingBatches[batchIndex].respond();
    }
    await waitFor(()=>document.querySelectorAll('main article p:nth-of-type(2) [data-shisui-ui="emergency-translation"] span').length===chunks.length);
    expect(chunks.length).toBeGreaterThan(2);expect(chunks.map(item=>item.text).join('')).toBe(longText);
    for(const [index,item] of chunks.entries()){
      expect(item.context.before).toBe(index?chunks[index-1].text.slice(-400):before);
      expect(item.context.after).toBe(index+1<chunks.length?chunks[index+1].text.slice(0,400):after);
      expect(item.context.before.length).toBeLessThanOrEqual(400);expect(item.context.after.length).toBeLessThanOrEqual(400);
      expect(item.text.length).toBeLessThanOrEqual(4000);expect(item.context.heading).toBe('Chunk context article');
    }
    expect((await send({type:'SS_STATUS'})).data.emergency.phase).toBe('complete');
    await send({type:'SS_EMERGENCY_END'});
    requestConcurrency=2;pendingBatches.length=0;
    document.querySelector('main article').innerHTML='<h1>Generation article</h1>'+Array.from({length:8},(_,i)=>'<p>'+('The paragraph '+i+' preserves its English source and reading context. ').repeat(18)+'</p>').join('');
    await send({type:'SS_EMERGENCY_START',token:'old-generation',resume:false});await waitFor(()=>pendingBatches.length===2);
    await send({type:'SS_EMERGENCY_STOP'});
    await send({type:'SS_EMERGENCY_START',token:'new-generation',resume:true});
    await new Promise(resolve=>setTimeout(resolve,10));expect(pendingBatches.length).toBe(2);
    pendingBatches[0].respond();await waitFor(()=>pendingBatches.length===3);
    expect(pendingBatches[2].message.token).toBe('new-generation');
    expect(document.querySelector('main [data-shisui-ui="emergency-translation"]')).toBeNull();
    await new Promise(resolve=>setTimeout(resolve,10));expect(pendingBatches.length).toBe(3);
    holdTranslations=false;pendingBatches[1].respond();pendingBatches[2].respond();
    await waitFor(()=>document.querySelectorAll('main article p [data-shisui-ui="emergency-translation"]').length===8);
    await send({type:'SS_EMERGENCY_END'});
    pendingBatches.length=0;holdTranslations=true;
    await send({type:'SS_EMERGENCY_START',token:'hidden-token',resume:false});await waitFor(()=>pendingBatches.length===2);
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
    pendingBatches[0].respond();await new Promise(resolve=>setTimeout(resolve,10));expect(pendingBatches.length).toBe(2);
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new window.Event('visibilitychange'));
    await waitFor(()=>pendingBatches.length===3);holdTranslations=false;pendingBatches[1].respond();pendingBatches[2].respond();
    await waitFor(()=>document.querySelectorAll('main article p [data-shisui-ui="emergency-translation"]').length===8);
    await send({type:'SS_EMERGENCY_END'});
    pendingBatches.length=0;holdTranslations=true;
    await send({type:'SS_EMERGENCY_START',token:'old-session',resume:false});await waitFor(()=>pendingBatches.length===2);
    await send({type:'SS_EMERGENCY_END'});await send({type:'SS_EMERGENCY_START',token:'new-session',resume:false});
    await new Promise(resolve=>setTimeout(resolve,10));expect(pendingBatches.length).toBe(2);
    pendingBatches[0].respond();await waitFor(()=>pendingBatches.length===3);expect(pendingBatches[2].message.token).toBe('new-session');
    expect(document.querySelector('main [data-shisui-ui="emergency-translation"]')).toBeNull();
    holdTranslations=false;pendingBatches[1].respond();pendingBatches[2].respond();
    await waitFor(()=>document.querySelectorAll('main article p [data-shisui-ui="emergency-translation"]').length===8);
    await send({type:'SS_EMERGENCY_END'});
    pendingBatches.length=0;holdTranslations=true;
    await send({type:'SS_EMERGENCY_START',token:'dirty-token',resume:false});await waitFor(()=>pendingBatches.length===2);
    document.querySelector('main h1').textContent='Changed heading';await new Promise(resolve=>setTimeout(resolve,5));
    pendingBatches[0].respond();await new Promise(resolve=>setTimeout(resolve,10));expect(pendingBatches.length).toBe(2);
    await waitFor(()=>pendingBatches.length===3);expect(pendingBatches[2].message.items[0].context.heading).toBe('Changed heading');
    expect(document.querySelector('main [data-shisui-ui="emergency-translation"]')).toBeNull();
    pendingBatches[2].respond();await waitFor(()=>pendingBatches.length===4);
    expect(pendingBatches[3].message.items.every(item=>!pendingBatches[1].message.items.some(old=>old.text===item.text))).toBe(true);
    pendingBatches[3].respond();await new Promise(resolve=>setTimeout(resolve,10));expect(pendingBatches.length).toBe(4);
    holdTranslations=false;pendingBatches[1].respond();
    await waitFor(()=>document.querySelectorAll('main article p [data-shisui-ui="emergency-translation"]').length===8);
    await send({type:'SS_EMERGENCY_END'});
  }finally{
    holdTranslations=false;for(const entry of pendingBatches)entry.respond();releaseState();window.__SHISUI_CONTENT__?.dispose();window.happyDOM.abort();
    for(const [key,value] of original){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}
  }
});
