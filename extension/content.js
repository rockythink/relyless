(() => {
  'use strict';
  const runtime = chrome.runtime, OWN = 'data-shisui-ui';
  const MARK_CLASS = 'shisui-term-mark', HINT_CLASS = 'shisui-term-hint';
  const SELECTION_KEYS=new Set(['Shift','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown']);
  const BLOCK_SELECTOR = 'p,li,blockquote,dd,dt,figcaption,h1,h2,h3,h4,h5,h6,td,th,article,section,main,div';
  const EDITABLE = '[contenteditable]:not([contenteditable="false"]),[role="textbox"]';
  const SKIP = `pre,video,audio,.html5-video-player,input,textarea,button,nav,menu,aside,form,body>header,footer,[role="complementary"],[role="banner"],[role="contentinfo"],script,style,noscript,template,select,option,dialog,[role="navigation"],[role="menu"],[role="toolbar"],[role="dialog"],[aria-hidden="true"],[hidden],[inert],${EDITABLE}`;
  const LOOKUP_CONTROLS='input,textarea,select,button,[role="button"],[role="combobox"],[role="searchbox"],[role="spinbutton"],[role="slider"],[role="checkbox"],[role="radio"],[role="switch"],'+EDITABLE;
  const LOOKUP_UI='['+OWN+']:not(['+OWN+'="term"]):not(['+OWN+'="hint"]):not(['+OWN+'="annotation"])';
  const LIMIT_ERROR = '请只选择一个句子或短段（最多 3 句、600 字符）';
  const previous = window.__SHISUI_CONTENT__;
  if (previous?.isAlive()) return;
  previous?.dispose();
  // 共享状态与纯工具来自 content/kernel.js；子系统（paragraph-copy / conversation-card）经内核钩子回调这里。
  const Kernel = globalThis.ShisuiContent;
  const {normalizeText,nodeElement,blockId,textMap,blockText,sha256,hiddenStyle,isVisible,lookupEditing} = Kernel;
  const state = Kernel.state;
  const readingScope=()=>Kernel.readingScope();
  const uiMountRoot=()=>Kernel.uiMountRoot();
  const inReadingSurface=node=>Kernel.inReadingSurface(node);
  const readerContent=node=>Kernel.isReaderContent(node);
  const readerScroll=()=>state.reader?globalThis.ShisuiReader.scrollRoot():null;
  let readerEpoch=0,readerSourceObserver=null;
  const readerScrollEvents=new WeakSet();
  let disposed = false, nextSentence = 0, contextRange = null, contextLink = null;
  const requestedRecords = [], sourceTexts=new WeakMap();
  const sentenceGroups={root:null,enabled:false,density:'medium',lineStyle:'solid',status:'off',error:'',processed:new Set(),failed:new Set(),entries:new Map(),generation:0,running:false,timer:0,frame:0,highlights:new Map(),style:null,measure:null,card:null,hits:[]};
  const lookup={held:false,code:null,point:null,press:null,preview:null,frame:0,quietUntil:0,idleTimer:0,waiters:new Set(),rebuildPending:null};
  const lookupKey=()=>state.settings.lookupKey||'D';
  const lookupLabel=()=>'按住 '+lookupKey()+' + 单击';
    const passageSources=new WeakMap();
  const isAlive = () => !disposed && Boolean(runtime.id);
  const identity = item => item.wordId + ':' + item.senseKey;
  const automatic = () => state.enabled && !state.paused && !state.emergency && state.settings.assistanceMode === 'ambient' && document.visibilityState === 'visible';
  const lookupBusy=()=>lookup.held||Boolean(lookup.press&&!lookup.press.cancelled)||Date.now()<lookup.quietUntil;
  function waitForLookupIdle(){return lookupBusy()?new Promise(resolve=>lookup.waiters.add(resolve)):Promise.resolve();}
  const waitForExplicitLookup=async()=>{const delay=lookup.quietUntil-Date.now();if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay));};
  function resumeLookupUpdates(){
    clearTimeout(lookup.idleTimer);lookup.idleTimer=0;
    if(lookup.held||lookup.press&&!lookup.press.cancelled)return;
    const delay=lookup.quietUntil-Date.now();if(delay>0){lookup.idleTimer=setTimeout(resumeLookupUpdates,delay);return;}
    for(const resolve of lookup.waiters)resolve();lookup.waiters.clear();
    if(!isAlive())return;scheduleSentenceRender();scheduleSentenceScan(0);
    if(lookup.rebuildPending!==null){const preserve=lookup.rebuildPending;lookup.rebuildPending=null;void rebuild(preserve);}else void refreshViewport();
  }
  function deferLookupUpdates(){
    lookup.quietUntil=Date.now()+180;clearTimeout(lookup.idleTimer);
    cancelAnimationFrame(sentenceGroups.frame);sentenceGroups.frame=0;clearTimeout(sentenceGroups.timer);sentenceGroups.timer=0;
    if(!lookup.held&&!(lookup.press&&!lookup.press.cancelled))lookup.idleTimer=setTimeout(resumeLookupUpdates,180);
  }
  const resultDiagnostics=new WeakMap();
  function reportResult(result,status){const traceId=result&&resultDiagnostics.get(result);if(!traceId)return;resultDiagnostics.delete(result);void request('DIAGNOSTICS_RENDER',{traceId,status}).catch(()=>{});}
  function request(type,payload={}) {
    return new Promise((resolve,reject) => {
      if (!isAlive()) return reject(new Error('扩展连接已失效，请从扩展按钮重新开启；无需重新登录。'));
      try { runtime.sendMessage({type,...payload},response => {
        if (runtime.lastError) reject(new Error(runtime.lastError.message));
        else if (!response?.ok) {const error=new Error((response?.error||'插件连接已断开，请重试。')+(response?.traceId?' [诊断 '+response.traceId+']':''));error.code=response?.code;error.traceId=response?.traceId;reject(error);}
        else {if(response.traceId&&response.data&&typeof response.data==='object')resultDiagnostics.set(response.data,response.traceId);resolve(response.data);}
      }); } catch(error) { reject(error); }
    });
  }
  const brandIconUrl=runtime.getURL('icons/relyless.svg');
  function createBrandIcon(){
    const icon=document.createElement('img');icon.setAttribute(OWN,'brand-icon');icon.src=brandIconUrl;icon.alt='RelyLess';icon.title='RelyLess';icon.width=icon.height=16;
    icon.style.cssText='display:inline-block;flex:none;width:16px;height:16px;max-width:none;vertical-align:middle;border:0';return icon;
  }
  function createBrandLabel(context=''){
    const label=document.createElement('span'),icon=createBrandIcon();icon.alt='';icon.removeAttribute('title');icon.setAttribute('aria-hidden','true');label.setAttribute(OWN,'brand');
    label.style.cssText='display:inline-flex;align-items:center;gap:var(--space-2);min-width:0;vertical-align:middle;color:var(--muted);font:var(--weight-medium) var(--type-support)/var(--leading-support) var(--sans);text-align:start';
    label.append(icon,document.createTextNode('RelyLess'+(context?' · '+context:'')));return label;
  }
  const pageStatus={host:null,root:null,timer:0,lines:new Map(),dismissed:new Map(),selected:null};
  const statusPriority={support:1,structure:2,emergency:3,passage:4,lookup:5,known:6};
  const statusFailures={support:'自动提示暂不可用',structure:'阅读解构暂不可用',emergency:'本页翻译已停止',passage:'选段翻译失败',lookup:'查词失败',known:'操作未保存'};
  function removePageStatus(){pageStatus.host?.remove();pageStatus.host=null;pageStatus.root=null;pageStatus.selected=null;}
  function createPageStatus(){
    const host=document.createElement('div');host.setAttribute(OWN,'task-status');
    host.style.cssText='position:fixed;top:max(16px,env(safe-area-inset-top));right:max(16px,env(safe-area-inset-right));z-index:2147483647;max-width:calc(100vw - 32px);pointer-events:none';
    const shadow=host.attachShadow({mode:'closed'}),style=document.createElement('style');
    style.textContent=globalThis.ShisuiDesign.cssFor(':host')+
      ":host{font:var(--type-control)/var(--leading-control) var(--sans);color:var(--ink)}*{box-sizing:border-box}[hidden]{display:none!important}.panel{max-width:min(320px,calc(100vw - 32px));border:1px solid var(--line);border-radius:var(--radius-panel);background:var(--surface);box-shadow:var(--shadow-low);pointer-events:auto}.bar{display:flex;align-items:center;gap:var(--space-2);padding:var(--space-1) var(--space-1) var(--space-1) var(--space-3);min-height:40px}.indicator{width:14px;height:14px;flex:none;color:var(--muted);display:grid;place-items:center;font-weight:var(--weight-semibold);font-size:var(--type-support)}.indicator[data-busy=true]{border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:working 1.4s linear infinite}.indicator[data-error=true]{color:var(--danger)}.label{min-width:0;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.count{color:var(--muted);font-size:var(--type-support);flex:none}button{flex:none;min-height:32px;padding:var(--space-1) var(--space-2);border:0;border-radius:var(--radius-control);background:transparent;color:var(--muted);font:inherit;cursor:pointer}button:hover{background:var(--surface-hover);color:var(--ink)}button:focus-visible{outline:var(--focus-ring);outline-offset:var(--focus-offset)}.close{width:32px;padding:0;display:grid;place-items:center}.close svg{width:14px;height:14px}.detail{border-top:1px solid var(--line);padding:var(--space-3);max-height:min(240px,50vh);overflow:auto;color:var(--muted-strong);font-size:var(--type-support);line-height:var(--leading-body);overflow-wrap:anywhere;white-space:pre-wrap}.panel.compact{max-width:none;border-radius:var(--radius-pill)}.panel.compact .bar{gap:0;padding:0;min-height:0}.panel.compact .bar>img{display:none!important}.panel.compact .label,.panel.compact .count,.panel.compact .more,.panel.compact .close{display:none}.panel.compact .indicator{width:18px;height:18px;margin:var(--space-2)}@keyframes working{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.indicator[data-busy=true]{animation:none}}";
    const panel=document.createElement('section'),bar=document.createElement('div'),indicator=document.createElement('span'),label=document.createElement('p'),count=document.createElement('span'),more=document.createElement('button'),close=document.createElement('button'),detail=document.createElement('div');
    panel.className='panel';panel.setAttribute('aria-label','RelyLess 阅读状态');bar.className='bar';indicator.className='indicator';indicator.setAttribute('aria-hidden','true');label.className='label';label.setAttribute('role','status');label.setAttribute('aria-live','polite');label.setAttribute('aria-atomic','true');count.className='count';
    more.type='button';more.textContent='详情';more.setAttribute('aria-expanded','false');more.setAttribute('aria-controls','status-detail');more.setAttribute('aria-label','查看阅读状态详情');detail.className='detail';detail.id='status-detail';detail.hidden=true;
    const collapse=()=>{detail.hidden=true;more.textContent='详情';more.setAttribute('aria-expanded','false');more.setAttribute('aria-label','查看阅读状态详情');};
    more.onclick=()=>{if(!detail.hidden){collapse();return;}detail.hidden=false;more.textContent='收起';more.setAttribute('aria-expanded','true');more.setAttribute('aria-label','收起阅读状态详情');};
    close.type='button';close.className='close';close.setAttribute('aria-label','隐藏本次提示');close.title='隐藏提示，任务继续';close.innerHTML='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg>';
    close.onclick=()=>{for(const [key,entry]of pageStatus.lines)pageStatus.dismissed.set(key,entry.error?entry.text:true);renderPageStatus();};
    panel.addEventListener('keydown',event=>{if(event.key!=='Escape')return;event.preventDefault();event.stopPropagation();if(!detail.hidden){collapse();more.focus();}else close.click();});
    bar.append(createBrandIcon(),indicator,label,count,more,close);panel.append(bar,detail);shadow.append(style,panel);uiMountRoot().append(host);
    pageStatus.host=host;pageStatus.root={indicator,label,count,more,detail,collapse,panel};
  }
  function renderPageStatus(){
    clearTimeout(pageStatus.timer);pageStatus.timer=0;
    const now=Date.now(),active=[];let selected=null,priority=-1,next=Infinity;
    for(const [key,entry]of pageStatus.lines){
      if(entry.expiresAt&&entry.expiresAt<=now){pageStatus.lines.delete(key);pageStatus.dismissed.delete(key);continue;}
      if(entry.expiresAt)next=Math.min(next,entry.expiresAt);
      if(pageStatus.dismissed.has(key))continue;
      if(entry.showAt>now){next=Math.min(next,entry.showAt);continue;}
      active.push(entry);const rank=(entry.error?100:0)+(statusPriority[key]||0);
      if(rank>priority){selected=entry;priority=rank;}
    }
    if(next<Infinity)pageStatus.timer=setTimeout(renderPageStatus,Math.max(1,next-now));
    if(!selected){removePageStatus();return;}
    if(!pageStatus.host?.isConnected)createPageStatus();
    pageStatus.host.style.top=state.reader?Math.max(16,readerScroll().getBoundingClientRect().top+8)+'px':'max(16px,env(safe-area-inset-top))';
    const {indicator,label,count,more,detail,collapse,panel}=pageStatus.root;
    if(pageStatus.selected!==selected.key){collapse();pageStatus.selected=selected.key;}
    panel.classList.toggle('compact',selected.busy&&!selected.error);
    const copy=selected.error?(statusFailures[selected.key]||'阅读辅助暂未完成'):selected.text;
    if(label.textContent!==copy)label.textContent=copy;label.title=copy;
    indicator.dataset.error=String(selected.error);indicator.dataset.busy=String(selected.busy&&!selected.error);indicator.textContent=selected.error?'!':selected.busy?'':'·';
    count.textContent=active.length>1?'+'+(active.length-1):'';count.hidden=active.length<2;count.setAttribute('aria-label','另有 '+(active.length-1)+' 项状态');
    more.hidden=!selected.error&&active.length===1;if(more.hidden)collapse();
    const details=active.map(entry=>entry.text).join('\n\n');if(detail.textContent!==details)detail.textContent=details;
  }
  function setPageStatus(key,text,{error=false,busy=false,duration=0}={}){
    const previous=pageStatus.lines.get(key);
    if(!text){pageStatus.lines.delete(key);pageStatus.dismissed.delete(key);renderPageStatus();return;}
    const dismissed=pageStatus.dismissed.get(key);
    if(dismissed&&error&&dismissed!==text)pageStatus.dismissed.delete(key);
    if(previous?.text===text&&previous.error===error&&previous.busy===busy)return;
    const now=Date.now();pageStatus.lines.set(key,{key,text,error,busy,showAt:busy&&!error?(previous?.busy?previous.showAt:now+600):now,expiresAt:duration?now+duration:0});renderPageStatus();
  }
  function clearPageStatus(){clearTimeout(pageStatus.timer);pageStatus.timer=0;pageStatus.lines.clear();pageStatus.dismissed.clear();removePageStatus();}
  function updatePassageStatus(outcome='cancelled'){const count=state.passageRequests.size;
    setPageStatus('passage',count?'正在翻译'+(count>1?' · '+count+' 处':''):outcome==='complete'?'翻译完成':outcome==='error'?'翻译未完成，未确认内容已撤下':'翻译已取消',{busy:count>0,error:!count&&outcome==='error',duration:count?0:3000});
  }
  const capture={timer:0,generation:0,session:null,lastInput:0,lastTick:0,elapsed:0,total:0,sequence:0,sent:new Set(),visible:new Map(),blocks:new WeakMap(),busy:false,summary:false};
  function historyInteraction(event){if(automatic()&&event.isTrusted)capture.lastInput=Date.now();}
  function stopHistoryCapture(){clearInterval(capture.timer);capture.timer=0;capture.generation++;capture.session=null;capture.visible.clear();}
  async function startHistoryCapture(){
    stopHistoryCapture();if(!state.settings.readingHistory?.enabled||!automatic())return;
    const generation=capture.generation;let session;try{session=await request('HISTORY_BEGIN');}catch{return;}
    if(generation!==capture.generation||!session.enabled)return;
    capture.session=session;capture.lastInput=Date.now();capture.lastTick=Date.now();capture.elapsed=0;capture.total=0;capture.sequence=session.sequence||0;capture.sent.clear();capture.blocks=new WeakMap();capture.summary=false;
    capture.timer=setInterval(()=>void historyTick(),1000);
  }
  async function historyTick(){
    if(capture.busy||!capture.session)return;const now=Date.now(),delta=Math.min(1500,now-capture.lastTick);capture.lastTick=now;
    if(!automatic()||!state.automaticReady||!state.root?.isConnected||!inReadingSurface(state.root)||document.visibilityState!=='visible'||!document.hasFocus()||Boolean(document.activeElement?.closest('input,textarea,[contenteditable=true]'))||now-capture.lastInput>60000){capture.visible.clear();return;}
    const root=state.root;if(!inViewport(root))return;
    capture.busy=true;const generation=capture.generation;
    try{
      const blocks=state.blocks,visible=new Map(),fresh=[];let examined=0;
      for(const block of blocks){if(!inViewport(block)||unsafe(block))continue;const mapping=textMap(block);if(!/[A-Za-z]/.test(mapping.text))continue;
        let memo=capture.blocks.get(block);if(!memo||memo.text!==mapping.text){memo={text:mapping.text,key:(await sha256(mapping.text))+':'+blockId(block)};capture.blocks.set(block,memo);}
        let {left,top,right,bottom}=viewportRect();for(let parent=block;parent;parent=parent.parentElement){const css=getComputedStyle(parent),rect=parent.getBoundingClientRect();if(/hidden|clip|auto|scroll/.test(css.overflowX)){left=Math.max(left,rect.left);right=Math.min(right,rect.right);}if(/hidden|clip|auto|scroll/.test(css.overflowY)){top=Math.max(top,rect.top);bottom=Math.min(bottom,rect.bottom);}}
        for(const match of mapping.text.matchAll(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)){if(++examined>1000)break;const range=rangeFor(mapping,match.index,match.index+match[0].length);if(!range||![...range.getClientRects()].some(r=>r.bottom>top&&r.top<bottom&&r.right>left&&r.left<right))continue;const id=memo.key+':'+match.index,since=capture.visible.get(id)||now;visible.set(id,since);if(now-since>=2000&&!capture.sent.has(id)&&fresh.length<500)fresh.push(id);}
        if(examined>1000)break;
      }
      if(generation!==capture.generation)return;capture.visible=visible;if(!visible.size)return;capture.elapsed+=delta;capture.total+=delta;
      for(const record of state.records){if(record.manual||record.target.stage==='pending'||record.stage==='quiet'||!record.target.historyId||record.historySent)continue;if(!visibleRange(record.range,record.block)){record.historySince=0;continue;}record.historySince ||= now;if(now-record.historySince<2000)continue;record.historySent=true;void request('HISTORY_ANNOTATION',{id:record.target.historyId,stage:record.stage}).catch(()=>{});}
      if(capture.elapsed<4000&&!fresh.length)return;
      const payload={sessionId:capture.session.id,epoch:capture.session.epoch,sequence:++capture.sequence,elapsedMs:Math.min(5000,Math.round(capture.elapsed)),words:fresh,domain:state.domain};
      if(capture.session.summaries&&!capture.summary&&capture.total>=15000&&state.settings.assistanceMode==='ambient'){payload.sample=collectReadingText(blocks).slice(0,2000);capture.summary=true;}
      const result=await request('HISTORY_TICK',payload);if(generation!==capture.generation)return;if(result.recorded){for(const id of fresh)capture.sent.add(id);capture.elapsed=0;}
    }catch{}finally{capture.busy=false;}
  }
  const viewportRect=()=>readerScroll()?.getBoundingClientRect()||{left:0,top:0,right:innerWidth,bottom:innerHeight,width:innerWidth,height:innerHeight};
  const inRect = rect => {const view=viewportRect();return rect.width>0&&rect.height>0&&rect.bottom>view.top&&rect.top<view.bottom&&rect.right>view.left&&rect.left<view.right;};
  function visibleRange(range,block) {
    if(!isVisible(block))return false;
    let {left,top,right,bottom}=viewportRect();
    for(let parent=block;parent;parent=parent.parentElement){
      const style=getComputedStyle(parent),rect=parent.getBoundingClientRect();
      if(/hidden|clip|auto|scroll/.test(style.overflowX)){left=Math.max(left,rect.left);right=Math.min(right,rect.right);}
      if(/hidden|clip|auto|scroll/.test(style.overflowY)){top=Math.max(top,rect.top);bottom=Math.min(bottom,rect.bottom);}
    }
    return [...range.getClientRects()].some(rect=>Math.min(rect.right,right)>Math.max(rect.left,left)&&Math.min(rect.bottom,bottom)>Math.max(rect.top,top));
  }
  const sentenceCanRun=()=>sentenceGroups.enabled&&automatic()&&state.providerConfigured;
  function sentenceClip(block){
    let {left,top,right,bottom}=viewportRect();
    for(let parent=block;parent;parent=parent.parentElement){const style=getComputedStyle(parent),rect=parent.getBoundingClientRect();if(/hidden|clip|auto|scroll/.test(style.overflowX)){left=Math.max(left,rect.left);right=Math.min(right,rect.right);}if(/hidden|clip|auto|scroll/.test(style.overflowY)){top=Math.max(top,rect.top);bottom=Math.min(bottom,rect.bottom);}}
    return {left,top,right,bottom};
  }
  function clearSentenceHighlights(){for(const name of sentenceGroups.highlights.keys())CSS.highlights.delete(name);sentenceGroups.highlights.clear();sentenceGroups.style?.remove();sentenceGroups.style=null;sentenceGroups.hits=[];}
  function sentenceRanges(mapping,start,end){
    const ranges=[];for(const part of mapping.nodes){if(part.end<=start)continue;if(part.start>=end)break;const range=document.createRange();range.setStart(part.node,Math.max(0,start-part.start));range.setEnd(part.node,Math.min(part.node.length,end-part.start));ranges.push(range);}return ranges;
  }
  function sentenceFont(element){const style=getComputedStyle(element);return style.font||style.fontStyle+' '+style.fontWeight+' '+style.fontSize+' '+style.fontFamily;}
  function sentenceHitAt(x,y){
    const measure=sentenceGroups.measure||(sentenceGroups.measure=document.createElement('canvas').getContext('2d'));
    for(const hit of sentenceGroups.hits){const entry=sentenceGroups.entries.get(hit.key);if(!entry||!validSentenceEntry(entry))continue;const clip=sentenceClip(entry.block);if(x<clip.left||x>clip.right||y<clip.top||y>clip.bottom)continue;
      measure.font=sentenceFont(hit.range.startContainer.parentElement);const descent=measure.measureText('Mg').fontBoundingBoxDescent;
      for(const rect of hit.range.getClientRects())if(x>=rect.left&&x<=rect.right&&Math.abs(y-(rect.bottom-descent+hit.offset+.75))<=4)return hit;
    }return null;
  }
  function validSentenceEntry(entry){if(!entry.block?.isConnected||!inReadingSurface(entry.block))return false;const mapping=textMap(entry.block);return mapping.text===entry.sourceText&&mapping.text.slice(entry.start,entry.end)===entry.sentence;}
  const structureRoles=globalThis.ShisuiDesign.structureRoles;
  const structureColors=globalThis.ShisuiDesign.structureColors;
  function sentenceColor(block,role){const rgb=getComputedStyle(block).color.match(/[\d.]+/g)?.slice(0,3).map(Number)||[32,32,32];return structureColors[structureRoles[role][1]][(.2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2])>145?1:0];}

  function removeStructureCard(){sentenceGroups.card?.host.remove();sentenceGroups.card=null;}
  function removeStructureControl(){setPageStatus('structure',null);removeStructureCard();sentenceGroups.hits=[];}
  function updateStructureCard(){
    const ui=sentenceGroups.card;if(!ui)return;const entry=sentenceGroups.entries.get(ui.key);if(!entry||!validSentenceEntry(entry)){removeStructureCard();return;}
    if(ui.signature===entry.id)return;ui.signature=entry.id;ui.tree.replaceChildren();
    const lists=new Map([[-1,ui.tree]]);for(const [index,node]of entry.groups.entries()){const parent=lists.get(node.parent);if(!parent)continue;const item=document.createElement('li'),label=document.createElement('span'),source=document.createElement('span');label.className='role';label.textContent=structureRoles[node.role][0];label.style.color=sentenceColor(entry.block,node.role);source.lang='en';source.textContent=entry.sentence.slice(node.start,node.end);item.append(label,source);parent.append(item);if(entry.groups.some(child=>child.parent===index)){const children=document.createElement('ul');item.append(children);lists.set(index,children);}}
  }
  function updateStructureControl(){
    if(lookupBusy())return;
    if(!sentenceGroups.enabled||!state.enabled||state.emergency){removeStructureControl();return;}
    if(state.settings.assistanceMode==='on-demand'){setPageStatus('structure',null);updateStructureCard();return;}
    const paused=state.paused||document.visibilityState!=='visible',busy=sentenceGroups.status==='analyzing'||sentenceGroups.status==='queued';
    const error=Boolean(sentenceGroups.error)||!state.providerConfigured,copy=sentenceGroups.error?'阅读解构未完成 · '+sentenceGroups.error:!state.providerConfigured?'请先连接服务，再开启阅读解构':!paused&&busy?'正在解构正文':null;
    setPageStatus('structure',copy,{error,busy:busy&&!paused});updateStructureCard();
  }
  function applySentenceDensity(density){if(!['coarse','medium','fine'].includes(density))throw new Error('无效的解构粒度。');sentenceGroups.density=density;renderSentenceGroups();return status();}
    function applySentenceLineStyle(lineStyle){if(!['solid','dashed','dotted','wavy'].includes(lineStyle))throw new Error('无效的下划线样式。');sentenceGroups.lineStyle=lineStyle;renderSentenceGroups();return status();}
  function onStructureClick(event){
    if(!event.isTrusted||!inReadingSurface(event.target)||nodeElement(event.target)?.closest('['+OWN+'="sentence-detail"]'))return;
    if(!sentenceCanRun()||event.shiftKey||event.ctrlKey||event.metaKey||getSelection()?.toString()||nodeElement(event.target)?.closest('a,button,input,select,.'+MARK_CLASS)||nodeElement(event.target)?.closest('['+OWN+']')&&!readerContent(event.target)){removeStructureCard();return;}
    const hit=sentenceHitAt(event.clientX,event.clientY);removeStructureCard();if(!hit)return;
    openStructureCard(hit.key,event.clientX,event.clientY);
  }
  function openStructureCard(key,x,y){
    const host=document.createElement('div');host.setAttribute(OWN,'sentence-detail');host.style.cssText='position:fixed;z-index:2147483646;width:min(340px,calc(100vw - 32px))';
    const shadow=host.attachShadow({mode:'closed'}),style=document.createElement('style'),panel=document.createElement('section'),head=document.createElement('div'),title=createBrandLabel('阅读解构'),close=document.createElement('button'),tree=document.createElement('ul');
    style.textContent=globalThis.ShisuiDesign.cssFor(':host')+':host{font:var(--type-control)/var(--leading-control) var(--sans);color:var(--ink)}section{box-sizing:border-box;max-height:min(60vh,420px);overflow:auto;padding:var(--space-3);background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-panel);box-shadow:var(--shadow-high)}.head{display:flex;align-items:center;justify-content:space-between;gap:12px}button{font:inherit;color:var(--muted);border:0;background:transparent;min-height:32px;cursor:pointer}ul{list-style:none;padding-left:14px;margin:8px 0}section>ul{padding-left:0}li{margin:7px 0;overflow-wrap:anywhere}.role{font-weight:var(--weight-medium);margin-right:8px}';
    panel.setAttribute('role','dialog');panel.setAttribute('aria-label','RelyLess · 本句解构');head.className='head';close.type='button';close.textContent='关闭';close.onclick=removeStructureCard;head.append(title,close);panel.append(head,tree);shadow.append(style,panel);uiMountRoot().append(host);sentenceGroups.card={host,tree,key,signature:''};updateStructureCard();const bounds=host.getBoundingClientRect();host.style.left=Math.max(16,Math.min(x-16,innerWidth-bounds.width-16))+'px';host.style.top=Math.max(12,Math.min(y+12,innerHeight-bounds.height-12))+'px';close.focus({preventScroll:true});
  }
  function originalTextRows(block,mapping,start,end,clip){
    const rows=[];
    for(const part of mapping.nodes){if(part.end<=start)continue;if(part.start>=end)break;const range=document.createRange();range.setStart(part.node,Math.max(0,start-part.start));range.setEnd(part.node,Math.min(part.node.length,end-part.start));for(const rect of range.getClientRects()){
      const left=Math.max(rect.left,clip.left),right=Math.min(rect.right,clip.right);if(right-left<1||rect.bottom<=clip.top||rect.top>=clip.bottom)continue;
      const visible=document.elementFromPoint((left+right)/2,Math.max(clip.top,rect.top)+Math.min(rect.height,clip.bottom-rect.top)/2);if(visible&&!block.contains(visible)&&!visible.contains(block))continue;
      rows.push({left,right,top:rect.bottom,height:rect.height});}}
    rows.sort((a,b)=>a.top-b.top||a.left-b.left);const merged=[];for(const row of rows){const last=merged.at(-1);if(last&&Math.abs(last.top-row.top)<=2){last.left=Math.min(last.left,row.left);last.right=Math.max(last.right,row.right);last.top=Math.max(last.top,row.top);last.height=Math.max(last.height,row.height);}else merged.push(row);}return merged;
  }
  function renderSentenceGroups(){
    if(lookupBusy())return;
    cancelAnimationFrame(sentenceGroups.frame);sentenceGroups.frame=0;sentenceGroups.hits=[];
    if(!sentenceCanRun()){clearSentenceHighlights();updateStructureControl();return;}
    const highlights=new Map(),rules=[],room=new WeakMap(),descents=new Map();
    for(const [key,entry]of sentenceGroups.entries){
      if(!entry.block?.isConnected||!inReadingSurface(entry.block)){sentenceGroups.entries.delete(key);sentenceGroups.processed.delete(key);continue;}
      const mapping=textMap(entry.block);if(mapping.text!==entry.sourceText||mapping.text.slice(entry.start,entry.end)!==entry.sentence){sentenceGroups.entries.delete(key);sentenceGroups.processed.delete(key);continue;}
      const density=sentenceGroups.density,style=getComputedStyle(entry.block),leading=parseFloat(style.lineHeight)||parseFloat(style.fontSize)*1.2;entry.tight=false;
      const hasRoom=(range,offset)=>{let available=room.get(range);if(available===undefined){const font=sentenceFont(range.startContainer.parentElement);let descent=descents.get(font);if(descent===undefined){const measure=sentenceGroups.measure||(sentenceGroups.measure=document.createElement('canvas').getContext('2d'));measure.font=font;descent=measure.measureText('Mg').fontBoundingBoxDescent;descents.set(font,descent);}available=Infinity;for(const rect of range.getClientRects())available=Math.min(available,leading-rect.height+descent);room.set(range,available);}return available>=offset+(sentenceGroups.lineStyle==='wavy'?3:1.5);};
      const children=new Map();for(const [index,node]of entry.groups.entries()){if(!children.has(node.parent))children.set(node.parent,[]);children.get(node.parent).push(index);}
      const selected=[];if(density==='coarse'){const visit=index=>{const node=entry.groups[index],inside=children.get(index)||[];if(node.role==='adverbial'||node.role==='attributive'&&inside.some(child=>entry.groups[child].role==='predicate'))selected.push(index);else for(const child of inside)visit(child);};visit(0);}else selected.push(...children.get(0)||[]);
      const add=(node,ranges,offset)=>{const color=sentenceColor(entry.block,node.role),name='shisui-'+runtime.id+'-'+node.role+'-'+color.slice(1)+'-'+offset;for(const range of ranges){if(!hasRoom(range,offset)){entry.tight=true;continue;}let highlight=highlights.get(name);if(!highlight){highlight=new Highlight();highlight.priority=offset===9?0:1;highlights.set(name,highlight);rules.push('::highlight('+name+'){text-decoration-line:underline;text-decoration-color:'+color+';text-decoration-style:'+sentenceGroups.lineStyle+';text-decoration-thickness:1.5px;text-underline-offset:'+offset+'px;text-decoration-skip-ink:auto}');}highlight.add(range);sentenceGroups.hits.push({key,range,offset});}};
      for(const index of selected){const node=entry.groups[index],ranges=sentenceRanges(mapping,entry.start+node.start,entry.start+node.end),inner=density==='fine'?children.get(index)||[]:[],nested=inner.length>0&&ranges.every(range=>hasRoom(range,9));
        if(inner.length&&!nested)entry.tight=true;add(node,ranges,nested?9:3);if(nested)for(const child of inner){const part=entry.groups[child];add(part,sentenceRanges(mapping,entry.start+part.start,entry.start+part.end),3);}
      }
    }
    for(const name of sentenceGroups.highlights.keys())if(!highlights.has(name))CSS.highlights.delete(name);
    for(const [name,highlight]of highlights)CSS.highlights.set(name,highlight);sentenceGroups.highlights=highlights;
    if(highlights.size){if(!sentenceGroups.style){const style=document.createElement('style');style.setAttribute(OWN,'sentence-style');document.documentElement.append(style);sentenceGroups.style=style;}const css=rules.join('');if(sentenceGroups.style.textContent!==css)sentenceGroups.style.textContent=css;}else clearSentenceHighlights();
    updateStructureControl();
  }
  function scheduleSentenceRender(){if(lookupBusy()||sentenceGroups.frame)return;sentenceGroups.frame=requestAnimationFrame(renderSentenceGroups);}
  function validSentenceGroups(item,job){
    if(!item||item.id!==job.id||!Array.isArray(item.groups)||!item.groups.length||item.groups.length>64)return false;
    const depths=[],lastEnds=new Map();for(const [index,node]of item.groups.entries()){
      if(!node||!Object.hasOwn(structureRoles,node.role)||!Number.isInteger(node.start)||!Number.isInteger(node.end)||node.start<0||node.end<=node.start||node.end>job.sentence.length||!Number.isInteger(node.parent)||node.parent>=index)return false;
      if(index===0){if(node.parent!==-1||node.role!=='clause')return false;depths.push(0);continue;}
      const parent=item.groups[node.parent];if(!parent||node.start<parent.start||node.end>parent.end||node.start<(lastEnds.get(node.parent)||0))return false;lastEnds.set(node.parent,node.end);const depth=depths[node.parent]+1;if(depth>4)return false;depths.push(depth);
    }return true;
  }
  function visibleSentenceJobs(){
    const jobs=[],found=resolveReadingRoot(),root=found?.element||(state.reader?null:document.querySelector('article,main,[role="main"]'));sentenceGroups.root=root;if(!root)return jobs;
    for(const block of found?.blocks||eligibleBlocks(root)){
      if(!inViewport(block))continue;const mapping=textMap(block),sourceText=mapping.text;if(!sourceTexts.has(block))sourceTexts.set(block,sourceText);
      for(const sentence of segments(sourceText)){
        if(sentence.segment.length>2000)continue;const start=sentence.index,end=start+sentence.segment.length,range=rangeFor(mapping,start,end);if(!range||!visibleRange(range,block))continue;
        const key=blockId(block)+':'+start+':'+sentence.segment;if(sentenceGroups.processed.has(key))continue;jobs.push({id:'g'+(++nextSentence),key,block,start,end,sentence:sentence.segment,sourceText});
      }
    }
    return jobs;
  }
  async function scanSentenceGroups(){
    clearTimeout(sentenceGroups.timer);sentenceGroups.timer=0;if(lookupBusy()||sentenceGroups.running||!sentenceCanRun()){updateStructureControl();return;}
    if(sentenceGroups.failed.size&&!sentenceGroups.error)sentenceGroups.error='有 '+sentenceGroups.failed.size+' 句未完成，请重试。';let pending=visibleSentenceJobs();if(!pending.length){sentenceGroups.status=sentenceGroups.error?'error':'idle';updateStructureControl();return;}
    sentenceGroups.running=true;sentenceGroups.status='analyzing';if(!sentenceGroups.failed.size)sentenceGroups.error='';updateStructureControl();const generation=sentenceGroups.generation,page=location.href,surface=readingScope();let activeBatch=[];
    try{
      while(pending.length&&!lookupBusy()&&sentenceCanRun()&&generation===sentenceGroups.generation&&page===location.href&&surface===readingScope()){
        const batch=[];let size=0;while(pending.length&&batch.length<2){const next=pending[0];if(batch.length&&size+next.sentence.length>4000)break;pending.shift();batch.push(next);size+=next.sentence.length;}activeBatch=batch;
        const result=await request('SENTENCE_GROUPS_BATCH',{items:batch.map(({id,sentence})=>({id,sentence}))});
        if(lookupBusy())await waitForLookupIdle();
        if(!sentenceCanRun()||generation!==sentenceGroups.generation||page!==location.href||surface!==readingScope()){reportResult(result,'cancelled');return;}
        if(!result||!Array.isArray(result.items)||result.items.length!==batch.length)throw new Error('结构分析未返回完整批次。');
        const ids=new Set();for(const item of result.items){const job=batch.find(value=>value.id===item?.id);if(!job||ids.has(item.id)||!validSentenceGroups(item,job))throw new Error('阅读解构范围无效。');ids.add(item.id);if(validSentenceEntry(job)){sentenceGroups.entries.set(job.key,{...job,groups:item.groups});sentenceGroups.processed.add(job.key);sentenceGroups.failed.delete(job.key);}}
        reportResult(result,'ok');renderSentenceGroups();activeBatch=[];pending=visibleSentenceJobs();
      }
      if(generation===sentenceGroups.generation&&surface===readingScope()){sentenceGroups.status=sentenceGroups.failed.size?'error':'idle';if(!sentenceGroups.failed.size)sentenceGroups.error='';}
    }catch(error){if(generation===sentenceGroups.generation&&surface===readingScope()){for(const job of activeBatch)if(validSentenceEntry(job)){sentenceGroups.processed.add(job.key);sentenceGroups.failed.add(job.key);}sentenceGroups.status='error';sentenceGroups.error=error.message||'阅读解构失败。';}}
    finally{sentenceGroups.running=false;updateStructureControl();if(sentenceCanRun()&&generation!==sentenceGroups.generation)scheduleSentenceScan(0);}
  }
  function scheduleSentenceScan(delay=120){if(lookupBusy()||!sentenceCanRun())return;clearTimeout(sentenceGroups.timer);sentenceGroups.timer=setTimeout(()=>void scanSentenceGroups(),delay);}
  function stopSentenceGroups(clear=false){
    sentenceGroups.generation++;clearTimeout(sentenceGroups.timer);sentenceGroups.timer=0;cancelAnimationFrame(sentenceGroups.frame);sentenceGroups.frame=0;clearSentenceHighlights();
    if(clear){sentenceGroups.root=null;sentenceGroups.enabled=false;sentenceGroups.entries.clear();sentenceGroups.processed.clear();sentenceGroups.failed.clear();sentenceGroups.status='off';sentenceGroups.error='';removeStructureControl();}
  }
  async function setSentenceGroups(enabled){
    if(typeof enabled!=='boolean')throw new Error('无效的阅读解构设置。');
    if(enabled)pageStatus.dismissed.delete('structure');
    if(enabled){const mode=await request('SENTENCE_GROUPS_GET');sentenceGroups.density=mode.density||'medium';sentenceGroups.lineStyle=mode.lineStyle||'solid';if(!state.providerConfigured){const snapshot=await request('STATE_GET');state.settings=snapshot.settings;state.providerConfigured=Boolean(snapshot.providerConfigured);}}
    if(enabled&&!state.providerConfigured){sentenceGroups.enabled=false;stopSentenceGroups(true);throw new Error('辅助服务尚未连接，无法开启阅读解构。');}
    if(enabled&&!state.enabled)await setManualEnabled(true);sentenceGroups.enabled=enabled;if(!enabled){stopSentenceGroups(true);return status();}
    sentenceGroups.generation++;sentenceGroups.status=automatic()?'queued':'idle';sentenceGroups.error='';updateStructureControl();scheduleSentenceRender();scheduleSentenceScan(0);return status();
  }
  async function restoreSentenceGroups(){
    const page=location.href;try{const result=await request('SENTENCE_GROUPS_GET');if(!isAlive()||page!==location.href)return;sentenceGroups.density=result.density||'medium';sentenceGroups.lineStyle=result.lineStyle||'solid';sentenceGroups.enabled=Boolean(result?.enabled);
      if(sentenceGroups.enabled){const snapshot=await request('STATE_GET');if(!isAlive()||page!==location.href)return;state.settings=snapshot.settings;state.providerConfigured=Boolean(snapshot.providerConfigured);sentenceGroups.status=state.providerConfigured?(automatic()?'queued':'idle'):'error';sentenceGroups.error=state.providerConfigured?'':'辅助服务尚未连接。';scheduleSentenceScan(0);updateStructureControl();}
    }catch(error){if(page!==location.href)return;sentenceGroups.enabled=false;sentenceGroups.status='error';sentenceGroups.error=error.message||'无法读取阅读解构设置。';}
  }
  const inViewport = element => inReadingSurface(element) && isVisible(element) && [...element.getClientRects()].some(inRect);
  function safeLinkHref(link) {
    try { const url = new URL(link.getAttribute('href'),location.href); return ['http:','https:','mailto:'].includes(url.protocol); } catch { return false; }
  }
  function unsafe(element,explicit=false) {
    if (!element || !inReadingSurface(element) || (element.closest(SKIP) && !readerContent(element)) || element.closest(explicit?'kbd,samp':'code,kbd,samp') || element.closest(`[${OWN}="card"],[${OWN}="video"]`)) return true;
    const link = element.closest('a');
    return Boolean(link && !safeLinkHref(link));
  }
  // 混合段落兜底证据：三种以上常用英文词，且拉丁字母仍占全部字母的两成以上。中文为主、只夹带零散英文的段落不会通过。
  const COMMON_ENGLISH_WORDS=new Set('the and for that with from this have not are was were which their there when what about would could should because into over after before while during each other some such only also than then them they these those your its more most very just like well here where who how all any both own same too been has had will can may but you she her his our us me my we it is of to in on as at by or an be so no if do does did says said'.split(' '));
  const mixedEnglishBlock=text=>{
    const letters=(text.match(/[A-Za-z\u00c0-\u024f\u4e00-\u9fff]/g)||[]).length;
    if(!letters||(text.match(/[A-Za-z]/g)||[]).length/letters<.2)return false;
    const words=new Set((text.toLowerCase().match(/[a-z]+(?:['\u2019-][a-z]+)*/g)||[]).filter(word=>COMMON_ENGLISH_WORDS.has(word)));
    return words.size>=3;
  };
  function siteRule(settings=state.settings){
    const cached=settings===state.settings;if(cached&&state.siteRuleChecked)return state.siteRule;
    if(cached)state.siteRuleChecked=true;
    const packs=settings.rulePacks;
    if(Array.isArray(packs)&&packs.length){
      const hostname=location.hostname,pathname=location.pathname;
      for(const pack of packs)for(const rule of pack.rules||[]){
        if(!rule.hosts.some(host=>hostname===host||hostname.endsWith('.'+host)))continue;
        if(rule.paths.length&&!rule.paths.some(path=>pathname.startsWith(path)))continue;
        if(cached)state.siteRule=rule;return rule;
      }
    }
    return null;
  }
  // 规则包只做“额外排除”，不替换内置 SKIP；坏选择器在运行时被忽略，不影响其余扫描。
  function ruleExcluded(block){
    const rule=siteRule();
    if(!rule?.exclude?.length)return false;
    try{return block.closest(rule.exclude.join(','));}catch{return false;}
  }
  function eligibleBlocks(root) {
      if(!root)return [];
      const candidates=[...(root.matches?.(BLOCK_SELECTOR)?[root]:[]),...root.querySelectorAll(BLOCK_SELECTOR)],page=location.href.split('#')[0];
      return candidates.filter(block=>{
        if((block.closest(SKIP)&&!readerContent(block))||block.closest('['+OWN+']')&&!readerContent(block)||!inReadingSurface(block)||!isVisible(block)||!state.reader&&ruleExcluded(block))return false;
        const mapping=textMap(block),text=mapping.text,latin=(text.match(/[A-Za-z]/g)||[]).length,letters=(text.match(/[A-Za-z\u00c0-\u024f\u4e00-\u9fff]/g)||[]).length;
        const minimum=/^H[1-6]$/.test(block.tagName)?4:12;
        if(latin<minimum)return false;
        // 英文为主直接保留；拉丁字母占比不足的混合段落按英文证据兜底，不因为夹带中文等文字整块丢弃。
        if(latin/Math.max(letters,1)<.58&&!mixedEnglishBlock(text))return false;
        if(/^(DIV|SECTION|ARTICLE|MAIN)$/.test(block.tagName)&&(text.match(/[A-Za-z]+/g)||[]).length<8)return false;
        let links=0;for(const {node}of mapping.nodes){const link=node.parentElement.closest('a');if(link&&(!/^H[1-6]$/.test(block.tagName)||link.href.split('#')[0]!==page))links+=node.nodeValue.length;}
        return links/Math.max(text.trim().length,1)<.5;
      });
    }
  function collectReadingText(blocks,limit=2000){let text='';for(const block of blocks){const part=blockText(block);if(text.length+part.length+1>limit)continue;text+=part+'\n';}return text;}
  
  async function articleContext(readable,focus=[]) {
      const original=readable.map(blockText).join('\n'),normalized=normalizeText(original),key=await sha256(original);
      if(normalized.length<=12000&&readable.length<=4)return {key,text:normalized,coverage:'full'};
      const selected=[],seen=new Set(),allowed=new Set(readable);
      const add=block=>{if(!allowed.has(block)||seen.has(block))return;seen.add(block);const text=normalizeText(blockText(block));if(text)selected.push(text);};
      readable.filter(block=>block.matches('h1,h2,h3')).slice(0,24).forEach(add);readable.slice(0,4).forEach(add);
      focus.forEach(block=>{add(block.previousElementSibling);add(block);add(block.nextElementSibling);});
      const title=normalizeText(document.title),pieces=title?[title,...selected]:selected;
      let text='';for(const piece of pieces){if(text.length>=12000)break;const room=12000-text.length-(text?1:0);if(room<=0)break;text+=(text?'\n':'')+piece.slice(0,room);}
      return {key,text,coverage:'excerpt'};
    }
  function resolveReadingRoot() {
      if(state.reader){const element=readingScope(),blocks=eligibleBlocks(element);return blocks.length?{element,blocks,latin:blocks.map(blockText).join(' ').match(/[A-Za-z]/g)?.length||0}:null;}
      const all=eligibleBlocks(document.body);
      // 规则包可以指定正文根：站点结构清晰时比语义推测更稳，命中且确实含英文块时优先采用。
      const ruleRoot=siteRule()?.root;
      if(ruleRoot){let element=null;try{element=document.querySelector(ruleRoot);}catch{element=null;}
        if(element&&isVisible(element)&&!element.closest(SKIP)){
          const blocks=all.filter(block=>element.contains(block)),latin=blocks.map(blockText).join(' ').match(/[A-Za-z]/g)?.length||0;
          if(blocks.length&&latin>=12)return {element,blocks,latin};
        }
      }
      function score(element){
        if(!element||element===document.body||!isVisible(element)||element.closest(SKIP))return null;
        const blocks=all.filter(block=>element.contains(block)),prose=blocks.map(blockText).join(' '),latin=(prose.match(/[A-Za-z]/g)||[]).length;
        let links=0;for(const block of blocks)for(const {node}of textMap(block).nodes)if(node.parentElement.closest('a'))links+=node.nodeValue.length;
        return blocks.length>=2&&latin>=200&&links/Math.max(prose.length,1)<.35?{element,blocks,latin}:null;
      }
      function best(candidates){return candidates.filter(Boolean).reduce((chosen,item)=>{
        if(!chosen)return item;
        const nested=chosen.element.contains(item.element)||item.element.contains(chosen.element);
        if(nested&&chosen.blocks.length===item.blocks.length)return chosen.element.contains(item.element)?item:chosen;
        return item.latin>chosen.latin?item:chosen;
      },null);}
      const article=best([...document.querySelectorAll('article')].map(score)),main=best([...document.querySelectorAll('main,[role="main"]')].map(score));
      if(article&&(!main||main.element.contains(article.element)&&article.latin>=main.latin/2)){
        const lead=main?main.blocks.filter(block=>!article.element.contains(block)&&/^(P|H1|BLOCKQUOTE)$/.test(block.tagName)&&(block.compareDocumentPosition(article.element)&Node.DOCUMENT_POSITION_FOLLOWING)):[];
        return lead.length?{element:main.element,blocks:[...lead,...article.blocks],latin:article.latin+lead.reduce((sum,block)=>sum+(blockText(block).match(/[A-Za-z]/g)||[]).length,0)}:article;
      }
      const semantic=best([article,main]);if(semantic)return semantic;
      const parents=new Set();for(const block of all){let parent=block.parentElement;for(let i=0;i<3&&parent&&parent!==document.body;i++,parent=parent.parentElement)parents.add(parent);}
      return best([...parents].map(score));
    }
  const segments = text => [...new Intl.Segmenter('en',{granularity:'sentence'}).segment(text)].filter(item => /[A-Za-z]/.test(item.segment));
  function rangeFor(mapping,start,end) {
    const first = mapping.nodes.find(entry => entry.end > start), last = [...mapping.nodes].reverse().find(entry => entry.start < end);
    if (!first || !last) return null;
    const range = document.createRange(); range.setStart(first.node,start-first.start); range.setEnd(last.node,end-last.start); return range;
  }
  function boundaryOffset(mapping,node,offset) {
    for (const entry of mapping.nodes) {
      if (entry.node === node) return entry.start + Math.min(offset,entry.node.nodeValue.length);
      const segment = document.createRange(); segment.selectNodeContents(entry.node);
      if (segment.comparePoint(node,offset) <= 0) return entry.start;
    }
    return mapping.text.length;
  }
  function readingBlockFor(node,explicit=false) {
    let block = nodeElement(node)?.closest(BLOCK_SELECTOR);
    while (block && inReadingSurface(block)) { if ((!block.closest(SKIP)||readerContent(block)) && blockText(block)) return block; block = block.parentElement?.closest(BLOCK_SELECTOR); }
    return explicit&&readingScope()?.contains(node)&&!unsafe(nodeElement(node),true)?readingScope():null;
  }
  function helpTarget(range,selected,record=null) {
    const block = readingBlockFor(range.startContainer,true);
    if (!block || readingBlockFor(range.endContainer,true) !== block || unsafe(nodeElement(range.startContainer),true) || unsafe(nodeElement(range.endContainer),true)) throw new Error(LIMIT_ERROR);
    const mapping = textMap(block);
    let start = boundaryOffset(mapping,range.startContainer,range.startOffset), end = boundaryOffset(mapping,range.endContainer,range.endOffset);
    if (!selected) {
      const word = [...mapping.text.matchAll(/[A-Za-z](?:[A-Za-z'’—-]*[A-Za-z])?/g)].find(item => item.index <= start && item.index + item[0].length >= start);
      if (!word) throw new Error('这里没有可解释的英文词。');
      start = word.index; end = start + word[0].length; range = rangeFor(mapping,start,end);
    }
    const text = mapping.text.slice(start,end);
    if (!text.trim() || !/[A-Za-z]/.test(text)) throw new Error('请选择英文词语或句子。');
    if (text !== range.toString() || mapping.nodes.some(entry => entry.end > start && entry.start < end && unsafe(entry.node.parentElement,true))) throw new Error(LIMIT_ERROR);
    const sentences = segments(mapping.text), first = sentences.find(item => item.index + item.segment.length > start), last = [...sentences].reverse().find(item => item.index < end);
    let context = first && last ? mapping.text.slice(first.index,last.index + last.segment.length) : text;
    if (context.length > 2000) {
      if(!/^[A-Za-z][A-Za-z'’—-]*$/.test(text.trim()))throw new Error('上下文超过 2000 字符，请选择更短的句子。');
      let left=Math.max(0,Math.min(start-(first?.index||0)-800,context.length-2000)),right=Math.min(context.length,left+2000);
      if(/[\uDC00-\uDFFF]/.test(context[left]))left++;if(/[\uD800-\uDBFF]/.test(context[right-1]))right--;
      context=context.slice(left,right);
    }
    const whole = normalizeText(context) === normalizeText(text);
    const kind = /^[A-Za-z][A-Za-z'’—-]*$/.test(text.trim()) ? 'word' : text.length > 100 || whole || /[.!?]/.test(text) ? 'passage' : 'phrase';
    if (text.length > 600 || (kind === 'passage' && segments(text).length > 3)) throw new Error(LIMIT_ERROR);
    const manualAssists=record?.manual?record.target.manualAssists||null:null;
    return {text,sourceText:mapping.text,context:record?.manual?record.context||context:record?.job?.sentence||context,kind,block,anchor:range.cloneRange(),generation:state.generation,viewportGeneration:state.viewportGeneration,support:record?.manual?record.target.manualSupport||null:record?.target||null,prepared:record?.manual?null:record?.target||null,manualAssists,requestedRecord:record?.manual?record:null,preparationArticle:record?.target?.preparationArticle,domain:record?.job?.domain};
  }
  function installPageStyles(){
      const mark='.'+MARK_CLASS+'['+OWN+'="term"]',hint='.'+HINT_CLASS+'['+OWN+'="hint"]',block='['+OWN+'="emergency-translation"]',passage='['+OWN+'="passage-translation"]',action='['+OWN+'="passage-action"]',annotation='['+OWN+'="annotation"]';
      let style=document.getElementById('shisui-content-style');if(!style){style=document.createElement('style');style.id='shisui-content-style';style.setAttribute(OWN,'style');document.documentElement.append(style);}const readingStyle=globalThis.ShisuiReadingStyle.normalize(state.settings.readingStyle),selectors={mark,hint,block,annotation};
      const pending=mark+'[data-shisui-support-stage="pending"]'; style.textContent=globalThis.ShisuiDesign.cssFor(mark+','+hint+','+block+','+passage+','+annotation+','+action)+mark+'{cursor:text}'+hint+'{user-select:none;cursor:text}'+globalThis.ShisuiReadingStyle.css(readingStyle,selectors)+globalThis.ShisuiReadingStyle.css(readingStyle,{...selectors,block:passage})+pending+'{background:none!important;color:inherit!important;border:0!important;border-radius:3px!important;box-shadow:0 0 0 1px color-mix(in srgb,currentColor 55%,transparent)!important;text-decoration:none!important}';
      style.textContent+=block+' button{font:inherit;font-size:.85em;line-height:1.4;min-height:32px;margin:0 .25em;padding:.2em .6em;border:1px solid currentColor;border-radius:4px;background:transparent;color:inherit;cursor:pointer}'+block+' button:focus-visible{outline:2px solid currentColor;outline-offset:3px}';
      style.textContent+=hint+'.veiled{filter:blur(4px)!important;opacity:.75!important;cursor:pointer;transition:filter .15s ease,opacity .15s ease}'+annotation+':hover '+hint+'.veiled,'+hint+'.veiled:focus-visible,'+hint+'.veiled[data-revealed]{filter:none!important;opacity:1!important}'+hint+'.veiled:focus-visible{outline:var(--focus-ring);outline-offset:var(--focus-offset)}@media(prefers-reduced-motion:reduce){'+hint+'.veiled{transition:none}}';
      const known='['+OWN+'="known-action"]';style.textContent+=annotation+'{position:relative}'+known+'{position:absolute;left:100%;top:50%;z-index:2;transform:translate(0,-50%);opacity:0;pointer-events:none;transition:opacity .12s ease;min-height:26px;box-sizing:border-box;padding:2px 8px;border:1px solid var(--line);border-radius:999px;background:var(--surface);box-shadow:var(--shadow-low);color:var(--accent);font:var(--weight-medium) var(--type-support)/var(--leading-support) var(--sans);white-space:nowrap;cursor:pointer}'+known+'::before{content:"";position:absolute;inset:-6px -2px -6px -12px}'+annotation+'[data-shisui-known-visible]>'+known+','+annotation+':focus-within>'+known+','+known+':focus{opacity:1;pointer-events:auto}'+known+':hover{background:var(--accent-soft)}'+known+':focus-visible{opacity:1;pointer-events:auto;outline:var(--focus-ring);outline-offset:var(--focus-offset)}'+known+':disabled{color:var(--on-action-disabled);background:var(--action-disabled);cursor:default}';
    }
  function removeKnownWordAnnotations(wordIds){
    const view=state.card;
    if(view&&wordIds.has(view.knownWordId())){
      if(state.assistRequestId===view.requestId)state.assistRequestId='';
      view.refreshPreparedOnClose=false;closeCard();
    }
    state.records=state.records.filter(record=>{
      if(!wordIds.has(record.target.wordId))return true;
      let blocks=state.knownBlocks.get(record.target.wordId);
      if(!blocks)state.knownBlocks.set(record.target.wordId,blocks=new Set());
      blocks.add(record.block);
      if(record.inlineRequestId){
        if(lookup.inlineRequestId===record.inlineRequestId)setPageStatus('lookup',null);
        record.inlineRequestId=null;
      }
      const requestedIndex=requestedRecords.indexOf(record);
      if(requestedIndex!==-1)requestedRecords.splice(requestedIndex,1);
      unwrapRecord(record);return false;
    });
  }
  function applyWordPreference(message){
    const wordIds=new Set(message.wordIds);
    for(const id of wordIds)if(message.known)state.knownWords.add(id);else state.knownWords.delete(id);
    if(message.known){removeKnownWordAnnotations(wordIds);return;}
    let restored=false;
    for(const id of wordIds){
      for(const block of state.knownBlocks.get(id)||[])if(block.isConnected){state.processed.delete(blockId(block));restored=true;}
      state.knownBlocks.delete(id);
    }
    if(restored){state.windowKey='';void refreshViewport();}
  }
  function showKnownFeedback(wordId,term){
    const previous=uiMountRoot().querySelector('['+OWN+'="known-feedback"]');previous?.remove();
    const host=document.createElement('div');host.setAttribute(OWN,'known-feedback');host.style.cssText='position:fixed;left:50%;bottom:max(20px,env(safe-area-inset-bottom));transform:translateX(-50%);z-index:2147483647;max-width:calc(100vw - 24px)';
    const shadow=host.attachShadow({mode:'closed'}),style=document.createElement('style'),panel=document.createElement('div'),message=document.createElement('span'),undo=document.createElement('button');
    style.textContent=globalThis.ShisuiDesign.cssFor(':host')+':host{font:var(--type-control)/var(--leading-control) var(--sans);color:var(--ink)}div{display:flex;align-items:center;gap:var(--space-3);padding:var(--space-3) var(--space-4);border:1px solid var(--line);border-radius:var(--radius-panel);background:var(--surface);box-shadow:var(--shadow-high)}span{min-width:0;overflow-wrap:anywhere}button{flex:none;min-height:32px;padding:var(--space-1) var(--space-3);border:1px solid var(--line);border-radius:var(--radius-pill);background:var(--surface);color:var(--accent);font:var(--weight-medium) var(--type-control)/var(--leading-control) var(--sans);cursor:pointer}button:hover{background:var(--accent-soft)}button:focus-visible{outline:var(--focus-ring);outline-offset:var(--focus-offset)}button:disabled{color:var(--on-action-disabled);background:var(--action-disabled)}';
    message.textContent='已认识“'+term+'”，以后不再自动提示。';undo.type='button';undo.textContent='撤销';
    undo.onclick=async()=>{undo.disabled=true;try{await request('WORD_PREFERENCE_SET',{wordId,known:false});host.remove();setPageStatus('known','已恢复“'+term+'”的自动提示。',{duration:3000});}catch(error){undo.disabled=false;message.textContent='恢复失败：'+error.message;}};
    panel.append(createBrandIcon(),message,undo);shadow.append(style,panel);uiMountRoot().append(host);setTimeout(()=>host.remove(),8000);
  }
  async function setWordKnown(wordId,term,button){
    if(!wordId)return;button.disabled=true;state.knownWords.add(wordId);
    try{const saved=await request('WORD_PREFERENCE_SET',{wordId,known:true});removeKnownWordAnnotations(new Set([wordId]));showKnownFeedback(saved.wordId||wordId,saved.term||term);}
    catch(error){state.knownWords.delete(wordId);button.disabled=false;setPageStatus('known','未能保存“已认识”：'+error.message,{error:true,duration:5000});}
  }
  function attachKnownAction(record){
    if(record.knownAction||!record.wrapper||!record.target.wordId)return;
    const button=document.createElement('button');button.type='button';button.setAttribute(OWN,'known-action');button.textContent='我已认识';button.setAttribute('aria-label','我已认识 '+record.target.text+'，不再自动提示');button.title='不再自动提示这个词';
    const stop=event=>{event.preventDefault();event.stopPropagation();event.stopImmediatePropagation();};button.addEventListener('pointerdown',stop);button.addEventListener('click',event=>{stop(event);void setWordKnown(record.target.wordId,record.target.text,button);});
    const wrapper=record.wrapper;let hideTimer=0;
    const show=()=>{clearTimeout(hideTimer);hideTimer=0;wrapper.dataset.shisuiKnownVisible='';};
    const scheduleHide=()=>{clearTimeout(hideTimer);hideTimer=setTimeout(()=>{hideTimer=0;if(record.wrapper===wrapper)delete wrapper.dataset.shisuiKnownVisible;},500);};
    wrapper.addEventListener('pointerenter',show);wrapper.addEventListener('pointerleave',scheduleHide);if(wrapper.matches(':hover'))show();
    wrapper.append(button);record.knownAction=button;
  }
  function configureHint(hint,text){
    if(hint.textContent!==text)delete hint.dataset.revealed;
    hint.textContent=text;
    const veiled=state.settings.hintDisplay==='veil';hint.classList.toggle('veiled',veiled);
    if(veiled){hint.removeAttribute('aria-hidden');hint.setAttribute('role','button');hint.tabIndex=0;hint.setAttribute('aria-label',hint.dataset.revealed!==undefined?text:'显示词注');hint.title=hint.dataset.revealed!==undefined?text:'按回车显示词注';}
    else{hint.setAttribute('aria-hidden','true');hint.removeAttribute('role');hint.removeAttribute('aria-label');hint.removeAttribute('tabindex');hint.title=text;delete hint.dataset.revealed;}
  }
  function layoutRecordHints(block){
    const items=[];
    for(const record of state.records)if(record.wrapper?.isConnected&&record.hint&&(!block||record.block===block))items.push(record);
    globalThis.ShisuiReadingStyle?.layoutHints?.(items);
  }
  function attachRecordHint(record){
      const text=annotationText(record);
      if(!text||!record.marks.length)return;
      if(record.hint){configureHint(record.hint,text);record.wrapper.dataset.shisuiAnnotation=text;layoutRecordHints(record.block);return;}
      const hint=document.createElement('span'),wrapper=document.createElement('span'),last=record.marks.at(-1),active=state.card?.target;
      const ownsTarget=active&&(active.requestedRecord===record||active.support===record.target);
      wrapper.setAttribute(OWN,'annotation');hint.className=HINT_CLASS;hint.setAttribute(OWN,'hint');hint.__shisuiRecord=record;configureHint(hint,text);
      const reveal=event=>{if(!hint.classList.contains('veiled'))return;event.preventDefault();event.stopPropagation();hint.dataset.revealed='';hint.setAttribute('aria-label',hint.textContent);hint.title=hint.textContent;};
      hint.addEventListener('click',reveal);hint.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' ')reveal(event);});
      wrapper.dataset.shisuiAnnotation=text;
      last.before(wrapper);wrapper.append(last,hint);record.hint=hint;record.wrapper=wrapper; if(!record.manual) attachKnownAction(record);
      record.range.setStart(record.marks[0].firstChild,0);record.range.setEnd(last.firstChild,last.firstChild.length);
      if(ownsTarget)active.anchor=record.range.cloneRange();
      layoutRecordHints(record.block);
    }
  function annotationText(record){ const language=record.manual?(record.language||state.settings.helpLanguage):state.settings.helpLanguage;return language==='zh'?record.target.translation:record.target.hint; }
  function confirmedTarget(target){return target?.stage!=='pending'&&typeof target?.senseKey==='string'&&Boolean(target.senseKey.trim());}
  function syncRecordPresentation(record){
    const supportStage=record.target.stage,pending=record.stage==='pending';
    const stage=pending?'待确认 · 尚未确认当前语境':record.stage==='hint'?'提示态 · 显示顶部释义':record.stage==='mark'?'标记态 · 仅标记原词':'静默态 · 不主动展示',title=stage+' · '+lookupLabel()+'获取帮助';
    for(const mark of record.marks){mark.dataset.shisuiStage=record.stage;if(supportStage)mark.dataset.shisuiSupportStage=supportStage;else delete mark.dataset.shisuiSupportStage;mark.title=title;}
  }
    function unwrapRecord(record) { const block=record.block;record.knownAction?.remove(); record.knownAction=null; record.hint?.remove();record.hint=null;if(record.wrapper?.isConnected)record.wrapper.replaceWith(...record.wrapper.childNodes);record.wrapper=null;for(const mark of record.marks||[])if(mark.isConnected)mark.replaceWith(...mark.childNodes);record.since=0;if(block?.isConnected)layoutRecordHints(block); }
  function clearAutomatic(preserveContent=false) {
    state.automaticReady=false;
    for(const [id,blocks]of state.knownBlocks){for(const block of blocks)if(!preserveContent||!block.isConnected)blocks.delete(block);if(!blocks.size)state.knownBlocks.delete(id);}
    clearTimeout(state.rebuildTimer);state.rebuildTimer=0;
    state.refreshing++;setPageStatus('support',null);
    state.intersections?.disconnect(); state.intersections = null;
    const texts=preserveContent?new Map():null;
    state.records=state.records.filter(record=>{
      if(preserveContent&&record.block.isConnected&&record.range?.toString()===record.target.text){
        if(!texts.has(record.block))texts.set(record.block,blockText(record.block));
        if(texts.get(record.block)===record.sourceText&&record.marks.every(mark=>mark.isConnected))return true;
      }
      unwrapRecord(record);return false;
    });
    for(const record of requestedRecords)if(!state.records.includes(record))unwrapRecord(record);
    requestedRecords.length=0;for(const record of state.records)if(record.manual)requestedRecords.push(record);
    state.processed.clear();state.windowKey='';
    clearInterval(state.opportunityTimer); state.opportunityTimer = 0;
  }
  function clearManualRecords(){
    state.assistRequestId='';
    const manual=state.records.filter(record=>record.manual);for(const record of manual)unwrapRecord(record);
    if(manual.length)state.records=state.records.filter(record=>!record.manual);requestedRecords.length=0;
  }
  function annotateTarget(job,target,stage,explicit=false) {
    const mapping = textMap(job.block);if(!sourceTexts.has(job.block))sourceTexts.set(job.block,mapping.text);
    const start = job.start + target.start, end = job.start + target.end;
    if (mapping.text.slice(job.start,job.end) !== job.sentence || mapping.text.slice(start,end) !== target.text) return null;
    const fragments = mapping.nodes.filter(entry => entry.end > start && entry.start < end);
    if (!fragments.length || fragments.some(entry => unsafe(entry.node.parentElement,explicit)||entry.node.parentElement.closest('.'+MARK_CLASS))) return null;
    const record = {block:job.block,sourceText:mapping.text,target,stage,marks:[],range:rangeFor(mapping,start,end),since:0,job,observed:false};
    if(!record.range || !visibleRange(record.range,job.block))return null;
    if (stage !== 'quiet') {
      for (const entry of fragments) {
        const from = Math.max(0,start-entry.start), to = Math.min(entry.end,end)-entry.start;
        if (to < entry.node.length) entry.node.splitText(to);
        const node = from ? entry.node.splitText(from) : entry.node;
        const mark = document.createElement('span'); mark.className = MARK_CLASS; mark.setAttribute(OWN,'term'); mark.__shisuiRecord = record;
        node.replaceWith(mark); mark.append(node); record.marks.push(mark);
      }
      const first = record.marks[0], last = record.marks.at(-1);
      syncRecordPresentation(record);
      record.range = document.createRange(); record.range.setStart(first.firstChild,0); record.range.setEnd(last.firstChild,last.firstChild.length);
      if(stage==='hint'){attachRecordHint(record);}
    }
    state.records.push(record); return record;
  }
  function validateTarget(target,job,personal=false) {
    const allowed=personal?['text','start','end','personal','wordId','senseKey','sense','stage','revision','hint','translation','meaning','sentenceTranslation','coverage','referenceNotice','historyId','locked']:['text','start','end','hint','translation','sense','wordId','senseKey','stage','revision','personal','historyId','locked'];if(!target||Object.keys(target).some(key=>!allowed.includes(key))||typeof target.text!=='string'||!target.text.trim()||target.text.length>100||!Number.isInteger(target.start)||!Number.isInteger(target.end)||target.start<0||target.end>job.sentence.length||target.end<=target.start||job.sentence.slice(target.start,target.end)!==target.text)return false;
    if(target.locked!==undefined&&typeof target.locked!=='boolean'||target.historyId!==undefined&&!/^[a-f0-9-]{36}$/i.test(target.historyId)||target.personal!==undefined&&typeof target.personal!=='boolean')return false;
    if(typeof target.hint!=='string' || (!personal&&!target.hint.trim()) || target.hint.length>80 || (!personal&&typeof target.senseKey!=='string') || (personal&&target.senseKey!==null&&typeof target.senseKey!=='string') || typeof target.wordId!=='string' || !(personal?['pending','hint','mark','quiet']:['hint','mark','quiet']).includes(target.stage) || !Number.isInteger(target.revision))return false;
    if(!personal)return true;
    if(target.personal!==true||typeof target.translation!=='string'||target.translation.length>160)return false;
    const pending=target.stage==='pending',empty=value=>value==null||typeof value==='string'&&!value.trim();
    if(pending)return target.senseKey===null&&!target.hint.trim()&&!target.translation.trim()&&empty(target.sense)&&empty(target.meaning)&&empty(target.sentenceTranslation);
    return typeof target.senseKey==='string'&&Boolean(target.senseKey.trim());
  }
  function validateBatch(result,jobs) {
    if (!result || !Array.isArray(result.items) || result.items.length !== jobs.length) throw new Error('提示服务未返回完整批次。');
    const ids=new Set(),values=new Map();
    for(const item of result.items){const job=jobs.find(value=>value.id===item?.id);if(!job||ids.has(item.id)||Object.keys(item).some(key=>!['id','target','meaning','sentenceTranslation','coverage'].includes(key)))throw new Error('提示批次身份无效。');ids.add(item.id);if(item.target!==null&&!validateTarget(item.target,job))throw new Error('提示范围无效。');if(item.target)item.target.details={meaning:item.meaning||null,sentenceTranslation:item.sentenceTranslation||null,coverage:item.coverage||state.article?.coverage||'excerpt'};values.set(item.id,item.target);}
    return jobs.map(job=>({job,target:values.get(job.id)}));
  }
  function validatePrepared(result,jobs) {
    if(!result||!Array.isArray(result.items)||result.items.length!==jobs.length)throw new Error('本地准备结果不完整。');
    const ids=new Set(),values=[];
    for(const item of result.items){const job=jobs.find(value=>value.id===item?.id);if(!job||ids.has(item.id)||!Array.isArray(item.targets))throw new Error('本地准备结果身份无效。');ids.add(item.id);const identities=new Set();for(const target of item.targets){if(!validateTarget(target,job,true)||identities.has(target.start+':'+target.end))throw new Error('本地准备范围无效。');identities.add(target.start+':'+target.end);target.details={meaning:target.meaning||item.meaning||null,sentenceTranslation:target.sentenceTranslation||item.sentenceTranslation||null,coverage:target.coverage||item.coverage||state.article?.coverage||'excerpt'};target.referenceNotice=target.referenceNotice||item.referenceNotice||'';values.push({job,target});}}
    return values;
  }
  function overlappingRecords(job,target) {
    const start=job.start+target.start,end=job.start+target.end;
    return state.records.filter(record=>record.block===job.block&&record.job.start+record.target.start<end&&record.job.start+record.target.end>start);
  }
  function allocatePrepared(values){
    if(!automatic())return;
    for(const {job,target}of values){
      if(!job.visible||state.knownWords.has(target.wordId))continue
      const overlaps=overlappingRecords(job,target);
      if(overlaps.some(record=>record.manual))continue;
      const existing=overlaps.find(record=>record.job.start+record.target.start===job.start+target.start&&record.job.start+record.target.end===job.start+target.end);
      if(overlaps.length&&!existing)continue;
      if(existing&&target.stage==='pending'&&confirmedTarget(existing.target))continue;
      const stage=target.stage;
      if(existing){
        if(blockText(job.block).slice(job.start,job.end)!==job.sentence)continue;
        if((existing.stage==='quiet')!==(stage==='quiet')){
          unwrapRecord(existing);state.records=state.records.filter(record=>record!==existing);
        }else{
          const changed=identity(existing.target)!==identity(target);
          existing.target=target;existing.job=job;existing.stage=stage;
          if(changed){existing.observed=false;existing.since=0;existing.historySent=false;existing.historySince=0;}
          for(const mark of existing.marks)mark.__shisuiRecord=existing;
          syncRecordPresentation(existing);
          if(stage==='hint'){attachRecordHint(existing);}else removeRecordHint(existing);
          continue;
        }
      }
      annotateTarget(job,target,stage);
    }
  }
  function removeRecordHint(record){
    record.knownAction?.remove(); record.knownAction=null; record.hint?.remove();record.hint=null;
    if(record.wrapper?.isConnected)record.wrapper.replaceWith(...record.wrapper.childNodes);
    record.wrapper=null;
  }
  function allocate(values) {
    const personal=[],system=[];
    for(const value of values){
      if(!value.target||!value.job.visible||state.knownWords.has(value.target.wordId))continue
      if(value.target.personal)personal.push(value);
      else if(overlappingRecords(value.job,value.target).some(record=>record.target.personal))personal.push({...value,target:{...value.target,personal:true}});
      else system.push(value);
    }
    allocatePrepared(personal);
    const suggestions=state.records.filter(record=>!record.manual&&!record.target.personal&&inViewport(record.block)),occupied=new Set(suggestions.filter(record=>record.stage!=='quiet').map(record=>record.block));
    const identities=new Set();for(const record of state.records)if(inViewport(record.block))identities.add(identity(record.target));
    let prominent=suggestions.filter(record=>record.stage!=='quiet').length,quiet=suggestions.filter(record=>record.stage==='quiet').length;
    const limit=state.settings.readingHistory?.policy?.annotation?.density==='sparse'?1:2,priorities=state.settings.readingHistory?.policy?.annotation?.priorityTerms||[];
    system.sort((a,b)=>Number(priorities.some(t=>t.toLowerCase()===b.target.text.toLowerCase()))-Number(priorities.some(t=>t.toLowerCase()===a.target.text.toLowerCase())));
    for(const {job,target}of system){
      if(occupied.has(job.block)||identities.has(identity(target)))continue;
      const stage=target.stage;
      if(stage==='quiet'?quiet>=2:prominent>=limit)continue;
      const record=annotateTarget(job,target,stage);if(!record)continue;
      identities.add(identity(target));occupied.add(job.block);if(stage==='quiet')quiet++;else prominent++;
    }
  }
  async function buildJobs(blocks,generation,viewport) {
    let budget=8000,inputLength=0;const samples=[];
    for(const block of blocks){const text=blockText(block);if(text.length>budget)continue;budget-=text.length;const inputStart=inputLength;samples.push({block,text,inputStart});inputLength+=text.length+1;}
    if(!samples.length||!automatic()||generation!==state.generation||viewport!==state.viewportGeneration||blocks.some(block=>!inReadingSurface(block)))return null;
    const analyzedText=samples.map(item=>item.text).join('\n'),local=await request('ANALYZE',{text:analyzedText,domain:state.domain});
    if(!automatic()||generation!==state.generation||viewport!==state.viewportGeneration||blocks.some(block=>!inReadingSurface(block)))return null;
    const jobs=[];
    for(const {block,text,inputStart}of samples)for(const sentence of segments(text)){
      if(sentence.segment.length>2000)continue;
      const absoluteStart=inputStart+sentence.index,absoluteEnd=absoluteStart+sentence.segment.length,matches=[];
      for(const [order,term]of(local.terms||[]).entries())for(const occurrence of term.occurrences||[]){
        if(!Number.isInteger(occurrence.start)||!Number.isInteger(occurrence.end)||occurrence.start<absoluteStart||occurrence.end>absoluteEnd||occurrence.end<=occurrence.start)continue;
        const actual=analyzedText.slice(occurrence.start,occurrence.end);if(actual!==occurrence.text)continue;
        matches.push({text:actual,wordId:term.id,priority:Number(term.priority)||0,order,start:occurrence.start});
      }
      matches.sort((a,b)=>b.priority-a.priority||a.order-b.order||a.start-b.start);
      const candidates=[],candidateKeys=new Set();for(const {text,wordId}of matches){const key=wordId+'\n'+text;if(candidateKeys.has(key))continue;candidateKeys.add(key);candidates.push({text,wordId});if(candidates.length===3)break;}
      const range=rangeFor(textMap(block),sentence.index,sentence.index+sentence.segment.length);
      jobs.push({id:'s'+(++nextSentence),block,start:sentence.index,end:sentence.index+sentence.segment.length,sentence:sentence.segment,domain:state.domain,candidates,rank:matches.reduce((max,item)=>Math.max(max,item.priority),0),visible:Boolean(range&&visibleRange(range,block))});
    }
    const ordered=jobs.sort((a,b)=>Number(b.visible)-Number(a.visible)||b.rank-a.rank),chosen=[...ordered.filter(job=>job.visible).slice(0,6),...ordered.filter(job=>!job.visible).slice(0,2)];let size=0;const batch=chosen.filter(job=>{const length=job.sentence.length+job.candidates.reduce((sum,item)=>sum+item.text.length,0);if(size+length>8000)return false;size+=length;return true;});return {samples,batch};
  }
  async function preparedFor(batch,article) {
    if(!state.settings.rememberSupport||!batch.length)return [];
    const result=await request('PREPARED_SUPPORT',{items:batch.map(({id,sentence,domain,candidates})=>({id,sentence,domain,candidates})),article});
    const values=validatePrepared(result,batch);for(const {target}of values)target.preparationArticle=article;return values;
  }
  async function scanPrepared(blocks,article,generation,viewport){
    if(!state.settings.rememberSupport)return;
    let batch=[],size=0;
    const current=()=>automatic()&&generation===state.generation&&viewport===state.viewportGeneration&&blocks.every(inReadingSurface);
    if(!current())return;
    const flush=async()=>{if(!batch.length)return current();const values=await preparedFor(batch,article);if(lookupBusy())await waitForLookupIdle();if(!current())return false;allocatePrepared(values);batch=[];size=0;return true;};
    for(const block of blocks){
      let mapping=textMap(block);
      for(const sentence of segments(mapping.text)){
        if(!sentence.segment.trim()||sentence.segment.length>2000)continue;
        if(batch.length===8||size+sentence.segment.length>8000){if(!await flush())return;mapping=textMap(block);}
        const start=sentence.index,end=start+sentence.segment.length,range=rangeFor(mapping,start,end);
        if(!range||!visibleRange(range,block))continue;
        batch.push({id:'h'+(++nextSentence),block,start,end,sentence:sentence.segment,domain:state.domain,candidates:[],visible:true});size+=sentence.segment.length;
      }
    }
    await flush();
  }
  async function refreshPreparedNow() {
    if(lookupBusy())await waitForLookupIdle();
    if(!automatic()||!state.automaticReady||!state.root?.isConnected||!inReadingSurface(state.root))return;
    const generation=state.generation,viewport=state.viewportGeneration,blocks=state.blocks.filter(inViewport),article=await articleContext(state.blocks,blocks);article.key=state.article?.key||article.key;await scanPrepared(blocks,article,generation,viewport);
  }
  async function refreshViewport() {
    if (lookupBusy() || !automatic() || !state.automaticReady || !state.root?.isConnected || !inReadingSurface(state.root)) return;
    const view=viewportRect(),scroll=readerScroll(),near=state.blocks.filter(block=>inReadingSurface(block)&&isVisible(block)&&block.getBoundingClientRect().bottom>view.top-(scroll?view.height*2:0)&&block.getBoundingClientRect().top<view.bottom+(scroll?view.height*2:view.height)),visible=near.filter(inViewport),key=visible.map(blockId).join(',')+':'+Math.floor((scroll?.scrollTop??scrollY)/Math.max(view.height,1));
    if(key===state.windowKey)return;state.windowKey=key;const viewport=++state.viewportGeneration,generation=state.generation;state.refreshing++;setPageStatus('support',null);
    // Leaving the viewport does not revoke an already displayed annotation.
    const blocks=[...visible,...near.filter(block=>!visible.includes(block))].filter(block=>!state.processed.has(blockId(block)));if(!blocks.length)return;
    let receivedResult=null,refresh=0;
    try{
      const article=await articleContext(state.blocks,visible.length?visible:blocks);if(!automatic()||generation!==state.generation||viewport!==state.viewportGeneration||blocks.some(block=>!inReadingSurface(block)))return;article.key=state.article?.key||article.key;
      void scanPrepared(blocks.filter(inViewport),article,generation,viewport).catch(()=>{});
      const built=await buildJobs(blocks,generation,viewport);if(!built)return;
      if(lookupBusy())await waitForLookupIdle();
      if(!automatic()||generation!==state.generation||viewport!==state.viewportGeneration||!built.batch.length)return;
      if(state.providerConfigured){
        refresh=++state.refreshing;state.failed=false;setPageStatus('support','正在准备阅读提示',{busy:true});
        const result=await request('SUPPORT_BATCH',{items:built.batch.map(({id,sentence,domain,candidates})=>({id,sentence,domain,candidates})),article});receivedResult=result;
        const values=validateBatch(result,built.batch);for(const {target}of values)if(target)target.preparationArticle=article;
        if(!automatic()||generation!==state.generation||viewport!==state.viewportGeneration){reportResult(result,'cancelled');if(refresh===state.refreshing)setPageStatus('support',null);return;}
        let personal=[];try{personal=await preparedFor(built.batch,article);}catch{}
        if(lookupBusy())await waitForLookupIdle();
        if(!automatic()||generation!==state.generation||viewport!==state.viewportGeneration){reportResult(result,'cancelled');if(refresh===state.refreshing)setPageStatus('support',null);return;}
        allocate(values.filter(({job})=>job.visible));allocatePrepared(personal);reportResult(result,'ok');if(refresh===state.refreshing)setPageStatus('support',null);
        for(const {job}of values)if(job.visible)state.processed.add(blockId(job.block));
      }
    }catch(error){reportResult(receivedResult,'error');if(refresh&&refresh===state.refreshing)setPageStatus('support',null);if(generation===state.generation&&viewport===state.viewportGeneration&&state.providerConfigured){state.failed=true;if(refresh&&refresh===state.refreshing)setPageStatus('support','自动提示未生成：'+(error.message||'未知错误')+'。可在运行诊断查看详情。',{error:true,duration:8000});}}
  }
  function trackOpportunities() {
    if (!automatic()) { state.records.forEach(record=>record.since=0); return; }
    const now=Date.now(),words=[];
    for(const record of state.records){const key=identity(record.target);if(!record.target.senseKey||record.observed||state.seen.has(key)||state.assisted.has(key)||!state.settings.rememberSupport)continue;const visible=visibleRange(record.range,record.block);if(!visible){record.since=0;continue;}if(!record.since)record.since=now;if(now-record.since<2000)continue;record.observed=true;state.seen.add(key);words.push({id:record.target.wordId,senseKey:record.target.senseKey,revision:record.target.revision,hintShown:record.stage==='hint'});}
    if(words.length)void request('ENCOUNTER',{words}).catch(()=>{});
  }
  function onScroll(event) { if(state.reader&&event?.type==='scroll'){if(event.target!==readerScroll()||readerScrollEvents.has(event))return;readerScrollEvents.add(event);}if(state.page!==location.href){onPageNavigation();return;}if(state.reader&&!readerSourceIntact()){leaveReader({restorePosition:false});return;} clearLookupPreview(); scheduleLookupPreview(); removeSelectionTool();if(event)removeStructureCard(); if(state.card){if(validTarget(state.card.target))positionCard(state.card);else closeCard();} state.records.forEach(record=>{if(!visibleRange(record.range,record.block))record.since=0;});if(!event||event.type!=='scroll'){scheduleSentenceRender();for(const container of readingScope().querySelectorAll('['+OWN+'="passage-translation"]')){const block=passageSources.get(container)?.block;if(block?.isConnected)inheritEmergencyStyle(block,container);}}scheduleSentenceScan(150);clearTimeout(state.scrollTimer);state.scrollTimer=setTimeout(()=>{void refreshViewport();void ShisuiReview.refresh();},150); }
  async function setupAutomatic(generation,contentGeneration) {
    if (!automatic()) return;
    const found=resolveReadingRoot(); if(!found)return;
    state.root=found.element;state.blocks=found.blocks;for(const block of state.blocks)sourceTexts.set(block,blockText(block));
    const article=await articleContext(state.blocks);
    if(generation!==state.generation||contentGeneration!==state.contentGeneration||!inReadingSurface(found.element))return;
    state.article=article;state.wordCount=state.blocks.reduce((total,block)=>total+(blockText(block).match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)||[]).length,0);
    const sample=collectReadingText(state.blocks);
    const lang=state.root.closest('[lang]')?.getAttribute('lang') || siteRule()?.lang || '';
    if (!/^en(?:-|$)/i.test(lang)) {
      const profile=await request('LANGUAGE_PROFILE',{text:sample});
      if(generation!==state.generation||contentGeneration!==state.contentGeneration||!inReadingSurface(found.element))return;
      const evidence=profile.english;
      // 只有可确认英文，或英文证据充分的混合正文才继续扫描；无法确认与非英文都在此停止。
      const englishPage=profile.status==='identified'?profile.languages.includes('en')
        :profile.status==='mixed'&&(evidence.tokens>=12&&evidence.recognized/evidence.tokens>=.6&&evidence.functionWords>=2);
      if(!englishPage){state.root=null;state.blocks=[];return;}
    }
    if(!state.domainResolved){
      if(state.settings.domain&&state.settings.domain!=='auto')state.domain=state.settings.domain;
      else{const route=await request('RESOLVE_DOMAIN',{text:sample,title:''});if(generation!==state.generation||contentGeneration!==state.contentGeneration||!automatic()||!inReadingSurface(found.element))return;state.domain=route?.domain||'general';}
      state.domainResolved=true;
    }
    state.automaticReady=true;
    state.intersections=new IntersectionObserver(()=>onScroll(),{root:readerScroll(),threshold:0});state.blocks.forEach(block=>state.intersections.observe(block));
    state.opportunityTimer=setInterval(trackOpportunities,100);
    void refreshViewport();void ShisuiReview.refresh();
  }
  function validTarget(target) {
    if (!isAlive() || state.paused && !state.reader || target.generation!==state.generation || state.page!==location.href || document.visibilityState!=='visible') return false;
    if(target.sourceKey)return !state.reader&&(target.isValid?target.isValid():target.viewportGeneration===state.viewportGeneration&&Boolean(target.anchorRect));
    if(target.displayLink&&(target.displayLink.element.getAttribute('href')!==target.displayLink.href||!safeLinkHref(target.displayLink.element)))return false;
    return target.block?.isConnected && inReadingSurface(target.block) && target.anchor?.startContainer?.isConnected && target.anchor.toString()===target.text && blockText(target.block)===target.sourceText && visibleRange(target.anchor,target.block);
  }
  function closeCard() {
    const view=state.card;if(!view)return;stopCardSpeech(view);state.card=null;releaseCardAnchor(view);view.host.remove();view.target.onClose?.();if(view.refreshPreparedOnClose)void refreshPreparedNow().catch(()=>{});
    // 卡片关闭即中止在途追问；已生成的回合按本机规则保留 30 天。
    if(view.convoTurnId)void request('CONVERSATION_STOP',{turnId:view.convoTurnId}).catch(()=>{});
  }
  function cardButton(parent,label,action) {const button=document.createElement('button');button.type='button';button.textContent=label;button.onclick=action;parent.append(button);return button;}
  function stopCardSpeech(view){
    const speech=view.speech;if(!speech)return;
    view.speech=null;speech.button.textContent='朗读';speech.button.setAttribute('aria-label',speech.label);speech.port.disconnect();view.speechNotice.textContent='';
  }
  function speechButton(view,parent,text,label){
    const button=cardButton(parent,'朗读',()=>{
      if(state.card!==view)return;
      if(view.speech?.button===button){stopCardSpeech(view);positionCard(view);return;}
      stopCardSpeech(view);
      try{
        const port=runtime.connect({name:'shisui-speech'}),speech={port,button,label};view.speech=speech;
        button.textContent='停止';button.setAttribute('aria-label','停止'+label);view.speechNotice.textContent='正在准备英文语音…';positionCard(view);
        port.onMessage.addListener(message=>{
          if(view.speech!==speech||state.card!==view)return;
          if(message.type==='start')view.speechNotice.textContent='正在'+label+'…';
          else if(['end','interrupted','cancelled','error'].includes(message.type)){stopCardSpeech(view);if(message.type==='error')view.speechNotice.textContent=message.error||'无法朗读，请检查系统语音设置。';}
          positionCard(view);
        });
        port.onDisconnect.addListener(()=>{
          const error=runtime.lastError;
          if(view.speech!==speech)return;
          stopCardSpeech(view);view.speechNotice.textContent=error?.message||'朗读连接已断开，请重试。';if(state.card===view)positionCard(view);
        });
        port.postMessage({text});
      }catch(error){stopCardSpeech(view);view.speechNotice.textContent=error.message||'无法连接系统语音。';positionCard(view);}
    });
    button.className='listen';button.setAttribute('aria-label',label);button.title=label;return button;
  }
  function cardAnchorSheet(){let sheet=document.getElementById('relyless-card-anchoring');if(!sheet){sheet=document.createElement('style');sheet.id='relyless-card-anchoring';sheet.textContent='@position-try --relyless-card-above{top:auto;bottom:anchor(top);margin-top:0;margin-bottom:8px}';document.documentElement.append(sheet);}return sheet;}
  function cardAnchorElement(target){
    if(target.sourceKey||target.anchorRect)return null;
    const range=target.anchor;if(!range||!range.startContainer)return null;
    const node=range.startContainer,el=node.nodeType===1?node:node.parentElement;
    return el&&el.isConnected?el:null;
  }
  function releaseCardAnchor(view){if(view.anchorEl){if(view.anchorName===null)view.anchorEl.style.removeProperty('anchor-name');else view.anchorEl.style.setProperty('anchor-name',view.anchorName,view.anchorNamePriority);view.anchorEl=null;view.anchorName=null;}const style=view.host.style;['position-anchor','position-try-fallbacks','margin','bottom','right'].forEach(name=>style.removeProperty(name));}
  function positionCard(view) {
    const width=Math.min(380,innerWidth-24);
    view.host.style.width=width+'px';
    const el=cardAnchorElement(view.target);
    if(el&&CSS.supports('top: anchor(bottom)')&&CSS.supports('position-try-fallbacks: flip-block')){
      cardAnchorSheet();
      if(view.anchorEl!==el){releaseCardAnchor(view);view.anchorName=el.style.getPropertyValue('anchor-name')||null;view.anchorNamePriority=el.style.getPropertyPriority('anchor-name');el.style.setProperty('anchor-name','--relyless-card');view.anchorEl=el;}
      const style=view.host.style;
      style.setProperty('position-anchor','--relyless-card');
      style.setProperty('position-try-fallbacks','--relyless-card-above');
      style.setProperty('top','anchor(bottom)');style.setProperty('bottom','auto');
      style.setProperty('left','clamp(12px,anchor(start),calc(100vw - '+width+'px - 12px))');style.setProperty('right','auto');
      style.setProperty('margin','0');style.setProperty('margin-top','8px');
      return;
    }
    releaseCardAnchor(view);
    const rect=view.target.anchorRect || view.target.anchor?.getBoundingClientRect?.() || {left:20,bottom:20};
    const bounds=view.host.getBoundingClientRect();
    view.host.style.left=Math.max(12,Math.min(rect.left,innerWidth-width-12))+'px';
    view.host.style.top=Math.max(12,Math.min(rect.bottom+8,innerHeight-bounds.height-12))+'px';
  }
  function renderHelpCard(target,error='') {
    closeCard();const host=document.createElement('div');host.setAttribute(OWN,'card');host.style.cssText='position:fixed;z-index:2147483647;width:min(380px,calc(100vw - 24px));';
    state.assistRequestId='';
    if(target.sourceKey)host.style.setProperty('--type-body',(state.settings.video?.fontSize || 20)+'px');
    const shadow=host.attachShadow({mode:'closed'}),style=document.createElement('style');
    style.textContent=globalThis.ShisuiDesign.cssFor(':host',target.sourceKey ? state.settings.video?.theme || 'auto' : 'auto')+`
      :host{color:var(--ink);font:var(--type-body)/var(--leading-body) var(--sans)}
      .card{padding:var(--space-4);border:1px solid var(--accent-line);border-top:3px solid var(--accent);border-radius:var(--radius-panel);background:var(--surface);box-shadow:var(--shadow-high);max-height:calc(100vh - 48px);overflow:auto;box-sizing:border-box}
      .source{font-weight:var(--weight-medium);overflow-wrap:anywhere;margin:0 0 var(--space-3);white-space:pre-wrap}.source:not(.passage){font-size:var(--type-word-head);line-height:var(--leading-title)}.answer{white-space:pre-wrap;margin:0 0 var(--space-3);overflow-wrap:anywhere;padding:var(--space-3);border:1px solid var(--teal-line);border-left:3px solid var(--teal);border-radius:var(--radius-control);background:var(--teal-soft)}.answer:empty,.explanation:empty{display:none}.explanation{margin:0 0 var(--space-4)}.explanation dt{font-size:var(--type-support);font-weight:var(--weight-medium);color:var(--muted);margin:0 0 var(--space-1)}.explanation dt:not(:first-child){border-top:1px solid var(--line);padding-top:var(--space-3)}.explanation dd{margin:0;padding:0 0 var(--space-3);white-space:pre-wrap;overflow-wrap:anywhere}.explanation dd:last-child{padding-bottom:0}
      button,summary{font:var(--weight-medium) var(--type-control)/var(--leading-control) var(--sans);cursor:pointer}button{min-height:36px;border:1px solid var(--accent-line);border-radius:var(--radius-pill);padding:var(--space-2) var(--space-4);background:var(--accent-soft);color:var(--accent);margin:0 var(--space-2) var(--space-2) 0}button:where(:enabled):hover{background:var(--accent-soft);border-color:var(--accent);color:var(--accent-hover)}button:where(:enabled):active{background:var(--action-hover);border-color:var(--action-hover);color:var(--on-action)}button:focus-visible,summary:focus-visible{outline:var(--focus-ring);outline-offset:var(--focus-offset)}button:disabled{border-color:var(--line);background:var(--action-disabled);color:var(--on-action-disabled);cursor:default}.minor{color:var(--muted);font-size:var(--type-support);margin:var(--space-2) 0 0}.minor:empty{display:none}.minor-action{min-height:0;padding:0;border:0;background:none;color:var(--accent);font:inherit;font-size:inherit;text-decoration:underline;text-underline-offset:2px;margin:0;cursor:pointer}.minor-action:hover{color:var(--accent-hover)}.minor-action:disabled{color:var(--on-action-disabled);background:none;cursor:default}.error{color:var(--danger)}details{border-top:1px solid var(--line);margin-top:var(--space-2);padding-top:var(--space-3)}summary{color:var(--muted);margin-bottom:var(--space-2)}
      .source-heading{padding:var(--space-3);border-radius:var(--radius-control);background:var(--accent-soft);display:flex;align-items:flex-start;gap:var(--space-2);margin-bottom:var(--space-3)}.source-heading .source{color:var(--accent);flex:1;min-width:0;margin:0}.listen{flex-shrink:0;margin:0;min-height:28px;padding:var(--space-1) var(--space-2)}.sentence{margin:0 0 var(--space-4)}.sentence .explanation{margin:var(--space-3) 0 0}.sentence-label{display:flex;align-items:center;justify-content:space-between;gap:var(--space-2)}
      .definition-value{color:var(--green);background:var(--green-soft);border:1px solid var(--green-line);border-radius:var(--radius-control);padding:2px 6px;font-weight:var(--weight-medium);-webkit-box-decoration-break:clone;box-decoration-break:clone}.inline-term{font-family:var(--mono);font-size:.95em;color:var(--accent);background:var(--accent-soft);border:1px solid var(--accent-line);border-radius:4px;padding:0 .25em;-webkit-box-decoration-break:clone;box-decoration-break:clone}.meaning-key{color:var(--green);font-weight:var(--weight-medium)}

      .language-action{background:var(--violet-soft);border-color:var(--violet-line);color:var(--violet)}.language-action:where(:enabled):hover{background:var(--violet-soft);border-color:var(--violet);color:var(--violet)}.known-action{background:var(--teal);border-color:var(--teal);color:var(--on-teal)}.known-action:where(:enabled):hover,.known-action:where(:enabled):active{background:var(--teal-hover);border-color:var(--teal-hover);color:var(--on-teal)}.dismiss{background:var(--surface);border-color:var(--line);color:var(--muted-strong)}.sentence{border-top:0;padding-top:0}.sentence>summary{padding:var(--space-2) var(--space-3);border-radius:var(--radius-control);background:var(--accent-soft);color:var(--accent)}.answer.error{background:var(--danger-soft);border-color:var(--danger)}
      .conversation{margin:var(--space-3) 0 0;border-top:1px solid var(--line);padding-top:var(--space-3)}.conversation-log{max-height:220px;overflow:auto;margin-bottom:var(--space-2)}.conversation-turn{margin:0 0 var(--space-3)}.conversation-question{margin:0 0 var(--space-1);font-weight:var(--weight-medium);color:var(--accent);white-space:pre-wrap;overflow-wrap:anywhere}.conversation-answer{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.conversation-memory{display:block;margin-top:2px;color:var(--muted);font-size:var(--type-support)}.conversation-form{display:flex;align-items:flex-end;gap:var(--space-2)}.conversation-input{flex:1;min-height:36px;max-height:120px;resize:vertical;field-sizing:content;box-sizing:border-box;font:var(--type-control)/var(--leading-control) var(--sans);color:var(--ink);padding:var(--space-2) var(--space-3);border:1px solid var(--line);border-radius:var(--radius-control);background:var(--surface)}.conversation-input:focus-visible{outline:var(--focus-ring);outline-offset:var(--focus-offset)}.conversation-form button{margin:0;flex:none}
    `;shadow.append(style);const card=document.createElement('section');card.className='card';card.setAttribute('role','dialog');card.setAttribute('aria-label','RelyLess · 帮助理解选中内容');shadow.append(card);
    const brand=createBrandLabel(target.kind==='word'?'词语释义':'内容释义');brand.style.marginBottom='var(--space-3)';card.append(brand);
    const sourceHeader=document.createElement('div');sourceHeader.className='source-heading';card.append(sourceHeader);const source=document.createElement('p');source.className='source'+(target.kind==='passage'?' passage':'');source.textContent=target.text;sourceHeader.append(source);
    const answer=document.createElement('p');answer.className='answer';answer.setAttribute('aria-live','polite');answer.textContent=error || '正在给出一条线索…';card.append(answer);
    const explanation=document.createElement('dl');explanation.className='explanation';explanation.setAttribute('aria-live','polite');card.append(explanation);
    const sentence=document.createElement('details'),sentenceSummary=document.createElement('summary'),sentenceBody=document.createElement('dl');sentence.className='sentence';sentence.hidden=target.kind==='passage'||!target.context;sentenceSummary.textContent='本句翻译';sentenceBody.className='explanation';sentence.append(sentenceSummary,sentenceBody);card.append(sentence);
    const originalLabel=document.createElement('dt'),original=document.createElement('dd'),translationLabel=document.createElement('dt'),sentenceTranslation=document.createElement('dd');
    originalLabel.textContent='英文原文';originalLabel.className='sentence-label';original.textContent=target.context||'';original.lang='en';translationLabel.textContent='中文翻译';sentenceTranslation.lang='zh-CN';sentenceTranslation.textContent=error?'尚未获取本句翻译。':'展开后获取本句翻译。';sentenceBody.append(originalLabel,original,translationLabel,sentenceTranslation);
    if(target.context)explanationText(original,target.context,target.text);
    const view={host,card,target,answer,explanation,sentence,sentenceTranslation,speech:null,requestId:'',level:'hint',detail:'brief',retries:0,support:null,fullDetails:null,fullResult:null,detailsLoading:false,pendingDetails:false,confirmedDisplayed:false,referenceDisplayed:false,hasUnconfirmedProgress:false,progressBackup:null,progressFields:{},assistFinished:false,anchorEl:null};state.card=view;
    speechButton(view,sourceHeader,target.text,target.kind==='word'?'朗读英文单词':'朗读选中英文');
    const sentenceSpeech=speechButton(view,originalLabel,target.context,'朗读英文原句');
    sentence.addEventListener('toggle',()=>{if(state.card!==view)return;if(sentence.open)void expandDetails(view);else if(view.speech?.button===sentenceSpeech)stopCardSpeech(view);positionCard(view);});
    view.rescue=cardButton(card,'用中文说明',()=>void assist(view,view.level==='rescue'?'hint':'rescue'));view.rescue.className='language-action';
    view.knownWordId=()=>view.support?.wordId||view.target.support?.wordId||view.target.prepared?.wordId||view.target.requestedRecord?.target?.wordId||''
    view.known=cardButton(card,'我已认识',()=>void setWordKnown(view.knownWordId(),view.target.text,view.known));view.known.className='known-action';view.known.hidden=!view.knownWordId();
    view.retry=cardButton(card,'重试',()=>{if(view.retries<2){view.retries++;void assist(view,view.level,true,view.detail);}});view.retry.hidden=true;
    cardButton(card,'收起',closeCard).className='dismiss';
    const more=document.createElement('details'),summary=document.createElement('summary');summary.textContent='更多';more.append(summary);card.append(more);
    const convo=document.createElement('div');convo.className='conversation';convo.hidden=true;
    const convoLog=document.createElement('div');convoLog.className='conversation-log';convoLog.setAttribute('aria-live','polite');
    const convoForm=document.createElement('form');convoForm.className='conversation-form';
    const convoInput=document.createElement('textarea');convoInput.className='conversation-input';convoInput.rows=1;convoInput.maxLength=300;convoInput.placeholder='就选中的英文继续追问…';convoInput.setAttribute('aria-label','继续追问');
    const convoSend=document.createElement('button');convoSend.type='submit';convoSend.textContent='追问';
    const convoStop=document.createElement('button');convoStop.type='button';convoStop.textContent='停止';convoStop.hidden=true;
    convoForm.append(convoInput,convoSend,convoStop);convoForm.addEventListener('submit',event=>{event.preventDefault();void ShisuiConversation.askConversation(view);});convoStop.addEventListener('click',()=>void ShisuiConversation.stopConversation(view));
    convo.append(convoLog,convoForm);card.append(convo);
    view.convo=convo;view.convoLog=convoLog;view.convoInput=convoInput;view.convoSend=convoSend;view.convoStop=convoStop;view.convoSessionId='';view.convoTurnId='';view.convoBusy=false;view.convoRow=null;
    view.wrong=cardButton(more,'解释不对',()=>{if(view.retries<2){view.retries++;void assist(view,view.level,true,view.detail);}});
    view.less=cardButton(more,'少提示这个用法',async()=>{
      if(!view.support || !state.settings.rememberSupport)return;
      view.less.disabled=true;
      try {
        const support=await request('INTERACT',{wordId:view.support.wordId,senseKey:view.support.senseKey,revision:view.support.revision,action:'less'});
        if(state.card!==view)return;
        state.records=state.records.filter(record=>{if(identity(record.target)!==identity(view.support))return true;unwrapRecord(record);return false;});
        view.support=support.support || support;renderSupportMeta(view);view.answer.textContent='这个用法将保持安静；随时可以再次求助。';
      }catch(error){if(state.card===view){view.answer.textContent=error.message;view.less.disabled=false;}}
    });view.less.disabled=true;
    view.meta=document.createElement('p');view.meta.className='minor';card.append(view.meta);
    const termRow=document.createElement('p');termRow.className='minor term-suggest';termRow.hidden=true;
    const termLabel=document.createElement('span');termLabel.textContent='这个词反复出现 · ';
    const termAction=document.createElement('button');termAction.type='button';termAction.className='minor-action';termAction.textContent='固定译法';
    termAction.addEventListener('click',async()=>{const suggestion=view.termSuggestion;if(!suggestion)return;termAction.disabled=true;try{await chrome.storage.local.set({pendingTerm:suggestion});await request('OPEN_OPTIONS');termLabel.textContent='已打开术语设置 · ';termAction.remove();view.termRow.hidden=false;}catch{termAction.disabled=false;}});
    termRow.append(termLabel,termAction);card.append(termRow);view.termRow=termRow;
    view.note=document.createElement('p');view.note.className='minor';card.append(view.note);
    view.speechNotice=document.createElement('p');view.speechNotice.className='minor';view.speechNotice.setAttribute('role','status');card.append(view.speechNotice);
    view.repair=cardButton(card,'连接或修复服务',()=>void request('OPEN_OPTIONS'));view.repair.hidden=true;
    uiMountRoot().append(host);positionCard(view);
    if(error){view.rescue.hidden=true;more.hidden=true;view.wrong.disabled=true;}
    renderSupportMeta(view);
    return view;
  }
  function relativeAgo(timestamp){
    const diff=Date.now()-timestamp;if(!(diff>0)||diff<90000)return'刚刚';
    const minutes=Math.floor(diff/60000);if(minutes<60)return minutes+' 分钟前';
    const hours=Math.floor(minutes/60);if(hours<24)return hours+' 小时前';
    const days=Math.floor(hours/24);if(days<30)return days+' 天前';
    const months=Math.floor(days/30);return months<12?months+' 个月前':Math.floor(months/12)+' 年前';
  }
  function renderSupportMeta(view){
    const history=view.support?.history||view.target?.history||view.target?.support?.history||null;
    view.meta.textContent=history&&history.helps>1?'第 '+history.helps+' 次求助'+(history.lastAt?' · 上次在 '+relativeAgo(history.lastAt):''):'';
  }
  function explanationText(parent,text,word,definition=''){
    parent.replaceChildren();
    const terms=[{text:word,tag:'code',className:'inline-term'},{text:definition,tag:'strong',className:'meaning-key'}].filter(term=>typeof term.text==='string'&&term.text.trim()&&term.text.length<=80).sort((a,b)=>b.text.length-a.text.length);
    if(!terms.length){parent.textContent=text;return;}
    const pattern=terms.map(term=>'('+term.text.replace(/[.*+?^$\{\}()|[\]\\]/g,'\\$&')+')').join('|');let offset=0;
    for(const match of text.matchAll(new RegExp(pattern,'giu'))){
      const start=match.index,end=start+match[0].length;
      if(/[A-Za-z0-9_]/.test(match[0][0])&&/[A-Za-z0-9_]/.test(text[start-1]||'')||/[A-Za-z0-9_]/.test(match[0].at(-1))&&/[A-Za-z0-9_]/.test(text[end]||''))continue;
      if(start>offset)parent.append(document.createTextNode(text.slice(offset,start)));
      const term=terms[match.findIndex((value,index)=>index>0&&value!==undefined)-1],emphasis=document.createElement(term.tag);emphasis.className=term.className;emphasis.textContent=match[0];parent.append(emphasis);offset=end;
    }
    if(offset<text.length)parent.append(document.createTextNode(text.slice(offset)));
  }
  function showDetails(view,details,definition=view.answer.textContent) {
    view.explanation.replaceChildren();if(view.target.kind==='passage')return;
    const language=view.level==='rescue'?'zh-CN':'en',rows=[['词义',definition],['当前语境',details?.meaning?.[view.level==='rescue'?'zh':'en']||'尚未获取当前语境解释。']];
    for(const [label,value]of rows){const term=document.createElement('dt'),description=document.createElement('dd');term.textContent=label;if(label==='词义'){const valueNode=document.createElement('strong');valueNode.className='definition-value';valueNode.textContent=value;description.append(valueNode);}else explanationText(description,value,view.target.text,definition);description.lang=language;view.explanation.append(term,description);}
    explanationText(view.sentenceTranslation,details?.sentenceTranslation||'尚未获取本句翻译。',view.target.text,definition);view.answer.textContent='';
  }
  async function expandDetails(view){
    if(state.card!==view||!view.sentence.open||view.target.kind==='passage')return;
    if(view.fullDetails){showDetails(view,view.fullDetails,view.answer.textContent);positionCard(view);return;}
    const prepared=view.target.prepared?.details;
    if(prepared?.meaning&&typeof prepared.sentenceTranslation==='string'&&prepared.sentenceTranslation.trim()){view.fullDetails=prepared;showDetails(view,prepared,view.answer.textContent);positionCard(view);return;}
    if(!view.assistFinished){view.pendingDetails=true;view.sentenceTranslation.textContent='简释完成后获取本句翻译。';return;}
    if(view.detailsLoading)return;
    view.detailsLoading=true;view.pendingDetails=false;
    try{await assist(view,view.level,false,'full');}finally{view.detailsLoading=false;}
  }
  function showAssistProgress(view,progress){
    if(lookupBusy())return;
    for(const key of ['definition','meaning','sentenceTranslation'])if(typeof progress[key]==='string'&&progress[key].trim())view.progressFields[key]=progress[key];
    const rows=[['词义',view.progressFields.definition],['当前语境',view.progressFields.meaning]].filter(([,value])=>typeof value==='string'&&value.trim());
    if(!rows.length&&!view.progressFields.sentenceTranslation)return;
    if(!view.progressBackup)view.progressBackup={answer:view.answer.textContent,nodes:[...view.explanation.childNodes].map(node=>node.cloneNode(true)),sentenceNodes:[...view.sentenceTranslation.childNodes].map(node=>node.cloneNode(true)),note:view.note.textContent,error:view.answer.classList.contains('error'),confirmed:view.confirmedDisplayed,reference:view.referenceDisplayed};
    view.answer.classList.remove('error');view.answer.textContent='';view.explanation.replaceChildren();
    for(const [label,value]of rows){const term=document.createElement('dt'),description=document.createElement('dd');term.textContent=label;if(label==='词义'){const valueNode=document.createElement('strong');valueNode.className='definition-value';valueNode.textContent=value;description.append(valueNode);}else explanationText(description,value,view.target.text,view.progressFields.definition);description.lang=view.level==='rescue'?'zh-CN':'en';view.explanation.append(term,description);}
    if(view.progressFields.sentenceTranslation)explanationText(view.sentenceTranslation,view.progressFields.sentenceTranslation,view.target.text,view.progressFields.definition);
    view.note.textContent='正在生成，暂未完成';view.hasUnconfirmedProgress=true;positionCard(view);
  }
  function restoreProgressBackup(view){
    const backup=view.progressBackup;if(!backup)return;
    view.answer.textContent=backup.answer;view.answer.classList.toggle('error',backup.error);view.explanation.replaceChildren(...backup.nodes.map(node=>node.cloneNode(true)));view.sentenceTranslation.replaceChildren(...backup.sentenceNodes.map(node=>node.cloneNode(true)));view.note.textContent=backup.note;view.confirmedDisplayed=backup.confirmed;view.referenceDisplayed=backup.reference;view.progressBackup=null;view.hasUnconfirmedProgress=false;
  }
  async function resolveTargetDomain(target,current){
    if(typeof target.domain==='string'&&target.domain)return target.domain;
    if(state.settings.domain&&state.settings.domain!=='auto'){state.domain=state.settings.domain;state.domainResolved=true;}
    if(!state.domainResolved){
      const route=await request('RESOLVE_DOMAIN',{text:target.context||target.text,title:'',explicit:true,immediate:true});
      if(!current())return null;
      state.domain=route?.domain||'general';state.domainResolved=true;
    }
    target.domain=state.domain||'general';
    if(target.requestedRecord)target.requestedRecord.job.domain=target.domain;
    return target.domain;
  }
  function requestTargetAssistance(target,command,requestId,bypassCache,prepared){
    const prior=target.support,identity=prior?.senseKey?{wordId:prior.wordId,senseKey:prior.senseKey}:{};
    return prepared?request('PREPARED_ASSIST',{requestId,...command,bypassCache,...identity,article:target.preparationArticle||{key:'',text:'',coverage:'excerpt'}}):request('ASSIST',{requestId,...command,articleKey:target.explicitDisplay||target.sourceKey?'':target.preparationArticle?.key||(state.root?.isConnected?state.article?.key:'')||'',bypassCache,...identity});
  }
  async function assistInline(target,level){
    closeCard();const record=target.requestedRecord;if(!record||record.inlineRequestId&&state.assistRequestId===record.inlineRequestId)return;
    const requestId=crypto.randomUUID();state.assistRequestId=requestId;record.inlineRequestId=requestId;lookup.inlineRequestId=requestId;
    const current=()=>state.assistRequestId===requestId&&record.inlineRequestId===requestId&&validTarget(target);
    const cached=record.target.manualAssists?.[level],field=level==='rescue'?'translation':'hint';
    if(cached?.sense&&cached.source!=='local-reference'&&cached[field]){if(lookupBusy())await waitForLookupIdle();if(!current()){if(record.inlineRequestId===requestId)record.inlineRequestId=null;return;}record.inlineRequestId=null;record.target[field]=cached[field];record.language=level==='rescue'?'zh':'en';record.stage='hint';attachRecordHint(record);record.hint.setAttribute('aria-hidden','false');record.hint.setAttribute('role','note');syncRecordPresentation(record);setPageStatus('lookup',null);return;}
    setPageStatus('lookup','正在查词',{busy:true});let received=null;
    try{
      const domain=await resolveTargetDomain(target,current);if(!domain||!current())return;
      const prepared=Boolean(target.prepared?.details?.meaning?.zh&&target.prepared?.details?.sentenceTranslation);
      const result=await requestTargetAssistance(target,{text:target.text,context:target.context,domain,kind:target.kind,level,detail:'brief'},requestId,false,prepared);received=result;
      if(lookupBusy())await waitForExplicitLookup();
      if(!current()){reportResult(result,'cancelled');return;}
      const answer=result[field];if(typeof answer!=='string'||!answer.trim())throw new Error('上下文不足，请选择包含该词的句子。');
      if(result.source==='local-reference'||!result.sense?.trim())throw new Error('仅有旧参考义，尚未确认当前语境；请使用解释卡片查看。');
      record.target[field]=answer;record.language=level==='rescue'?'zh':'en';record.stage='hint';attachRecordHint(record);target.anchor=record.range.cloneRange();syncRecordPresentation(record);
      record.hint.setAttribute('aria-hidden','false');record.hint.setAttribute('role','note');
      if(!current()){reportResult(result,'cancelled');return;}reportResult(result,'ok');
      const stored={...result};record.target.manualAssists={...(record.target.manualAssists||{}),[level]:stored};
      let support=result.support;
      if(result.source==='prepared'&&!support)await request('HISTORY_COMMIT',{requestId});
      else if(result.source==='provider'||result.source==='prepared'||result.source==='cache'){const adopted=await request('ASSIST_COMMIT',{requestId});support=adopted.support||support;}
      if(!current())return;stored.support=support;record.target.manualSupport=support;
      if(support){Object.assign(record.target,support);state.assisted.add(identity(support));syncRecordPresentation(record);}
      if(lookup.inlineRequestId===requestId)setPageStatus('lookup',null);
    }catch(error){reportResult(received,'error');if(current()&&lookup.inlineRequestId===requestId)setPageStatus('lookup',error.message,{error:true});}
    finally{if(!validTarget(target)&&lookup.inlineRequestId===requestId)setPageStatus('lookup',null);if(record.inlineRequestId===requestId)record.inlineRequestId=null;}
  }
  async function assist(view,level,bypassCache=false,detail='brief'){
    if(state.card!==view||!validTarget(view.target))return;
    const requestId=crypto.randomUUID();state.assistRequestId=requestId;
    detail=view.target.kind==='passage'?'full':detail;view.requestId=requestId;view.level=level;view.detail=detail;view.rescue.textContent=level==='rescue'?'查看英文线索':'用中文说明';view.support=null;view.less.disabled=true;view.retry.hidden=true;view.explanation.replaceChildren();view.progressBackup=null;view.progressFields={};view.hasUnconfirmedProgress=false;view.confirmedDisplayed=false;view.referenceDisplayed=false;view.assistFinished=false;
    stopCardSpeech(view);if(detail==='full')view.sentenceTranslation.textContent='正在获取本句翻译…';else if(!view.fullDetails)view.sentenceTranslation.textContent='展开后获取本句翻译。';
    view.wrong.disabled=view.retries>=2;view.answer.classList.remove('error');view.answer.textContent=detail==='full'?'正在请求详细解释…':'正在请求简释…';view.note.textContent='';view.repair.hidden=true;
    const record=view.target.requestedRecord,prior=view.target.support;
    const current=()=>state.assistRequestId===requestId&&view.requestId===requestId&&validTarget(view.target)&&(state.card===view||Boolean(record?.manual&&record.marks.some(mark=>mark.isConnected)));
    const cardCurrent=()=>state.card===view&&current();
    const domain=await resolveTargetDomain(view.target,current);if(!domain||!current())return;
    const manualCached=!bypassCache&&detail==='brief'?view.target.manualAssists?.[level]||null:!bypassCache&&detail==='full'?view.fullResult:null;
    const cached=manualCached||(!bypassCache?view.target.prepared:null),cachedAnswer=cached?.[level==='rescue'?'translation':'hint'];
    const cachedReference=cached?.source==='local-reference'||(detail==='full'&&(!cached?.details?.meaning||typeof cached?.details?.sentenceTranslation!=='string'||!cached.details.sentenceTranslation.trim()));
    const prepared=(!manualCached||manualCached.source==='prepared')&&view.target.kind!=='passage'&&!view.target.sourceKey&&Boolean(cached?.details?.meaning?.zh&&cached?.details?.sentenceTranslation);
    let fullFinished=false;
    if(cardCurrent()){
      if(cachedAnswer?.trim()&&!cachedReference&&detail==='full'){showDetails(view,cached.details,cachedAnswer);view.confirmedDisplayed=true;view.fullDetails=cached.details;view.note.textContent=cached.cacheNotice||cached.referenceNotice||'';positionCard(view);}
      else if(cachedAnswer?.trim()){view.explanation.replaceChildren();view.answer.textContent=cachedAnswer;view.note.textContent=cachedReference?(cached.referenceNotice||'旧参考义，未经当前语境确认。'):(cached.cacheNotice||'');view.referenceDisplayed=cachedReference;positionCard(view);}
      else view.answer.textContent=prepared?'正在读取已准备的帮助…':detail==='full'?'正在请求详细解释…':'正在请求简释…';
    }
    if(prior?.senseKey){state.assisted.add(identity(prior));if(record){attachRecordHint(record);record.stage='hint';if(state.card!==view)view.target.anchor=record.range.cloneRange();}}
    let receivedResult=null;
    try{
      const command={text:view.target.text,context:view.target.context,domain,kind:view.target.kind,level,detail};
      const previewPromise=!prepared&&!bypassCache?request('ASSIST_PREVIEW',command).catch(()=>null):Promise.resolve(null);
      const resultPromise=requestTargetAssistance(view.target,command,requestId,bypassCache,prepared);
      void previewPromise.then(preview=>{
        if(lookupBusy()||fullFinished||manualCached||view.hasUnconfirmedProgress||!cardCurrent()||!preview||!['saved-reference','local-reference'].includes(preview.source)||preview.level!==level)return;
        const answer=level==='rescue'?preview.translation:preview.hint;
        if(typeof answer!=='string'||!answer.trim())return;
        view.explanation.replaceChildren();view.answer.textContent=answer;view.note.textContent=preview.referenceNotice||'旧参考义，未经当前语境确认。';view.referenceDisplayed=true;positionCard(view);
      });
      const result=await resultPromise;receivedResult=result;fullFinished=true;
      if(lookupBusy())await waitForExplicitLookup();
      if(!current()){reportResult(result,'cancelled');return;}view.assistFinished=true;const answer=level==='rescue'?result.translation:result.hint;
      if(answer===null){
        view.sentenceTranslation.textContent='上下文不足，未能获取本句翻译。';
        if(cardCurrent()){view.progressBackup=null;view.hasUnconfirmedProgress=false;view.confirmedDisplayed=false;view.explanation.replaceChildren();view.answer.textContent='上下文不足，请选择包含该表达的句子';view.note.textContent=result.cacheNotice||result.referenceNotice||'';reportResult(result,'ok');}
        else reportResult(result,'cancelled');
        return;
      }
      if(typeof answer!=='string'||!answer.trim())throw new Error('服务未返回有效帮助。');
      const confirmed=result.source!=='local-reference'&&(detail==='brief'?typeof result.sense==='string'&&Boolean(result.sense.trim()):Boolean(result.details?.meaning)&&typeof result.details?.sentenceTranslation==='string'&&Boolean(result.details.sentenceTranslation.trim()));
      let stored=null;
      if(record&&confirmed&&detail==='brief'){
        record.target[level==='rescue'?'translation':'hint']=answer;record.language=level==='rescue'?'zh':'en';record.stage='hint';attachRecordHint(record);
        if(state.card!==view)view.target.anchor=record.range.cloneRange();
        stored={...result,level,[level==='rescue'?'translation':'hint']:answer,support:result.support||null};record.target.manualAssists={...(record.target.manualAssists||{}),[level]:stored};view.target.manualAssists=record.target.manualAssists;if(result.source==='provider'||result.source==='cache')view.target.prepared=null;
      }
      if(!current()){reportResult(result,'cancelled');return;}
      if(cardCurrent()&&confirmed&&detail==='full'){view.progressBackup=null;view.hasUnconfirmedProgress=false;view.answer.textContent=answer;view.fullDetails=result.details||(prepared?cached.details:null);view.fullResult=result;showDetails(view,view.fullDetails,answer);view.confirmedDisplayed=true;view.note.textContent=result.cacheNotice||result.referenceNotice||'';positionCard(view);}
      else if(cardCurrent()&&confirmed){view.progressBackup=null;view.hasUnconfirmedProgress=false;view.explanation.replaceChildren();view.answer.textContent=answer;view.sentenceTranslation.textContent=view.fullDetails?.sentenceTranslation||'展开后获取本句翻译。';if(view.sentence.open&&view.fullDetails)showDetails(view,view.fullDetails,answer);view.confirmedDisplayed=true;view.note.textContent=result.cacheNotice||result.referenceNotice||'';positionCard(view);}
      else if(cardCurrent()){view.progressBackup=null;view.hasUnconfirmedProgress=false;view.explanation.replaceChildren();view.answer.textContent=answer;view.sentenceTranslation.textContent='旧参考义，尚未按当前句完整确认。';view.note.textContent=result.referenceNotice||'旧参考义，未经当前语境确认。';view.referenceDisplayed=true;positionCard(view);}
      else if(!record?.hint?.isConnected){reportResult(result,'cancelled');return;}
      reportResult(result,'ok');
      if(detail==='brief'&&confirmed&&result.source==='prepared'&&!result.support)void request('HISTORY_COMMIT',{requestId}).catch(()=>{});
      if(detail==='brief'&&confirmed&&(result.source==='provider'||result.source==='prepared'&&result.support)){if(!current())return;const adopted=await request('ASSIST_COMMIT',{requestId});if(!current())return;view.support=adopted.support||result.support||null;view.target.support=view.support;if(cardCurrent())view.less.disabled=!view.support||!state.settings.rememberSupport;if(view.support)state.assisted.add(identity(view.support));view.termSuggestion=adopted.termSuggestion||null;if(view.termRow)view.termRow.hidden=!view.termSuggestion;renderSupportMeta(view);}
      if(stored){stored.support=view.support||stored.support;record.target.manualSupport=stored.support;}
      if(record&&view.support){Object.assign(record.target,view.support);syncRecordPresentation(record);}
      if(cardCurrent()&&view.knownWordId())view.known.hidden=false;
      if(detail==='brief'&&confirmed&&prepared){if(cardCurrent())view.refreshPreparedOnClose=true;else void refreshPreparedNow().catch(()=>{});}if(detail==='brief'&&view.pendingDetails&&cardCurrent()&&view.sentence.open)void expandDetails(view);
    }catch(error){reportResult(receivedResult,'error');fullFinished=true;if(cardCurrent()){view.assistFinished=true;if(view.hasUnconfirmedProgress)restoreProgressBackup(view);if(!view.confirmedDisplayed)view.sentenceTranslation.textContent='未能获取本句翻译，请重试。';if(view.confirmedDisplayed||view.referenceDisplayed)view.note.textContent=[view.note.textContent,error.message,view.confirmedDisplayed?'已确认内容保留；可重新请求解释。':'旧参考义保留，尚未按当前语境确认。'].filter(Boolean).join(' ');else{view.explanation.replaceChildren();view.answer.textContent=error.message;view.answer.classList.add('error');}view.retry.textContent=prepared?'重新请求解释':'重试';view.retry.hidden=view.retries>=2;view.repair.hidden=false;positionCard(view);}}
  }
  function markRequestedTarget(target){
      if(target.sourceKey||target.explicitDisplay||target.kind==='passage')return;
      const existing=target.anchor.startContainer.parentElement.closest('.'+MARK_CLASS)?.__shisuiRecord;
      if(existing){if(!existing.manual){existing.manual=true;requestedRecords.push(existing);}existing.context=target.context;existing.sourceText=target.sourceText;target.requestedRecord=existing;return;}
      const mapping=textMap(target.block),start=boundaryOffset(mapping,target.anchor.startContainer,target.anchor.startOffset),end=start+target.text.length;
      const record=annotateTarget({block:target.block,start:0,end:mapping.text.length,sentence:mapping.text},{text:target.text,start,end},'mark',true);
      if(!record)return;record.manual=true;record.context=target.context;record.job.domain=target.domain||state.domain;requestedRecords.push(record);target.requestedRecord=record;target.anchor=record.range.cloneRange();installPageStyles();
    }
    function assistTarget(target) { target.generation=state.generation;target.viewportGeneration=state.viewportGeneration;
    if(!validTarget(target))return;
    if(target.requestedRecord&&state.card?.target.requestedRecord===target.requestedRecord&&validTarget(state.card.target))return;
    markRequestedTarget(target);const level=target.kind!=='passage'&&state.settings.helpLanguage==='zh'?'rescue':'hint';
    if(state.settings.lookupDisplay==='annotation'&&target.kind!=='passage'&&!target.sourceKey&&!target.explicitDisplay){void assistInline(target,level);return;}
    const view=renderHelpCard(target);void assist(view,level);void ShisuiConversation.openConversation(view);return {close:()=>{if(state.card===view)closeCard();}}; }
  function caretRangeAt(event) {
    if(document.caretPositionFromPoint){const point=document.caretPositionFromPoint(event.clientX,event.clientY);if(point){const range=document.createRange();range.setStart(point.offsetNode,point.offset);range.collapse(true);return range;}}
    return document.caretRangeFromPoint?.(event.clientX,event.clientY) || null;
  }
  function explicitLookupElement(event){
    const element=nodeElement(event.target);
    if(!element||!inReadingSurface(element)||element.closest('pre,code,kbd,samp,input,textarea,select,option,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[aria-hidden="true"],[hidden],[inert],svg,canvas')||element.closest('['+OWN+']')&&!readerContent(element)||!isVisible(element))return null;
    const link=element.closest('a');if(link&&!safeLinkHref(link))return null;
    return link||element.closest('button,[role="button"],label,p,li,blockquote,dd,dt,figcaption,h1,h2,h3,h4,h5,h6,td,th,span')||element;
  }
  function explicitLookupTarget(event){
    const block=explicitLookupElement(event),point=caretRangeAt(event);
    if(!block||!point||!block.contains(point.startContainer))throw new Error('请点击可见的英文词语。');
    const mapping=textMap(block),offset=boundaryOffset(mapping,point.startContainer,point.startOffset);
    const word=[...mapping.text.matchAll(/[A-Za-z](?:[A-Za-z'’—-]*[A-Za-z])?/g)].find(item=>item.index<=offset&&item.index+item[0].length>=offset);
    if(!word)throw new Error('这里没有可解释的英文词。');
    const start=word.index,end=start+word[0].length,anchor=rangeFor(mapping,start,end),link=block.closest('a');
    if(!anchor||!anchor.getClientRects().length||![...anchor.getClientRects()].some(rect=>event.clientX>=rect.left&&event.clientX<=rect.right&&event.clientY>=rect.top&&event.clientY<=rect.bottom))throw new Error('请点击英文词语。');
    if(link&&mapping.text.length>200)throw new Error('链接文字超过 200 字符，请选择更短的英文。');
    const context=mapping.text.slice(Math.max(0,start-800),Math.min(mapping.text.length,end+800));
    return {text:word[0],sourceText:mapping.text,context,kind:'word',block,anchor,generation:state.generation,viewportGeneration:state.viewportGeneration,displayLink:link?{element:link,href:link.getAttribute('href')}:null,explicitDisplay:true};
  }
  function clearNavigationTranslation(link){
    const previous=link.querySelector('[data-shisui-ui="passage-translation"]');if(!previous)return false;
    const pending=[...state.passageRequests].find(view=>view.panel===previous);if(pending){pending.cancelled=true;state.passageRequests.delete(pending);updatePassageStatus();}previous.remove();return true;
  }
  function translateNavigationLink(link){
    if(clearNavigationTranslation(link))return;
    const range=document.createRange();range.selectNodeContents(link);const target=passageTarget(range);
    if(!target||target.kind!=='navigation'||target.error){setPageStatus('lookup',target?.error||'此链接没有可翻译的英文导航文字。',{error:true});return;}
    void translatePassage(target);
  }
  function clearLookupPreview(){cancelAnimationFrame(lookup.frame);lookup.frame=0;lookup.preview?.remove();lookup.preview=null;}
  function resetLookup(){lookup.held=false;lookup.code=null;clearLookupPreview();if(lookup.press)lookup.press.cancelled=true;lookup.quietUntil=0;clearTimeout(lookup.idleTimer);lookup.idleTimer=setTimeout(resumeLookupUpdates,0);}
  function onLookupKey(event){
    if(!event.isTrusted)return;
    if(event.type==='keyup'){if(lookup.held&&(event.code===lookup.code||event.key.toUpperCase()===lookupKey())){consumeLookup(event);lookup.held=false;lookup.code=null;clearLookupPreview();deferLookupUpdates();if(state.settings.keyboardNav?.enabled&&nav.record&&!lookup.press)openNavRecord();}return;}
    if(!state.enabled&&!state.reader||state.paused&&!state.reader||event.isComposing||event.keyCode===229||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey||lookupEditing(event)&&!nodeElement(event.target)?.closest('button,[role="button"]')){resetLookup();return;}
    if(event.key.toUpperCase()!==lookupKey()){resetLookup();return;}
    if(event.repeat&&!lookup.held)return;
    consumeLookup(event);lookup.held=true;lookup.code=event.code;deferLookupUpdates();scheduleLookupPreview();
  }
  const nav={record:null,flash:null};
  function navCandidates(){
    return state.records
      .filter(record=>!record.manual&&record.marks?.length&&record.marks[0].isConnected&&record.stage!=='quiet')
      .sort((a,b)=>{if(a.block===b.block)return a.target.start-b.target.start;const pos=a.block.compareDocumentPosition(b.block);return pos&Node.DOCUMENT_POSITION_PRECEDING?1:pos&Node.DOCUMENT_POSITION_FOLLOWING?-1:0;});
  }
  function flashNavRecord(record){
    nav.flash?.remove();nav.flash=null;
    const host=document.createElement('div');host.setAttribute(OWN,'nav-flash');host.setAttribute('aria-hidden','true');
    host.style.cssText='position:fixed;inset:0;pointer-events:none;z-index:2147483646;transition:opacity .4s ease;opacity:1';
    let drew=false;
    for(const rect of record.range.getClientRects()){
      if(rect.width<2||rect.height<2)continue;drew=true;
      const line=document.createElement('span');
      line.style.cssText='position:absolute;box-sizing:border-box;border:2px solid rgba(13,148,136,.9);border-radius:4px;box-shadow:0 0 0 4px rgba(13,148,136,.22);left:'+(rect.left-3)+'px;top:'+(rect.top-3)+'px;width:'+(rect.width+6)+'px;height:'+(rect.height+6)+'px';
      host.append(line);
    }
    if(!drew)return;
    uiMountRoot().append(host);nav.flash=host;
    setTimeout(()=>{host.style.opacity='0';setTimeout(()=>{if(nav.flash===host)nav.flash=null;host.remove();},420);},750);
  }
  function navigateRecords(direction,event){
    const candidates=navCandidates();if(!candidates.length)return;
    consumeLookup(event);removeSelectionTool();
    let index=candidates.indexOf(nav.record);
    if(index<0){
      const mid=innerHeight/2;
      index=candidates.findIndex(record=>{const rect=record.marks[0].getBoundingClientRect();return rect.bottom>=mid;});
      if(index<0)index=direction>0?0:candidates.length-1;else if(direction<0)index=Math.max(0,index-1);
    }else index=(index+direction+candidates.length)%candidates.length;
    nav.record=candidates[index];
    nav.record.marks[0].scrollIntoView({block:'center'});
    flashNavRecord(nav.record);
    setPageStatus('lookup','已选中标记，按 '+lookupKey()+' 打开解释',{duration:1500});
  }
  function openNavRecord(){
    const record=nav.record;
    if(!record||!record.marks?.[0]?.isConnected)return;
    try{assistTarget(helpTarget(record.range.cloneRange(),true,record));}catch{}
  }
  function onNavKey(event){
    if(event.type==='keyup'||!event.isTrusted)return;
    if(event.key!=='['&&event.key!==']')return;
    if(!state.enabled||state.paused||!state.settings.keyboardNav?.enabled||event.isComposing||event.keyCode===229||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey||lookupEditing(event))return;
    navigateRecords(event.key===']'?1:-1,event);
  }
  function lookupElement(event){const element=nodeElement(event.target);return element&&inReadingSurface(element)&&(!element.closest(SKIP)||readerContent(element))&&!element.closest('kbd,samp,'+LOOKUP_CONTROLS)&&(!element.closest(LOOKUP_UI)||readerContent(element))?element:null;}
  function pointHelpTarget(event,selected=false){
    const element=lookupElement(event);
    if(!element||element.closest('a'))return explicitLookupTarget(event);
    const record=element.closest('.'+MARK_CLASS+',.'+HINT_CLASS)?.__shisuiRecord,selection=getSelection();
    let range=selected&&selection?.rangeCount&&!selection.isCollapsed&&inReadingSurface(selection.anchorNode)?selection.getRangeAt(0).cloneRange():null;
    if(range&&![...range.getClientRects()].some(rect=>event.clientX>=rect.left&&event.clientX<=rect.right&&event.clientY>=rect.top&&event.clientY<=rect.bottom))range=null;
    const hasSelection=Boolean(range);range=range||record?.range.cloneRange()||caretRangeAt(event);if(!range)throw new Error('这里没有可解释的英文词。');
    const target=helpTarget(range,hasSelection||Boolean(record),record);
    if(![...target.anchor.getClientRects()].some(rect=>event.clientX>=rect.left&&event.clientX<=rect.right&&event.clientY>=rect.top&&event.clientY<=rect.bottom))throw new Error('请点击英文词语。');
    return target;
  }
  function scheduleLookupPreview(){
    if(!lookup.held||lookup.press||!lookup.point||lookup.frame)return;
    lookup.frame=requestAnimationFrame(()=>{lookup.frame=0;clearLookupPreview();if(!lookup.held||!lookup.point)return;
      try{const point={...lookup.point,target:document.elementFromPoint(lookup.point.clientX,lookup.point.clientY)},target=pointHelpTarget(point),clip=sentenceClip(target.block);
        const host=document.createElement('div');host.setAttribute(OWN,'lookup-preview');host.setAttribute('aria-hidden','true');host.style.cssText='position:fixed;inset:0;pointer-events:none;z-index:2147483646;color:'+getComputedStyle(nodeElement(target.anchor.startContainer)).color;
        for(const rect of target.anchor.getClientRects()){const left=Math.max(rect.left-2,clip.left),right=Math.min(rect.right+2,clip.right),top=Math.max(rect.top-1,clip.top),bottom=Math.min(rect.bottom+1,clip.bottom);if(right<=left||bottom<=top)continue;const line=document.createElement('span');line.style.cssText='position:absolute;pointer-events:none;box-sizing:border-box;border:1px solid color-mix(in srgb,currentColor 48%,transparent);border-radius:3px;left:'+left+'px;top:'+top+'px;width:'+(right-left)+'px;height:'+(bottom-top)+'px';host.append(line);}
        uiMountRoot().append(host);lookup.preview=host;
      }catch{}
    });
  }
  function onLookupPointerMove(event){if(!event.isTrusted||!inReadingSurface(event.target))return;lookup.point={clientX:event.clientX,clientY:event.clientY};scheduleLookupPreview();}
  function consumeLookup(event){historyInteraction(event);event.preventDefault();event.stopImmediatePropagation();}
  function onHelpPointerDown(event){
    if(!event.isTrusted||event.button!==0||!inReadingSurface(event.target))return;lookup.press=null;
    if(!lookup.held||!state.enabled&&!state.reader||state.paused&&!state.reader||event.shiftKey||event.ctrlKey||event.metaKey||event.altKey||lookupEditing(event)&&!explicitLookupElement(event)||!lookupElement(event)&&!explicitLookupElement(event))return;
    nav.record=null;
    // Own the whole pointer gesture before range validation, DOM changes, or service work.
    consumeLookup(event);clearLookupPreview();lookup.press={pointerId:event.pointerId,target:null,error:'',cancelled:false};
    try{lookup.press.target=pointHelpTarget(event,true);}catch(error){lookup.press.error=error.message;}
  }
  function onHelpPointerUp(event){if(event.isTrusted&&lookup.press?.pointerId===event.pointerId)consumeLookup(event);}
  function onHelpClick(event){
    if(!event.isTrusted||event.button!==0||!event.detail||!lookup.press||event.pointerId!==undefined&&event.pointerId!==lookup.press.pointerId)return;
    const press=lookup.press;lookup.press=null;consumeLookup(event);deferLookupUpdates();if(press.cancelled)return;
    removeSelectionTool();getSelection()?.removeAllRanges();
    if(press.target){const link=press.target.displayLink?.element;if(link?.closest('nav,[role="navigation"]'))translateNavigationLink(link);else assistTarget(press.target);}else setPageStatus('lookup',press.error,{error:true,duration:3000});
  }
  function onLookupBlur(event){if(event.target===window){resetLookup();lookup.point=null;}}
  function onLookupFocus(event){if(lookupEditing(event))resetLookup();}
  function onLookupCancel(){resetLookup();lookup.press=null;}
  function onLookupLeave(event){if(event.target===document.documentElement){lookup.point=null;clearLookupPreview();}}
  function onKey(event){if(event.key!=='Escape'||state.reader)return;removeStructureCard();if(state.card)closeCard();if(state.selectionTool){removeSelectionTool();Kernel.dismissSelection(passageSelectionSignature());}else Kernel.dismissSelection('');}
  function onOutside(event){if(state.card&&!event.composedPath().includes(state.card.host))closeCard();
    // 点击浮条以外的页面：收起浮条并记住这次选区，避免浏览器保留旧选区时在原地再次弹出。
    if(state.selectionTool&&!event.composedPath().includes(state.selectionTool)){Kernel.dismissSelection(passageSelectionSignature());removeSelectionTool();}
  }
  const passageHover=()=>state.settings.passageAction?.open==='hover';
  const passageDelay=()=>{const delay=state.settings.passageAction?.delay;return Number.isSafeInteger(delay)&&delay>=0&&delay<=3000?delay:600;};
  function onContextMenu(event){
    const selection=getSelection(),link=inReadingSurface(event.target)?nodeElement(event.target)?.closest('a'):null;
    contextRange=inReadingSurface(event.target)&&!unsafe(event.target) && selection?.rangeCount && !selection.isCollapsed?selection.getRangeAt(0).cloneRange():null;
    contextLink=link&&link.closest('nav,[role="navigation"]')&&safeLinkHref(link)&&isVisible(link)?{link,href:link.href}:null;
  }
  async function translateContextLink(linkUrl){
    if(state.paused)throw new Error('本页已暂停，请先继续辅助。');
    const captured=contextLink;contextLink=null;
    if(!captured||!captured.link.isConnected||captured.href!==linkUrl||captured.link.href!==linkUrl)throw new Error('导航链接已变化，请重新右键该链接。');
    if(!state.enabled)await enable();
    if(!captured.link.isConnected||captured.link.href!==linkUrl)throw new Error('导航链接已变化，请重新右键该链接。');
    clearNavigationTranslation(captured.link);
    const range=document.createRange();range.selectNodeContents(captured.link);
    const target=passageTarget(range);
    if(!target||target.kind!=='navigation'||target.error)throw new Error(target?.error||'此链接没有可翻译的英文导航文字。');
    if(!validPassageTarget(target))throw new Error('导航链接已变化，请重新右键该链接。');
    await translatePassage(target);return status();
  }
  async function contextHelp(selectionText) {
    if(state.paused)throw new Error('本页已暂停，请先继续辅助。');
    const selection=getSelection(),range=contextRange || (selection?.rangeCount&&!selection.isCollapsed?selection.getRangeAt(0).cloneRange():null);contextRange=null;
    if(!range || !range.startContainer.isConnected||!inReadingSurface(range.startContainer))throw new Error('选区已失效，请重新选择。');
    const target=helpTarget(range,true);if(normalizeText(selectionText)!==normalizeText(target.text))throw new Error('选区已变化，请重新选择。');if(target.kind==='word')throw new Error('单词请使用“'+lookupLabel()+'”。');
    if(!state.enabled)await enable();assistTarget(target);return status();
  }
  function removeSelectionTool(){state.selectionTool?.remove();state.selectionTool=null;}
  function passageSelectionSignature(){
    const selection=getSelection();if(!selection?.rangeCount||selection.isCollapsed||!inReadingSurface(selection.anchorNode))return '';
    const range=selection.getRangeAt(0),link=navigationLink(range);
    return link?'nav:'+blockId(link)+':'+normalizeText(range.toString()).slice(0,160):Kernel.selectionSignature(selection);
  }
  function navigationLink(range){
    const start=nodeElement(range?.startContainer),end=nodeElement(range?.endContainer),link=start?.closest('a');
    return link&&link===end?.closest('a')&&link.closest('nav,[role="navigation"]')&&safeLinkHref(link)&&isVisible(link)&&!start.closest('code,kbd,samp,[contenteditable],[aria-hidden="true"],[inert],['+OWN+']')&&!end.closest('code,kbd,samp,[contenteditable],[aria-hidden="true"],[inert],['+OWN+']')?link:null;
  }
  function passageTarget(range,wholeBlock=false){
    if(!range?.startContainer?.isConnected||!range.endContainer?.isConnected||!inReadingSurface(range.startContainer)||!inReadingSurface(range.endContainer))return null;
    const link=navigationLink(range);
    if(!link&&unsafe(nodeElement(range.startContainer))||link&&wholeBlock)return null;
    let blocks;
    if(link)blocks=[link];
    else if(wholeBlock){
      const block=readingBlockFor(range.startContainer);if(!block||unsafe(block))return null;blocks=[block];
    }else{
      const scope=readingScope(),boundaryBlocks=[readingBlockFor(range.startContainer),readingBlockFor(range.endContainer)].filter(Boolean),eligible=eligibleBlocks(scope);
      blocks=[...new Set([...eligible,...scope.querySelectorAll(BLOCK_SELECTOR),...boundaryBlocks])].filter(block=>{
        if(!block.isConnected||!inReadingSurface(block)||(block.closest(SKIP)&&!readerContent(block))||block.closest('['+OWN+']')&&!readerContent(block)||!isVisible(block))return false;
        try{return range.intersectsNode(block);}catch{return false;}
      }).sort((a,b)=>a===b?0:a.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_FOLLOWING?-1:1);
    }
    const parts=[];
    for(const block of blocks){
      const mapping=textMap(block);if(!mapping.text.trim())continue;
      const start=wholeBlock?0:boundaryOffset(mapping,range.startContainer,range.startOffset),end=wholeBlock?mapping.text.length:boundaryOffset(mapping,range.endContainer,range.endOffset);
      if(end<=start)continue;
      if(mapping.nodes.some(entry=>entry.end>start&&entry.start<end&&(link?!link.contains(entry.node.parentElement)||!isVisible(entry.node.parentElement):unsafe(entry.node.parentElement))))return null;
      const partRange=rangeFor(mapping,start,end);if(!partRange)continue;
      parts.push({block,start,end,text:mapping.text.slice(start,end),sourceText:mapping.text,range:partRange});
    }
    if(!parts.length)return null;
    const text=parts.map(part=>part.text).join('\n');if(!text.trim()||!/[A-Za-z]/.test(text)||link&&(text.length>200||text!==range.toString()))return null;
    let error='';let chunks=[];
    if(text.length>12000)error='所选原文超过 12000 字符，请缩小选择范围。';
    else{chunks=splitEmergencyText(text);if(!chunks.length||chunks.length>4||chunks.some(chunk=>chunk.length>4000))error='所选原文超过 4 段、每段 4000 字符的翻译上限，请缩小选择范围。';}
    return {text,chunks,error,kind:link?'navigation':wholeBlock?'passage':'selection',block:parts.at(-1).block,blocks:parts,range:wholeBlock?parts[0].range.cloneRange():range.cloneRange(),generation:state.generation,page:location.href,...link?{href:link.getAttribute('href')}:null};
  }
  function validPassageTarget(target){
    if(!state.enabled||state.paused||target.error||target.generation!==state.generation||target.page!==location.href||!target.block.isConnected||!inReadingSurface(target.block)||!target.range.startContainer.isConnected||!target.range.endContainer.isConnected||target.kind==='navigation'&&(navigationLink(target.range)!==target.block||target.block.getAttribute('href')!==target.href))return false;
    const current=[];
    for(const part of target.blocks){
      if(!part.block.isConnected||!part.range.startContainer.isConnected||!part.range.endContainer.isConnected)return false;
      const mapping=textMap(part.block);
      if(mapping.text!==part.sourceText||mapping.text.slice(part.start,part.end)!==part.text)return false;
      if(boundaryOffset(mapping,part.range.startContainer,part.range.startOffset)!==part.start||boundaryOffset(mapping,part.range.endContainer,part.range.endOffset)!==part.end)return false;
      current.push(part.text);
    }
    return current.join('\n')===target.text;
  }
  function insertRelatedTranslation(block,node){
    let table=block.closest('table');if(table){while(table.parentElement?.closest('table'))table=table.parentElement.closest('table');table.insertAdjacentElement('afterend',node);node.dataset.layout='table';return;}
    if(block.matches('li,dd')){block.append(node);return;}
    if(block.matches('dt')){const description=block.nextElementSibling?.matches('dd')?block.nextElementSibling:null;if(description){description.append(node);return;}const list=block.closest('dl');if(list){list.insertAdjacentElement('afterend',node);return;}}
    let anchor=block;while(anchor.parentElement&&/^(UL|OL|MENU|DL|TBODY|THEAD|TFOOT|TR)$/.test(anchor.parentElement.tagName))anchor=anchor.parentElement;
    const parentStyle=getComputedStyle(anchor.parentElement),style=getComputedStyle(anchor);
    if(/^(inline-)?flex$/.test(parentStyle.display)&&parentStyle.flexDirection.startsWith('row')){anchor.parentElement.insertAdjacentElement('afterend',node);node.dataset.layout='associated';return;}
    if(/^(inline-)?grid$/.test(parentStyle.display)){node.style.gridColumn=style.gridColumn==='auto'?'1 / -1':style.gridColumn;node.style.order=style.order;node.dataset.layout='grid';}
    else if(/^(inline-)?flex$/.test(parentStyle.display))node.style.order=style.order;
    anchor.insertAdjacentElement('afterend',node);
  }
  function passagePanel(target){
    const navigation=target.kind==='navigation';installPageStyles();
    if(navigation){
      const panel=document.createElement('span');panel.setAttribute(OWN,'passage-translation');panel.lang='zh-CN';panel.setAttribute('aria-label','导航文字中文翻译');panel.setAttribute('aria-live','polite');panel.setAttribute('aria-busy','true');panel.textContent='翻译中…';
      for(const [name,value] of [['display','block'],['font-size','0.82em'],['line-height','1.4'],['font-weight','400'],['color','var(--accent)'],['white-space','normal'],['max-width','200px'],['overflow-wrap','anywhere']])panel.style.setProperty(name,value,'important');
      target.block.append(panel);passageSources.set(panel,target);return {panel,body:panel,cancel:null};
    }
    const passage=target.kind==='passage',panel=document.createElement('details');panel.open=true;panel.setAttribute(OWN,'passage-translation');panel.lang='zh-CN';panel.setAttribute('aria-label',passage?'本段中文翻译':'所选范围中文翻译');
    const summary=document.createElement('summary'),brand=createBrandLabel(passage?'本段译文':'所选译文');brand.style.color='inherit';summary.append(brand);
    const body=document.createElement('div');body.setAttribute('aria-live','polite');body.setAttribute('aria-busy','true');
    const cancel=document.createElement('button');cancel.type='button';cancel.textContent='取消';cancel.style.cssText='margin-top:var(--space-2);min-height:32px;padding:var(--space-1) var(--space-3);border:1px solid var(--line);border-radius:var(--radius-pill);background:transparent;color:var(--muted);cursor:pointer';
    panel.append(summary,body,cancel);insertRelatedTranslation(target.block,panel);inheritEmergencyStyle(target.block,panel);passageSources.set(panel,target);return {panel,body,cancel};
  }
  function renderPassageProgress(view,rows,complete=false){
    if(!Array.isArray(rows)||!rows.length||rows.length>view.items.length||complete&&rows.length!==view.items.length)return false;
    const values=new Map();for(const item of rows){if(!item||typeof item!=='object'||Object.keys(item).length!==2||!view.items.some(source=>source.id===item.id)||values.has(item.id)||typeof item.translation!=='string'||!item.translation.trim()||item.translation.length>8000||!item.translation.isWellFormed()||complete&&(item.translation!==item.translation.trim()||!/[\u3400-\u9fff\uf900-\ufaff]/u.test(item.translation)))return false;values.set(item.id,item.translation);}
    if(view.target.kind==='navigation'){view.body.textContent=values.get(view.items[0].id)||'翻译中…';return true;}
    let next=null;for(let index=view.items.length-1;index>=0;index--){const id=view.items[index].id,value=values.get(id);let node=view.parts.get(id);if(value!==undefined){if(!node){node=document.createElement('p');view.parts.set(id,node);}if(node.textContent!==value)node.textContent=value;}if(node){if(node.parentNode!==view.body||node.nextSibling!==next)view.body.insertBefore(node,next);next=node;}}
    return true;
  }
  async function translatePassage(target){
    pageStatus.dismissed.delete('passage');
    const requestId=crypto.randomUUID(),items=target.chunks.map((text,index)=>({id:'p'+(index+1),text})),view={requestId,target,items,parts:new Map(),cancelled:false,finished:false,...passagePanel(target)};state.passageRequests.add(view);updatePassageStatus();
    if(view.cancel)view.cancel.onclick=event=>{if(!event.isTrusted)return;view.cancelled=true;if(state.passageRequests.delete(view))updatePassageStatus();view.panel.remove();};
    let receivedResult=null,outcome='cancelled';
    try{
      const current=()=>!view.cancelled&&validPassageTarget(target)&&view.panel.isConnected,domain=await resolveTargetDomain(target,current);if(!domain||!current()){view.panel.remove();return;}
      const result=await request('PASSAGE_TRANSLATE',{requestId,items,domain});receivedResult=result;
      if(!current()){reportResult(result,'cancelled');view.panel.remove();return;}
      if(!result||!renderPassageProgress(view,result.items,true))throw new Error('翻译结果不完整或无效。');
      view.finished=true;view.body.setAttribute('aria-busy','false');if(view.cancel)view.cancel.textContent='关闭';outcome='complete';reportResult(result,'ok');void request('HISTORY_COMMIT',{requestId}).catch(()=>{});
    }catch(error){reportResult(receivedResult,'error');outcome='error';if(!view.cancelled&&validPassageTarget(target)&&view.panel.isConnected){view.finished=true;view.parts.clear();view.body.textContent=error.message||'翻译失败。';view.body.setAttribute('aria-busy','false');if(view.cancel)view.cancel.textContent='关闭';else view.panel.style.setProperty('color','var(--danger)','important');}else view.panel.remove();}
    finally{if(state.passageRequests.delete(view))updatePassageStatus(outcome);}
  }
  function cancelPassageRequests(remove=true,preserveContent=false){
    removeSelectionTool();let changed=false;
    for(const view of state.passageRequests){if(preserveContent&&validPassageTarget(view.target))continue;view.cancelled=true;state.passageRequests.delete(view);changed=true;}
    if(!preserveContent)setPageStatus('passage',null);else if(changed)updatePassageStatus();
    if(remove)for(const node of document.querySelectorAll('['+OWN+'="passage-translation"]')){const target=passageSources.get(node);if(!preserveContent||!target||!validPassageTarget(target))node.remove();}
  }
  async function decomposeSelection(target,x,y){
    const part=target.blocks[0],sentence=part.text.trim(),start=part.start+part.text.indexOf(sentence);
    const job={id:'g'+(++nextSentence),key:blockId(part.block)+':'+start+':'+sentence,block:part.block,start,end:start+sentence.length,sentence,sourceText:part.sourceText};
    const generation=sentenceGroups.generation,page=location.href,surface=readingScope();
    try{
      const result=await request('SENTENCE_GROUPS_BATCH',{items:[{id:job.id,sentence}],explicit:true});
      if(!sentenceGroups.enabled||generation!==sentenceGroups.generation||page!==location.href||surface!==readingScope()||!validPassageTarget(target)||!validSentenceEntry(job)){reportResult(result,'cancelled');return;}
      const item=result?.items?.[0];if(result.items.length!==1||!validSentenceGroups(item,job))throw new Error('阅读解构范围无效。');
      sentenceGroups.entries.set(job.key,{...job,groups:item.groups});reportResult(result,'ok');removeStructureCard();openStructureCard(job.key,x,y);
    }catch(error){setPageStatus('structure',error.message||'阅读解构失败。',{error:true});}
  }
  function showPassageAction(event){
    if(event.type==='keyup'&&!SELECTION_KEYS.has(event.key)&&!((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='a'))return;
    if(nodeElement(event.target)?.closest('['+OWN+'="passage-action"],['+OWN+'="passage-translation"]'))return;removeSelectionTool();if(!event.isTrusted||!state.enabled||state.paused||event.shiftKey||!inReadingSurface(event.target))return;
    const selection=getSelection();if(!selection?.rangeCount||selection.isCollapsed)return;const selected=passageTarget(selection.getRangeAt(0));if(!selected)return;
    const signature=passageSelectionSignature();
    if(signature===Kernel.dismissedSignature())return;
    const trimmed=selected.text.trim(),singleWord=selected.blocks.length===1&&/^[A-Za-z](?:[A-Za-z'’—-]*[A-Za-z])?$/.test(trimmed),passage=selected.kind==='navigation'?null:selected.blocks.length===1?passageTarget(selection.getRangeAt(0),true):null;
    const actions=selected.kind==='navigation'?[['翻译导航文字',selected]]:singleWord?(passage?[['翻译本段',passage]]:[]):[['翻译所选',selected],...(passage&&passage.text!==selected.text?[['翻译本段',passage]]:[])];if(selected.kind!=='navigation'&&sentenceGroups.enabled&&state.providerConfigured&&selected.blocks.length===1&&trimmed.length<=2000&&segments(selected.blocks[0].sourceText).some(item=>item.segment.trim()===trimmed&&item.index+item.segment.indexOf(trimmed)===selected.blocks[0].start+selected.blocks[0].text.indexOf(trimmed))&&!selected.error)actions.push(['解构所选',selected,'structure']);if(!actions.length)return;
    if(!document.getElementById('shisui-content-style'))installPageStyles();const rect=selected.range.getBoundingClientRect(),host=document.createElement('div');host.setAttribute(OWN,'passage-action');host.style.cssText='position:fixed;z-index:2147483647;display:flex;align-items:center;flex-wrap:wrap;max-width:calc(100vw - 16px);gap:var(--space-1);pointer-events:auto;box-sizing:border-box;padding:var(--space-1) var(--space-2);border:1px solid var(--line);border-radius:var(--radius-panel);background:var(--surface);box-shadow:var(--shadow-high)';const brand=createBrandLabel();brand.style.marginInlineEnd='var(--space-1)';host.append(brand);
    const clearPreview=()=>host.querySelectorAll('[data-passage-preview]').forEach(node=>node.remove());
    const preview=target=>{clearPreview();for(const part of target.blocks){const mapping=textMap(part.block);if(mapping.text!==part.sourceText)continue;for(const box of originalTextRows(part.block,mapping,part.start,part.end,sentenceClip(part.block))){const line=document.createElement('span');line.dataset.passagePreview='';line.setAttribute(OWN,'passage-preview');line.style.cssText='position:fixed;pointer-events:none;z-index:-1;box-sizing:border-box;border:1px solid color-mix(in srgb,var(--accent) 48%,transparent);border-radius:3px;background:color-mix(in srgb,var(--accent) 7%,transparent);left:'+box.left+'px;top:'+(box.top-box.height)+'px;width:'+(box.right-box.left)+'px;height:'+box.height+'px';host.append(line);}}};
    for(const [label,target,kind]of actions){const button=document.createElement('button');button.type='button';button.textContent=label;button.disabled=Boolean(target.error);button.title=target.error||'';button.style.cssText='font:var(--weight-medium) var(--type-control)/var(--leading-control) var(--sans);min-height:36px;padding:var(--space-2) var(--space-3);border:1px solid var(--line);border-radius:var(--radius-pill);background:var(--surface);color:var(--accent);cursor:'+(target.error?'not-allowed':'pointer');let hoverTimer=0;const cancelHover=()=>{clearTimeout(hoverTimer);hoverTimer=0;};const runAction=()=>{cancelHover();if(target.error)return;button.disabled=true;removeSelectionTool();Kernel.dismissSelection(signature);if(kind==='structure'){const rect=target.range.getBoundingClientRect();void decomposeSelection(target,rect.left,rect.bottom);}else void translatePassage(target);};button.onmouseenter=()=>{preview(target);if(kind!=='structure'&&passageHover())hoverTimer=setTimeout(runAction,passageDelay());};button.onfocus=()=>preview(target);button.onmouseleave=()=>{cancelHover();clearPreview();};button.onblur=()=>{cancelHover();clearPreview();};button.onclick=click=>{if(!click.isTrusted||target.error)return;runAction();};host.append(button);if(target.error){const warning=document.createElement('span');warning.setAttribute('role','status');warning.textContent=target.error;warning.style.cssText='max-width:320px;padding:var(--space-2);border-radius:var(--radius-medium);background:var(--surface);color:var(--danger,var(--accent));box-shadow:var(--shadow-high);font:var(--weight-medium) var(--type-control)/var(--leading-control) var(--sans)';host.append(warning);}}
    uiMountRoot().append(host);
    const bounds=host.getBoundingClientRect();host.style.left=Math.max(8,Math.min(rect.left,innerWidth-bounds.width-8))+'px';host.style.top=Math.max(8,Math.min(rect.bottom+6,innerHeight-bounds.height-8))+'px';state.selectionTool=host;
  }
  function mountVideoTool() {
    if(!state.videoAllowed || state.paused){globalThis.ShisuiVideoSubtitles?.unmount();return;}
    globalThis.ShisuiVideoSubtitles?.mount({settings:state.settings.video,onAssist:target=>{
      if(state.paused)return;
      if(target.text.length>600 || segments(target.text).length>3){renderHelpCard(target,LIMIT_ERROR);return;}
      return assistTarget(target);
    },onSettingsChange:async patch=>{const result=await request('VIDEO_SETTINGS_PATCH',{patch});state.settings.video=result.video;return result;}});
  }
  function emergencyText(node) {
    if(node.nodeType===Node.TEXT_NODE)return node.nodeValue;
    if(node.nodeType!==Node.ELEMENT_NODE||node.namespaceURI!=='http://www.w3.org/1999/xhtml')return '';
    if(node.matches(SKIP)||node.hasAttribute(OWN)&&!['term','annotation'].includes(node.getAttribute(OWN))||hiddenStyle(getComputedStyle(node)))return '';
    if(node.tagName==='BR')return '\n';
    return [...node.childNodes].map(emergencyText).join('');
  }
  function emergencyBlocks(root) {
    const units=[];
    function visit(parent){
      if(parent.namespaceURI!=='http://www.w3.org/1999/xhtml'||parent.matches(SKIP)||parent.hasAttribute(OWN)||!isVisible(parent)||parent.matches('img,canvas,iframe,object,embed,hr'))return;
      const layout=/^(inline-)?(grid|flex)$/.test(getComputedStyle(parent).display);let nodes=[];
      const flush=()=>{const text=nodes.map(emergencyText).join(''),threshold=parent.matches('h1,h2,h3,h4,h5,h6,td,th')?2:12;if((text.match(/[A-Za-z]/g)||[]).length>=threshold)units.push({parent,nodes,text,skipped:layout});nodes=[];};
      for(const node of parent.childNodes){
        if(node.nodeType===Node.ELEMENT_NODE){
          if(node.hasAttribute(OWN)&&!['term','annotation'].includes(node.getAttribute(OWN)))continue;
          if(node.matches(SKIP)||node.namespaceURI!==parent.namespaceURI||hiddenStyle(getComputedStyle(node))){flush();continue;}
          const display=getComputedStyle(node).display;
          if(layout||node.matches(BLOCK_SELECTOR)||!/^inline(?:$|-)/.test(display)&&display!=='contents'&&node.tagName!=='BR'){flush();visit(node);continue;}
        }
        if(node.nodeType===Node.TEXT_NODE||node.nodeType===Node.ELEMENT_NODE)nodes.push(node);
      }flush();
    }visit(root);return units;
  }
  function splitEmergencyText(text) {
    const chunks=[];let rest=text;while(rest.length>4000){const prefix=rest.slice(0,4001);let cut=0;for(const match of prefix.matchAll(/[.!?](?:["’”)]*)\s+|\n+/g))if(match.index+match[0].length<=4000)cut=match.index+match[0].length;if(cut<2000){cut=Math.max(rest.lastIndexOf(' ',4000),rest.lastIndexOf('\n',4000));if(cut<2000)cut=4000;}if(/[\uD800-\uDBFF]/.test(rest[cut-1])&&/[\uDC00-\uDFFF]/.test(rest[cut]))cut--;chunks.push(rest.slice(0,cut));rest=rest.slice(cut);}if(rest)chunks.push(rest);return chunks;
  }
  function validEmergencyUnit(unit,session){
    if(unit.invalid||state.emergency!==session||session.source!==location.href||!session.root.isConnected||!unit.parent.isConnected||!session.root.contains(unit.parent)||!isVisible(unit.parent)||unit.parent.closest(SKIP)&&!readerContent(unit.parent))return false;
    if(unit.nodes.some(node=>node.parentNode!==unit.parent))return false;
    let index=0;for(let node=unit.nodes[0];node;node=node.nextSibling){if(node.nodeType===1&&node.hasAttribute(OWN)&&!['term','annotation'].includes(node.getAttribute(OWN)))continue;if(node!==unit.nodes[index++])return false;if(index===unit.nodes.length)break;}
    return index===unit.nodes.length&&unit.nodes.map(emergencyText).join('')===unit.text;
  }
  function inheritEmergencyStyle(block,container){
      const style=getComputedStyle(block),widthSource=block.closest('table')||block;
      // Remove the old width before measuring a grid the panel itself participates in.
      container.style.width='auto';container.style.minWidth='0';container.style.maxWidth='100%';
      if(container.parentElement===widthSource.parentElement){const layoutStyle=widthSource===block?style:getComputedStyle(widthSource),display=getComputedStyle(container.parentElement).display;
        container.style.gridColumn=/^(inline-)?grid$/.test(display)?layoutStyle.gridColumn==='auto'?'1 / -1':layoutStyle.gridColumn:'';container.style.order=layoutStyle.order;
        container.style.setProperty('margin-inline-start',layoutStyle.marginInlineStart,'important');container.style.setProperty('margin-inline-end',layoutStyle.marginInlineEnd,'important');
      }
      const size=parseFloat(style.fontSize),leading=style.lineHeight==='normal'?'normal':String(parseFloat(style.lineHeight)/size),parentWidth=widthSource.parentElement?.getBoundingClientRect().width||innerWidth,width=Math.min(widthSource.getBoundingClientRect().width,parentWidth);
      for(const [name,value]of [['--ss-source-font',style.fontFamily],['--ss-source-size',style.fontSize],['--ss-source-leading',leading],['--ss-source-color',style.color]])if(container.style.getPropertyValue(name)!==value)container.style.setProperty(name,value);
      container.style.width=Math.max(0,width)+'px';
    }
  function observeEmergencyStyles(session,items){
   session.syncStyles=()=>{if(session.styleFrame||state.emergency!==session)return;session.styleFrame=requestAnimationFrame(()=>{session.styleFrame=0;if(state.emergency!==session)return;for(const [unit,entry]of session.containers)if(unit.parent.isConnected&&entry.container.isConnected)inheritPageTranslationStyle(unit.parent,entry.container);});};
   session.styleObserver=new MutationObserver(mutations=>{if(mutations.some(mutation=>!document.head?.contains(mutation.target)||nodeElement(mutation.target)?.closest('style,link[rel="stylesheet"]')||[...mutation.addedNodes,...mutation.removedNodes].some(node=>node.nodeType===1&&(node.matches('style,link[rel="stylesheet"]')||node.querySelector('style,link[rel="stylesheet"]')))))session.syncStyles();});
   const ancestors=new Set();for(const {block}of items)for(let node=block;node;node=node.parentElement)ancestors.add(node);
   for(const node of ancestors)session.styleObserver.observe(node,{attributes:true,attributeFilter:['class','style','data-theme','data-color-mode','data-color-scheme']});
   if(document.head)session.styleObserver.observe(document.head,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['href','media','disabled']});
   session.onStyleLoad=event=>{if(event.target?.matches?.('link[rel="stylesheet"]'))session.syncStyles();};document.addEventListener('load',session.onStyleLoad,true);window.addEventListener('resize',session.syncStyles);
   session.colorScheme=matchMedia('(prefers-color-scheme: dark)');session.colorScheme.addEventListener('change',session.syncStyles);
  }
  
  function removeEmergencyTranslations(root=readingScope()){root.querySelectorAll('['+OWN+'="emergency-translation"]').forEach(node=>node.remove());}
  function stopEmergencyObservers(session){
    cancelAnimationFrame(session.frame);session.frame=0;session.intersections?.disconnect();session.scrollTarget?.removeEventListener('scroll',session.onScroll,true);window.removeEventListener('resize',session.onScroll);clearTimeout(session.scanTimer);session.contentObserver?.disconnect();session.styleObserver?.disconnect();cancelAnimationFrame(session.styleFrame);window.removeEventListener('resize',session.syncStyles);document.removeEventListener('load',session.onStyleLoad,true);session.colorScheme?.removeEventListener('change',session.syncStyles);
  }
  function finishEmergency(remove=true,notify=true) {
    const session=state.emergency;if(!session){if(remove){removeEmergencyTranslations();setPageStatus('emergency',null);}return;}
    session.active=false;session.generation++;session.phase='stopped';
    for(const unit of session.units)if(unit.state==='translating')unit.state='queued';
    if(notify&&session.token)void request('EMERGENCY_END',{token:session.token}).catch(()=>{});session.token='';
    if(remove){stopEmergencyObservers(session);removeEmergencyTranslations(session.root);setPageStatus('emergency',null);state.emergency=null;if(notify)queueMicrotask(()=>{if(automatic())void rebuild();scheduleSentenceScan(0);});}
    else updateEmergencyStatus(session);
  }
  function suspendPageEmergency(){
    if(!state.emergency)return null;
    finishEmergency(false,true);const session=state.emergency;stopEmergencyObservers(session);session.near.clear();state.emergency=null;setPageStatus('emergency',null);return session;
  }
  function restorePageEmergency(session){
    if(!session)return;
    if(session.source!==location.href||!session.root.isConnected){removeEmergencyTranslations(session.root);return;}
    state.emergency=session;observeEmergencyStyles(session,session.units.map(unit=>({block:unit.parent})));observeEmergencyContent(session);updateEmergencyStatus(session);
  }
  function emergencyStatus(){
    const session=state.emergency,result={active:Boolean(session?.active),displayed:Boolean(session?.containers.size),phase:'off',total:0,completed:0,failed:0,pending:0,skipped:0};if(!session)return result;
    result.total=session.units.length;for(const unit of session.units){if(unit.state==='complete')result.completed++;else if(unit.state==='failed')result.failed++;else if(unit.state==='skipped')result.skipped++;else result.pending++;}
    result.phase=!session.active?session.phase:session.running||session.units.some(unit=>unit.state==='queued'||unit.state==='translating')?'translating':result.failed?'partial':result.pending?'waiting':'complete';if(session.error)result.error=session.error;return result;
  }
  function updateEmergencyStatus(session){
    if(state.emergency!==session)return;const value=emergencyStatus();setPageStatus('emergency','已译 '+value.completed+' / 已识别 '+value.total+' 段'+(value.failed?' · 失败 '+value.failed:'')+(value.pending?' · 待阅读 '+value.pending:'')+(value.skipped?' · 跳过 '+value.skipped:'')+(session.cacheHits?' · 缓存 '+session.cacheHits:'')+(!session.active?' · '+(session.error||'已停止'):''),{busy:value.phase==='translating',error:value.phase==='error'});
  }
  function retryEmergency(unit){
    const session=state.emergency;if(!session?.active)return status();for(const target of unit?[unit]:session.units){if(target.state!=='failed')continue;target.state='deferred';session.containers.get(target)?.error?.remove();const entry=session.containers.get(target);if(entry)entry.error=null;}void runEmergency(session);return status();
  }
  function renderEmergencyFailure(unit,session){
    // A failed chunk has no model text. Keep validated chunks and append local controls only.
    let entry=session.containers.get(unit);if(!entry){const container=document.createElement('span');container.setAttribute(OWN,'emergency-translation');container.style.display='block';unit.nodes.at(-1).after(container);entry={container,parts:new Map()};session.containers.set(unit,entry);inheritPageTranslationStyle(unit.parent,container);}
    entry.error?.remove();const error=document.createElement('span');error.style.display='block';error.setAttribute('role','status');error.setAttribute('aria-live','polite');error.append(document.createTextNode('本段未译完 '));const button=document.createElement('button');button.type='button';button.textContent='重试这一段';button.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();retryEmergency(unit);});error.addEventListener('pointerdown',event=>event.stopPropagation());error.append(button);entry.container.append(error);entry.error=error;
  }
  function inheritPageTranslationStyle(parent,container){
    const style=getComputedStyle(parent);container.style.width='auto';container.style.minWidth='0';container.style.maxWidth='100%';container.style.webkitTextFillColor='currentColor';
    for(const [name,value]of [['--ss-source-font',style.fontFamily],['--ss-source-size',style.fontSize],['--ss-source-leading','1.6'],['--ss-source-color',style.color==='rgba(0, 0, 0, 0)'?getComputedStyle(document.body).color:style.color]])container.style.setProperty(name,value);
  }
  function renderEmergencyChunk(item,translation,session) {
    const unit=item.unit;if(!validEmergencyUnit(unit,session)||unit.version!==item.version)return;
    let entry=session.containers.get(unit);
    if(!entry){const container=document.createElement('span');container.setAttribute(OWN,'emergency-translation');container.lang='zh-CN';container.setAttribute('aria-label','对应正文的中文翻译');container.style.display='block';unit.nodes.at(-1).after(container);entry={container,parts:new Map()};session.containers.set(unit,entry);inheritPageTranslationStyle(unit.parent,container);}
    const part=document.createElement('span');part.style.display='block';part.textContent=translation;entry.parts.set(item.index,part);entry.container.replaceChildren(...[...entry.parts].sort((a,b)=>a[0]-b[0]).map(([,node])=>node));
  }
  let emergencyPending=null;
  function emergencySlice(text,limit,tail=false){
    if(text.length<=limit)return text;let start=tail?text.length-limit:0,end=tail?text.length:limit;if(start&&/[\uDC00-\uDFFF]/.test(text[start]))start++;if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;return text.slice(start,end);
  }
  function emergencyTableHeaders(cell,session){
    const table=cell.closest('table');if(cell.tagName==='TH'||!table||!session.root.contains(table))return [];
    const visible=header=>header?.tagName==='TH'&&header.closest('table')===table&&!header.closest(SKIP)&&isVisible(header);
    if(cell.headers){const explicit=cell.headers.split(/\s+/).map(id=>document.getElementById(id)).filter(visible);if(explicit.length)return explicit;}
    const column=[...cell.parentElement.cells].slice(0,cell.cellIndex).reduce((sum,item)=>sum+item.colSpan,0),headers=[];
    for(const row of table.rows){let start=0;for(const candidate of row.cells){if(candidate===cell)break;const end=start+candidate.colSpan;if(visible(candidate)&&(row===cell.parentElement&&candidate.scope!=='col'||row!==cell.parentElement&&candidate.scope!=='row'&&start<=column&&column<end))headers.push(candidate);start=end;}if(row===cell.parentElement)break;}
    return headers;
  }
  function validEmergencyContext(unit,session){
    const refs=unit.contextSources;if(!refs)return true;
    const source=value=>value&&value.parent.isConnected&&isVisible(value.parent)?value.nodes.map(emergencyText).join(''):'';
    const context={title:session.title,heading:refs.heading?.isConnected&&isVisible(refs.heading)?emergencySlice(emergencyText(refs.heading),160):'',before:emergencySlice(refs.headers?refs.headers.filter(node=>node.isConnected&&isVisible(node)).map(emergencyText).join(' · '):source(refs.before),400,true),after:emergencySlice(source(refs.after),400)};
    return JSON.stringify(context)===unit.contextSignature;
  }
  function updateEmergencyContexts(session){
    const headings=[...session.root.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(node=>isVisible(node)&&(!node.closest(SKIP)||readerContent(node))&&(!node.closest('['+OWN+']')||readerContent(node))),headingTexts=new Map(headings.map(node=>[node,emergencySlice(emergencyText(node),160)]));
    let index=0,heading=null;const dependencies=new Map();const depend=(node,unit)=>{if(!node)return;if(!dependencies.has(node))dependencies.set(node,new Set());dependencies.get(node).add(unit);};
    for(const unit of session.units){while(index<headings.length&&(headings[index]===unit.parent||headings[index].compareDocumentPosition(unit.nodes[0])&Node.DOCUMENT_POSITION_FOLLOWING))heading=headings[index++];unit.section=heading;}
    for(let i=0;i<session.units.length;i++){
      const unit=session.units[i],before=session.units[i-1],after=session.units[i+1],cell=unit.parent.closest('td,th');let beforeText='',afterText='';unit.contextSources={heading:unit.section};depend(unit.section,unit);
      if(cell){const headers=emergencyTableHeaders(cell,session);unit.contextSources.headers=headers;beforeText=headers.map(header=>emergencyText(header)).join(' · ');for(const header of headers)depend(header,unit);}
      else{if(before&&before.section===unit.section&&!before.parent.closest('td,th')){beforeText=before.text;unit.contextSources.before=before;depend(before.parent,unit);}if(after&&after.section===unit.section&&!after.parent.closest('td,th')){afterText=after.text;unit.contextSources.after=after;depend(after.parent,unit);}}
      const context={title:session.title,heading:headingTexts.get(unit.section)||'',before:emergencySlice(beforeText,400,true),after:emergencySlice(afterText,400)},signature=JSON.stringify(context);
      if(unit.contextSignature!==undefined&&unit.contextSignature!==signature)invalidateEmergencyUnit(unit,session,false);unit.context=context;unit.contextSignature=signature;
    }session.contextDependencies=dependencies;
  }
  function emergencyReady(session){
    for(const unit of session.ready)if(unit.state==='queued')unit.state='deferred';
    const candidates=[];for(const parent of session.near){const rect=parent.getBoundingClientRect();if(rect.bottom < -600||rect.top>innerHeight+600)continue;const visible=rect.bottom>0&&rect.top<innerHeight,distance=visible?0:Math.max(-rect.bottom,rect.top-innerHeight,0);for(const unit of session.byParent.get(parent)||[])if(unit.state==='deferred'||unit.state==='queued')candidates.push({unit,visible,distance});}
    candidates.sort((a,b)=>Number(b.visible)-Number(a.visible)||a.distance-b.distance||a.unit.order-b.unit.order);session.ready=candidates.slice(0,16).map(({unit})=>unit);for(const unit of session.ready)unit.state='queued';return session.ready;
  }
  function scheduleEmergency(session){
    if(state.emergency!==session||session.frame)return;session.frame=requestAnimationFrame(()=>{session.frame=0;emergencyReady(session);updateEmergencyStatus(session);if(session.active)void runEmergency(session);});
  }
  function cancelEmergencyBatch(session){
    const pending=emergencyPending;if(!pending||pending.session!==session||pending.cancelled)return;pending.cancelled=true;
    for(const item of pending.batch)if(item.unit.state==='translating')item.unit.state='deferred';
    if(session.active&&session.token===pending.token)void request('EMERGENCY_CANCEL_REQUEST',{token:pending.token,through:pending.seq}).catch(()=>{});
  }
  function invalidateEmergencyUnit(unit,session,sourceChanged=true){
    unit.version=++session.version;unit.invalid=unit.invalid||sourceChanged;unit.done.clear();unit.state=unit.skipped?'skipped':'deferred';session.containers.get(unit)?.container.remove();session.containers.delete(unit);
    if(emergencyPending?.batch.some(item=>item.unit===unit))cancelEmergencyBatch(session);
  }
  async function runEmergency(session) {
    if(session.running||emergencyPending||session.dirty.size||!session.active||state.emergency!==session||document.visibilityState!=='visible')return;session.running=true;
    try{while(session.active&&state.emergency===session&&!session.dirty.size&&document.visibilityState==='visible'){
      if(!session.root.isConnected||session.source!==location.href){finishEmergency(true,true);break;}
      const batch=[];let size=0;for(const unit of emergencyReady(session)){if(!validEmergencyUnit(unit,session)||!validEmergencyContext(unit,session)){invalidateEmergencyUnit(unit,session);continue;}const index=unit.chunks.findIndex((_,index)=>!unit.done.has(index));if(index<0){unit.state='complete';continue;}const text=unit.chunks[index];if(batch.length&&(unit.chunks.length>1||size+text.length>4000))continue;batch.push({id:'e'+(++session.nextId),text,context:unit.context,unit,version:unit.version,index});size+=text.length;if(batch.length===4||unit.chunks.length>1)break;}if(!batch.length)break;
      for(const item of batch)item.unit.state='translating';const pending={session,batch,seq:++session.requestSeq,token:session.token,cancelled:false};emergencyPending=pending;updateEmergencyStatus(session);const generation=session.generation;let result;
      try{result=await request('EMERGENCY_TRANSLATE',{token:pending.token,requestSeq:pending.seq,items:batch.map(({id,text,context})=>({id,text,context}))});
        if(!session.active||state.emergency!==session||generation!==session.generation||pending.cancelled){reportResult(result,'cancelled');continue;}
        if(batch.some(item=>item.unit.version!==item.version||!validEmergencyUnit(item.unit,session)||!validEmergencyContext(item.unit,session))){cancelEmergencyBatch(session);reportResult(result,'cancelled');continue;}
        if(!result||!Array.isArray(result.items)||!Array.isArray(result.errors))throw new Error('全文翻译协议不兼容，请同时更新扩展与连接器。');
        const byId=new Map(result.items.map(item=>[item.id,item.translation])),failures=new Map(result.errors.map(item=>[item.id,item.code]));
        if(byId.size!==result.items.length||failures.size!==result.errors.length||byId.size+failures.size!==batch.length||batch.some(item=>byId.has(item.id)===failures.has(item.id)))throw new Error('全文翻译结果映射无效。');
        session.cacheHits=(session.cacheHits||0)+(result?.cacheHits||0);for(const item of batch){const unit=item.unit;if(failures.has(item.id)){unit.state='failed';renderEmergencyFailure(unit,session);continue;}renderEmergencyChunk(item,byId.get(item.id),session);unit.done.add(item.index);unit.state=unit.done.size===unit.chunks.length?'complete':'deferred';}reportResult(result,result.errors.length?'error':'ok');
      }catch(error){reportResult(result,error.code==='STALE'||error.code==='CANCELLED'?'cancelled':'error');if(session.active&&state.emergency===session&&generation===session.generation&&!pending.cancelled){finishEmergency(false,true);session.phase='error';session.error=error.message;}}
      finally{if(emergencyPending===pending)emergencyPending=null;for(const item of batch)if(item.unit.state==='translating')item.unit.state='deferred';}
    }}finally{session.running=false;updateEmergencyStatus(session);const current=state.emergency;if(current?.active&&current!==session)scheduleEmergency(current);}
  }
  function scanEmergency(session,roots=[session.root]){
    if(state.emergency!==session)return 0;if(session.source!==location.href||!session.root.isConnected){finishEmergency(true,true);return 0;}
    roots=roots.filter(root=>root.isConnected&&session.root.contains(root));roots=roots.filter((root,index)=>!roots.some((other,otherIndex)=>index!==otherIndex&&other.contains(root)));
    const previous=session.units,affected=previous.filter(unit=>!unit.parent.isConnected||roots.some(root=>root.contains(unit.parent))),next=previous.filter(unit=>!affected.includes(unit));let added=0;
    for(const root of roots)for(const descriptor of emergencyBlocks(root)){
      let unit=affected.find(value=>!value.invalid&&value.parent===descriptor.parent&&value.nodes.length===descriptor.nodes.length&&value.nodes.every((node,index)=>node===descriptor.nodes[index])&&value.text===descriptor.text&&value.skipped===descriptor.skipped);
      if(!unit){unit={...descriptor,version:++session.version,chunks:splitEmergencyText(descriptor.text),done:new Set(),state:descriptor.skipped?'skipped':'deferred'};added++;}next.push(unit);
    }
    for(const unit of affected)if(!next.includes(unit))invalidateEmergencyUnit(unit,session);
    next.sort((a,b)=>a===b?0:a.nodes[0].compareDocumentPosition(b.nodes[0])&Node.DOCUMENT_POSITION_FOLLOWING?-1:1);session.units=next;next.forEach((unit,index)=>unit.order=index);
    const byParent=new Map();for(const unit of next){if(!byParent.has(unit.parent))byParent.set(unit.parent,new Set());byParent.get(unit.parent).add(unit);}
    for(const parent of session.byParent.keys())if(!byParent.has(parent)){session.intersections?.unobserve(parent);session.near.delete(parent);}
    for(const parent of byParent.keys())if(!session.byParent.has(parent)){session.intersections?.observe(parent);const rect=parent.getBoundingClientRect();if(rect.bottom>=-600&&rect.top<=innerHeight+600)session.near.add(parent);}
    session.byParent=byParent;updateEmergencyContexts(session);emergencyReady(session);updateEmergencyStatus(session);if(session.active)void runEmergency(session);return added;
  }
  function observeEmergencyContent(session){
    session.intersections=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting)session.near.add(entry.target);else session.near.delete(entry.target);scheduleEmergency(session);},{root:state.reader?readerScroll():null,rootMargin:'600px 0px 600px 0px'});for(const parent of session.byParent.keys())session.intersections.observe(parent);
    session.onScroll=()=>scheduleEmergency(session);session.scrollTarget=state.reader?readerScroll():window;session.scrollTarget.addEventListener('scroll',session.onScroll,{passive:true,capture:true});window.addEventListener('resize',session.onScroll);
    session.contentObserver=new MutationObserver(mutations=>{
      if(!session.root.isConnected||session.source!==location.href){finishEmergency(true,true);return;}
      let changed=false;for(const mutation of mutations){let target=nodeElement(mutation.target),owned=target?.closest('['+OWN+']');if(!target||owned&&(!state.reader||owned!==globalThis.ShisuiReader.contentRoot()?.closest('[data-shisui-ui="reader"]'))||mutation.type!=='attributes'&&target.closest(SKIP)&&!readerContent(target))continue;if(mutation.type==='childList'&&[...mutation.addedNodes,...mutation.removedNodes].every(node=>nodeElement(node)?.closest('['+OWN+']')))continue;
        if(!session.root.contains(target)){if(target.contains(session.root))target=session.root;else continue;}
        while(target!==session.root&&!target.matches(BLOCK_SELECTOR)&&!session.byParent.has(target))target=target.parentElement;
        session.dirty.add(target);changed=true;
        for(const [node,units]of session.contextDependencies){const touched=mutation.type==='childList'?(node===target||node.contains(target)||[...mutation.removedNodes].some(removed=>removed===node||removed.contains?.(node))):target.contains(node)||node.contains(target);if(touched)for(const unit of units)if(!validEmergencyContext(unit,session))invalidateEmergencyUnit(unit,session,false);}
        if(mutation.type==='childList'&&mutation.addedNodes.length){for(const added of mutation.addedNodes){if(added.nodeType===1&&added.matches(SKIP)||added.nodeType===3&&!added.nodeValue.trim())continue;let before=null,after=null;for(const unit of session.units){if(unit.nodes.at(-1).compareDocumentPosition(added)&Node.DOCUMENT_POSITION_FOLLOWING)before=unit;else if(added.compareDocumentPosition(unit.nodes[0])&Node.DOCUMENT_POSITION_FOLLOWING){after=unit;break;}}for(const unit of [before,after])if(unit)invalidateEmergencyUnit(unit,session,false);}}
        for(const [parent,units]of session.byParent)if(target.contains(parent))for(const unit of units)if(!validEmergencyUnit(unit,session)||mutation.type==='childList'&&parent===target)invalidateEmergencyUnit(unit,session);
      }
      if(!changed)return;clearTimeout(session.scanTimer);session.scanTimer=setTimeout(()=>{const roots=[...session.dirty];session.dirty.clear();scanEmergency(session,roots);},120);
    });session.contentObserver.observe(session.root,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['hidden','class','style','aria-hidden']});
  }
  async function startEmergency(token,resume) {
    if(typeof token!=='string'||!token||typeof resume!=='boolean')throw new Error('本页翻译授权无效。');
    const source=location.href,surface=readingScope(),next=await request('STATE_GET');if(source!==location.href||surface!==readingScope())throw new Error('页面已变化，请重新确认。');state.settings=next.settings;state.providerConfigured=Boolean(next.providerConfigured);
    const saved=state.emergency,sameSurface=saved&&(state.reader?saved.root===surface:document.body.contains(saved.root)&&!readerContent(saved.root));if(resume&&saved&&saved.source===location.href&&sameSurface&&saved.root.isConnected){saved.token=token;saved.active=true;saved.phase='translating';saved.error='';saved.generation++;saved.requestSeq=0;for(const unit of saved.units)if(unit.state==='failed'){unit.state='queued';saved.containers.get(unit)?.error?.remove();}scanEmergency(saved);void runEmergency(saved);return {...status(),started:true};}finishEmergency(true,true);
    const root=state.reader?surface:resolveReadingRoot()?.element||document.querySelector('article')||document.querySelector('main,[role="main"]')||document.body;
    const session={token,root,title:emergencySlice(document.title,160),contextDependencies:new Map(),source:location.href,generation:0,version:0,active:true,running:false,units:[],ready:[],near:new Set(),byParent:new Map(),dirty:new Set(),requestSeq:0,nextId:0,containers:new Map(),scanTimer:0};state.emergency=session;stopSentenceGroups(false);
    state.viewportGeneration++;state.windowKey='';for(const record of state.records)record.since=0;closeCard();cancelPassageRequests(true);
    installPageStyles();const count=scanEmergency(session);if(!count){finishEmergency(true,true);throw new Error('当前页面没有可翻译的英文正文。');}
    observeEmergencyStyles(session,session.units.map(unit=>({block:unit.parent})));observeEmergencyContent(session);return {...status(),started:true,count};
  }
  function setupMutationObserver() {
    const touchesSentence=node=>{const element=nodeElement(node);if(!element||element.closest('['+OWN+']'))return false;for(const {block}of sentenceGroups.entries.values())if(block?.isConnected&&(element.contains(block)||block.contains(element)))return true;return false;};
    const originalNode=node=>{const element=nodeElement(node);if(element?.closest(SKIP))return false;const owned=element?.closest('['+OWN+']');return !owned||owned.getAttribute(OWN)==='term'||owned.getAttribute(OWN)==='annotation';};
    state.observer?.disconnect();state.observer=new MutationObserver(mutations=>{
      if(!state.enabled)return;
      if(state.page!==location.href){onPageNavigation();return;}if(state.reader&&!readerSourceIntact()){leaveReader({restorePosition:false});return;}
      for(const panel of document.querySelectorAll('['+OWN+'="passage-translation"]')){const target=passageSources.get(panel);if(target?.kind==='navigation'&&!validPassageTarget(target))panel.remove();}
      if(sentenceGroups.enabled&&mutations.some(mutation=>mutation.type==='attributes'&&touchesSentence(mutation.target))){scheduleSentenceRender();scheduleSentenceScan(180);}
      const marksChanged=mutations.some(mutation=>nodeElement(mutation.target)?.closest('.'+MARK_CLASS)||mutation.type==='childList'&&[...mutation.addedNodes,...mutation.removedNodes].some(node=>nodeElement(node)?.closest('.'+MARK_CLASS)));
      if(marksChanged)scheduleSentenceRender();
      const root=state.root||sentenceGroups.root,checked=new Map();
      const relevant=Boolean(root&&(!root.isConnected||!isVisible(root)))||mutations.some(mutation=>{
        if(mutation.type==='attributes'||!originalNode(mutation.target))return false;
        if(mutation.type==='childList'&&[...mutation.addedNodes,...mutation.removedNodes].every(node=>!originalNode(node)))return false;
        if(root?.isConnected&&!root.contains(mutation.target))return false;
        const block=nodeElement(mutation.target)?.closest(BLOCK_SELECTOR)||document.body;
        if(!block||!sourceTexts.has(block))return true;
        if(!checked.has(block)){const before=sourceTexts.get(block),after=blockText(block);sourceTexts.set(block,after);checked.set(block,before!==after);}
        return checked.get(block);
      });
      if(!relevant)return;if(sentenceGroups.enabled){scheduleSentenceRender();scheduleSentenceScan(180);}if(state.emergency)return;
      clearTimeout(state.rebuildTimer);state.rebuildTimer=setTimeout(()=>void rebuild(true),180);
    });const attributes=['class','style','hidden','href','aria-hidden','inert','data-theme','data-color-mode','data-color-scheme'];state.observer.observe(state.reader?readingScope():document,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:attributes});
  }
  async function rebuild(preserveContent=false) {
    clearTimeout(state.rebuildTimer);state.rebuildTimer=0;
    if(lookupBusy()){lookup.rebuildPending=lookup.rebuildPending===null?preserveContent:lookup.rebuildPending&&preserveContent;return;}
    const generation=preserveContent?state.generation:++state.generation,contentGeneration=++state.contentGeneration;state.viewportGeneration++;
    if(state.card&&(!preserveContent||!validTarget(state.card.target))){state.card.refreshPreparedOnClose=false;closeCard();}
    cancelPassageRequests(true,preserveContent);if(!preserveContent)state.observer?.disconnect();clearAutomatic(preserveContent);state.root=null;state.blocks=[];
    if(!state.enabled)return;
    installPageStyles();setupMutationObserver();
    try{await setupAutomatic(generation,contentGeneration);}catch{if(generation===state.generation&&contentGeneration===state.contentGeneration){state.failed=true;}}
    if(generation===state.generation&&contentGeneration===state.contentGeneration&&state.enabled&&state.card&&validTarget(state.card.target))positionCard(state.card);
  }
  function readerSourceIntact(){return state.reader?.host?.isConnected&&state.reader.sourceRoot?.isConnected&&document.body===state.reader.body&&state.reader.url===location.href&&globalThis.ShisuiReader.active()&&globalThis.ShisuiReader.contentRoot()===state.reader.article;}
  function observeReaderSource(){
    readerSourceObserver?.disconnect();readerSourceObserver=new MutationObserver(()=>{if(state.reader&&state.reader.url!==location.href)onPageNavigation();else if(state.reader&&!readerSourceIntact())leaveReader({restorePosition:false});});
    readerSourceObserver.observe(document,{childList:true,subtree:true});
  }
  function clearSurface(){
    resetLookup();stopHistoryCapture();state.generation++;state.contentGeneration++;state.viewportGeneration++;state.observer?.disconnect();state.observer=null;
    state.card&&(state.card.refreshPreparedOnClose=false);closeCard();cancelPassageRequests(true);removeStructureCard();stopSentenceGroups(false);
    sentenceGroups.root=null;sentenceGroups.entries.clear();sentenceGroups.processed.clear();sentenceGroups.failed.clear();
    clearAutomatic();state.root=null;state.blocks=[];state.article=null;state.windowKey='';
    nav.record=null;nav.flash?.remove();nav.flash=null;document.querySelectorAll('['+OWN+'="known-feedback"]').forEach(node=>node.remove());clearPageStatus();ShisuiReview.hide();getSelection()?.removeAllRanges();
  }
  async function translateReader({translate,clearTranslation,notice}){
    if(!state.reader||translate.disabled)return;
    if(state.emergency?.active){finishEmergency(false,true);translate.textContent='继续翻译';notice.textContent='已停止发送新请求，已有译文保留。';return;}
    const epoch=state.reader.epoch;translate.disabled=true;let token='';
    try{
      if(!translate.dataset.confirm){const estimate=await request('READER_TRANSLATION_ESTIMATE');if(!state.reader||state.reader.epoch!==epoch)return;notice.textContent='预计约 '+estimate.estimate+' tokens。将向当前服务发送读到附近的正文，可能产生费用。';translate.dataset.confirm='normal';translate.textContent='确认并翻译';return;}
      const begin=await request('READER_TRANSLATION_BEGIN',{confirmed:translate.dataset.confirm==='budget'});if(!state.reader||state.reader.epoch!==epoch){if(begin.token)void request('EMERGENCY_END',{token:begin.token}).catch(()=>{});return;}
      if(begin.budgetExceeded){notice.textContent='预计超出本月预算（已用约 '+begin.monthlyUsed+' + 预计 '+begin.estimate+' > 限额 '+begin.budget+' tokens）。';translate.dataset.confirm='budget';translate.textContent='仍要翻译';return;}
      token=begin.token;await startEmergency(token,Boolean(state.emergency&&!state.emergency.active));if(!state.reader||state.reader.epoch!==epoch)return;translate.dataset.confirm='';translate.textContent='停止翻译';clearTranslation.hidden=false;notice.textContent='只翻译读到附近的正文；原文保留。';
    }catch(error){if(token)void request('EMERGENCY_END',{token}).catch(()=>{});if(state.reader?.epoch===epoch){notice.textContent=error.message||'翻译失败，请重试。';translate.dataset.confirm='';translate.textContent=state.emergency?.active?'停止翻译':'翻译本页';}}
    finally{translate.disabled=false;}
  }
  function clearReaderTranslation({translate,clearTranslation,notice}){finishEmergency(true,true);translate.dataset.confirm='';translate.textContent='翻译本页';clearTranslation.hidden=true;notice.textContent='已返回原文。';}
  function leaveReader({restorePosition=true,rebuildPage=true}={}){
    ++readerEpoch;if(!state.reader&&!globalThis.ShisuiReader?.active())return;
    const suspended=state.reader?.suspendedEmergency;readerSourceObserver?.disconnect();readerSourceObserver=null;if(state.emergency?.root===state.reader?.article)finishEmergency(true,true);clearSurface();
    globalThis.ShisuiReader.unmount({restorePosition});state.reader=null;restorePageEmergency(suspended);
    if(rebuildPage&&state.enabled){void rebuild().then(()=>{if(state.enabled)void startHistoryCapture();});scheduleSentenceScan(0);}
  }
  async function setReaderEnabled(enabled){
    if(enabled&&state.reader&&readerSourceIntact())return status();
    if(state.reader&&!readerSourceIntact())leaveReader({restorePosition:false});
    const epoch=++readerEpoch;
    if(!enabled){leaveReader();return status();}
    if(!/^https?:$/.test(location.protocol))throw new Error('当前页面不支持专注阅读。');
    if(state.emergency?.root&&!state.emergency.root.isConnected)finishEmergency(true,true);
    const source=location.href,next=await request('STATE_GET');
    if(epoch!==readerEpoch||source!==location.href||!isAlive())return status();
    if(!state.emergency&&next.emergencyActive)throw new Error('请先停止这页尚未同步的翻译，再进入专注阅读。');
    const extracted=globalThis.ShisuiReader.extract({rootDocument:document,rule:siteRule(next.settings),baseURL:document.baseURI});
    if(epoch!==readerEpoch||source!==location.href||!extracted.sourceRoot.isConnected)return status();
    const suspendedEmergency=suspendPageEmergency(),priorScroll={x:scrollX,y:scrollY};clearSurface();window.scrollTo(priorScroll.x,priorScroll.y);
    try{
      const host=globalThis.ShisuiReader.mount({...extracted,onExit:()=>leaveReader(),onEscape:()=>{
        if(state.card){closeCard();return;}if(state.selectionTool){removeSelectionTool();return;}
        if(sentenceGroups.card){removeStructureCard();return;}if(ShisuiReview.dismiss())return;leaveReader();
      },onScroll:event=>onScroll(event),onTranslate:controls=>void translateReader(controls),onClearTranslation:clearReaderTranslation});
      state.reader={host,url:source,sourceRoot:extracted.sourceRoot,sourceMap:extracted.sourceMap,article:extracted.article,body:document.body,epoch,suspendedEmergency};
      state.settings=next.settings;state.siteRule=null;state.siteRuleChecked=false;state.providerConfigured=Boolean(next.providerConfigured);
      state.domainResolved=false;state.domain=next.settings.domain!=='auto'?next.settings.domain:'general';
      observeReaderSource();if(state.enabled){void rebuild().then(()=>{if(state.reader?.epoch===epoch&&state.enabled)void startHistoryCapture();});scheduleSentenceScan(0);}
      return status();
    }catch(error){readerSourceObserver?.disconnect();readerSourceObserver=null;globalThis.ShisuiReader.unmount();state.reader=null;restorePageEmergency(suspendedEmergency);
      if(state.enabled){void rebuild().then(()=>{if(state.enabled)void startHistoryCapture();});}throw error;}
  }
  async function enable(snapshot) { resetLookup(); const next=snapshot || await request('STATE_GET');if(!isAlive())return;
  resetLookup(); state.settings = next.settings;state.providerConfigured=Boolean(next.providerConfigured);state.domainResolved=false;state.domain=next.settings.domain!=='auto'?next.settings.domain:'general';state.enabled=true;state.paused=false;await rebuild();mountVideoTool();void startHistoryCapture();scheduleSentenceScan(0);return status(); }
  function disable() { leaveReader({rebuildPage:false});resetLookup(); stopHistoryCapture();state.enabled=false;state.generation++;state.viewportGeneration++;state.observer?.disconnect();clearAutomatic();closeCard();cancelPassageRequests(true);finishEmergency(true,true);stopSentenceGroups(false);globalThis.ShisuiVideoSubtitles?.unmount();document.getElementById('shisui-content-style')?.remove(); }
  async function setManualEnabled(enabled){await request('PAGE_ACTIVITY_SET',{enabled});state.paused=!enabled;if(!enabled){disable();return status();}state.manual=true;state.videoAllowed=true;return enable();}
  async function refresh() { resetLookup(); const next=await request('STATE_GET'),wasConfigured=state.providerConfigured;if(state.emergency?.active&&!next.emergencyActive)finishEmergency(true,true);resetLookup(); state.knownWords.clear(); state.settings = next.settings;state.siteRule=null;state.siteRuleChecked=false;state.providerConfigured=Boolean(next.providerConfigured);state.domainResolved=false;state.domain=next.settings.domain!=='auto'?next.settings.domain:'general';if(!state.providerConfigured||state.settings.assistanceMode==='on-demand'){stopSentenceGroups(false);sentenceGroups.status=sentenceGroups.enabled?'idle':'off';sentenceGroups.error='';updateStructureControl();}else if(!wasConfigured&&sentenceGroups.enabled){sentenceGroups.generation++;sentenceGroups.status='idle';sentenceGroups.error='';scheduleSentenceScan(0);}if(state.enabled)await rebuild();mountVideoTool();void startHistoryCapture();return status(); }
  async function applyAutomation(message){
    if(message.origin&&message.origin!==location.origin)return status();
    const page=location.href;state.paused=Boolean(message.paused);state.videoAllowed=!state.paused&&(Boolean(message.video)||state.manual);
    if(state.paused){disable();return status();}
    if(document.readyState==='loading')await new Promise(resolve=>document.addEventListener('DOMContentLoaded',resolve,{once:true}));
    if(page!==location.href)return status();
    if(message.reading&&!state.enabled)await enable();else if(!message.reading&&!state.manual&&state.enabled)disable();
    if(page!==location.href)return status();
    if(message.sentenceGroups)await restoreSentenceGroups();else if(sentenceGroups.enabled)stopSentenceGroups(true);
    if(page!==location.href)return status();
    if(state.videoAllowed){if(!state.settings.video){const snapshot=await request('STATE_GET');if(page!==location.href)return status();state.settings=snapshot.settings;}mountVideoTool();}
    scheduleSentenceRender();scheduleSentenceScan(0);return status();
  }
  function onPageNavigation() { if(state.reader)leaveReader({restorePosition:false,rebuildPage:false});resetLookup(); nav.record=null;nav.flash?.remove();nav.flash=null; if(location.href===state.page)return;const emergencyToken=state.emergency?.token;finishEmergency(true,false);if(emergencyToken)void request('EMERGENCY_END',{token:emergencyToken}).catch(()=>{});stopHistoryCapture();stopSentenceGroups(true);state.page=location.href;state.manual=false;state.domainResolved=false;state.domain=state.settings.domain!=='auto'?state.settings.domain:'general';state.failed=false;state.article=null;state.siteRule=null;state.siteRuleChecked=false;state.assisted.clear();state.seen.clear();globalThis.ShisuiVideoSubtitles?.unmount();void rebuild().then(()=>startHistoryCapture());void restoreSentenceGroups();void ShisuiReview.refresh();void request('AUTO_BOOTSTRAP_CHECK').catch(()=>{}); }
  function status(){return {enabled:state.enabled,paused:state.paused,domain:state.domain,assistanceMode:state.settings.assistanceMode,providerConfigured:state.providerConfigured,count:state.records.filter(record=>record.stage!=='quiet').length,reader:{active:Boolean(state.reader&&globalThis.ShisuiReader.active())},emergency:emergencyStatus(),sentenceGroups:{enabled:sentenceGroups.enabled,density:sentenceGroups.density,lineStyle:sentenceGroups.lineStyle,status:sentenceGroups.status,error:sentenceGroups.error,processed:sentenceGroups.entries.size}};}
  function onRuntimeMessage(message,_sender,respond){
   if(message?.type==='SS_READER_SET'){
     if(_sender?.id!==runtime.id||_sender.url!==runtime.getURL('ui/popup.html')||typeof message.enabled!=='boolean'||typeof message.pageUrl!=='string'||message.pageUrl!==location.href){respond({ok:false,error:'页面已变化，请重新打开扩展。'});return false;}
     setReaderEnabled(message.enabled).then(data=>respond({ok:true,data}),error=>respond({ok:false,error:error.message||'无法进入专注阅读。'}));return true;
   }
   if(message?.type==='SS_TRANSLATION_PROGRESS'){
     const view=[...state.passageRequests].find(item=>item.requestId===message.requestId);
     if(_sender.id===runtime.id&&view&&!view.cancelled&&!view.finished){
       if(validPassageTarget(view.target)&&view.panel.isConnected)renderPassageProgress(view,message.items);
       else{view.cancelled=true;view.panel.remove();if(state.passageRequests.delete(view))updatePassageStatus();}
     }
     respond({ok:true,data:null});return false;
   }
   if(message?.type==='SS_CONVERSATION_PROGRESS'){
     const view=state.card;
     if(_sender?.id===runtime.id&&view&&view.convoTurnId===message.turnId&&view.convoRow&&typeof message.answer==='string'&&message.answer.trim()&&message.answer.length<=1200){
       view.convoRow.querySelector('.conversation-answer').textContent=message.answer;positionCard(view);
     }
     respond({ok:true,data:null});return false;
   }
   if(message?.type==='SS_ASSIST_PROGRESS'){
     const view=state.card,fields=['definition','meaning','sentenceTranslation'];
     const limits={definition:message.level==='hint'?80:1200,meaning:message.level==='hint'?600:400,sentenceTranslation:2000};
     const validFields=fields.some(key=>typeof message[key]==='string'&&message[key].trim())&&fields.every(key=>message[key]===undefined||typeof message[key]==='string'&&message[key].length<=limits[key]);
     if(_sender?.id===runtime.id&&view&&!view.assistFinished&&message.requestId===view.requestId&&message.level===view.level&&validFields&&validTarget(view.target))showAssistProgress(view,message);
     respond({ok:true,data:null});return false;
   }
   if(message?.type==='SS_WORD_PREFERENCE'){
     if(_sender?.id!==runtime.id||typeof message.known!=='boolean'||!Array.isArray(message.wordIds)||message.wordIds.some(id=>typeof id!=='string')){respond({ok:false,error:'无效的词条偏好。'});return false;}
     applyWordPreference(message);respond({ok:true,data:status()});return false;
   }
   if(message?.type==='SS_READING_STYLE'){try{state.settings.readingStyle=globalThis.ShisuiReadingStyle.validate(message.readingStyle);if(state.enabled||state.emergency||document.getElementById('shisui-content-style'))installPageStyles();respond({ok:true,data:status()});}catch(error){respond({ok:false,error:error.message});}return false;}
   if(message?.type==='SS_HELP_LANGUAGE'){
     if(!['zh','en'].includes(message.helpLanguage)){respond({ok:false,error:'无效的解释语言。'});return false;}
     state.settings.helpLanguage=message.helpLanguage;
     if(state.card){state.card.refreshPreparedOnClose=false;closeCard();}
     clearManualRecords();
     for(const record of state.records)if(record.hint)attachRecordHint(record);
     respond({ok:true,data:status()});return false;
   }
   if(message?.type==='SS_SET_SENTENCE_DENSITY'){try{respond({ok:true,data:applySentenceDensity(message.density)});}catch(error){respond({ok:false,error:error.message});}return false;}
   if(message?.type==='SS_SET_SENTENCE_LINE_STYLE'){try{respond({ok:true,data:applySentenceLineStyle(message.lineStyle)});}catch(error){respond({ok:false,error:error.message});}return false;}
   let operation;if(message?.type==='SS_STATUS')operation=Promise.resolve(status());else if(message?.type==='SS_SET_ENABLED')operation=setManualEnabled(message.enabled);else if(message?.type==='SS_SET_SENTENCE_GROUPS')operation=setSentenceGroups(message.enabled);else if(message?.type==='SS_AUTO_START')operation=applyAutomation(message);else if(message?.type==='SS_REFRESH')operation=refresh();else if(message?.type==='SS_COPY_PARAGRAPH')operation=ShisuiCopy.copyParagraph();else if(message?.type==='SS_CONTEXT_HELP')operation=contextHelp(message.selectionText);else if(message?.type==='SS_NAV_LINK_TRANSLATE')operation=translateContextLink(message.linkUrl);else if(message?.type==='SS_EMERGENCY_COUNT')operation=Promise.resolve().then(()=>{const root=state.reader?readingScope():resolveReadingRoot()?.element||document.querySelector('article')||document.querySelector('main,[role="main"]')||document.body;return {ok:true,chars:emergencyBlocks(root).filter(unit=>!unit.skipped).reduce((sum,unit)=>sum+unit.text.length,0)};});else if(message?.type==='SS_EMERGENCY_START')operation=Promise.resolve().then(()=>startEmergency(message.token,message.resume));else if(message?.type==='SS_EMERGENCY_RETRY')operation=Promise.resolve().then(()=>retryEmergency());else if(message?.type==='SS_EMERGENCY_STOP')operation=Promise.resolve().then(()=>{finishEmergency(false,true);return status();});else if(message?.type==='SS_EMERGENCY_END')operation=Promise.resolve().then(()=>{if(!message.navigation||state.emergency?.source!==message.url)finishEmergency(true,true);return status();});else if(message?.type==='SS_VIDEO_SETTINGS'){state.settings.video=message.video;mountVideoTool();operation=Promise.resolve(status());}else return false;
   operation.then(data=>respond({ok:true,data}),error=>respond({ok:false,error:error.message||'页面辅助失败。'}));return true;
  }
  function onVisibilityChange(){
    if(state.page!==location.href){onPageNavigation();return;}if(state.reader&&!readerSourceIntact()){leaveReader({restorePosition:false});return;}
    if(document.visibilityState!=='visible')resetLookup();
    state.records.forEach(record=>{record.since=0;record.historySince=0;});
    if(document.visibilityState!=='visible')stopSentenceGroups(false);
    if(document.visibilityState==='visible'&&state.enabled&&!capture.session)void startHistoryCapture();
    if(document.visibilityState==='visible'){if(state.emergency?.active)scheduleEmergency(state.emergency);state.windowKey='';if(automatic()&&!state.root)void rebuild();else void refreshViewport();scheduleSentenceRender();scheduleSentenceScan(0);void ShisuiReview.refresh();}
  }
  function dispose(){if(disposed)return;disable();stopSentenceGroups(true);ShisuiReview.hide();disposed=true;clearTimeout(lookup.idleTimer);for(const resolve of lookup.waiters)resolve();lookup.waiters.clear();clearPageStatus();runtime.onMessage.removeListener(onRuntimeMessage);for(const [target,type,listener]of listeners)target.removeEventListener(type,listener,true);clearTimeout(state.scrollTimer);}
  const listeners=[[window,'keydown',onLookupKey],[window,'keyup',onLookupKey],[window,'keydown',onNavKey],[window,'pointerdown',onHelpPointerDown],[window,'pointerup',onHelpPointerUp],[window,'click',onHelpClick],[window,'pointermove',onLookupPointerMove],[window,'blur',onLookupBlur],[window,'focusin',onLookupFocus],[window,'compositionstart',resetLookup],[window,'pointercancel',onLookupCancel],[document,'pointerleave',onLookupLeave],[matchMedia('(prefers-color-scheme: dark)'),'change',onScroll],[document,'pointerdown',historyInteraction],[document,'keydown',historyInteraction],[window,'scroll',historyInteraction],[document,'pointerdown',onOutside],[document,'pointerup',showPassageAction],[document,'keyup',showPassageAction],[document,'keydown',onKey],[window,'pointermove',ShisuiCopy.onPointerTrack],[document,'contextmenu',onContextMenu],[document,'visibilitychange',onVisibilityChange],[document,'scroll',onScroll],[window,'scroll',onScroll],[window,'resize',onScroll],[window,'popstate',onPageNavigation],[window,'hashchange',onPageNavigation]];
  listeners.push([document,'click',onStructureClick],[document.fonts,'loadingdone',scheduleSentenceRender]);
  listeners.forEach(([target,type,listener])=>target.addEventListener(type,listener,true));
  // 子系统经内核钩子回调 content.js 的实现；注册发生在监听之前，模块只在运行时调用。
  Kernel.register({request,setPageStatus,positionCard,consumeLookup,clearLookupPreview,status,passageTarget,translatePassage,enable,inViewport});
  runtime.onMessage.addListener(onRuntimeMessage);window.__SHISUI_CONTENT__={isAlive,dispose};void restoreSentenceGroups();
})();
