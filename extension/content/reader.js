(() => {
  'use strict';
  if (globalThis.ShisuiReader) return;
  const OWN = 'data-shisui-ui';
  const prose = 'p,blockquote,dd';
  const allowed = new Set('h1 h2 h3 h4 h5 h6 p div section blockquote ul ol li dl dt dd strong em b i u s sub sup br hr pre code kbd samp figure figcaption table caption thead tbody tfoot tr th td a img'.split(' '));
  const excluded = 'script,style,link,meta,base,noscript,template,iframe,object,embed,form,input,textarea,button,select,option,nav,menu,aside,footer,[role="navigation"],[role="complementary"],[role="contentinfo"],[role="menu"],[role="toolbar"],[hidden],[inert],[aria-hidden="true"]';
  const failure = () => new Error('无法可靠识别这页的正文，请在原网页继续阅读。');
  const tooLong = () => new Error('正文过长，暂不能进入专注阅读。');
  let view = null;
  const visible = element => globalThis.ShisuiContent?.isVisible(element) ?? Boolean(element.getClientRects().length);
  function skip(element, rule) {
    if (element.matches(excluded) || !visible(element)) return true;
    if (element.hasAttribute(OWN) && !['term','annotation'].includes(element.getAttribute(OWN))) return true;
    if (rule?.exclude?.length) { try { if (element.matches(rule.exclude.join(','))) return true; } catch {} }
    return false;
  }
  function extract({rootDocument = document, rule = null, baseURL = rootDocument.baseURI} = {}) {
    const root = rootDocument.body;
    if (!root) throw failure();
    let visited = 0, chars = 0;
    const filtered = new WeakMap();
    // One bounded walk supplies both candidate evidence and the eventual renderer.
    if (root.querySelectorAll('*').length > 50000) throw tooLong();
    function describe(element) {
      if (++visited > 50000) throw tooLong();
      if (skip(element,rule)) return {letters:0,links:0,blocks:0};
      let letters = 0, links = 0, blocks = 0;
      for (const child of element.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          if (++visited > 50000) throw tooLong();
          const value = child.nodeValue || ''; chars += value.length;
          if (chars > 500000) throw tooLong();
          const count = value.match(/[\p{L}\p{N}]/gu)?.length || 0;
          letters += count;
          if (element.closest('a')) links += count;
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const result = describe(child); letters += result.letters; links += result.links; blocks += result.blocks;
        }
      }
      if (element.matches(prose)) blocks = 1;
      const result = {letters,links,blocks}; filtered.set(element,result); return result;
    }
    describe(root);
    const score = element => {
      if (!element || element === root || element === rootDocument.documentElement || !filtered.has(element) || !visible(element)) return null;
      const data = filtered.get(element), letters = data.letters;
      if (data.blocks < 2 || letters < 200 || data.links / letters >= .35) return null;
      return {element,letters};
    };
    function choose(elements) {
      const candidates = elements.map(score).filter(Boolean).sort((a,b) => b.letters-a.letters || a.element.contains(b.element)-b.element.contains(a.element));
      const first = candidates[0]; if (!first) return null;
      for (const other of candidates.slice(1)) if (!first.element.contains(other.element) && !other.element.contains(first.element) && other.letters >= first.letters*.8) throw failure();
      return first;
    }
    let selected = null;
    if (rule?.root) { try { selected = score(rootDocument.querySelector(rule.root)); } catch {} }
    if (!selected) {
      const articles = choose([...rootDocument.querySelectorAll('article')]);
      const mains = choose([...rootDocument.querySelectorAll('main,[role="main"]')]);
      if (articles && mains && mains.element.contains(articles.element) && articles.letters >= mains.letters/2) selected = articles;
      else selected = choose([articles?.element,mains?.element].filter(Boolean));
      if (!selected) {
        const ancestors = new Set();
        for (const block of rootDocument.querySelectorAll(prose)) {
          if (!filtered.has(block)) continue;
          let parent = block.parentElement;
          for (let level = 0; parent && parent !== root && level < 3; level++,parent=parent.parentElement) ancestors.add(parent);
        }
        selected = choose([...ancestors]);
      }
    }
    if (!selected) throw failure();
    const article = rootDocument.createElement('article'), sourceMap = new WeakMap(), anchorIds = new Map(), renderedIds = new Set(), pendingAnchors = [];
    let serial = 0, outputNodes = 0, outputChars = 0;
    const source = selected.element;
    for (const element of source.querySelectorAll('[id]')) if (element.id.length <= 256 && !anchorIds.has(element.id)) anchorIds.set(element.id,'shisui-reader-anchor-'+(++serial));
    function render(node, destination) {
      if (++outputNodes > 50000) throw tooLong();
      if (node.nodeType === Node.TEXT_NODE) {
        outputChars += node.nodeValue.length; if (outputChars > 500000) throw tooLong();
        destination.append(rootDocument.createTextNode(node.nodeValue)); return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE || skip(node,rule)) return;
      const kind = node.localName, owner = node.getAttribute(OWN);
      if (owner === 'hint' || owner === 'known-action') return;
      if (owner === 'term' || owner === 'annotation') { for (const child of node.childNodes) render(child,destination); return; }
      if (kind === 'svg' || kind === 'canvas' || kind === 'video' || kind === 'audio') {
        const note = rootDocument.createElement('a');note.href=rootDocument.location.href;note.rel='noopener noreferrer';note.textContent=(kind === 'svg' || kind === 'canvas' ? (node.getAttribute('aria-label') || node.getAttribute('title') || '此内容').slice(0,300) : '媒体')+' · 请在原网页查看';destination.append(note);return;
      }
      let href = null, fragment = null, fallbackHref = null;
      if (kind === 'a') { try { const raw=node.getAttribute('href') || '';if(raw.length>4096)throw new Error('long URL');fragment=raw.startsWith('#')?decodeURIComponent(raw.slice(1)):null;const url=new URL(raw,baseURL);fallbackHref=['http:','https:','mailto:'].includes(url.protocol)?url.href:null;if (fragment !== null && anchorIds.has(fragment)) href='#'+anchorIds.get(fragment);else if (['http:','https:','mailto:'].includes(url.protocol)) href=url.href; } catch {} }
      const tag = allowed.has(kind) && (kind !== 'a' || href) ? kind : 'span';
      if (kind === 'img') {
        const note=()=>{const fallback=rootDocument.createElement('span');fallback.textContent=(node.alt ? node.alt.slice(0,300)+' · ' : '')+'图片请在原网页查看';destination.append(fallback);};
        if (!node.complete || node.naturalWidth <= 0) {note();return;}
        try { if(node.currentSrc.length>4096)throw new Error('long URL');const url=new URL(node.currentSrc,baseURL); if (!['http:','https:'].includes(url.protocol)) {note();return;} } catch {note();return;}
      }
      const result=rootDocument.createElement(tag);sourceMap.set(result,node);
      if (node.id && anchorIds.has(node.id)) {result.id=anchorIds.get(node.id);renderedIds.add(result.id);}
      if (['ltr','rtl','auto'].includes(node.dir)) result.dir=node.dir;
      for (const name of ['colspan','rowspan','start']) { const value=Number(node.getAttribute(name));if (Number.isInteger(value) && value>0 && value<=1000 && node.hasAttribute(name)) result.setAttribute(name,String(value)); }
      if (node.hasAttribute('title')) result.title=node.title.slice(0,300);
      if (tag === 'a') {result.href=href;result.rel='noopener noreferrer';if(fragment!==null&&anchorIds.has(fragment))pendingAnchors.push({link:result,id:anchorIds.get(fragment),href:fallbackHref});}
      if (tag === 'img') {
        result.src=node.currentSrc;result.alt=(node.alt || '').slice(0,300);result.referrerPolicy='no-referrer';
        result.addEventListener('error',()=>{const note=rootDocument.createElement('span');note.textContent=(result.alt ? result.alt+' · ' : '')+'图片请在原网页查看';result.replaceWith(note);},{once:true});
      }
      destination.append(result);
      if (kind !== 'img') for (const child of node.childNodes) render(child,result);
    }
    if (!source.querySelector('h1') && rootDocument.title) {const heading=rootDocument.createElement('h1');heading.textContent=rootDocument.title.slice(0,300);article.append(heading);}
    render(source,article);
    for (const {link,id,href} of pendingAnchors) if (!renderedIds.has(id)) {if(href)link.href=href;else link.removeAttribute('href');}
    return {article,sourceRoot:source,sourceMap};
  }
  function mount({article,sourceRoot,sourceMap,onExit=()=>{},onEscape=onExit,onScroll=()=>{},onTranslate=()=>{},onClearTranslation=()=>{}}) {
    if (view) return view.host;
    if (!HTMLElement.prototype.showPopover) throw new Error('当前浏览器暂不支持专注阅读，请升级浏览器。');
    const doc=article.ownerDocument, host=doc.createElement('div');host.setAttribute(OWN,'reader');host.setAttribute('popover','manual');host.setAttribute('role','dialog');host.setAttribute('aria-modal','true');host.setAttribute('aria-label','专注阅读');
    const style=doc.createElement('style'), selector='[data-shisui-ui="reader"]';
    style.textContent=globalThis.ShisuiDesign.cssFor(selector)+`${selector}{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;margin:0!important;padding:0!important;border:0!important;box-sizing:border-box!important;background:var(--surface)!important;color:var(--ink)!important;font-family:var(--sans)!important;z-index:2147483647!important;display:flex!important;flex-direction:column!important;overflow:hidden!important} ${selector} *{box-sizing:border-box} ${selector} [hidden]{display:none!important} ${selector} button,${selector} select{font:inherit!important;color:inherit!important;background:var(--surface)!important;border:1px solid var(--line)!important;border-radius:6px!important;padding:6px 10px!important;cursor:pointer!important} ${selector} button:focus-visible,${selector} select:focus-visible,${selector} a:focus-visible{outline:var(--focus-ring)!important;outline-offset:2px} ${selector} .reader-toolbar{display:flex!important;flex-wrap:wrap!important;align-items:center!important;gap:8px!important;padding:12px 24px!important;border-bottom:1px solid var(--line)!important;flex:none!important;font-size:14px!important} ${selector} .reader-scroll{overflow:auto!important;overscroll-behavior:contain!important;flex:1!important;padding:40px 24px 80px!important} ${selector} article{display:block!important;width:100%!important;max-width:var(--reader-width,72ch)!important;margin:0 auto!important;font-size:var(--reader-size,20px)!important;line-height:var(--reader-leading,1.8)!important;overflow-wrap:anywhere!important;color:inherit!important;background:none!important} ${selector} article *{max-width:100%!important;color:inherit!important;background-color:transparent!important;font-family:inherit!important;line-height:inherit!important} ${selector} article h1,${selector} article h2,${selector} article h3{line-height:1.3!important} ${selector} article img{max-width:100%!important;height:auto!important} ${selector} article pre,${selector} article table{display:block!important;overflow-x:auto!important;max-width:100%!important} ${selector} article pre,${selector} article code{font-family:var(--mono)!important;white-space:pre-wrap} ${selector} article table{border-collapse:collapse} ${selector} article td,${selector} article th{border:1px solid var(--line)!important;padding:8px!important} ${selector} .reader-overlay{position:absolute!important;inset:0!important;pointer-events:none!important} ${selector} .reader-overlay>*{pointer-events:auto!important}@media(max-width:600px){${selector} .reader-toolbar{padding:8px 16px!important}${selector} .reader-scroll{padding:24px 16px 64px!important}}`;
    style.textContent+=`${selector} article :where(p,blockquote,li,dd,dt,figcaption){font-size:inherit!important;font-weight:400!important;letter-spacing:normal!important;text-transform:none!important;margin:0 0 1em!important} ${selector} article :where(h1,h2,h3,h4,h5,h6){font-family:var(--sans)!important;font-weight:600!important;letter-spacing:normal!important;text-transform:none!important;margin:1.5em 0 .6em!important} ${selector} article h1{font-size:1.55em!important;margin-top:0!important} ${selector} article h2{font-size:1.25em!important} ${selector} article a{color:var(--accent)!important;text-decoration:underline!important}`;
    style.textContent+=`${selector} article :where(*):not([data-shisui-ui]){position:static!important;visibility:visible!important;display:revert!important} ${selector} article [data-shisui-ui="known-action"]{display:inline-flex!important;align-items:center!important;justify-content:center!important;left:0!important;top:0!important;transform:translateY(calc(-100% - 2px))!important;min-height:28px!important;padding:3px 9px!important;border:1px solid var(--teal-line)!important;border-radius:var(--radius-pill)!important;background:var(--surface)!important;color:var(--teal)!important;font:var(--weight-medium) var(--type-support)/var(--leading-support) var(--sans)!important;white-space:nowrap!important}${selector} article [data-shisui-ui="known-action"]:hover{background:var(--teal-soft)!important}`;
    style.textContent+=`${selector} article{font-family:var(--sans)!important;font-weight:400!important;letter-spacing:normal!important}`;
    const toolbar=doc.createElement('div');toolbar.className='reader-toolbar';toolbar.setAttribute('role','toolbar');toolbar.setAttribute('aria-label','专注阅读设置');
    const exit=doc.createElement('button');exit.type='button';exit.textContent='退出专注阅读';exit.addEventListener('click',onExit);
    const origin=doc.createElement('span');origin.textContent=location.hostname+' · 当前正文快照';toolbar.append(exit,origin);
    const translate=doc.createElement('button');translate.type='button';translate.textContent='翻译本页';
    const clearTranslation=doc.createElement('button');clearTranslation.type='button';clearTranslation.textContent='返回原文';clearTranslation.hidden=true;clearTranslation.addEventListener('click',()=>onClearTranslation({translate,clearTranslation,notice}));
    const notice=doc.createElement('span');notice.setAttribute('role','status');notice.style.maxWidth='32ch';translate.addEventListener('click',()=>onTranslate({translate,clearTranslation,notice}));toolbar.append(translate,clearTranslation,notice);
    for (const [label,values,property,unit] of [['字号',[18,20,22,24],'--reader-size','px'],['栏宽',[60,72,84],'--reader-width','ch'],['行距',[1.6,1.8,2],'--reader-leading','']]) {const select=doc.createElement('select');select.setAttribute('aria-label',label);for (const value of values){const option=doc.createElement('option');option.value=String(value);option.textContent=label+' '+value+unit;if(value===values[1])option.selected=true;select.append(option);}select.addEventListener('change',()=>{host.style.setProperty(property,select.value+unit);onScroll();});toolbar.append(select);}
    const theme=doc.createElement('select');theme.setAttribute('aria-label','主题');for(const [value,label] of [['auto','跟随系统'],['light','浅色'],['dark','深色']]){const option=doc.createElement('option');option.value=value;option.textContent=label;theme.append(option);}theme.addEventListener('change',()=>{style.textContent=style.textContent.replace(/^.*?(?=\[data-shisui-ui="reader"\]\{position)/s,globalThis.ShisuiDesign.cssFor(selector,theme.value));});toolbar.append(theme);
    const scroll=doc.createElement('div');scroll.className='reader-scroll';scroll.append(article);scroll.addEventListener('scroll',onScroll,{passive:true});article.addEventListener('load',onScroll,true);const overlay=doc.createElement('div');overlay.className='reader-overlay';host.append(style,toolbar,scroll,overlay);
    const previous={x:window.scrollX,y:window.scrollY,focus:doc.activeElement,body:doc.body,html:doc.documentElement,bodyOverflow:doc.body.style.getPropertyValue('overflow'),bodyPriority:doc.body.style.getPropertyPriority('overflow'),htmlOverflow:doc.documentElement.style.getPropertyValue('overflow'),htmlPriority:doc.documentElement.style.getPropertyPriority('overflow'),inert:new Map()};
    const inertSibling=node=>{if(node!==host && node.nodeType===Node.ELEMENT_NODE && !previous.inert.has(node)){previous.inert.set(node,node.inert);node.inert=true;}};
    let observer;
    try {
      doc.body.append(host);host.showPopover();
      for(const child of doc.body.children)inertSibling(child);
      observer=new MutationObserver(mutations=>{for(const mutation of mutations)for(const node of mutation.addedNodes)if(node.parentElement===doc.body)inertSibling(node);});observer.observe(doc.body,{childList:true});
      doc.body.style.setProperty('overflow','hidden','important');doc.documentElement.style.setProperty('overflow','hidden','important');
      view={host,article,sourceRoot,sourceMap,scroll,overlay,previous,observer};exit.focus();host.addEventListener('toggle',event=>{if(event.newState==='closed'&&view?.host===host)onExit();});
      host.addEventListener('keydown',event=>{if(event.key==='Escape'){if(event.target.closest('['+OWN+'="task-status"]'))return;event.preventDefault();event.stopPropagation();onEscape();}else if(event.key==='Tab'){const items=[...host.querySelectorAll('button:not([disabled]),select:not([disabled]),a[href]')].filter(item=>item.getClientRects().length);const index=items.indexOf(doc.activeElement);if(event.shiftKey&&index<=0){event.preventDefault();items.at(-1)?.focus();}else if(!event.shiftKey&&index===items.length-1){event.preventDefault();items[0]?.focus();}}},true);
      return host;
    } catch(error) { observer?.disconnect();host.remove();for(const [node,original] of previous.inert)if(node.inert)node.inert=original;doc.body.style.setProperty('overflow',previous.bodyOverflow,previous.bodyPriority);doc.documentElement.style.setProperty('overflow',previous.htmlOverflow,previous.htmlPriority);throw error; }
  }
  function unmount({restorePosition=true}={}) {
    if (!view) return;
    const {host,previous,observer}=view;view=null;observer.disconnect();if(host.matches(':popover-open'))host.hidePopover();host.remove();
    for(const [node,original] of previous.inert)if(node.inert)node.inert=original;
    if(previous.body.style.getPropertyValue('overflow')==='hidden'&&previous.body.style.getPropertyPriority('overflow')==='important')previous.body.style.setProperty('overflow',previous.bodyOverflow,previous.bodyPriority);
    if(previous.html.style.getPropertyValue('overflow')==='hidden'&&previous.html.style.getPropertyPriority('overflow')==='important')previous.html.style.setProperty('overflow',previous.htmlOverflow,previous.htmlPriority);
    document.getSelection()?.removeAllRanges();
    if(restorePosition){window.scrollTo(previous.x,previous.y);if(previous.focus?.isConnected)previous.focus.focus({preventScroll:true});else previous.body.focus?.({preventScroll:true});}
  }
  globalThis.ShisuiReader=Object.freeze({extract,mount,unmount,contains:node=>Boolean(view?.host.contains(node)),contentRoot:()=>view?.article||null,overlayRoot:()=>view?.overlay||null,scrollRoot:()=>view?.scroll||null,active:()=>Boolean(view?.host.isConnected)});
})();
