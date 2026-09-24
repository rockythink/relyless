import {expect,test,beforeAll,afterAll} from 'bun:test';
import {Window} from 'happy-dom';
import {readFileSync} from 'node:fs';

const originalGlobals = {};
beforeAll(async () => {
  const window = new Window({url: 'https://reading.example/article'});
  for (const key of ['location', 'getComputedStyle', 'navigator', 'document', 'Node', 'NodeFilter', 'window']) originalGlobals[key] = globalThis[key];
  const scope = {
    window, document: window.document, Node: window.Node, NodeFilter: window.NodeFilter,
    getComputedStyle: value => window.getComputedStyle(value), location: window.location,
    navigator: window.navigator, CustomEvent: window.CustomEvent, Event: window.Event,
    NodeFilter_: undefined,
  };
  Object.assign(globalThis, scope);
  // happy-dom 的 getComputedStyle 对未设置属性返回空串，而内核把空 opacity 视为隐藏；测试环境补齐浏览器默认值。
  const realComputed = value => window.getComputedStyle(value);
  globalThis.getComputedStyle = value => ({...realComputed(value), opacity: '1', display: 'block', visibility: 'visible', contentVisibility: 'visible', clip: 'auto', clipPath: 'none', overflow: 'visible'});
  // 剪贴板在测试环境不可用，注入可观察的替身。
  const written = [];
  Object.defineProperty(globalThis.navigator, 'clipboard', {value: {writeText: async text => { written.push(text); }}, configurable: true});
  globalThis.__clipboardWrites = written;
  for (const file of ['content/kernel.js', 'content/paragraph-copy.js', 'content/conversation-card.js']) {
    const source = readFileSync(new URL(`../extension/${file}`, import.meta.url), 'utf8');
    new Function(source)();
  }
});

const kernel = () => globalThis.ShisuiContent;
const copy = () => globalThis.ShisuiCopy;
const convo = () => globalThis.ShisuiConversation;

test('the kernel textMap keeps only original text nodes', () => {
  document.body.innerHTML = '<p id="p">The client <span class="shisui-term-mark">retries</span><span class="shisui-term-hint">重试</span> when <b>it</b> fails.</p>';
  const block = document.getElementById('p');
  expect(kernel().blockText(block)).toBe('The client retries when it fails.');
  expect(kernel().blockId(block)).toBe(kernel().blockId(block));
});

test('the kernel reports stable selection signatures and dismisses matching ones', () => {
  const range = document.createRange();
  const paragraph = document.createElement('p');
  paragraph.textContent = 'The client retries with backoff.';
  document.body.append(paragraph);
  range.selectNodeContents(paragraph);
  const signature = kernel().selectionSignature({rangeCount: 1, isCollapsed: false, getRangeAt: () => range});
  expect(signature).toContain('The client retries with backoff.');
  expect(kernel().selectionSignature({rangeCount: 0, isCollapsed: true, getRangeAt: () => range})).toBe('');
  kernel().dismissSelection(signature);
  expect(kernel().dismissedSignature()).toBe(signature);
  kernel().dismissSelection('');
  expect(kernel().dismissedSignature()).toBe('');
});

test('copy uses the selection block and writes only original text', async () => {
  document.body.innerHTML = '<p id="p">The client <span class="shisui-term-hint">客户端</span> retries with backoff.</p>';
  const paragraph = document.getElementById('p');
  const range = document.createRange();
  range.selectNodeContents(paragraph);
  const messages = [];
  kernel().register({setPageStatus: (key, text) => messages.push([key, text])});
  const originalSelection = kernel().currentSelection;
  kernel().currentSelection = () => ({rangeCount: 1, isCollapsed: false, getRangeAt: () => range});
  await copy().copyParagraph();
  kernel().currentSelection = originalSelection;
  expect(globalThis.__clipboardWrites.at(-1)).toBe('The client retries with backoff.');
  expect(messages.at(-1)[0]).toBe('copy');
  expect(messages.at(-1)[1]).toContain('已复制');
});

test('copy reports a clear error without a paragraph selection', async () => {
  const messages = [];
  kernel().register({setPageStatus: (key, text) => messages.push([key, text])});
  kernel().currentSelection = () => ({rangeCount: 0, isCollapsed: true, getRangeAt: () => null});
  await expect(copy().copyParagraph()).rejects.toThrow('没有找到可复制的段落。');
});


const makeView = () => {
  const card = document.createElement('section');
  document.body.append(card);
  const view = {level: 'hint', target: {text: 'index', context: 'The query uses an index.', kind: 'word'}};
  convo().mount(view, card);
  return view;
};

test('mounting the conversation block builds the log and form on the view', () => {
  const view = makeView();
  expect(view.convo.hidden).toBe(true);
  expect(view.convoLog.childNodes).toHaveLength(0);
  expect(view.convoInput.maxLength).toBe(300);
  expect(view.convoSend.type).toBe('submit');
  expect(view.convoStop.hidden).toBe(true);
  expect(view.convoBusy).toBe(false);
});

test('renderConversation shows answered turns and an empty hint', async () => {
  const view = makeView();
  convo().renderConversation(view, [{question: '为什么用复数？', answer: '因为泛指一类。', status: 'complete', createdAt: 1}]);
  expect(view.convoLog.querySelectorAll('.conversation-turn')).toHaveLength(1);
  expect(view.convoLog.querySelector('.conversation-question').textContent).toBe('为什么用复数？');
  convo().renderConversation(view, []);
  expect(view.convoLog.querySelectorAll('.conversation-turn')).toHaveLength(0);
  expect(view.convoLog.querySelector('.minor').textContent).toContain('继续提问');
});

test('asking streams into a turn row and shows the local memory note', async () => {
  const view = makeView();
  kernel().state.card = view;
  const asked = [];
  kernel().register({
    request: async (type, payload) => {
      asked.push([type, payload]);
      if (type === 'CONVERSATION_HISTORY') return {turns: []};
      return {turnId: payload.turnId, answer: '因为强调持续到现在。', status: 'complete', memoryCount: 2};
    },
    positionCard: () => {},
  });
  view.convoSessionId = 'a'.repeat(64);
  view.convoInput.value = '这里为什么用完成时？';
  const form = view.convoSend.closest('form');
  form.dispatchEvent(new window.Event('submit', {cancelable: true, bubbles: true}));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(asked.map(([type]) => type)).toEqual(['CONVERSATION_HISTORY', 'CONVERSATION_ASK']);
  expect(asked[1][1].question).toBe('这里为什么用完成时？');
  expect(asked[1][1].turnId).toMatch(/^[0-9a-f-]{36}$/);
  expect(asked[1][1].text).toBe('index');
  const row = view.convoLog.querySelector('.conversation-turn');
  expect(row.querySelector('.conversation-answer').textContent).toBe('因为强调持续到现在。');
  expect(row.querySelector('.conversation-memory').textContent).toContain('2 条笔记');
  expect(view.convoBusy).toBe(false);
  kernel().state.card = null;
});

test('a failed ask surfaces the error inside the turn row', async () => {
  const view = makeView();
  kernel().state.card = view;
  kernel().register({request: async type => type === 'CONVERSATION_HISTORY' ? {turns: []} : Promise.reject(new Error('服务未返回有效回答。')), positionCard: () => {}});
  view.convoSessionId = 'b'.repeat(64);
  view.convoInput.value = '测试失败';
  view.convoSend.closest('form').dispatchEvent(new window.Event('submit', {cancelable: true, bubbles: true}));
  await new Promise(resolve => setTimeout(resolve, 20));
  const row = view.convoLog.querySelector('.conversation-turn');
  expect(row.querySelector('.conversation-answer').textContent).toBe('服务未返回有效回答。');
  expect(row.querySelector('.conversation-answer').classList.contains('error')).toBe(true);
  kernel().state.card = null;
});

test('stopping asks the background once and marks the turn stopped', async () => {
  const view = makeView();
  const asked = [];
  kernel().register({request: async type => { asked.push(type); return {}; }});
  view.convoTurnId = '11111111-1111-1111-1111-111111111111';
  view.convoRow = convo().conversationRow({question: '进行中的问题', answer: '讲到这里被打断', status: 'stopped'});
  kernel().state.card = view;
  await convo().stopConversation(view);
  expect(asked).toEqual(['CONVERSATION_STOP']);
  expect(view.convoRow).toBeNull();
  kernel().state.card = null;
});

afterAll(() => {
  Object.assign(globalThis, originalGlobals);
  delete globalThis.__clipboardWrites;
});
