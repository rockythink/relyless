/**
 * @file content/kernel.js
 * 内容脚本共享内核：状态、常量与纯工具。
 * 从 content.js 原样搬出的部分不做行为改动；子系统（复制、会话卡、划词卫生）通过内核通信，
 * 由 content.js 在启动时注册 passageTarget / translatePassage / enable 等钩子。
 */
(() => {
  'use strict';
  if (globalThis.ShisuiContent) return;

  const OWN = 'data-shisui-ui';
  const MARK_CLASS = 'shisui-term-mark', HINT_CLASS = 'shisui-term-hint';
  const BLOCK_SELECTOR = 'p,li,blockquote,dd,dt,figcaption,h1,h2,h3,h4,h5,h6,td,th,article,section,main,div';
  const EDITABLE = '[contenteditable]:not([contenteditable="false"]),[role="textbox"]';
  const SKIP = `pre,video,audio,.html5-video-player,input,textarea,button,nav,menu,aside,form,body>header,footer,[role="complementary"],[role="banner"],[role="contentinfo"],script,style,noscript,template,select,option,dialog,[role="navigation"],[role="menu"],[role="toolbar"],[role="dialog"],[aria-hidden="true"],[hidden],[inert],${EDITABLE}`;
  const LOOKUP_CONTROLS = 'input,textarea,select,button,[role="button"],[role="combobox"],[role="searchbox"],[role="spinbox"],[role="slider"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="option"],' + EDITABLE;
  const LOOKUP_UI = '[' + OWN + ']:not([' + OWN + '="term"]):not([' + OWN + '="hint"]):not([' + OWN + '="annotation"])';

  const state = {
    enabled: false, automaticReady: false, manual: false, paused: false, videoAllowed: false,
    settings: {assistanceMode: 'ambient', rememberSupport: true, helpLanguage: 'zh', domain: 'auto', hintDisplay: 'direct'},
    providerConfigured: false, domain: 'general', domainResolved: false, generation: 0, contentGeneration: 0,
    viewportGeneration: 0, page: location.href, root: null, blocks: [], records: [], processed: new Set(),
    assisted: new Set(), seen: new Set(), card: null, assistRequestId: '', selectionTool: null,
    passageRequests: new Set(), knownWords: new Set(), knownBlocks: new Map(), observer: null, intersections: null,
    scrollTimer: 0, rebuildTimer: 0, opportunityTimer: 0,
    startedAt: Date.now(),
    failed: false, windowKey: '', policyKey: '', refreshing: 0, article: null, emergency: null,
    siteRule: null, siteRuleChecked: false, reader: null,
  };

  const blockIds = new WeakMap();
  let nextBlock = 0;
  let dismissedSelection = '';

  const hooks = {};
  // content.js 启动时注入依赖它的实现，避免内核反向依赖子系统。
  const register = injected => Object.assign(hooks, injected);

  const normalizeText = text => (text || '').replace(/\s+/g, ' ').trim();
  const nodeElement = node => node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  const blockId = block => { if (!blockIds.has(block)) blockIds.set(block, ++nextBlock); return blockIds.get(block); };
  const readerContentRoot = () => state.reader && globalThis.ShisuiReader?.active() ? globalThis.ShisuiReader.contentRoot() : null;
  const readingScope = () => readerContentRoot() || document.body;
  const uiMountRoot = () => readerContentRoot() ? globalThis.ShisuiReader.overlayRoot() : document.body;
  const isReaderContent = node => { const root = readerContentRoot(); return Boolean(root && node && (node === root || root.contains(node))); };
  const inReadingSurface = node => Boolean(node && (!state.reader || isReaderContent(node)));
  function hiddenStyle(style) { return style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.contentVisibility === 'hidden' || Number(style.opacity) === 0 || style.clip === 'rect(0px, 0px, 0px, 0px)' || style.clipPath === 'inset(50%)' || style.overflow === 'hidden' && parseFloat(style.width) <= 1 && parseFloat(style.height) <= 1; }
  function isVisible(element) {
    if (!element?.isConnected || !element.getClientRects().length) return false;
    for (let parent = element; parent; parent = parent.parentElement) if (hiddenStyle(getComputedStyle(parent))) return false;
    return true;
  }
  // The original text nodes remain authoritative. Inline emphasis and links are never rebuilt.
  function textMap(block) {
    const nodes = []; let text = '';
    const excluded = BLOCK_SELECTOR + ',' + SKIP + ',[' + OWN + '="card"],[' + OWN + '="video"],[' + OWN + '="emergency"],[' + OWN + '="emergency-translation"],[' + OWN + '="passage-action"],[' + OWN + '="passage-translation"],.' + HINT_CLASS;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) return node.matches(excluded) || hiddenStyle(getComputedStyle(node)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
      return node.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }});
    let node; while ((node = walker.nextNode())) { nodes.push({node, start: text.length, end: text.length + node.nodeValue.length}); text += node.nodeValue; }
    return {text, nodes};
  }
  const blockText = block => textMap(block).text;
  async function sha256(text) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
  }
  function lookupEditing(event) {
    if (document.designMode === 'on') return true;
    const inContent = isReaderContent(event.target);
    const pathEditing = event.composedPath().some(node => node?.nodeType === Node.ELEMENT_NODE &&
      (node.isContentEditable || node.matches(LOOKUP_CONTROLS) ||
        node.matches(LOOKUP_UI) && !(inContent && globalThis.ShisuiReader?.contains(node))));
    const active = document.activeElement;
    return pathEditing || !inContent && Boolean(active?.matches(LOOKUP_CONTROLS) ||
      active?.matches(LOOKUP_UI) && !isReaderContent(active) ||
      active?.localName.includes('-') && !isReaderContent(active));
  }
  // 供测试替换的取点/取选区接缝：默认走真实 DOM。
  const pointElement = point => document.elementFromPoint(point.clientX, point.clientY);
  const currentSelection = () => document.getSelection();
  // 选区签名只用于识别“同一个选区再次出现”，不做稳定性校验；任何新选区都会得到不同签名从而解除屏蔽。
  function selectionSignature(selection = currentSelection()) {
    if (!selection?.rangeCount || selection.isCollapsed) return '';
    const range = selection.getRangeAt(0), block = nodeElement(range.startContainer)?.closest(BLOCK_SELECTOR);
    return block ? blockId(block) + ':' + normalizeText(range.toString()).slice(0, 160) : '';
  }
  const dismissSelection = signature => { dismissedSelection = signature; };
  const dismissedSignature = () => dismissedSelection;

  globalThis.ShisuiContent = {
    OWN, MARK_CLASS, HINT_CLASS, BLOCK_SELECTOR, SKIP, LOOKUP_CONTROLS, LOOKUP_UI,
    state, register, hooks,
    normalizeText, nodeElement, readingScope, uiMountRoot, inReadingSurface, isReaderContent,
    blockId, hiddenStyle, isVisible, textMap, blockText, sha256, lookupEditing,
    pointElement, currentSelection, selectionSignature, dismissSelection, dismissedSignature,
  };
})();
