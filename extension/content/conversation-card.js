/**
 * @file content/conversation-card.js
 * 帮助卡片的追问线程：会话号、历史渲染、流式提问与停止。
 * 会话号 = 来源 + 选文 + 上下文的 sha256，同句恢复、换句不串；30 天保留由后台仓库负责。
 */
(() => {
  'use strict';
  const kernel = globalThis.ShisuiContent;
  if (!kernel || globalThis.ShisuiConversation) return;

  const currentView = (view, scope, generation) => kernel.state.card === view &&
    kernel.readingScope() === scope && kernel.state.generation === generation &&
    (!kernel.state.reader || kernel.inReadingSurface(view.target.block || view.target.anchor?.startContainer));
  async function openConversation(view) {
    if (view.convoSessionId || !kernel.state.enabled) return;
    const scope = kernel.readingScope(), generation = kernel.state.generation;
    if (!currentView(view, scope, generation)) return;
    const seed = view.target.context || view.target.text;
    const sessionId = await kernel.sha256([location.origin, view.target.text, seed.slice(0, 400)].join(String.fromCharCode(0)));
    if (!currentView(view, scope, generation)) return;
    view.convoSessionId = sessionId;
    view.convo.hidden = false;
    let turns = [];
    try { const result = await kernel.hooks.request('CONVERSATION_HISTORY', {sessionId}); turns = result.turns || []; } catch { turns = []; }
    if (!currentView(view, scope, generation)) return;
    renderConversation(view, turns);
  }
  function renderConversation(view, turns) {
    view.convoLog.replaceChildren();
    const live = turns.filter(turn => turn.status !== 'error' || turn.answer);
    for (const turn of live) view.convoLog.append(conversationRow(turn));
    if (!live.length) {
      const empty = document.createElement('p'); empty.className = 'minor';
      empty.textContent = '就选中的英文继续提问，例如“这里为什么用完成时？”';
      view.convoLog.append(empty);
    }
    kernel.hooks.positionCard?.(view);
  }
  function conversationRow(turn) {
    const row = document.createElement('div'); row.className = 'conversation-turn';
    const question = document.createElement('p'); question.className = 'conversation-question'; question.textContent = turn.question;
    const answer = document.createElement('p'); answer.className = 'conversation-answer';
    answer.textContent = turn.answer || (turn.status === 'generating' ? '正在回答…' : '未保存回答。');
    row.append(question, answer); return row;
  }
  async function askConversation(view) {
    const scope = kernel.readingScope(), generation = kernel.state.generation;
    if (!currentView(view, scope, generation) || view.convoBusy || !view.convoSessionId) return;
    const question = kernel.normalizeText(view.convoInput.value);
    if (!question) { view.convoInput.focus(); return; }
    view.convoBusy = true; view.convoInput.value = ''; view.convoSend.disabled = true; view.convoStop.hidden = false; view.convoTurnId = crypto.randomUUID();
    let history = [];
    try { const result = await kernel.hooks.request('CONVERSATION_HISTORY', {sessionId: view.convoSessionId}); history = (result.turns || []).filter(turn => turn.status === 'complete' && turn.answer).slice(-4).map(turn => ({question: turn.question, answer: turn.answer})); } catch { history = []; }
    if (!currentView(view, scope, generation)) return;
    const row = conversationRow({question, answer: '', status: 'generating'}); view.convoLog.append(row); view.convoRow = row;
    const target = view.target;
    try {
      const result = await kernel.hooks.request('CONVERSATION_ASK', {turnId: view.convoTurnId, sessionId: view.convoSessionId, question, text: target.text, context: target.context, domain: kernel.state.domain || 'general', kind: target.kind, level: view.level, history});
      if (currentView(view, scope, generation)) {
        const answer = row.querySelector('.conversation-answer');
        answer.textContent = result.answer; answer.classList.remove('error');
        if (result.memoryCount > 0) {
          const memory = document.createElement('small'); memory.className = 'conversation-memory';
          memory.textContent = '已结合你过去的 ' + result.memoryCount + ' 条笔记';
          answer.after(memory);
        }
        view.convoRow = null; kernel.hooks.positionCard?.(view);
      }
    } catch (error) {
      if (currentView(view, scope, generation)) {
        const answer = row.querySelector('.conversation-answer');
        answer.textContent = error.message || '追问失败。'; answer.classList.add('error'); view.convoRow = null;
      }
    } finally {
      view.convoBusy = false; view.convoSend.disabled = false; view.convoStop.hidden = true; view.convoTurnId = '';
      if (currentView(view, scope, generation)) kernel.hooks.positionCard?.(view);
    }
  }
  async function stopConversation(view) {
    const scope = kernel.readingScope(), generation = kernel.state.generation;
    if (!currentView(view, scope, generation)) return;
    const turnId = view.convoTurnId;
    if (!turnId) return;
    view.convoStop.disabled = true;
    try { await kernel.hooks.request('CONVERSATION_STOP', {turnId}); } catch {}
    if (!currentView(view, scope, generation)) return;
    view.convoStop.disabled = false;
    if (view.convoRow) { view.convoRow.querySelector('.conversation-answer').textContent = '已停止。'; view.convoRow = null; }
  }
  // 由 renderHelpCard 在按钮区之后调用：构建并挂载追问区块，字段回填到 view。
  function mount(view, card) {
    const convo = document.createElement('div'); convo.className = 'conversation'; convo.hidden = true;
    const convoLog = document.createElement('div'); convoLog.className = 'conversation-log'; convoLog.setAttribute('aria-live', 'polite');
    const convoForm = document.createElement('form'); convoForm.className = 'conversation-form';
    const convoInput = document.createElement('textarea'); convoInput.className = 'conversation-input'; convoInput.rows = 1; convoInput.maxLength = 300;
    convoInput.placeholder = '就选中的英文继续追问…'; convoInput.setAttribute('aria-label', '继续追问');
    const convoSend = document.createElement('button'); convoSend.type = 'submit'; convoSend.textContent = '追问';
    const convoStop = document.createElement('button'); convoStop.type = 'button'; convoStop.textContent = '停止'; convoStop.hidden = true;
    convoForm.append(convoInput, convoSend, convoStop);
    convoForm.addEventListener('submit', event => { event.preventDefault(); void askConversation(view); });
    convoStop.addEventListener('click', () => void stopConversation(view));
    convo.append(convoLog, convoForm); card.append(convo);
    view.convo = convo; view.convoLog = convoLog; view.convoInput = convoInput; view.convoSend = convoSend; view.convoStop = convoStop;
    view.convoSessionId = ''; view.convoTurnId = ''; view.convoBusy = false; view.convoRow = null;
  }

  globalThis.ShisuiConversation = Object.freeze({openConversation, askConversation, stopConversation, renderConversation, conversationRow, mount});
})();
