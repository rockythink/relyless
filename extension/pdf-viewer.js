import {pdfBlocks} from './pdf-blocks.mjs';
import {getDocument,GlobalWorkerOptions} from './vendor/pdfjs/pdf.min.mjs';

const $=id=>document.getElementById(id);
const pagesEl=$('pages'),statusEl=$('status'),zhPanel=$('zh-panel'),zhList=$('zh-list'),cardEl=$('word-card'),selActions=$('sel-actions');
const ext=globalThis.chrome?.runtime?.id?globalThis.chrome:null;
GlobalWorkerOptions.workerSrc=(ext?.runtime?.getURL?ext.runtime.getURL('vendor/pdfjs/pdf.worker.min.mjs'):'./vendor/pdfjs/pdf.worker.min.mjs');
const state={src:'',doc:null,scale:1.15,pages:[],currentPage:1,domain:'',emergency:null,requestSeq:0,translateBusy:false,renderGen:0,observer:null,translations:new Map(),tabId:null,assistSeq:0};
const MAX_PDF_BYTES=64*1024*1024,MAX_PDF_PAGES=500,MAX_RENDER_PIXELS=16_000_000;

function setStatus(text){statusEl.textContent=text||'';}
addEventListener('error',event=>{if(statusEl&&!statusEl.textContent)setStatus('脚本加载失败：'+(event.message||'未知错误'));});
addEventListener('unhandledrejection',event=>{if(statusEl&&!statusEl.textContent)setStatus('运行错误：'+(event.reason?.message||'未知错误'));});
function send(type,payload={}){
  return new Promise((resolve,reject)=>{
    if(!ext)return reject(new Error('阅读辅助需要在扩展页面中运行。'));
    ext.runtime.sendMessage({type,...payload},response=>{
      if(ext.runtime.lastError)return reject(new Error(ext.runtime.lastError.message));
      if(!response?.ok)return reject(new Error(response?.error||'请求失败，请重试。'));
      resolve(response.data);
    });
  });
}
// tabs.sendMessage 只投递给内容脚本，到不了扩展页：用量字符数由 EMERGENCY_BEGIN 自带，
// 翻译进度走 runtime 广播并按 tabId 定向过滤。
if(ext)ext.runtime.onMessage.addListener(message=>{
  if(message?.type==='SS_TRANSLATION_PROGRESS'&&message.tabId===state.tabId&&Array.isArray(message.items))applyPassageProgress(message.requestId,message.items);
});
if(ext)chrome.tabs.getCurrent(tab=>{state.tabId=tab?.id??null;});

const srcParam=new URLSearchParams(location.search).get('src')||'';
function docName(src){try{const name=decodeURIComponent(new URL(src).pathname.split('/').pop()||'');return name||'PDF 文档';}catch{return 'PDF 文档';}}

async function resolveSrc(){
  try{const url=new URL(srcParam);if(!['http:','https:','file:'].includes(url.protocol))throw 0;return url;}catch{setStatus('缺少有效的文档地址。');return null;}
}

async function readPdfResponse(response){
  const declared=Number(response.headers.get('content-length'));
  if(declared>MAX_PDF_BYTES)throw new Error('PDF 超过 64 MiB，请使用原生查看器。');
  if(!response.body?.getReader)throw new Error('文档没有可读取的数据流。');
  const reader=response.body.getReader(),parts=[];let bytes=0;
  try{
    while(true){
      const {done,value}=await reader.read();if(done)break;
      bytes+=value.byteLength;
      if(bytes>MAX_PDF_BYTES)throw new Error('PDF 超过 64 MiB，请使用原生查看器。');
      parts.push(value);
    }
  }catch(error){await reader.cancel().catch(()=>{});throw error;}
  const data=new Uint8Array(bytes);let offset=0;
  for(const part of parts){data.set(part,offset);offset+=part.byteLength;}
  return data;
}

async function fetchPdf(url){
  try{
    const response=await fetch(url.href,{credentials:'include'});
    if(!response.ok)throw new Error(response.status===401||response.status===403
      ?'该文档需要登录或授权（HTTP '+response.status+'）。请先在来源站点登录后重试，或改用原生查看器。'
      :'文档读取失败（HTTP '+response.status+'）。');
    return await readPdfResponse(response);
  }catch(error){
    if(!(error instanceof TypeError)&&error.message)throw error;
    if(ext&&['http:','https:'].includes(url.protocol)){
      const origin=url.origin+'/*';
      const owned=await chrome.permissions.contains({origins:[origin]}).catch(()=>false);
      if(!owned){
        setStatus('读取该文档需要网站访问权限。');
        const grant=document.createElement('button');grant.type='button';grant.textContent='授权访问 '+url.origin;
        grant.addEventListener('click',async()=>{
          const ok=await chrome.permissions.request({origins:[origin]}).catch(()=>false);
          if(ok){setStatus('已授权，正在读取文档…');void boot();}else setStatus('未获得权限，无法读取文档。可改用原生查看器打开。');
        });
        statusEl.append(' ',grant);return null;
      }
    }
    throw new Error(url.protocol==='file:'?'读取本地文件失败：请在扩展详情页开启“允许访问文件网址”。':'文档读取失败，请检查网络或改用原生查看器。');
  }
}

async function boot(){
  const src=await resolveSrc();if(!src)return;
  state.src=src.href;
  $('doc-title').textContent=docName(src.href);
  setStatus('正在读取文档…');
  let data;try{data=await fetchPdf(src);}catch(error){setStatus(error.message);return;}
  if(!data)return;
  setStatus('正在渲染…');
  try{state.doc=await getDocument({data}).promise;}catch{setStatus('文档解析失败：可能不是有效的 PDF，或已加密/损坏。');return;}
  if(state.doc.numPages>MAX_PDF_PAGES){await state.doc.destroy();state.doc=null;setStatus('PDF 超过 500 页，请使用原生查看器。');return;}
  buildPlaceholders();
  $('page-info').textContent='1 / '+state.doc.numPages;
  setStatus('');
}

function observePages(){
  const gen=state.renderGen;
  state.observer?.disconnect();
  const observer=new IntersectionObserver(entries=>{
    for(const entry of entries){
      if(!entry.isIntersecting)continue;
      const pageNo=Number(entry.target.dataset.page);observer.unobserve(entry.target);
      void renderPage(pageNo,entry.target,gen);
    }
    updatePageInfo();
  },{rootMargin:'800px 0px'});
  state.observer=observer;
  for(const page of state.pages)if(page?.wrap)observer.observe(page.wrap);
}

function buildPlaceholders(){
  for(let index=1;index<=state.doc.numPages;index++){
    const wrap=document.createElement('div');wrap.className='pdf-page';wrap.dataset.page=String(index);wrap.style.minHeight='640px';
    pagesEl.append(wrap);state.pages[index]={wrap,rendered:false,blocks:[]};
  }
  observePages();
}

// gen 代次守卫：缩放/重建期间过期的渲染任务不得再写 wrap 或块状态。
async function renderPage(pageNo,wrap,gen){
  const page=await state.doc.getPage(pageNo);
  if(gen!==state.renderGen)return;
  const viewport=page.getViewport({scale:state.scale});
  if(viewport.width*viewport.height*devicePixelRatio**2>MAX_RENDER_PIXELS){setStatus('页面尺寸过大，请使用原生查看器。');return;}
  wrap.style.minHeight='';wrap.style.width=viewport.width+'px';wrap.style.height=viewport.height+'px';
  const canvas=document.createElement('canvas');canvas.className='pdf-canvas';
  canvas.width=Math.floor(viewport.width*devicePixelRatio);canvas.height=Math.floor(viewport.height*devicePixelRatio);
  canvas.style.width=viewport.width+'px';canvas.style.height=viewport.height+'px';
  wrap.append(canvas);
  const renderTask=page.render({canvasContext:canvas.getContext('2d'),viewport,canvas});
  const layer=document.createElement('div');layer.className='textLayer';layer.style.setProperty('--scale-factor',String(state.scale));
  wrap.append(layer);
  const textLayer=new pdfjsTextLayer({textContentSource:page.streamTextContent(),container:layer,viewport});
  const rec=state.pages[pageNo];if(rec)rec.renderTask=renderTask;
  try{await Promise.all([renderTask.promise,textLayer.render()]);}catch(error){if(gen!==state.renderGen)return;setStatus('页面渲染失败：'+(error?.message||'未知错误'));return;}
  if(gen!==state.renderGen)return;
  if(rec&&rec.renderTask===renderTask)rec.renderTask=null;
  const divs=[...layer.querySelectorAll('span')].map(el=>({el,x:el.offsetLeft,y:el.offsetTop,w:el.offsetWidth,h:el.offsetHeight,text:el.textContent}));
  const blocks=pdfBlocks(divs);
  for(const block of blocks){
    block.pageNo=pageNo;
    block.els=block.indices.map(i=>divs[i]?.el).filter(Boolean);
    const overlay=document.createElement('div');overlay.className='pdf-block';overlay.dataset.block=block.id;
    overlay.style.left=block.x+'px';overlay.style.top=block.y+'px';overlay.style.width=block.w+'px';overlay.style.height=block.h+'px';
    const action=document.createElement('button');action.type='button';action.className='block-action';action.textContent='译';
    action.addEventListener('click',event=>{
      event.stopPropagation();
      const zh=overlay.querySelector('.pdf-zh');
      if(zh){zh.hidden=!zh.hidden;action.textContent=zh.hidden?'译':'文';}
      else void translateBlocks(pageNo,[block]);
    });
    overlay.append(action);
    layer.append(overlay);
    block.overlay=overlay;
    for(const el of block.els){
      el.addEventListener('mouseenter',()=>overlay.classList.add('hover'));
      el.addEventListener('mouseleave',()=>overlay.classList.remove('hover'));
      el.addEventListener('click',event=>onSpanClick(event,el,block));
    }
    const saved=state.translations.get(pageNo+':'+block.id);
    if(saved)setTranslation(block,saved);
  }
  state.pages[pageNo].blocks=blocks;state.pages[pageNo].rendered=true;
}

// v6 起 TextLayer 直接从同包导出；保持一处引用便于将来替换。
import {TextLayer as pdfjsTextLayer} from './vendor/pdfjs/pdf.min.mjs';

function updatePageInfo(){
  const mid=scrollY+innerHeight/2;
  for(const page of state.pages){
    if(!page?.wrap)continue;
    const top=page.wrap.offsetTop,bottom=top+page.wrap.offsetHeight;
    if(mid>=top&&mid<bottom){if(state.currentPage!==Number(page.wrap.dataset.page)){state.currentPage=Number(page.wrap.dataset.page);$('page-info').textContent=state.currentPage+' / '+state.doc.numPages;}return;}
  }
}
addEventListener('scroll',()=>updatePageInfo(),{passive:true});
$('prev-page').addEventListener('click',()=>scrollToPage(state.currentPage-1));
$('next-page').addEventListener('click',()=>scrollToPage(state.currentPage+1));
function scrollToPage(pageNo){const page=state.pages[Math.min(Math.max(pageNo,1),state.doc?.numPages||1)];page?.wrap.scrollIntoView({behavior:'smooth'});}
$('zoom-out').addEventListener('click',()=>rezoom(Math.max(state.scale-0.15,0.5)));
$('zoom-in').addEventListener('click',()=>rezoom(Math.min(state.scale+0.15,3)));
async function rezoom(scale){
  state.scale=scale;state.renderGen++;
  for(const page of state.pages)if(page?.wrap){page.rendered=false;page.blocks=[];try{page.renderTask?.cancel();}catch{}page.renderTask=null;page.wrap.replaceChildren();page.wrap.style.minHeight='640px';}
  observePages();
}
$('native-open').addEventListener('click',()=>{
  if(!state.src)return;
  location.href=state.src.split('#')[0]+'#relyless-native';
});

// —— 阅读辅助 ——
async function ensureDomain(){
  if(state.domain)return state.domain;
  try{const sample=(state.pages[state.currentPage]?.blocks||[]).map(block=>block.text).join(' ').slice(0,2000)||'document';
    const result=await send('RESOLVE_DOMAIN',{text:sample,title:docName(state.src),explicit:true,immediate:true});
    state.domain=result?.domain||'general';
  }catch{state.domain='general';}
  return state.domain;
}
function blockContext(block){
  const pageBlocks=state.pages[block.pageNo]?.blocks||[],index=pageBlocks.indexOf(block);
  const before=pageBlocks[index-1]?.text.slice(-400)||'',after=pageBlocks[index+1]?.text.slice(0,400)||'';
  return {title:docName(state.src).slice(0,160),heading:'',before,after};
}
function aroundContext(text,whole){
  if(whole.length<=2000)return whole;
  const at=whole.indexOf(text),half=Math.max(0,Math.floor((2000-text.length)/2));
  return whole.slice(Math.max(0,at-half),at+text.length+half);
}
function wordAtPoint(x,y){
  const caret=document.caretPositionFromPoint?document.caretPositionFromPoint(x,y):(document.caretRangeFromPoint?(()=>{const r=document.caretRangeFromPoint(x,y);return r?{offsetNode:r.startContainer,offset:r.startOffset}:null;})():null);
  if(!caret||caret.offsetNode?.nodeType!==Node.TEXT_NODE)return null;
  const text=caret.offsetNode.textContent||'';
  let start=caret.offset,end=caret.offset;
  while(start>0&&/[\p{L}\p{N}'’-]/u.test(text[start-1]))start--;
  while(end<text.length&&/[\p{L}\p{N}'’-]/u.test(text[end]))end++;
  const word=text.slice(start,end);
  return /^[\p{L}][\p{L}\p{N}'’-]*$/u.test(word)?{word,node:caret.offsetNode,start,end}:null;
}
function onSpanClick(event,spanEl,block){
  if(getSelection()?.toString().trim())return;
  const hit=wordAtPoint(event.clientX,event.clientY);
  if(!hit)return;
  const word=hit.word;if(!/[A-Za-z]/.test(word))return;
  openWordCard(word,block,event.clientX,event.clientY);
}
async function openWordCard(word,block,x,y){
  const seq=++state.assistSeq;
  cardEl.hidden=false;cardEl.style.left=Math.min(x,innerWidth-316)+'px';cardEl.style.top=Math.min(y+12,innerHeight-200)+'px';
  cardEl.innerHTML='<button type="button" class="card-close" aria-label="关闭">×</button><div class="card-word"></div><div class="card-sense"></div><div class="card-answer">查询中…</div><div class="card-actions"><button type="button" data-act="hint">英文提示</button><button type="button" data-act="rescue">中文释义</button></div>';
  cardEl.querySelector('.card-word').textContent=word;
  cardEl.querySelectorAll('.card-actions button').forEach(button=>button.addEventListener('click',()=>void runAssist(button.dataset.act)));
  async function runAssist(level){
    const answer=cardEl.querySelector('.card-answer');answer.textContent='查询中…';
    const slow=setTimeout(()=>{if(answer.textContent==='查询中…')answer.textContent='查询中…（模型仍在思考，可能需要半分钟以上）';},12000);
    try{
      const domain=await ensureDomain();
      const result=await send('ASSIST',{requestId:crypto.randomUUID(),text:word,context:aroundContext(word,block.text),domain,kind:'word',level,detail:'brief',articleKey:''});
      if(seq!==state.assistSeq)return; // 卡片已被更新请求接管，丢弃过期响应
      if(level==='hint')answer.textContent=result.hint||'没有可用提示。';
      else{answer.textContent=result.translation||'没有释义。';cardEl.querySelector('.card-sense').textContent=result.sense||'';}
    }catch(error){if(seq!==state.assistSeq)return;answer.innerHTML='';const p=document.createElement('p');p.className='card-error';p.textContent=error.message;answer.append(p);}finally{clearTimeout(slow);}
  }
  void runAssist('hint');
}
document.addEventListener('mousedown',event=>{
  if(!cardEl.hidden&&!event.target.closest('#word-card'))cardEl.hidden=true;
});
cardEl.addEventListener('click',event=>{if(event.target.closest('.card-close'))cardEl.hidden=true;});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'){
    cardEl.hidden=true;selActions.hidden=true;pendingSelection=null;passageCard=null;
    getSelection()?.removeAllRanges();
    return;
  }
  const tag=event.target?.tagName||'';
  if(/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(tag)||event.target?.isContentEditable)return;
  if(event.key==='ArrowLeft')scrollToPage(state.currentPage-1);
  else if(event.key==='ArrowRight')scrollToPage(state.currentPage+1);
});

// 选段：翻译或解释
let pendingSelection=null;
document.addEventListener('selectionchange',()=>{
  const selection=getSelection();
  if(!selection||selection.isCollapsed||!selection.toString().trim()){selActions.hidden=true;pendingSelection=null;return;}
  const anchor=selection.anchorNode?.parentElement?.closest?.('.textLayer');
  if(!anchor){selActions.hidden=true;return;}
  const text=selection.toString().replace(/\s+/g,' ').trim();
  if(!/[A-Za-z]/.test(text))return;
  pendingSelection={text};
  const rect=selection.getRangeAt(0).getBoundingClientRect();
  selActions.hidden=false;selActions.style.left=Math.min(rect.left,innerWidth-200)+'px';selActions.style.top=Math.max(rect.bottom+8,8)+'px';
});
$('sel-translate').addEventListener('click',()=>void translateSelection());
$('sel-assist').addEventListener('click',()=>void explainSelection());
let passageCard=null;
function selectionCard(){
  const sel=getSelection(),rect=sel&&sel.rangeCount?sel.getRangeAt(0).getBoundingClientRect():{left:innerWidth/2,bottom:innerHeight/2};
  cardEl.hidden=false;cardEl.style.left=Math.min(rect.left,innerWidth-316)+'px';cardEl.style.top=Math.min(rect.bottom+12,innerHeight-260)+'px';
  return cardEl;
}
// 译文挂上块覆盖层：inline 显示在原文块下方，右侧面板行保持不变。
function setTranslation(block,text){
  state.translations.set(block.pageNo+':'+block.id,text);
  if(!block.overlay)return;
  block.overlay.classList.add('translated');
  let zh=block.overlay.querySelector('.pdf-zh');
  if(!zh){zh=document.createElement('div');zh.className='pdf-zh';block.overlay.append(zh);}
  zh.hidden=false;
  zh.style.fontSize=Math.max(9,Math.min(15,(block.h/Math.max(block.lines?.length||1,1))*0.7))+'px';
  zh.textContent=text.length>280?text.slice(0,280)+'…':text;
  const action=block.overlay.querySelector('.block-action');
  if(action)action.textContent='文';
}
async function translateBlocks(pageNo,blocks){
  const seq=++state.assistSeq;
  const first=blocks[0];
  const rect=first.overlay?.getBoundingClientRect()||{left:innerWidth/2,bottom:innerHeight/2};
  cardEl.hidden=false;cardEl.style.left=Math.min(rect.left,innerWidth-316)+'px';cardEl.style.top=Math.min(rect.bottom+10,innerHeight-260)+'px';
  cardEl.innerHTML='<button type="button" class="card-close" aria-label="关闭">×</button><div class="card-word">段落翻译</div><div class="card-answer">翻译中…</div>';
  const oversized=blocks.filter(block=>block.text.length>4000);
  if(oversized.length){cardEl.querySelector('.card-answer').textContent='该段超过 4000 字符上限，暂不支持整段发送；请改用选段翻译并缩小范围。';return;}
  try{
    const result=await send('PASSAGE_TRANSLATE',{requestId:crypto.randomUUID(),items:blocks.map(block=>({id:block.id,text:block.text}))});
    if(seq!==state.assistSeq)return;
    const lines=(result.items||[]).map(item=>item.translation).filter(Boolean);
    cardEl.querySelector('.card-answer').textContent=lines.join('\n\n')||(result.errors?.[0]?'翻译失败：'+result.errors[0].code:'没有返回译文。');
    for(const item of result.items||[]){
      const block=blocks.find(b=>b.id===item.id);
      if(block&&item.translation)setTranslation(block,item.translation);
    }
  }catch(error){cardEl.querySelector('.card-answer').innerHTML='';const p=document.createElement('p');p.className='card-error';p.textContent=error.message;cardEl.querySelector('.card-answer').append(p);}
}
function applyPassageProgress(requestId,items){
  if(!passageCard||passageCard.dataset.requestId!==requestId)return;
  const target=passageCard.querySelector('.card-answer');
  const first=items?.[0];if(target&&first?.translation)target.textContent=first.translation;
}
async function translateSelection(){
  if(!pendingSelection)return;const text=pendingSelection.text;selActions.hidden=true;
  if(text.length>4000){setStatus('选段超过 4000 字符上限，请缩小选择范围。');return;}
  const seq=++state.assistSeq;
  const card=selectionCard();const requestId=crypto.randomUUID();passageCard=card;card.dataset.requestId=requestId;
  card.innerHTML='<button type="button" class="card-close" aria-label="关闭">×</button><div class="card-word">翻译选段</div><div class="card-answer">翻译中…</div>';
  try{
    const result=await send('PASSAGE_TRANSLATE',{requestId,items:[{id:'s1',text}]});
    if(seq!==state.assistSeq)return;
    const item=result.items?.[0];card.querySelector('.card-answer').textContent=item?.translation||(result.errors?.[0]?'翻译失败：'+result.errors[0].code:'没有返回译文。');
  }catch(error){if(seq!==state.assistSeq)return;card.querySelector('.card-answer').innerHTML='';const p=document.createElement('p');p.className='card-error';p.textContent=error.message;card.querySelector('.card-answer').append(p);}
}
async function explainSelection(){
  if(!pendingSelection)return;const text=pendingSelection.text;selActions.hidden=true;
  if(text.length>600||text.split(/[.!?。！？]+/).filter(Boolean).length>3){setStatus('解释选段最多 3 句、600 字符，请缩小选择范围。');return;}
  const seq=++state.assistSeq;
  const card=selectionCard();
  card.innerHTML='<button type="button" class="card-close" aria-label="关闭">×</button><div class="card-word">解释选段</div><div class="card-answer">分析中…</div>';
  try{
    const domain=await ensureDomain();
    const block=state.pages.flatMap(p=>p.blocks||[]).find(b=>b.text.includes(text));
    const result=await send('ASSIST',{requestId:crypto.randomUUID(),text,context:aroundContext(text,block?.text||text),domain,kind:'passage',level:'rescue',detail:'full',articleKey:''});
    if(seq!==state.assistSeq)return;
    card.querySelector('.card-answer').textContent=result.translation||'没有解释。';
  }catch(error){if(seq!==state.assistSeq)return;card.querySelector('.card-answer').innerHTML='';const p=document.createElement('p');p.className='card-error';p.textContent=error.message;card.querySelector('.card-answer').append(p);}
}

// 整页翻译：紧急翻译会话复用同一授权与计费路径。
$('translate-page').addEventListener('click',()=>void translateCurrentPage());
// 先不确认地开始一次：后台返回预算超限信息时，由用户在页面内再次确认后才带 confirmed 重发。
function confirmBudgetExceeded(b){
  return new Promise(resolve=>{
    statusEl.replaceChildren();
    statusEl.append('本页预计消耗约 '+b.estimate+' token；本月已用 '+b.monthlyUsed+' / 预算 '+b.budget+'，将超出月度预算。 ');
    const ok=document.createElement('button');ok.type='button';ok.textContent='仍然翻译';
    const no=document.createElement('button');no.type='button';no.textContent='取消';
    ok.addEventListener('click',()=>{setStatus('已确认超支，正在开始翻译…');resolve(true);});
    no.addEventListener('click',()=>{setStatus('已取消翻译。');resolve(false);});
    statusEl.append(ok,' ',no);
  });
}
// chars 由查看器按当前实际待译块计算后随请求上报：tabs.sendMessage 到不了扩展页，
// 后台无法探测扩展页内容，故预算口径以本消息声明值为准（后台仍会封顶 2e6）。
async function beginEmergency(tabId,chars){
  const begun=await send('EMERGENCY_BEGIN',{tabId,url:location.href,chars});
  if(begun?.budgetExceeded){
    if(!await confirmBudgetExceeded(begun))return null;
    const retry=await send('EMERGENCY_BEGIN',{tabId,url:location.href,confirmed:true,chars});
    if(!retry?.token)throw new Error(retry?.error||'翻译授权失败。');
    return retry;
  }
  if(!begun?.token)throw new Error('翻译授权失败。');
  return begun;
}
async function translateCurrentPage(){
  if(state.translateBusy)return;
  selActions.hidden=true;pendingSelection=null;
  const pageNo=state.currentPage;
  const page=state.pages[pageNo];
  if(!page?.rendered||!page.blocks.length){setStatus('当前页还没有可翻译的文本层。');return;}
  if(!ext){setStatus('翻译需要在扩展中运行。');return;}
  const sendable=page.blocks.filter(block=>block.text.length<=4000);
  const skipped=page.blocks.filter(block=>block.text.length>4000);
  const pending=sendable.filter(block=>!state.translations.get(pageNo+':'+block.id));
  const chars=pending.reduce((sum,block)=>sum+block.text.length,0);
  state.translateBusy=true;$('translate-page').disabled=true;
  try{
    const tabId=await new Promise((resolve,reject)=>{chrome.tabs.getCurrent(tab=>resolve(tab?.id));setTimeout(()=>reject(new Error('无法定位当前标签页。')),3000);});
    if(pending.length){
      // 每页的新待译内容都需重新估算；旧页面授权不得覆盖后来更大的页面。
      const begun=await beginEmergency(tabId,chars);
      if(!begun)return;
      state.emergency={token:begun.token,tabId};
    }
    zhPanel.hidden=false;zhList.replaceChildren();
    const rows=new Map();
    const jump=block=>{
      selActions.hidden=true;pendingSelection=null;
      const overlay=state.pages[pageNo]?.blocks.find(b=>b.id===block.id)?.overlay;
      if(!overlay)return;
      overlay.scrollIntoView({behavior:'smooth',block:'center'});
      overlay.classList.add('highlight');
      setTimeout(()=>overlay.classList.remove('highlight'),1200);
    };
    for(const block of sendable){
      const row=document.createElement('div');row.className='zh-row';row.dataset.blockId=block.id;
      row.tabIndex=0;row.setAttribute('role','button');row.title='回跳到原文块';
      const src=document.createElement('div');src.className='zh-src';src.textContent=block.text.slice(0,120)+(block.text.length>120?'…':'');
      const zh=document.createElement('div');zh.className='zh-dst';
      const saved=state.translations.get(pageNo+':'+block.id);
      zh.textContent=saved||'等待翻译…';
      row.append(src,zh);zhList.append(row);rows.set(block.id,zh);
      const target=()=>state.pages[pageNo]?.blocks.find(b=>b.id===block.id)?.overlay;
      row.addEventListener('mouseenter',()=>target()?.classList.add('translated'));
      row.addEventListener('click',()=>jump(block));
      row.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();jump(block);}});
    }
    for(const block of skipped){
      const row=document.createElement('div');row.className='zh-row zh-skip';
      const src=document.createElement('div');src.className='zh-src';src.textContent=block.text.slice(0,120)+'…';
      const zh=document.createElement('div');zh.className='zh-dst zh-err';zh.textContent='原文块超过 4000 字符，未送译（可框选其中片段翻译）。';
      row.append(src,zh);zhList.append(row);
    }
    // 重试只补发尚未译出的块，已成功的块直接复用缓存译文。
    // 已验证的译文不重发；预算估算与此处的待译块集合完全相同。
    const batches=[];for(let i=0;i<pending.length;i+=4)batches.push(pending.slice(i,i+4));
    let done=0;setStatus(pending.length?'正在翻译本页（0/'+batches.length+' 批）…':'本页已全部翻译。');
    for(const batch of batches){
      const requestSeq=++state.requestSeq;
      const result=await send('EMERGENCY_TRANSLATE',{token:state.emergency.token,requestSeq,items:batch.map(block=>({id:block.id,text:block.text,context:blockContext(block)}))});
      for(const item of result.items||[]){
        const zh=rows.get(item.id);if(zh)zh.textContent=item.translation;
        const block=sendable.find(b=>b.id===item.id);
        if(block&&item.translation)setTranslation(block,item.translation);
      }
      for(const error of result.errors||[]){const zh=rows.get(error.id);if(zh){zh.textContent='翻译失败：'+error.code;zh.classList.add('zh-err');}}
      done++;setStatus('正在翻译本页（'+done+'/'+batches.length+' 批）…');
    }
    const untranslated=sendable.filter(block=>!state.translations.get(pageNo+':'+block.id));
    let status=untranslated.length
      ?'本页已译 '+(sendable.length-untranslated.length)+'/'+sendable.length+' 块，'+untranslated.length+' 块失败，可再次点击重试。'
      :'本页翻译完成（'+sendable.length+' 块），译文附在原文下方，右侧栏可总览。';
    if(skipped.length)status+=' '+skipped.length+' 个超长块未送译。';
    setStatus(status);
  }catch(error){
    setStatus(error.message);
    if(/过期|失效|变化/.test(error.message))state.emergency=null;
  }finally{state.translateBusy=false;$('translate-page').disabled=false;}
}

void boot();
