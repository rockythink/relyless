import {expect,test,beforeAll} from 'bun:test';
import {Window} from 'happy-dom';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {serviceCatalog} from '../extension/ui/options-service-catalog.js';

let window, document, settings, patches, removedOrigins;

beforeAll(async () => {
  const html = readFileSync(path.resolve('extension/ui/options.html'), 'utf8');
  window = new Window({
    url: 'chrome-extension://olkjdjooklmengneakktetfpmmmmnhbpf/ui/options.html',
    width: 1280,
    height: 800
  });
  window.document.write(html);
  window.HTMLElement.prototype.scrollIntoView=()=>{};
  document = window.document;

  function MockOption(text, value) {
    const option=document.createElement('option');
    option.textContent=text;
    option.value=value;
    return option;
  }

  const service=(id,providerId,apiKey)=>({id,name:id,providerId,baseUrl:providerId==='deepseek'?'https://api.deepseek.com/v1':'https://api.openai.com/v1',model:'fixture-model',apiKey,apiKeys:[apiKey],options:{}});
  settings={providerKind:'api',activeApiServiceId:'first',apiServices:[service('first','openai','first-key'),service('second','deepseek','second-key')]};
  patches=[];
  removedOrigins=[];

  // Mock chrome API for options page
  window.chrome = {
    runtime: {
      id: 'olkjdjooklmengneakktetfpmmmmnhbpf',
      sendMessage: (msg, cb) => {
        if(msg.type==='STATE_PATCH'){patches.push(msg.patch);settings={...settings,...msg.patch};}
        const data=msg.type==='AUTOMATION_GET'?{automation:{sites:[]}}:
          msg.type==='DOMAIN_TEST'?{domain:'general',source:'local-model',confident:false,suggested:'data'}:
          msg.type==='SUBSCRIPTION_STATUS'?{connected:false,authenticated:false}:
          {settings,providerConfigured:true,subscription:{connected:false,authenticated:false},sessions:[],config:{enabled:false}};
        const res = {ok:true,data};
        if (cb) cb(res);
        return Promise.resolve(res);
      },
      onMessage: {
        addListener: () => {}
      }
    },
    storage: {
      local: {
        get: (keys, cb) => {
          const res = {};
          if (cb) cb(res);
          return Promise.resolve(res);
        },
        set: (items, cb) => {
          if (cb) cb();
          return Promise.resolve();
        }
      },
      onChanged: {
        addListener: () => {}
      }
    },
    permissions: {
      contains: (p, cb) => { if (cb) cb(true); return Promise.resolve(true); },
      request: (p, cb) => { if (cb) cb(true); return Promise.resolve(true); },
      remove: (p, cb) => { removedOrigins.push(...(p?.origins || [])); if (cb) cb(true); return Promise.resolve(true); }
    },
    tabs: {
      create: () => {}
    }
  };

  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.chrome = window.chrome;
  globalThis.location = window.location;
  globalThis.history = window.history;
  globalThis.navigator = window.navigator;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.Event = window.Event;
  globalThis.Option = MockOption;
  globalThis.window.Option = MockOption;
  globalThis.matchMedia = () => ({ addEventListener: () => {} });
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  globalThis.confirm = () => true;

  // Load modules
  await import(path.resolve('extension/design.js'));
  await import(path.resolve('extension/ui/options.js'));
  await import(path.resolve('extension/ui/history.js'));
  await new Promise(resolve=>setTimeout(resolve,0));
});

test('options page initializes with assistance section visible by default', () => {
  expect(globalThis.optionsState?.settings.activeApiServiceId).toBe('first');
  expect(document.getElementById('global-error').textContent).toBe('');
  expect(document.getElementById('assistance').hidden).toBe(false);
  expect(document.getElementById('history').hidden).toBe(true);
  const activeLink = document.querySelector('.sidebar a.active');
  expect(activeLink?.dataset.section).toBe('assistance');
  expect(document.getElementById('section-title').textContent).toBe('阅读偏好');
});

test('previewing another service clears only its keys when disconnected', async () => {
  serviceCatalog.selectService('deepseek');
  expect(document.getElementById('provider-name').value).toBe('second');
  expect(settings.activeApiServiceId).toBe('first');
  expect(patches).toHaveLength(0);
  const disconnect=document.getElementById('disconnect-provider');
  expect(disconnect.disabled).toBe(false);
  disconnect.click();
  await new Promise(resolve=>setTimeout(resolve,20));
  expect(patches).toHaveLength(1);
  expect(settings.activeApiServiceId).toBe('first');
  expect(settings.apiServices.find(service=>service.id==='first').apiKeys).toEqual(['first-key']);
  expect(settings.apiServices.find(service=>service.id==='second').apiKeys).toEqual([]);
});

test('switching hash to #history switches visible section and active link', async () => {
  window.location.hash = '#history';
  window.dispatchEvent(new window.Event('hashchange'));
  await new Promise(r => setTimeout(r, 50));

  expect(document.getElementById('assistance').hidden).toBe(true);
  expect(document.getElementById('history').hidden).toBe(false);
  const activeLink = document.querySelector('.sidebar a.active');
  expect(activeLink?.dataset.section).toBe('history');
  expect(document.getElementById('section-title').textContent).toBe('阅读记录');
});

test('settings search filters navigation, lists deep matches, and navigates on click', async () => {
  const input=document.getElementById('settings-search');
  input.value='并发';
  input.dispatchEvent(new window.Event('input',{bubbles:true}));
  const visible=[...document.querySelectorAll('.sidebar nav a')].filter(a=>!a.hidden).map(a=>a.dataset.section);
  expect(visible).toEqual(['service']);
  const results=[...document.querySelectorAll('#search-results button')];
  expect(results.length).toBeGreaterThan(0);
  expect(results.every(b=>b.dataset.section==='service')).toBe(true);
  results[0].click();
  await new Promise(r=>setTimeout(r,20));
  expect(document.getElementById('service').hidden).toBe(false);
  expect(document.getElementById('request-concurrency').closest('details').open).toBe(true);
  expect(document.activeElement.textContent).toContain('并发');
  expect(input.value).toBe('');
  input.value='绝不可能匹配xyz';
  input.dispatchEvent(new window.Event('input',{bubbles:true}));
  expect(document.querySelector('#search-results .search-empty')).toBeTruthy();
  expect([...document.querySelectorAll('.sidebar nav a')].every(a=>a.hidden)).toBe(true);

  input.value='';
  input.dispatchEvent(new window.Event('input',{bubbles:true}));
  expect([...document.querySelectorAll('.sidebar nav a')].every(a=>!a.hidden)).toBe(true);
  expect([...document.querySelectorAll('.sidebar .nav-group-label')].every(g=>!g.hidden)).toBe(true);
  expect(document.getElementById('search-results').hidden).toBe(true);
});

test('deep search reveals a hidden appearance tab and focuses the exact label in the current section', async () => {
  window.location.hash='#appearance';
  window.dispatchEvent(new window.Event('hashchange'));
  const input=document.getElementById('settings-search');
  input.value='被提示的原词';
  input.dispatchEvent(new window.Event('input',{bubbles:true}));
  document.querySelector('#search-results button').click();
  await new Promise(r=>setTimeout(r,20));
  expect(document.getElementById('appearance-panel-original').hidden).toBe(false);
  expect(document.activeElement.textContent).toBe('被提示的原词');
  expect(document.querySelector('#appearance-tab-original').getAttribute('aria-selected')).toBe('true');
});
test('request concurrency select persists a bounded integer patch', async () => {
  const select=document.getElementById('request-concurrency');
  expect(select).toBeTruthy();
  select.value='4';
  select.dispatchEvent(new window.Event('change',{bubbles:true}));
  await new Promise(r=>setTimeout(r,20));
  expect(patches.at(-1)).toMatchObject({requestConcurrency:4});
});

test('switching hash across all main sections properly displays each section', async () => {
  const sections = [
    {hash: 'appearance', label: '显示与解构'},
    {hash: 'sites', label: '网站规则'},
    {hash: 'service', label: '模型服务'},
    {hash: 'privacy', label: '数据与隐私'},
    {hash: 'personalization', label: '提示偏好'},
    {hash: 'advanced', label: '领域识别'},
    {hash: 'guide', label: '使用说明'},
    {hash: 'assistance', label: '阅读偏好'}
  ];

  for (const item of sections) {
    window.location.hash = '#' + item.hash;
    window.dispatchEvent(new window.Event('hashchange'));
    await new Promise(r => setTimeout(r, 20));

    expect(document.getElementById(item.hash).hidden).toBe(false);
    expect(document.getElementById('section-title').textContent).toBe(item.label);
    const activeLink = document.querySelector('.sidebar a.active');
    expect(activeLink?.dataset.section).toBe(item.hash);
  }
});

test('a low-confidence domain test suggests a manual site rule only in settings',async()=>{
  document.getElementById('domain-test-text').value='Data pipelines transform events into warehouse tables.';
  document.getElementById('run-domain-test').click();
  await new Promise(resolve=>setTimeout(resolve,0));
  const result=document.getElementById('domain-test-result').textContent;
  expect(result).toContain('本机识别不确定');
  expect(result).toContain('网站规则');
  expect(result).toContain('数据工程');
});

// 判定接入的权限生命周期：路由开启时把领域识别切回本地不得回收判官主机权限；
// 关闭最后一个使用者才允许回收；跨接入方切换（即使同源）不得沿用旧密钥。
test('detection mode switch keeps the judge origin while routing still uses it', async () => {
  settings.domainDetection={mode:'jev',subscriptionModel:'',apiModel:'',useTranslationApi:true,api:{baseUrl:'https://api.openai.com/v1',apiKey:''},jevProvider:'requesty',jevModel:'typesafe/jev-1.13.0',jevApiKey:'judge-key',jevBaseUrl:'https://router.requesty.ai/v1'};
  settings.routing={enabled:true,premiumServiceId:'',operations:{assist:true,passage:true,emergency:true,conversation:true,sentenceGroups:false},minConfidence:0.7,cacheTtlMinutes:1440};
  const local=document.querySelector('input[name="domain-detection-mode"][value="local"]');
  local.checked=true;
  local.dispatchEvent(new window.Event('change',{bubbles:true}));
  document.getElementById('save-recognition').click();
  await new Promise(resolve=>setTimeout(resolve,30));
  expect(settings.domainDetection.mode).toBe('local');
  expect(settings.domainDetection.jevApiKey).toBe('judge-key');
  expect(removedOrigins.includes('https://router.requesty.ai/*')).toBe(false);
});

test('disabling routing revokes the judge origin once detection no longer uses it', async () => {
  const toggle=document.getElementById('routing-enabled');
  toggle.checked=false;
  toggle.dispatchEvent(new window.Event('change',{bubbles:true}));
  await new Promise(resolve=>setTimeout(resolve,30));
  expect(settings.routing?.enabled).toBe(false);
  expect(removedOrigins.includes('https://router.requesty.ai/*')).toBe(true);
});

test('switching judgment provider never carries the old key across', async () => {
  settings.domainDetection={...settings.domainDetection,mode:'jev',jevProvider:'requesty',jevModel:'typesafe/jev-1.13.0',jevApiKey:'judge-key',jevBaseUrl:'https://proxy.example/v1'};
  const jevRadio=document.querySelector('input[name="domain-detection-mode"][value="jev"]');
  jevRadio.checked=true;
  jevRadio.dispatchEvent(new window.Event('change',{bubbles:true}));
  const providerSelect=document.getElementById('detection-jev-provider');
  providerSelect.value='requesty';
  document.getElementById('detection-jev-url').value='https://proxy.example/v1';
  document.getElementById('detection-jev-key').value='';
  document.getElementById('save-recognition').click();
  await new Promise(resolve=>setTimeout(resolve,30));
  // 同接入方 + 同源接口：留空密钥沿用已保存值。
  expect(patches.at(-1).domainDetection.jevApiKey).toBe('judge-key');
  providerSelect.value='siliconflow-systemone';
  providerSelect.dispatchEvent(new window.Event('change',{bubbles:true}));
  await new Promise(resolve=>setTimeout(resolve,30));
  // 跨接入方即使同源也必须重新填写密钥。
  expect(patches.at(-1).domainDetection.jevProvider).toBe('siliconflow-systemone');
  expect(patches.at(-1).domainDetection.jevApiKey).toBe('');
});

test('switching judgment provider discards an unsaved key before saving the new provider',async()=>{
  settings.domainDetection={...settings.domainDetection,mode:'jev',jevProvider:'requesty',jevModel:'typesafe/jev-1.13.0',jevApiKey:'',jevBaseUrl:'https://router.requesty.ai/v1'};
  const provider=document.getElementById('detection-jev-provider'),key=document.getElementById('detection-jev-key');
  provider.value='requesty';
  key.value='unsaved-requesty-secret';
  provider.value='siliconflow-systemone';
  provider.dispatchEvent(new window.Event('change',{bubbles:true}));
  await new Promise(resolve=>setTimeout(resolve,30));
  expect(key.value).toBe('');
  expect(patches.at(-1).domainDetection.jevProvider).toBe('siliconflow-systemone');
  expect(patches.at(-1).domainDetection.jevApiKey).toBe('');
});
