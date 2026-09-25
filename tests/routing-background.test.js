import {expect,test} from 'bun:test';
import {normalizeRouting} from '../extension/routing.js';
import {isolatedChrome,isolatedSend} from './helpers/chrome-fixture.js';
const chromeBefore=globalThis.chrome;
// 结构化输出能力探针：与 api-transport 的检测协议对应，未包装的 fetch 会让 responses 协议的请求失败。
const withCapabilityProbe=handler=>async(url,options)=>{
  let body=null;try{body=JSON.parse(options?.body||'null');}catch{}
  const format=body?.response_format?.json_schema?.name==='relyless_capability'?body.response_format.json_schema:body?.text?.format?.name==='relyless_capability'?body.text.format:null;
  if(format){
    const content=JSON.stringify({probe:format?.schema?.properties?.probe?.enum?.[0]});
    return body?.text?.format?Response.json({status:'completed',output_text:content}):Response.json({choices:[{finish_reason:'stop',message:{content}}]});
  }
  return handler(url,options);
};
const pageSender={url:'https://isolated.example/read',tab:{id:91,url:'https://isolated.example/read',active:true},frameId:0};

// 模型路由集成：判卷（Requesty Jev）→ 升级到目标服务 / 判卷失败回落主服务。
// 判卷凭据复用领域识别的 jev 配置；这里用 fetch 分流模拟 router 与两个服务。

const primary = {id:'svc-primary',name:'主力服务',providerId:'openai',baseUrl:'https://primary.example/v1',model:'primary-model',apiKey:'primary-key'};
const premium = {id:'svc-premium',name:'升级服务',providerId:'deepseek',baseUrl:'https://premium.example/v1',model:'premium-model',apiKey:'premium-key'};

const routingFixture = (overrides = {}) => isolatedChrome({
  wordSchemaVersion: 5, productSchemaVersion: 1, words: [],
  settings: {
    providerKind: 'api', apiServices: [primary, premium], activeApiServiceId: primary.id,
    domainDetection: {mode: 'local', subscriptionModel: '', apiModel: '', useTranslationApi: true, api: {baseUrl: 'https://api.openai.com/v1', apiKey: ''}, jevModel: 'typesafe/jev-1.13.0', jevApiKey: 'judge-key', jevBaseUrl: 'https://router.requesty.ai/v1'},
    routing: normalizeRouting({enabled: true, premiumServiceId: premium.id, operations: {assist: true, passage: true, emergency: true, conversation: true, sentenceGroups: false}, ...overrides}),
    rememberSupport: false,
  },
}, {id: 'routing-fixture'});

const judgeReply = (tier, score) => Response.json({choices: [{finish_reason: 'stop', message: {content: JSON.stringify({tier: {selected: tier}, confidence: {score}})}}]});
const assistPayload = () => ({result: {level: 'hint', hint: 'a short gloss', sense: 'test sense', details: {meaning: {en: 'It means something here.', zh: '它在这里表示某个意思。'}, sentenceTranslation: '查询用了索引。'}}});
// 回复体按协议分支：responses 协议用 output_text，chat 协议用 choices。
const assistReply = init => { let body = null; try { body = JSON.parse(init?.body || 'null'); } catch {}
  const payload = JSON.stringify(assistPayload());
  return body?.text?.format ? Response.json({status: 'completed', output_text: payload}) : Response.json({choices: [{finish_reason: 'stop', message: {content: payload}}]}); };
const conversationReply = init => { let body = null; try { body = JSON.parse(init?.body || 'null'); } catch {}
  const payload = JSON.stringify({answer:'It refers to the database index in this sentence.'});
  return body?.text?.format ? Response.json({status:'completed',output_text:payload}) : Response.json({choices:[{finish_reason:'stop',message:{content:payload}}]}); };
test('a premium judgment routes the assist request to the premium service', async () => {
  const fixture = routingFixture();
  globalThis.chrome = fixture.api;
  const seen = [];
  globalThis.fetch = withCapabilityProbe(async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({url: String(url), model: body.model, questions: body.response_format?.type === 'questions'});
    if (String(url).includes('router.requesty.ai')) return judgeReply('premium', 0.4);
    return assistReply(init);
  });
  await import(`../extension/background.js?routing-premium=${Date.now()}`);
  const result = await isolatedSend(fixture, {type: 'ASSIST', requestId: 'route-1', text: 'index', context: 'The database query uses an index.', domain: 'tech', kind: 'word', level: 'hint', detail: 'full'}, pageSender);
  expect(result.hint).toBe('a short gloss');
  const judge = seen.find(entry => entry.url.includes('router.requesty.ai'));
  expect(judge).toBeTruthy();
  expect(judge.questions).toBe(true);
  expect(judge.model).toBe('typesafe/jev-1.13.0');
  const served = seen.filter(entry => !entry.url.includes('router.requesty.ai'));
  expect(served.at(-1).url).toContain('premium.example');
  expect(served.at(-1).model).toBe('premium-model');
  const stats = await isolatedSend(fixture, {type: 'ROUTING_STATS'}, {id: 'routing-fixture', url: 'chrome-extension://routing-fixture/ui/options.html'});
  expect(stats.routing.escalated).toBeGreaterThanOrEqual(1);
  expect(stats.routing.judged).toBeGreaterThanOrEqual(1);
  globalThis.chrome = chromeBefore;
});
test('a premium judgment routes a conversation request without changing the saved default', async () => {
  const fixture = routingFixture();
  globalThis.chrome = fixture.api;
  const seen = [];
  globalThis.fetch = withCapabilityProbe(async (url, init) => {
    seen.push(String(url));
    if (String(url).includes('router.requesty.ai')) return judgeReply('premium', 0.4);
    return conversationReply(init);
  });
  try {
    await import(`../extension/background.js?routing-conversation=${Date.now()}`);
    const result = await isolatedSend(fixture, {
      type:'CONVERSATION_ASK',sessionId:'a'.repeat(64),turnId:'11111111-1111-1111-1111-111111111111',
      text:'index',context:'The database query uses an index.',domain:'tech',kind:'word',level:'hint',history:[],question:'What does index mean here?',
    }, pageSender);
    expect(result.answer).toBe('It refers to the database index in this sentence.');
    expect(seen.some(url => url.includes('premium.example'))).toBe(true);
    expect(fixture.local.settings.activeApiServiceId).toBe(primary.id);
  } finally { globalThis.chrome = chromeBefore; }
});

test('a routine judgment keeps the primary service and caches the decision', async () => {
  const fixture = routingFixture();
  globalThis.chrome = fixture.api;
  const seen = [];
  globalThis.fetch = withCapabilityProbe(async (url, init) => {
    seen.push(String(url));
    if (String(url).includes('router.requesty.ai')) return judgeReply('routine', 0.2);
    return assistReply(init);
  });
  await import(`../extension/background.js?routing-routine=${Date.now()}`);
  await isolatedSend(fixture, {type: 'ASSIST', requestId: 'route-2', text: 'index', context: 'The database query uses an index.', domain: 'tech', kind: 'word', level: 'hint', detail: 'full'}, pageSender);
  expect(seen.filter(url => url.includes('router.requesty.ai'))).toHaveLength(1);
  expect(seen.filter(url => url.includes('primary.example')).length).toBeGreaterThanOrEqual(1);
  // 同一请求再次发起：命中辅助结果缓存，根本不会走到判卷（更强的实际保证）。
  await isolatedSend(fixture, {type: 'ASSIST', requestId: 'route-3', text: 'index', context: 'The database query uses an index.', domain: 'tech', kind: 'word', level: 'hint', detail: 'full'}, pageSender);
  expect(seen.filter(url => url.includes('router.requesty.ai'))).toHaveLength(1);
  const stats = await isolatedSend(fixture, {type: 'ROUTING_STATS'}, {id: 'routing-fixture', url: 'chrome-extension://routing-fixture/ui/options.html'});
  expect(stats.routing.judged).toBe(1);
  globalThis.chrome = chromeBefore;
});

test('incognito routing does not retain a decision in shared local storage', async () => {
  const fixture = routingFixture();
  fixture.api.tabs.get = async () => ({...pageSender.tab, incognito: true});
  globalThis.chrome = fixture.api;
  globalThis.fetch = withCapabilityProbe(async (url, init) => String(url).includes('router.requesty.ai') ? judgeReply('routine', 0.8) : assistReply(init));
  try {
    await import(`../extension/background.js?routing-incognito=${Date.now()}`);
    const sender={...pageSender,tab:{...pageSender.tab,incognito:true}};
    await isolatedSend(fixture, {type:'ASSIST',requestId:'private-route',text:'index',context:'The database query uses an index.',domain:'tech',kind:'word',level:'hint',detail:'full'}, sender);
    expect(fixture.local.routeDecisions).toBeUndefined();
  } finally { globalThis.chrome = chromeBefore; }
});

test('a siliconflow systemone judge routes through the systemone endpoint', async () => {
  const fixture = isolatedChrome({
    wordSchemaVersion: 5, productSchemaVersion: 1, words: [],
    settings: {
      providerKind: 'api', apiServices: [primary, premium], activeApiServiceId: primary.id,
      domainDetection: {mode: 'local', subscriptionModel: '', apiModel: '', useTranslationApi: true, api: {baseUrl: 'https://api.openai.com/v1', apiKey: ''}, jevProvider: 'siliconflow-systemone', jevModel: 'diffusiongemma', jevApiKey: 'judge-key', jevBaseUrl: 'https://api.siliconflow.cn/v1'},
      routing: normalizeRouting({enabled: true, premiumServiceId: premium.id}),
      rememberSupport: false,
    },
  }, {id: 'routing-systemone'});
  globalThis.chrome = fixture.api;
  const seen = [];
  globalThis.fetch = withCapabilityProbe(async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({url: String(url), model: body.model, state: typeof body.state === 'string'});
    if (String(url).includes('api.siliconflow.cn')) return Response.json({answers: {tier: {selected: 'premium'}, confidence: {score: 0.4}}});
    return assistReply(init);
  });
  await import(`../extension/background.js?routing-systemone=${Date.now()}`);
  const result = await isolatedSend(fixture, {type: 'ASSIST', requestId: 'route-sf', text: 'index', context: 'The database query uses an index.', domain: 'tech', kind: 'word', level: 'hint', detail: 'full'}, pageSender);
  expect(result.hint).toBe('a short gloss');
  const judge = seen.find(entry => entry.url === 'https://api.siliconflow.cn/v1/systemone');
  expect(judge).toBeTruthy();
  expect(judge.model).toBe('diffusiongemma');
  expect(judge.state).toBe(true);
  const served = seen.filter(entry => !entry.url.includes('api.siliconflow.cn'));
  expect(served.at(-1).url).toContain('premium.example');
  const stats = await isolatedSend(fixture, {type: 'ROUTING_STATS'}, {id: 'routing-systemone', url: 'chrome-extension://routing-systemone/ui/options.html'});
  expect(stats.routing.escalated).toBeGreaterThanOrEqual(1);
  globalThis.chrome = chromeBefore;
});

test('a failing judge falls back to the primary service without breaking the request', async () => {
  const fixture = routingFixture();
  globalThis.chrome = fixture.api;
  const seen = [];
  globalThis.fetch = withCapabilityProbe(async (url, init) => {
    seen.push(String(url));
    if (String(url).includes('router.requesty.ai')) throw new Error('judge network down');
    return assistReply(init);
  });
  await import(`../extension/background.js?routing-fail=${Date.now()}`);
  const result = await isolatedSend(fixture, {type: 'ASSIST', requestId: 'route-4', text: 'index', context: 'The database query uses an index.', domain: 'tech', kind: 'word', level: 'hint', detail: 'full'}, pageSender);
  expect(result.hint).toBe('a short gloss');
  expect(seen.some(url => url.includes('primary.example'))).toBe(true);
  const stats = await isolatedSend(fixture, {type: 'ROUTING_STATS'}, {id: 'routing-fixture', url: 'chrome-extension://routing-fixture/ui/options.html'});
  expect(stats.routing.judgeFailed).toBeGreaterThanOrEqual(1);
  globalThis.chrome = chromeBefore;
});

test('routing stays off by default and never touches the provider choice', async () => {
  const fixture = isolatedChrome({
    wordSchemaVersion: 5, productSchemaVersion: 1, words: [],
    settings: {providerKind: 'api', apiServices: [primary], activeApiServiceId: primary.id, domainDetection: {mode: 'local', jevApiKey: 'judge-key', jevModel: 'typesafe/jev-1.13.0', jevBaseUrl: 'https://router.requesty.ai/v1'}, rememberSupport: false},
  }, {id: 'routing-off'});
  globalThis.chrome = fixture.api;
  const seen = [];
  globalThis.fetch = withCapabilityProbe(async (url, init) => { seen.push(String(url)); return assistReply(init); });
  await import(`../extension/background.js?routing-off=${Date.now()}`);
  await isolatedSend(fixture, {type: 'ASSIST', requestId: 'route-5', text: 'index', context: 'The database query uses an index.', domain: 'tech', kind: 'word', level: 'hint', detail: 'full'}, pageSender);
  expect(seen.some(url => url.includes('router.requesty.ai'))).toBe(false);
  expect(seen.some(url => url.includes('primary.example'))).toBe(true);
  const stats = await isolatedSend(fixture, {type: 'ROUTING_STATS'}, {id: 'routing-off', url: 'chrome-extension://routing-off/ui/options.html'});
  expect(stats.routing.judged).toBe(0);
  expect(stats.settings.enabled).toBe(false);
  globalThis.chrome = chromeBefore;
});

test('an unauthenticated subscription target degrades to the primary service', async () => {
  const fixture = routingFixture({premiumServiceId: 'subscription'});
  globalThis.chrome = fixture.api;
  const seen = [];
  globalThis.fetch = withCapabilityProbe(async (url, init) => {
    seen.push(String(url));
    if (String(url).includes('router.requesty.ai')) return judgeReply('premium', 0.3);
    return assistReply(init);
  });
  await import(`../extension/background.js?routing-sub=${Date.now()}`);
  await isolatedSend(fixture, {type: 'ASSIST', requestId: 'route-6', text: 'index', context: 'The database query uses an index.', domain: 'tech', kind: 'word', level: 'hint', detail: 'full'}, pageSender);
  expect(seen.some(url => url.includes('primary.example'))).toBe(true);
  globalThis.chrome = chromeBefore;
});

test('routing settings patch merges instead of resetting', async () => {
  const fixture = routingFixture();
  globalThis.chrome = fixture.api;
  await import(`../extension/background.js?routing-patch=${Date.now()}`);
  const saved = await isolatedSend(fixture, {type: 'STATE_PATCH', patch: {routing: {operations: {emergency: false}}}}, {id: 'routing-fixture', url: 'chrome-extension://routing-fixture/ui/options.html'});
  expect(saved.settings.routing.enabled).toBe(true);
  expect(saved.settings.routing.operations.emergency).toBe(false);
  expect(saved.settings.routing.operations.assist).toBe(true);
  expect(saved.settings.routing.premiumServiceId).toBe(premium.id);
  // 非法把握度按设计钳位回默认，而不是抛错（路由失败永远不该阻塞读者）。
  const clamped = await isolatedSend(fixture, {type: 'STATE_PATCH', patch: {routing: {minConfidence: 2}}}, {id: 'routing-fixture', url: 'chrome-extension://routing-fixture/ui/options.html'});
  expect(clamped.settings.routing.minConfidence).toBe(0.7);
  globalThis.chrome = chromeBefore;
});
