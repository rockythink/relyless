/**
 * @file content/review.js
 * 间隔重复复习入口：把本机计划里到期的词在页面角落形成一个“复习 N”浮钮，
 * 打开后逐个呈现，认识 / 不认识两个动作直接写回计划。只使用本机记录，不发送页面内容。
 */
(() => {
  'use strict';
  const kernel = globalThis.ShisuiContent;
  if (!kernel || globalThis.ShisuiReview) return;
  const state = kernel.state;
  let button = null, panel = null, panelShadow = null, due = [];

  function hide() {
    button?.remove(); button = null;
    panel?.remove(); panel = null; panelShadow = null;
    due = [];
  }

  async function refresh() {
    if (button && button.parentNode !== kernel.uiMountRoot() || panel && panel.parentNode !== kernel.uiMountRoot()) hide();
    if (!state.enabled || state.paused || document.visibilityState !== 'visible') { if (!panel) hide(); return; }
    const scope = kernel.readingScope(), generation = state.generation;
    const entries = [];
    const seen = new Set();
    for (const record of state.records) {
      const target = record.target;
      if (!target?.wordId || !target?.senseKey || !target.text) continue;
      if (!kernel.hooks.inViewport?.(record.block)) continue;
      const key = target.wordId + '#' + target.senseKey;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({wordId: target.wordId, senseKey: target.senseKey, text: target.text.slice(0, 100), domain: typeof target.domain === 'string' ? target.domain.slice(0, 32) : 'general'});
      if (entries.length >= 40) break;
    }
    if (!entries.length) { if (!panel) hide(); return; }
    let result;
    try { result = await kernel.hooks.request('REVIEW_DUE', {entries}); } catch { return; }
    if (!state.enabled || state.paused || scope !== kernel.readingScope() || generation !== state.generation) return;
    due = Array.isArray(result?.due) ? result.due : [];
    if (!due.length && !panel) { button?.remove(); button = null; return; }
    if (!button && due.length) mountButton();
    if (button) button.textContent = '复习 ' + due.length;
    if (panel) renderPanel();
  }

  function mountButton() {
    button = document.createElement('button');
    button.type = 'button';
    button.setAttribute(kernel.OWN, 'review-button');
    button.textContent = '复习';
    button.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483646;min-height:36px;padding:8px 16px;border:1px solid var(--accent);border-radius:999px;background:var(--surface);color:var(--accent);font:var(--weight-medium) var(--type-control)/var(--leading-control) var(--sans);cursor:pointer;box-shadow:var(--shadow-high)';
    button.addEventListener('click', () => (panel ? closePanel() : openPanel()));
    kernel.uiMountRoot().append(button);
  }

  function openPanel() {
    if (panel || !due.length) return;
    const host = document.createElement('div');
    host.setAttribute(kernel.OWN, 'review-panel');
    host.style.cssText = 'position:fixed;right:16px;bottom:60px;z-index:2147483646;width:min(320px,calc(100vw - 32px))';
    const shadow = host.attachShadow({mode: 'closed'});
    const style = document.createElement('style');
    style.textContent = ':host{color:var(--ink);font:var(--type-body)/var(--leading-body) var(--sans)}section{box-sizing:border-box;max-height:min(60vh,420px);overflow:auto;padding:var(--space-4);border:1px solid var(--accent-line);border-top:3px solid var(--accent);border-radius:var(--radius-panel);background:var(--surface);box-shadow:var(--shadow-high)}h3{margin:0 0 var(--space-1);font-size:var(--type-support);color:var(--muted);font-weight:var(--weight-medium)}.term{font-weight:var(--weight-medium);color:var(--accent);margin:0 0 var(--space-1)}.meta{margin:0 0 var(--space-3);color:var(--muted);font-size:var(--type-support)}.row{display:flex;gap:var(--space-2);margin-bottom:var(--space-3)}button{flex:1;min-height:36px;border:1px solid var(--accent-line);border-radius:var(--radius-pill);background:var(--accent-soft);color:var(--accent);font:var(--weight-medium) var(--type-control)/var(--leading-control) var(--sans);cursor:pointer}button:hover{border-color:var(--accent);color:var(--accent-hover)}.again{background:var(--surface);border-color:var(--line);color:var(--muted-strong)}.done{color:var(--muted)}';
    const card = document.createElement('section');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'RelyLess · 复习');
    shadow.append(style, card);
    kernel.uiMountRoot().append(host);
    panel = host; panelShadow = shadow;
    renderPanel();
  }

  function renderPanel() {
    if (!panelShadow) return;
    const card = panelShadow.querySelector('section');
    card.replaceChildren();
    const heading = document.createElement('h3');
    heading.textContent = due.length ? '这些词之前帮过你，现在凭印象过一遍：' : '这次没有到期的复习。';
    card.append(heading);
    for (const item of due) {
      const term = document.createElement('p');
      term.className = 'term';
      term.textContent = item.text;
      const meta = document.createElement('p');
      meta.className = 'meta';
      meta.textContent = '第 ' + item.box + ' 盒 · 下次会更晚再来';
      const row = document.createElement('div');
      row.className = 'row';
      const know = document.createElement('button');
      know.type = 'button';
      know.textContent = '认识了';
      const again = document.createElement('button');
      again.type = 'button';
      again.textContent = '还不熟';
      again.className = 'again';
      know.addEventListener('click', () => void answer(item, 'know'));
      again.addEventListener('click', () => void answer(item, 'again'));
      row.append(know, again);
      card.append(term, meta, row);
    }
    if (!due.length) {
      const done = document.createElement('p');
      done.className = 'meta done';
      done.textContent = '关掉这个面板，继续读就好。';
      card.append(done);
    }
  }

  async function answer(item, outcome) {
    const scope = kernel.readingScope(), generation = state.generation, currentPanel = panel;
    try { await kernel.hooks.request('REVIEW_FEEDBACK', {wordId: item.wordId, senseKey: item.senseKey, outcome}); } catch {}
    if (scope !== kernel.readingScope() || generation !== state.generation || currentPanel !== panel) return;
    due = due.filter(entry => entry.key !== item.key);
    if (!due.length) { closePanel(); return; }
    if (button) button.textContent = '复习 ' + due.length;
    renderPanel();
  }

  function closePanel() {
    panel?.remove(); panel = null; panelShadow = null;
    if (!due.length) { button?.remove(); button = null; }
  }

  globalThis.ShisuiReview = Object.freeze({refresh, hide, answer, dismiss: () => {
    if (!panel) return false;
    closePanel();
    return true;
  }});
})();
