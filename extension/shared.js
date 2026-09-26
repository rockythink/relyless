import './reading-style.js';
import {normalizeApiService} from './api-providers.mjs';
import {normalizeRulePacks} from './rule-pack.js';
import {normalizeRouting} from './routing.js';

export const DOMAINS = {auto:'自动识别',general:'通用阅读',tech:'软件与 AI',data:'数据工程',finance:'金融与商业',medical:'医学与生命科学',legal:'法律',design:'设计与产品'};
export const DEFAULT_SETTINGS = {assistanceMode:'ambient',rememberSupport:true,keyboardNav:{enabled:false},persistTranslationCache:false,helpLanguage:'zh',lookupKey:'D',lookupDisplay:'card',hintDisplay:'direct',readingStyle:globalThis.ShisuiReadingStyle.defaults,domain:'auto',providerKind:'chatgpt',subscriptionModel:'',apiServices:[],activeApiServiceId:'',domainRules:[],domainDetection:{mode:'local',subscriptionModel:'',apiModel:'',useTranslationApi:true,api:{baseUrl:'https://api.openai.com/v1',apiKey:''},jevProvider:'requesty',jevModel:'typesafe/jev-1.13.0',jevApiKey:'',jevBaseUrl:'https://router.requesty.ai/v1'},customTerms:[],automation:{allSites:false,sentenceGroupsAllSites:false,sites:[],videoSites:false},video:{fontSize:20,theme:'auto'},passageAction:{open:'click',delay:600},rulePacks:[],requestConcurrency:2,routing:{enabled:false,premiumServiceId:'',operations:{assist:true,passage:true,emergency:true,conversation:true,sentenceGroups:false},minConfidence:0.7,cacheTtlMinutes:1440},usageBudget:{monthlyTokens:0},pdfReader:true};
// Removed settings must not revive through a spread of an older configuration.
export function normalizeSettings(value = {}) {
  const pick = (defaults, source) => Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, source?.[key] ?? fallback]));
  const settings = pick(DEFAULT_SETTINGS,value);
  settings.assistanceMode = value.assistanceMode === 'on-demand' ? 'on-demand' : 'ambient';
  settings.rememberSupport = value.rememberSupport !== false;
  settings.persistTranslationCache = value.persistTranslationCache === true;
  settings.helpLanguage = value.helpLanguage === 'en' ? 'en' : 'zh';
  settings.lookupKey = typeof value.lookupKey === 'string' && /^[A-Za-z]$/.test(value.lookupKey) ? value.lookupKey.toUpperCase() : DEFAULT_SETTINGS.lookupKey;
  settings.lookupDisplay = value.lookupDisplay === 'annotation' ? 'annotation' : 'card';
  settings.hintDisplay = value.hintDisplay === 'veil' ? 'veil' : 'direct';
  settings.readingStyle = globalThis.ShisuiReadingStyle.normalize(value.readingStyle);
  settings.providerKind = ['chatgpt','grok','antigravity','api','local'].includes(value.providerKind) ? value.providerKind : (value.provider?.apiKey ? 'api' : 'chatgpt');
  const legacyProvider = !Array.isArray(value.apiServices) && Object.hasOwn(value,'provider');
  const rows = Array.isArray(value.apiServices) ? value.apiServices : (legacyProvider ? [{id:'legacy-api',name:'原有 API 服务',baseUrl:value.provider?.baseUrl,model:value.provider?.model,apiKey:value.provider?.apiKey}] : []);
  const seen=new Set();settings.apiServices=rows.flatMap(row=>{try{const service=normalizeApiService(row);if(!service.id||seen.has(service.id))return [];seen.add(service.id);return [service];}catch{return [];}});
  settings.activeApiServiceId = settings.apiServices.some(service=>service.id===value.activeApiServiceId) ? value.activeApiServiceId : (legacyProvider&&settings.apiServices.some(service=>service.id==='legacy-api')?'legacy-api':'');
  settings.domainDetection = pick(DEFAULT_SETTINGS.domainDetection,value.domainDetection);
  settings.domainDetection.api = pick(DEFAULT_SETTINGS.domainDetection.api,value.domainDetection?.api);
  settings.automation = pick(DEFAULT_SETTINGS.automation,value.automation);
  settings.automation.sites = Array.isArray(value.automation?.sites) ? value.automation.sites.map(({origin,enabled}) => ({origin,enabled})) : [];
  settings.video = pick(DEFAULT_SETTINGS.video,value.video);
  settings.passageAction = {open:value.passageAction?.open==='hover'?'hover':'click',delay:Number.isSafeInteger(value.passageAction?.delay)&&value.passageAction.delay>=0&&value.passageAction.delay<=3000?value.passageAction.delay:DEFAULT_SETTINGS.passageAction.delay};
  settings.requestConcurrency = Number.isSafeInteger(value.requestConcurrency) && value.requestConcurrency >= 1 && value.requestConcurrency <= 8 ? value.requestConcurrency : DEFAULT_SETTINGS.requestConcurrency;
  settings.rulePacks = normalizeRulePacks(value.rulePacks);
  const currentRouting=value.routing&&typeof value.routing==='object'&&!Array.isArray(value.routing)?value.routing:{};
  settings.routing = normalizeRouting(currentRouting, DEFAULT_SETTINGS.routing);
  settings.usageBudget = {monthlyTokens:Number.isSafeInteger(value.usageBudget?.monthlyTokens)&&value.usageBudget.monthlyTokens>=0?Math.min(value.usageBudget.monthlyTokens,100000000):0};
  settings.keyboardNav = {enabled:value.keyboardNav?.enabled===true};
  settings.pdfReader = value.pdfReader !== false;
  return settings;
}
export function activeApiProvider(settings) { return settings?.apiServices?.find(service=>service.id===settings.activeApiServiceId) || null; }
export const wordId = (term, domain = 'general') => `${domain}:${term.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase()}`;
export async function request(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({type,...payload});
  if (!response?.ok) throw new Error(response?.error || '插件连接已断开，请刷新页面后重试。');
  return response.data;
}
export function errorText(error) { return error instanceof Error ? error.message : String(error); }
export function setResult(element, message, isError = false) { element.textContent = message; element.hidden = !message; element.classList.toggle('error', isError); }
export function parseOrigin(value) { const entered = value.trim(); let parsed; try { parsed = new URL(entered); } catch { throw new Error('请输入完整的网站 origin。'); } if (!['http:','https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('网站必须是协议 + 主机，可含端口但不能含路径。'); return parsed.origin; }
export function downloadJson(data, name) { const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type:'application/json'})); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0); }
export function upsertSiteEntry(sites, origin, enabled) { return [...(sites || []).filter(site => site.origin !== origin), {origin, enabled}]; }