import {DOMAINS, request, activeApiProvider, errorText, setResult, parseOrigin, downloadJson, upsertSiteEntry} from '../shared.js';
import {parseRulePack} from '../rule-pack.js';
import {API_PROVIDERS, getApiProvider, apiProviderBaseUrl, normalizeApiService, apiServiceOrigins} from '../api-providers.mjs';
import {createProviderPicker} from './provider-picker.js';
import {serviceCatalog} from './options-service-catalog.js';
import {VIDEO_SUPPORT_ENABLED} from '../activation.js';

const optionsSections = ['assistance','appearance','sites','service','privacy','history','personalization','advanced','terms','diagnostics','guide','about'];
const optionsLabels = {assistance:'阅读偏好',appearance:'显示与解构',sites:'网站规则',service:'模型服务',privacy:'数据与隐私',history:'阅读记录',personalization:'提示偏好',advanced:'领域识别',terms:'固定术语',diagnostics:'运行诊断',guide:'使用说明',about:'关于作者'};
const optionsSourceLabels = {personalized:'个性化倾向',manual:'当前页手动','site-user':'个人站点规则',global:'全局固定','site-built-in':'内置站点规则','local-model':'本地模型',chatgpt:'ChatGPT 增强',api:'自定义 API',general:'通用回退'};
const diagnosticOperationLabels = {SENTENCE_GROUPS_BATCH:'阅读解构',HISTORY_SUMMARY:'阅读摘要',PERSONALIZATION_ANALYZE:'个性化分析',ASSIST_COMMIT:'帮助记录提交',ASSIST:'阅读辅助',SUPPORT_BATCH:'批量辅助',PASSAGE_TRANSLATE:'选段翻译',EMERGENCY_TRANSLATE:'整页翻译',RESOLVE_DOMAIN:'领域识别',PROVIDER_TEST:'服务测试',CONNECTION:'连接器通信',ANALYZE:'本机分析',PREPARED_ASSIST:'预备辅助',PREPARED_SUPPORT:'预备解释'};
const diagnosticStageLabels = {request:'请求',provider:'服务',first_content:'首段内容',validation:'校验',render:'呈现',connection:'连接',rpc:'通信',stderr:'连接器错误'};
const diagnosticStatusLabels = {start:'开始',ok:'完成',error:'失败',cancelled:'已取消'};
const diagnosticCodeLabels = {STARTUP_FAILED:'连接器启动失败',CODEX_EXIT:'模型进程已退出',RPC_TIMEOUT:'连接器通信超时',TURN_FAILED:'模型处理失败',UNKNOWN:'其他异常',OK:'处理完成',LOCAL_RESULT:'使用本机结果',CACHE_HIT:'使用本机缓存',TIMEOUT:'请求超时',NETWORK:'网络错误',AUTH:'服务认证失败',RATE_LIMIT:'请求过于频繁',HTTP:'服务请求失败',JSON_INVALID:'响应解析失败',OUTPUT_INVALID:'响应格式无效',BATCH_SHAPE:'批次格式无效',BATCH_COUNT:'批次数量不符',ITEM_FIELDS:'结果字段无效',ITEM_ID:'结果标识无效',ITEM_DUPLICATE:'结果重复',TRANSLATION_TYPE:'译文类型无效',TRANSLATION_EMPTY:'译文为空',TRANSLATION_WHITESPACE:'译文含首尾空白',TRANSLATION_LENGTH:'译文长度异常',TRANSLATION_NO_HAN:'译文不含汉字',STALE:'请求状态已过期',CANCELLED:'请求已取消',NOT_READY:'服务尚未准备',DISCONNECTED:'连接器已断开',NATIVE_START:'连接器已启动',NATIVE_EXIT:'连接器已退出',NATIVE_RPC:'连接器通信失败',NATIVE_STDERR:'连接器报告错误',STDERR_AUTH:'连接器认证失败',STDERR_RATE_LIMIT:'连接器请求过频',STDERR_TIMEOUT:'连接器处理超时',STDERR_UNKNOWN:'连接器未知错误',STORAGE_ERROR:'本机存储失败',RENDER_INVALID:'呈现数据无效',NOT_DISPLAYED:'结果未能呈现',INTERRUPTED:'请求意外中断',SLOW_REQUEST:'请求耗时较长',REPEATED_FAILURE:'同类请求多次失败',FAILOVER:'服务故障转移',LOCAL_FALLBACK:'本机模型回落'};
const optionsIds = ['section-title','save-state','global-error','reading-domain','lookup-key','passage-delay','passage-delay-field','automation-all-sites','automation-video-sites','automation-site-form','automation-site-origin','automation-result','automation-site-list','automation-site-empty','keyword-hints-badge','keyword-hints-form','keyword-hints-keywords','keyword-hints-result','keyword-hints-dismissed-list','keyword-hints-dismissed-empty','rule-pack-form','rule-pack-json','rule-pack-result','rule-pack-list','rule-pack-empty','routing-enabled','routing-fields','routing-premium','routing-confidence','routing-ttl','routing-stats','request-concurrency','settings-search','search-results','video-font-size','video-theme','detection-chatgpt','detection-api','detection-subscription-model','detection-model-note','detection-use-translation-api','detection-api-model','detection-api-fields','detection-api-url','detection-api-key','detection-key-state','clear-detection-key','detection-jev','detection-jev-model','detection-jev-url','detection-jev-key','detection-jev-key-state','clear-detection-jev-key','save-recognition','domain-test-text','run-domain-test','domain-test-result','domain-rule-form','rule-host','rule-path','rule-domain','rule-subdomains','domain-rule-result','domain-rule-list','domain-rule-empty','term-form','term-source','term-translation','term-domain','term-list','term-empty','subscription-panel','api-panel','subscription-dot','subscription-state','subscription-detail','refresh-subscription','subscription-account','subscription-email','subscription-plan','subscription-model','subscription-model-note','login-subscription','cancel-subscription','logout-subscription','test-subscription','subscription-result','install-command','copy-install-command','provider-form','provider-url','provider-model','provider-keys','key-state','check-all-keys','test-provider','disconnect-provider','provider-result','remember-support','keyboard-nav','export-data','clear-memory','data-result','usage-list','usage-empty','usage-total','usage-clear','usage-result','open-extension-manager','help-language','api-service-select','new-api-service','provider-name','delete-api-service','cancel-api-service', 'reading-style-preview', 'reset-reading-style', 'diagnostics-storage-error','diagnostics-enabled','diagnostics-recording-note','diagnostics-native-dot','diagnostics-native-state','diagnostics-native-note','diagnostics-requests','diagnostics-failures','diagnostics-slow','diagnostics-pending','diagnostics-updated','diagnostics-issues','diagnostics-issues-empty','diagnostics-events','diagnostics-events-empty','export-diagnostics','clear-diagnostics','diagnostics-result']
const optionsEls = Object.fromEntries(optionsIds.map(id => [id.replace(/-([a-z])/g,(_match,char)=>char.toUpperCase()),document.querySelector(`#${id}`)]));
optionsEls.dataProblem = document.querySelector('#data-problem');
Object.assign(optionsEls,Object.fromEntries(['provider-id','provider-key-link','provider-fields','provider-model-list','provider-model-note','list-provider-models','provider-fallback','usage-budget','nano-dot','nano-state','nano-detail','nano-download','nano-refresh','nano-result','nano-progress'].map(id=>[id.replace(/-([a-z])/g,(_match,char)=>char.toUpperCase()),document.querySelector('#'+id)])));
Object.assign(optionsEls,Object.fromEntries(['persist-translation-cache','clear-translation-cache','translation-cache-result'].map(id=>[id.replace(/-([a-z])/g,(_match,char)=>char.toUpperCase()),document.querySelector('#'+id)])));
const optionsMissing = Object.entries(optionsEls).filter(([, element]) => !element).map(([key]) => key);
if (optionsMissing.length) throw new Error('设置页缺少元素：' + optionsMissing.join(', '));
const optionsProviderPicker=createProviderPicker(optionsEls.providerId,API_PROVIDERS);
const optionsSentenceDensityInputs=[...document.querySelectorAll('input[name="sentence-density"]')];
const optionsSentenceLineInputs=[...document.querySelectorAll('input[name="sentence-line-style"]')];
const optionsSentenceDensityResult=document.querySelector('#sentence-density-result');
const optionsLookupKeyCopies=[...document.querySelectorAll('[data-lookup-key]')];
const optionsLookupDisplayInputs=[...document.querySelectorAll('input[name="lookup-display"]')];
const optionsHintDisplayInputs=[...document.querySelectorAll('input[name="hint-display"]')];
const optionsPassageOpenInputs=[...document.querySelectorAll('input[name="passage-open"]')];
const optionsSentenceAllSites=document.querySelector('#sentence-groups-all-sites');
const optionsSentencePreview=document.querySelector('#sentence-structure-preview');
const optionsSentencePreviewSource=document.querySelector('#sentence-preview-source');
const ALL_HOSTS=['http://*/*','https://*/*'];
const optionsStructureHighlightNames=new Set();
const optionsReadingLayers = ['original','annotation','translation'];
const optionsReadingControls = Object.fromEntries(optionsReadingLayers.map(layer => [layer,{
  group:document.querySelector('[data-reading-layer="'+layer+'"]'),
  style:document.querySelector('#reading-'+layer+'-style'),
  size:document.querySelector('#reading-'+layer+'-size'),
  color:document.querySelector('#reading-'+layer+'-color'),
  palette:document.querySelector('#reading-'+layer+'-palette')
}]));
let optionsSentenceDensity='medium';
let optionsSentenceLineStyle='solid';
let optionsState = null;
// 目录控制器通过全局状态读取当前服务；赋值时同步，避免两份真实来源。
const setOptionsState = value => { optionsState = value; globalThis.optionsState = value; };
let optionsAutomation = null;
let optionsModels = [];
let optionsProviderDirty = false;let optionsDraftServiceId=null;let optionsDisplayedServiceId=null;
let optionsProviderModels=[];
const optionsDraftPermissionPatterns=new Set();
let optionsDetectionDirty = false;
let optionsSubscriptionBusy = false;
let optionsSaveTimer = 0;
let optionsSyncTimer = 0;
let optionsDiagnosticsBusy = false;
let optionsDiagnosticsSequence = 0;
let optionsDiagnosticsTimer = 0;
let optionsCurrentSection = '';
let optionsAppearanceView='structure';
for(const element of document.querySelectorAll('[data-video-feature]'))element.hidden=!VIDEO_SUPPORT_ENABLED;
const optionsAppearanceTabs=[...document.querySelectorAll('[data-appearance-tab]')].filter(tab=>!tab.hidden);
const optionsVideoPreviewStyle=document.createElement('style');
document.head.append(optionsVideoPreviewStyle);

function optionsShowError(error) { setResult(optionsEls.globalError,errorText(error),true); }
function optionsClearError() { setResult(optionsEls.globalError,''); }
function optionsShowSaved(message='已保存') { clearTimeout(optionsSaveTimer);optionsEls.saveState.textContent=message;optionsSaveTimer=setTimeout(()=>{optionsEls.saveState.textContent='';},1800); }
function optionsDomainName(domain) { return DOMAINS[domain] || domain || DOMAINS.general; }
function optionsProviderKind() { return optionsState?.settings?.providerKind === 'api' ? 'api' : 'chatgpt'; }
function optionsLookupKey(){const key=optionsState?.settings?.lookupKey;return typeof key==='string'&&/^[A-Z]$/.test(key)?key:'D';}
function optionsRenderLookupKey(){const key=optionsLookupKey();optionsEls.lookupKey.value=key;for(const copy of optionsLookupKeyCopies)copy.textContent=key;}
function optionsFillDomains(select,includeAuto) { select.replaceChildren();for(const [value,label] of Object.entries(DOMAINS)){if(!includeAuto&&value==='auto')continue;select.append(new Option(value==='auto'?'自动识别':label,value));} }
function optionsNavigate(hit) {
  const previous=optionsCurrentSection, requested=location.hash.slice(1);
  const section=optionsSections.includes(requested)?requested:'assistance';
  const apply=()=>{
    for(const name of optionsSections)document.getElementById(name).hidden=name!==section;
    const parent=['advanced','terms','diagnostics'].includes(section)?'advanced':section;
    for(const link of document.querySelectorAll('[data-section]')){
      const active=link.dataset.section===parent;
      link.classList.toggle('active',active);
      if(active)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');
    }
    for(const link of document.querySelectorAll('.section-links a')){
      if(link.hash==='#'+section)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');
    }
    optionsEls.sectionTitle.textContent=optionsLabels[section];
    document.title='RelyLess · '+optionsLabels[section];
    if(requested!==section)history.replaceState(null,'','#'+section);
    optionsCurrentSection=section;
  };
  if(previous&&previous!==section&&!hit?.element&&typeof document.startViewTransition==='function'&&!matchMedia('(prefers-reduced-motion: reduce)').matches)document.startViewTransition(apply);else apply();
  if(previous==='diagnostics'&&section!=='diagnostics')void optionsSyncState().catch(optionsShowError);
  clearInterval(optionsDiagnosticsTimer);optionsDiagnosticsTimer=0;
  if(section==='diagnostics'){
    if(previous!==section)void optionsRefreshDiagnostics();
    optionsDiagnosticsTimer=setInterval(()=>void optionsRefreshDiagnostics(),5000);
  }
  if(section==='appearance')optionsRenderAppearance();
  if(section==='service'){if(serviceCatalog)serviceCatalog.sync();void optionsRefreshUsage();}
  if(hit?.element){
    const target=hit.element;
    const panel=target.closest('[data-appearance-panel]');
    if(panel)optionsSelectAppearance(panel.dataset.appearancePanel);
    for(const details of document.getElementById(section).querySelectorAll('details'))if(details.contains(target))details.open=true;
    if(!target.hasAttribute('tabindex')&&!target.matches('summary, button, a, input, select, textarea'))target.tabIndex=-1;
    target.focus({preventScroll:true});target.scrollIntoView({block:'center'});
  }else if(previous!==section){
    requestAnimationFrame(()=>window.scrollTo(0,0));
    if(previous)optionsEls.sectionTitle.focus({preventScroll:true});
  }
}
let optionsUsageDays=7;
function usageTokensLabel(value,estimated){
  const format=n=>n>=1000000?(n/1000000).toFixed(1)+'M':n>=1000?(n/1000).toFixed(1)+'K':String(n);
  const parts=[];
  if(value>0)parts.push(format(value));
  if(estimated>0)parts.push('≈'+format(estimated));
  return parts.join(' + ')||'—';
}
async function optionsRefreshUsage(){
  try{
    const result=await request('USAGE_STATS',{days:optionsUsageDays});
    const usage=result.usage||{totals:{},models:[]};
    optionsEls.usageList.replaceChildren();
    for(const group of usage.models||[]){
      const row=document.createElement('div');row.className='usage-row';
      const info=document.createElement('div');info.className='usage-info';
      const title=document.createElement('b');title.textContent=(group.service||'未知服务')+' · '+(group.model||'未知模型');
      const detail=document.createElement('span');detail.textContent=(group.operations||[]).map(op=>(diagnosticOperationLabels[op.operation]||op.operation||'其他')+' '+op.requests+' 次').join(' · ');
      info.append(title,detail);
      const numbers=document.createElement('span');numbers.className='usage-numbers';
      numbers.textContent=group.requests+' 次'+(group.errors>0?'（失败 '+group.errors+'）':'')+' · 输入 '+usageTokensLabel(group.input,group.estInput)+' · 输出 '+usageTokensLabel(group.output,group.estOutput);
      row.append(info,numbers);
      optionsEls.usageList.append(row);
    }
    const totals=usage.totals||{};
    optionsEls.usageEmpty.hidden=Boolean((usage.models||[]).length);
    optionsEls.usageTotal.textContent=totals.requests>0?'合计 '+totals.requests+' 次请求 · 输入 '+usageTokensLabel(totals.input,totals.estInput)+' · 输出 '+usageTokensLabel(totals.output,totals.estOutput):'';
  }catch{optionsEls.usageTotal.textContent='统计暂不可用。';}
}
function optionsRenderModels(select,selected,note) { select.replaceChildren(new Option('由连接器选择默认模型',''));for(const model of optionsModels)select.append(new Option(model.name||model.id,model.id));select.value=[...select.options].some(option=>option.value===selected)?selected:'';note.textContent=optionsModels.length?'可选择账户当前可用模型。':'连接后刷新可用模型；留空由连接器选择。'; }
function optionsRenderAutomation() { const automation=optionsAutomation?.automation||optionsState.settings.automation||{allSites:false,sites:[],videoSites:false};optionsEls.automationAllSites.checked=Boolean(automation.allSites);optionsEls.automationVideoSites.checked=Boolean(automation.videoSites);optionsEls.automationSiteList.replaceChildren();for(const site of automation.sites||[]){const row=document.createElement('div');row.className='automation-site-item';const code=document.createElement('code');code.textContent=site.origin;const toggle=document.createElement('button');toggle.type='button';toggle.textContent=site.enabled?'已启用':'已停用';toggle.addEventListener('click',()=>void optionsToggleSite(site,!site.enabled));const remove=document.createElement('button');remove.className='delete-button';remove.type='button';remove.textContent='移除';remove.addEventListener('click',()=>void optionsToggleSite(site,null));row.append(code,toggle,remove);optionsEls.automationSiteList.append(row);}optionsEls.automationSiteEmpty.hidden=Boolean(automation.sites?.length);
const hints=automation.keywordHints||{badge:false,keywords:[],dismissed:[]};optionsEls.keywordHintsBadge.checked=Boolean(hints.badge);optionsEls.keywordHintsKeywords.value=hints.keywords.join(' ');optionsEls.keywordHintsDismissedList.replaceChildren();for(const origin of hints.dismissed||[]){const row=document.createElement('div');row.className='automation-site-item';const code=document.createElement('code');code.textContent=origin;const restore=document.createElement('button');restore.type='button';restore.textContent='恢复提示';restore.addEventListener('click',()=>void optionsRestoreKeywordHint(origin));row.append(code,restore);optionsEls.keywordHintsDismissedList.append(row);}optionsEls.keywordHintsDismissedEmpty.hidden=Boolean(hints.dismissed?.length); }
function optionsDetectionSettings(){return optionsState.settings.domainDetection||{mode:'local',subscriptionModel:'',apiModel:'',useTranslationApi:true,api:{baseUrl:'https://api.openai.com/v1',apiKey:''},jevModel:'typesafe/jev-1.13.0',jevApiKey:'',jevBaseUrl:'https://router.requesty.ai/v1'};}
function optionsRenderDetection(){const value=optionsDetectionSettings();const radio=document.querySelector(`input[name="domain-detection-mode"][value="${value.mode}"]`);if(radio)radio.checked=true;optionsEls.detectionChatgpt.hidden=value.mode!=='chatgpt';optionsEls.detectionApi.hidden=value.mode!=='api';optionsEls.detectionJev.hidden=value.mode!=='jev';optionsEls.detectionUseTranslationApi.checked=value.useTranslationApi!==false;optionsEls.detectionApiFields.hidden=optionsEls.detectionUseTranslationApi.checked;optionsRenderModels(optionsEls.detectionSubscriptionModel,value.subscriptionModel||'',optionsEls.detectionModelNote);if(!optionsDetectionDirty){optionsEls.detectionApiModel.value=value.apiModel||'';optionsEls.detectionApiUrl.value=value.api?.baseUrl||'https://api.openai.com/v1';optionsEls.detectionApiKey.value='';}const hasKey=Boolean(value.api?.apiKey);optionsEls.detectionApiKey.placeholder=hasKey?'已保存；同源留空保持':'输入单独的 API Key';optionsEls.detectionKeyState.textContent=hasKey?'单独的识别密钥已保存在本机。':'留空不会复制辅助 API 密钥。';optionsEls.clearDetectionKey.disabled=!hasKey;
  if(!optionsDetectionDirty){optionsEls.detectionJevModel.value=value.jevModel||'typesafe/jev-1.13.0';optionsEls.detectionJevUrl.value=value.jevBaseUrl||'https://router.requesty.ai/v1';optionsEls.detectionJevKey.value='';}
  const hasJevKey=Boolean(value.jevApiKey);
  optionsEls.detectionJevKey.placeholder=hasJevKey?'已保存；留空保持':'输入 Requesty 或兼容端点的 API Key';
  optionsEls.detectionJevKeyState.textContent=hasJevKey?'Jev 密钥已保存在本机。':'支持填入 Requesty 控制台 API Key 或兼容端点密钥。';
  optionsEls.clearDetectionJevKey.disabled=!hasJevKey;
}
function optionsDeleteButton(label,handler){const button=document.createElement('button');button.type='button';button.className='delete-button';button.textContent=label;button.addEventListener('click',handler);return button;}
function optionsRenderRules(){
  const rules=optionsState.settings.domainRules||[];
  optionsEls.domainRuleList.replaceChildren();
  rules.forEach((rule,index)=>{const row=document.createElement('div');row.className='rule-item';const info=document.createElement('div');const strong=document.createElement('b');strong.textContent=`${rule.includeSubdomains?'*.':''}${rule.host}${rule.pathPrefix}`;const domain=document.createElement('span');domain.textContent=optionsDomainName(rule.domain);info.append(strong,domain);row.append(info,optionsDeleteButton('删除',()=>void optionsSavePatch({domainRules:rules.filter((_item,itemIndex)=>itemIndex!==index)},'站点规则已删除')));optionsEls.domainRuleList.append(row);});
  optionsEls.domainRuleEmpty.hidden=Boolean(rules.length);
}
function optionsRenderRulePacks(){
  const packs=optionsState.settings.rulePacks||[];
  optionsEls.rulePackList.replaceChildren();
  packs.forEach((pack,index)=>{
    const row=document.createElement('div');row.className='automation-site-item';
    const info=document.createElement('div');
    const code=document.createElement('code');code.textContent=pack.name||pack.id;
    const summary=document.createElement('small');summary.textContent=pack.rules.map(rule=>rule.hosts[0]).join(' · ');
    info.append(code,summary);row.append(info,optionsDeleteButton('删除',()=>void optionsSavePatch({rulePacks:packs.filter((_item,itemIndex)=>itemIndex!==index)},'规则包已删除')));
    optionsEls.rulePackList.append(row);
  });
  optionsEls.rulePackEmpty.hidden=Boolean(packs.length);
}
function optionsRoutingOperations(){const checked=[...document.querySelectorAll('input[name="routing-operation"]:checked')].map(input=>input.value);const operations={};for(const input of document.querySelectorAll('input[name="routing-operation"]'))operations[input.value]=checked.includes(input.value);return operations;}
async function optionsRefreshRoutingStats(){try{const result=await request('ROUTING_STATS');const stats=result.routing||{};optionsEls.routingStats.textContent='已判 '+stats.judged+' 次 · 升级 '+stats.escalated+' 次 · 判卷失败 '+stats.judgeFailed+' 次 · 缓存命中 '+stats.cacheHits+' 次';}catch{optionsEls.routingStats.textContent='统计暂不可用。';}}
function optionsRenderRouting(){
  const routing=optionsState.settings.routing||{enabled:false,premiumServiceId:'',operations:{},minConfidence:0.7,cacheTtlMinutes:1440};
  optionsEls.routingEnabled.checked=routing.enabled===true;optionsEls.routingFields.hidden=!routing.enabled;
  const services=optionsState.settings.apiServices||[];
  optionsEls.routingPremium.replaceChildren(new Option('不升级（仅记录判断）',''),new Option('ChatGPT 订阅（已登录通道）','subscription'),...services.map(service=>new Option(service.name+' · '+service.model,service.id)));
  optionsEls.routingPremium.value=services.some(service=>service.id===routing.premiumServiceId)||routing.premiumServiceId==='subscription'?routing.premiumServiceId:'';
  for(const input of document.querySelectorAll('input[name="routing-operation"]'))input.checked=routing.operations?.[input.value]===true;
  optionsEls.routingConfidence.value=String(routing.minConfidence??0.7);
  optionsEls.routingTtl.value=String(routing.cacheTtlMinutes??1440);
  if(!optionsEls.routingFields.hidden)void optionsRefreshRoutingStats();
}
function optionsRenderTerms(){
  const terms=optionsState.settings.customTerms||[];
  optionsEls.termList.replaceChildren();
  terms.forEach((term,index)=>{const row=document.createElement('div');row.className='term-item';const source=document.createElement('h3');source.textContent=term.term;const translation=document.createElement('p');translation.textContent=term.translation;const domain=document.createElement('small');domain.textContent=optionsDomainName(term.domain);row.append(source,translation,domain,optionsDeleteButton('删除',()=>void optionsSavePatch({customTerms:terms.filter((_item,itemIndex)=>itemIndex!==index)},'术语已删除')));optionsEls.termList.append(row);});
  optionsEls.termEmpty.hidden=Boolean(terms.length);
}
function optionsRenderSubscription(){const subscription=optionsState?.subscription||{};const connected=Boolean(subscription.connected),authenticated=Boolean(subscription.authenticated),pending=Boolean(subscription.loginPending);optionsEls.subscriptionDot.classList.toggle('active',authenticated);optionsEls.subscriptionDot.classList.toggle('connected',connected&&!authenticated);optionsEls.subscriptionAccount.hidden=!authenticated;optionsEls.subscriptionEmail.textContent=subscription.email||'未提供';optionsEls.subscriptionPlan.textContent=subscription.plan||'未提供';if(!connected){optionsEls.subscriptionState.textContent='本机连接器未连接';optionsEls.subscriptionDetail.textContent=subscription.error||'请按下方步骤安装连接器。';}else if(authenticated){optionsEls.subscriptionState.textContent='ChatGPT 已登录';optionsEls.subscriptionDetail.textContent=subscription.error||'当前账户可用于英文线索与局部中文说明。';}else if(pending){optionsEls.subscriptionState.textContent='等待 ChatGPT 登录';optionsEls.subscriptionDetail.textContent=subscription.error||'请完成刚打开的登录流程。';}else{optionsEls.subscriptionState.textContent='连接器已就绪';optionsEls.subscriptionDetail.textContent=subscription.error||'登录后即可使用订阅权益。';}optionsRenderModels(optionsEls.subscriptionModel,optionsState?.settings?.subscriptionModel||'',optionsEls.subscriptionModelNote);optionsEls.loginSubscription.hidden=!connected||authenticated||pending;optionsEls.cancelSubscription.hidden=!pending;optionsEls.logoutSubscription.hidden=!authenticated;optionsEls.loginSubscription.disabled=optionsSubscriptionBusy||!connected;optionsEls.cancelSubscription.disabled=optionsSubscriptionBusy;optionsEls.logoutSubscription.disabled=optionsSubscriptionBusy;optionsEls.refreshSubscription.disabled=optionsSubscriptionBusy;optionsEls.subscriptionModel.disabled=optionsSubscriptionBusy||!authenticated;optionsEls.testSubscription.disabled=optionsSubscriptionBusy||optionsProviderKind()!=='chatgpt'||!optionsState?.providerConfigured;
  document.getElementById('subscription-model-field').hidden=!authenticated;
  optionsEls.testSubscription.hidden=!authenticated;
  const install=document.getElementById('connector-install');
  if(install.dataset.connected!==String(connected)){install.open=!connected;install.dataset.connected=String(connected);}
}
function optionsReadingStyleValue(){return globalThis.ShisuiReadingStyle.validate(Object.fromEntries(optionsReadingLayers.map(layer=>{const controls=optionsReadingControls[layer];return[layer,{style:controls.style.value,color:controls.group.dataset.color||'auto',size:Number(controls.size.value)}];})));}
let optionsReadingDraft=null,optionsReadingWrites=Promise.resolve();
function optionsSaveReadingStyle(readingStyle,message='阅读样式已保存'){optionsReadingDraft=readingStyle;optionsRenderReadingStyle();const save=async()=>{await optionsSavePatch({readingStyle},message);if(optionsReadingDraft===readingStyle){optionsReadingDraft=null;optionsRenderReadingStyle();}};optionsReadingWrites=optionsReadingWrites.then(save,save);return optionsReadingWrites;}
let optionsReadingPreviewObserver=null;
function optionsSizeStylePreview(){const doc=optionsEls.readingStylePreview.contentDocument;if(!doc?.body)return;const height=Math.ceil(doc.body.getBoundingClientRect().height),current=parseFloat(optionsEls.readingStylePreview.style.height)||0;if(current!==height)optionsEls.readingStylePreview.style.height=height+'px';}
function optionsObserveStylePreview(){optionsReadingPreviewObserver?.disconnect();const body=optionsEls.readingStylePreview.contentDocument?.body;if(!body)return;optionsReadingPreviewObserver=new ResizeObserver(optionsSizeStylePreview);optionsReadingPreviewObserver.observe(body);optionsSizeStylePreview();}
function optionsBuildReadingPalettes(){
  for(const layer of optionsReadingLayers){const container=optionsReadingControls[layer].palette;if(container.childElementCount)continue;const choices=[{id:'auto',label:'跟随网页',color:''},...globalThis.ShisuiReadingStyle.palettes];for(const choice of choices){const button=document.createElement('button');button.type='button';button.className='reading-color-option';button.dataset.color=choice.id==='auto'?'auto':choice.color;button.setAttribute('aria-label','颜色：'+choice.label);button.setAttribute('aria-pressed','false');const swatch=document.createElement('span');swatch.className='reading-color-swatch';swatch.setAttribute('aria-hidden','true');if(choice.id==='auto')swatch.dataset.auto='true';else swatch.style.setProperty('--swatch-color',choice.color);const label=document.createElement('span');label.textContent=choice.label;button.append(swatch,label);container.append(button);}}
}
function optionsUpdateReadingColorUI(layer){const controls=optionsReadingControls[layer],selected=controls.group.dataset.color||'auto';let preset=false;for(const button of controls.palette.querySelectorAll('button')){const active=button.dataset.color.toLowerCase()===selected.toLowerCase();button.classList.toggle('selected',active);button.setAttribute('aria-pressed',String(active));preset||=active;}controls.color.closest('.reading-custom-color').classList.toggle('selected',!preset);}
function optionsPreviewReadingStyle(value){
  const css=globalThis.ShisuiDesign.cssFor(':root')+'body{margin:0;padding:16px;font:16px/1.65 var(--sans);color:var(--ink);background:var(--paper);overflow-wrap:anywhere}p{margin:0 0 12px}'+globalThis.ShisuiReadingStyle.css(value,{mark:'#preview-word',hint:'#preview-hint',block:'#preview-translation',annotation:'#preview-annotation'});
  const existing=optionsEls.readingStylePreview.contentDocument?.getElementById('preview-style');if(existing){existing.textContent=css;optionsSizeStylePreview();return;}
  optionsEls.readingStylePreview.srcdoc='<!doctype html><html lang="en"><meta charset="utf-8"><style id="preview-style">'+css+'</style><body><p>The model uses <span id="preview-annotation" data-shisui-annotation="推理"><span id="preview-word">reasoning</span><span id="preview-hint" lang="zh-CN">推理</span></span> to compare possible answers.</p><div id="preview-translation" lang="zh-CN"><p>模型通过推理比较可能的答案。</p></div></body></html>';
}
function optionsRenderReadingStyle(){optionsBuildReadingPalettes();const value=globalThis.ShisuiReadingStyle.normalize(optionsReadingDraft||optionsState.settings.readingStyle);for(const layer of optionsReadingLayers){const controls=optionsReadingControls[layer],layerValue=value[layer];controls.style.value=layerValue.style;controls.size.value=String(layerValue.size);controls.group.dataset.color=layerValue.color;controls.color.value=layerValue.color==='auto'?globalThis.ShisuiReadingStyle.palettes[0].color:layerValue.color;optionsUpdateReadingColorUI(layer);}optionsPreviewReadingStyle(value);}
function optionsDiscardProviderDraft(){
  if(!optionsProviderDirty)return true;
  if(!optionsEls.providerKeys.value.trim()){optionsProviderDirty=false;return true;}
  return confirm('表单有未保存的更改。确定放弃这些更改吗？');
}
function optionsProviderOptions(){return Object.fromEntries([...optionsEls.providerFields.querySelectorAll('[data-provider-option]')].map(input=>[input.dataset.providerOption,input.value.trim()]));}
function optionsRenderProviderFields(meta,values={}){
  optionsEls.providerFields.replaceChildren();
  for(const field of meta.fields||[]){const label=document.createElement('label');label.className='field';const title=document.createElement('span');title.textContent=field.label;let input;if(field.type==='select'){input=document.createElement('select');for(const choice of field.options||[])input.append(new Option(choice.label,choice.value));}else{input=document.createElement('input');input.type='text';input.autocomplete='off';input.spellcheck=false;if(field.placeholder)input.placeholder=field.placeholder;}input.dataset.providerOption=field.key;input.value=values[field.key]??field.defaultValue??'';input.required=true;input.addEventListener('input',()=>{optionsProviderDirty=true;if(meta.id==='azure'&&(field.key==='resourceName'||field.key==='apiMode'))optionsEls.providerUrl.value=apiProviderBaseUrl(meta.id,optionsProviderOptions());});input.addEventListener('change',()=>{optionsProviderDirty=true;if(meta.id==='azure'||meta.id==='bedrock')optionsEls.providerUrl.value=apiProviderBaseUrl(meta.id,optionsProviderOptions());});label.append(title,input);optionsEls.providerFields.append(label);}
}
function optionsRenderProvider(selectedServiceId = null){
  if(selectedServiceId!==null)optionsDisplayedServiceId=selectedServiceId;
  const kind=optionsProviderKind(),radio=document.querySelector('input[name="provider-kind"][value="'+kind+'"]');if(radio)radio.checked=true;
  const isSubscription = serviceCatalog.isSubscriptionKey(serviceCatalog.selectedKey || optionsState.settings.providerKind);
  optionsEls.subscriptionPanel.hidden = !isSubscription;
  optionsEls.apiPanel.hidden = isSubscription;
  optionsRenderSubscription();
  const services=optionsState.settings.apiServices||[],active=activeApiProvider(optionsState.settings);
  const displayed=(optionsDraftServiceId?null:(services.find(s=>s.id===optionsDisplayedServiceId)||active||services[0]))||null;
  optionsEls.providerFallback.replaceChildren(new Option('不切换',''),...services.filter(service=>service.id!==displayed?.id).map(service=>new Option(service.name+' · '+service.model,service.id)));
  optionsEls.providerFallback.disabled=!optionsEls.providerFallback.options.length||optionsEls.providerFallback.options.length<2;
  const isActiveDisplayed=Boolean(displayed&&active&&displayed.id===active.id);
  const provider=optionsDraftServiceId?{id:optionsDraftServiceId,name:'',providerId:optionsEls.providerId.value||'openai',baseUrl:'',model:'',apiKey:'',options:{}}:displayed;
  optionsEls.apiServiceSelect.replaceChildren(...services.map(service=>new Option(service.name+' · '+service.model,service.id)));
  if(!services.length)optionsEls.apiServiceSelect.append(new Option('尚未保存 API 服务',''));
  optionsEls.apiServiceSelect.value=displayed?.id||optionsState.settings.activeApiServiceId||'';
  optionsEls.apiServiceSelect.disabled=!services.length;
  if(!optionsProviderDirty){
    const providerId=provider?(provider.providerId||'openai-compatible'):'openai',meta=getApiProvider(providerId)||getApiProvider('openai-compatible');
    optionsEls.providerId.value=meta.id;
    optionsRenderProviderFields(meta,provider?.options||{});
    optionsEls.providerName.value=provider?.name||meta.name;
    optionsEls.providerUrl.value=provider?.baseUrl||apiProviderBaseUrl(meta.id,provider?.options||{});
    optionsEls.providerModel.value=provider?.model||meta.defaultModel||'';
    optionsEls.providerKeys.value=(provider?.apiKeys||[]).join('\n');
    optionsEls.providerFallback.value=provider?.fallbackServiceId||'';
    optionsProviderModels=[];
  }
  optionsProviderPicker.sync();
  const meta=getApiProvider(optionsEls.providerId.value),hasKey=Boolean(provider?.apiKey||(provider?.apiKeys&&provider.apiKeys.length));
  optionsEls.providerKeyLink.hidden=!meta?.apiKeyUrl;
  optionsEls.providerKeyLink.href=meta?.apiKeyUrl||'#';
  const keyCount=(provider?.apiKeys||[]).length;
  optionsEls.providerKeys.placeholder=meta?.keyOptional?'可选；本地服务可不填密钥':('每行一个密钥，最多 8 个'+(hasKey?'；当前已保存 '+keyCount+' 个':''));
  optionsEls.keyState.textContent=meta?.keyOptional?'本地服务可不填密钥；填写后也只用于此服务。':keyCount>1?'已保存 '+keyCount+' 个密钥；请求按权重轮询，失败自动切换，约 1 分钟后恢复。':hasKey?'密钥保存在本机；更换服务商或域名不会带入。':'密钥只用于此服务，不会复制到其他服务。';
  optionsEls.providerModelList.replaceChildren(new Option(optionsProviderModels.length?'选择已获取的模型':'获取后选择',''),...optionsProviderModels.map(model=>new Option(model.name||model.id,model.id)));
  optionsEls.providerModelNote.textContent=optionsProviderModels.length?'已获取 '+optionsProviderModels.length+' 个模型；仍可手动填写模型 ID。':'也可直接填写模型 ID。';
  optionsEls.testProvider.disabled=!isActiveDisplayed||!displayed?.apiKey||Boolean(optionsDraftServiceId)||optionsProviderDirty;
  optionsEls.checkAllKeys.disabled=!isActiveDisplayed||!displayed?.apiKeys?.length||Boolean(optionsDraftServiceId)||optionsProviderDirty;
  optionsEls.disconnectProvider.disabled=!displayed?.apiKey||Boolean(optionsDraftServiceId);
  optionsEls.deleteApiService.disabled=!displayed||Boolean(optionsDraftServiceId);
  optionsEls.cancelApiService.hidden=!optionsDraftServiceId;
  optionsEls.newApiService.disabled=services.length>=20;
  const editor=document.getElementById('api-editor');
  if(!active||optionsDraftServiceId)editor.open=true;
  editor.querySelector('summary').textContent=optionsDraftServiceId||!displayed?'配置 API 服务':'编辑当前服务';
}
function optionsRenderSentenceDensity(){for(const input of optionsSentenceDensityInputs)input.checked=input.value===optionsSentenceDensity;}
function optionsRenderSentenceLineStyle(){for(const input of optionsSentenceLineInputs)input.checked=input.value===optionsSentenceLineStyle;}
function optionsRenderSentenceAllSites(){optionsSentenceAllSites.checked=Boolean((optionsAutomation?.automation||optionsState?.settings?.automation)?.sentenceGroupsAllSites);}
function optionsStructureSegments(){
  const relative='that each explanation provides',adverbial='before they reach a conclusion';
  if(optionsSentenceDensity==='coarse')return[['attributive',relative,3],['adverbial',adverbial,3]];
  const fine=optionsSentenceDensity==='fine',segments=[['subject','Careful readers',3],['predicate','compare',3],['object','the evidence '+relative,fine?9:3],['adverbial',adverbial,fine?9:3]];
  if(fine)segments.push(['attributive',relative,3],['subject','they',3],['predicate','reach',3],['object','a conclusion',3]);
  return segments;
}
function optionsClearStructureHighlights(){if(!globalThis.CSS?.highlights)return;for(const name of optionsStructureHighlightNames)CSS.highlights.delete(name);optionsStructureHighlightNames.clear();}
function optionsRenderStructurePreview(){
  if(optionsSentencePreview.hidden||!globalThis.CSS?.highlights)return;
  const text=optionsSentencePreviewSource.firstChild,{structureColors:colors,structureRoles:roles}=globalThis.ShisuiDesign,dark=matchMedia('(prefers-color-scheme: dark)').matches?1:0;
  optionsClearStructureHighlights();
  let css=document.querySelector('#sentence-preview-highlight-style');if(!css){css=document.createElement('style');css.id='sentence-preview-highlight-style';document.head.append(css);}
  const rules=[];
  for(const [role,fragment,offset] of optionsStructureSegments()){
    const start=text.data.indexOf(fragment);if(start<0)continue;
    const range=new Range();range.setStart(text,start);range.setEnd(text,start+fragment.length);
    const name='shisui-preview-'+role+'-'+offset;let highlight=CSS.highlights.get(name);
    if(!highlight){highlight=new Highlight();highlight.priority=offset===9?0:1;CSS.highlights.set(name,highlight);optionsStructureHighlightNames.add(name);rules.push('::highlight('+name+'){text-decoration:underline '+optionsSentenceLineStyle+' '+colors[roles[role][1]][dark]+' 1.5px;text-underline-offset:'+offset+'px;text-decoration-skip-ink:auto}');}
    highlight.add(range);
  }
  css.textContent=rules.join('');
}
function optionsRefreshStructurePreview(){optionsRenderAppearance();}
function optionsRenderAppearance(){
  const view=optionsAppearanceView;
  for(const tab of optionsAppearanceTabs){const active=tab.dataset.appearanceTab===view;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;}
  for(const panel of document.querySelectorAll('[data-appearance-panel]'))panel.hidden=panel.dataset.appearancePanel!==view;
  optionsSentencePreview.hidden=view!=='structure';
  optionsEls.readingStylePreview.hidden=!optionsReadingLayers.includes(view);
  optionsEls.resetReadingStyle.parentElement.hidden=!optionsReadingLayers.includes(view);
  const videoPreview=document.getElementById('video-style-preview');videoPreview.hidden=view!=='video';
  if(view==='structure')optionsRenderStructurePreview();else optionsClearStructureHighlights();
  if(optionsReadingLayers.includes(view))optionsSizeStylePreview();
  if(view==='video'){
    const video=optionsState?.settings?.video||{fontSize:20,theme:'auto'};
    optionsVideoPreviewStyle.textContent=globalThis.ShisuiDesign.cssFor('#video-style-preview',video.theme);
    videoPreview.querySelector('p').style.fontSize=video.fontSize+'px';
  }
}
function optionsSelectAppearance(view){optionsAppearanceView=view;optionsRenderAppearance();}
function optionsRenderPassageAction(){const action=optionsState.settings.passageAction||{open:'click',delay:600};for(const input of optionsPassageOpenInputs)input.checked=input.value===action.open;optionsEls.passageDelayField.hidden=action.open!=='hover';optionsEls.passageDelay.value=String(action.delay);}
function optionsRenderAll(){
  optionsEls.readingDomain.value=optionsState.settings.domain||'auto';
  optionsRenderLookupKey();
  for(const input of optionsLookupDisplayInputs)input.checked=input.value===(optionsState.settings.lookupDisplay||'card');
  for(const input of optionsHintDisplayInputs)input.checked=input.value===(optionsState.settings.hintDisplay||'direct');
  optionsEls.helpLanguage.value=optionsState.settings.helpLanguage||'zh';
  optionsEls.requestConcurrency.value=String(optionsState.settings.requestConcurrency||2);
  const mode=document.querySelector('input[name="assistance-mode"][value="'+(optionsState.settings.assistanceMode||'ambient')+'"]');
  if(mode)mode.checked=true;
  optionsEls.rememberSupport.checked=optionsState.settings.rememberSupport!==false;
  optionsEls.persistTranslationCache.checked=optionsState.settings.persistTranslationCache===true;
  optionsEls.keyboardNav.checked=optionsState.settings.keyboardNav?.enabled===true;
  optionsEls.usageBudget.value=String(optionsState.settings.usageBudget?.monthlyTokens||0)||'';
  setResult(optionsEls.dataProblem,optionsState.dataProblem||'',Boolean(optionsState.dataProblem));
  const video=optionsState.settings.video||{fontSize:20,theme:'auto'};
  optionsEls.videoFontSize.value=String(video.fontSize||20);optionsEls.videoTheme.value=video.theme||'auto';
  optionsRenderAutomation();optionsRenderSentenceAllSites();optionsRenderPassageAction();optionsRenderDetection();optionsRenderReadingStyle();optionsRenderSentenceDensity();optionsRenderSentenceLineStyle();optionsRenderRules();optionsRenderTerms();optionsRenderRulePacks();optionsRenderProvider();serviceCatalog.sync();optionsRenderRouting();void optionsRefreshStructurePreview();
}
async function optionsSavePatch(patch,message='已保存'){optionsClearError();try{setOptionsState(await request('STATE_PATCH',{patch}));optionsRenderAll();optionsShowSaved(message);return true;}catch(error){optionsShowError(error);optionsRenderAll();return false;}}
async function optionsPatchAutomation(patch,message){optionsClearError();try{optionsAutomation=await request('AUTOMATION_PATCH',{patch});optionsState.settings.automation=optionsAutomation.automation;optionsRenderAutomation();optionsRenderSentenceAllSites();void optionsRefreshStructurePreview();optionsShowSaved(message);return true;}catch(error){optionsShowError(error);optionsRenderAutomation();optionsRenderSentenceAllSites();void optionsRefreshStructurePreview();return false;}}
async function optionsSetSentenceLineStyle(lineStyle){
  if(!['solid','dashed','dotted','wavy'].includes(lineStyle))return;
  const previous=optionsSentenceLineStyle;optionsSentenceLineStyle=lineStyle;optionsRenderSentenceLineStyle();optionsRenderStructurePreview();
  optionsSentenceLineInputs.forEach(input=>{input.disabled=true;});setResult(optionsSentenceDensityResult,'正在保存…');
  try{const saved=await request('SENTENCE_GROUPS_LINE_STYLE_SET',{lineStyle});optionsSentenceLineStyle=saved.lineStyle;optionsRenderSentenceLineStyle();optionsRenderStructurePreview();setResult(optionsSentenceDensityResult,'下划线样式已保存，并已应用到开启的阅读页。');optionsShowSaved('下划线样式已保存');}
  catch(error){optionsSentenceLineStyle=previous;optionsRenderSentenceLineStyle();optionsRenderStructurePreview();setResult(optionsSentenceDensityResult,errorText(error),true);}
  finally{optionsSentenceLineInputs.forEach(input=>{input.disabled=false;});}
}
async function optionsSetSentenceDensity(density){
  if(!['coarse','medium','fine'].includes(density))return;
  const previous=optionsSentenceDensity;optionsSentenceDensity=density;optionsRenderSentenceDensity();optionsRenderStructurePreview();
  optionsSentenceDensityInputs.forEach(input=>{input.disabled=true;});setResult(optionsSentenceDensityResult,'正在保存…');
  try{const saved=await request('SENTENCE_GROUPS_DENSITY_SET',{density});optionsSentenceDensity=['coarse','medium','fine'].includes(saved?.density)?saved.density:density;optionsRenderSentenceDensity();optionsRenderStructurePreview();setResult(optionsSentenceDensityResult,'解构粒度已保存，并已应用到开启的阅读页。');optionsShowSaved('解构粒度已保存');}
  catch(error){optionsSentenceDensity=previous;optionsRenderSentenceDensity();optionsRenderStructurePreview();setResult(optionsSentenceDensityResult,errorText(error),true);}
  finally{optionsSentenceDensityInputs.forEach(input=>{input.disabled=false;});}
}
async function optionsToggleSite(site,enabled){const sites=optionsAutomation.automation.sites.filter(item=>item.origin!==site.origin);if(enabled!==null)sites.push({...site,enabled});await optionsPatchAutomation({sites},enabled===null?'网站已移除':'网站设置已保存');}
function optionsParseProviderURL(value){const baseUrl=value.trim();if(!baseUrl||baseUrl.length>2048)throw new Error('请输入有效的 API 地址。');let url;try{url=new URL(baseUrl);}catch{throw new Error('请输入有效的 API 地址。');}const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname);if(!url.hostname||(url.protocol!=='https:'&&!(url.protocol==='http:'&&loopback)))throw new Error('API 地址必须使用 HTTPS；仅本机地址可使用 HTTP。');if(url.username||url.password||url.search||url.hash)throw new Error('API 地址不能包含用户名、密码、查询参数或片段。');return{baseUrl:baseUrl.replace(/\/+$/,''),url};}
function optionsOriginPattern(baseUrl){try{return baseUrl?`${new URL(baseUrl).origin}/*`:'';}catch{return'';}}
function optionsCredentialPatterns(settings){const patterns=new Set();for(const service of settings.apiServices||[])if(service.baseUrl)patterns.add(optionsOriginPattern(service.baseUrl));const detection=settings.domainDetection;if(detection?.mode==='api'&&!detection.useTranslationApi&&detection.api?.apiKey&&detection.api?.baseUrl)patterns.add(optionsOriginPattern(detection.api.baseUrl));if(detection?.mode==='jev'&&detection.jevApiKey&&detection.jevBaseUrl)patterns.add(optionsOriginPattern(detection.jevBaseUrl));for(const site of settings.automation?.sites||[])if(site.enabled)patterns.add(site.origin+'/*');patterns.delete('');return patterns;}
async function optionsRemoveUnusedPermissions(before,after){if(after.automation?.allSites||after.automation?.sentenceGroupsAllSites)return;const needed=optionsCredentialPatterns(after);for(const pattern of optionsCredentialPatterns(before))if(!needed.has(pattern))await chrome.permissions.remove({origins:[pattern]});}
async function optionsEnsurePermission(pattern,needed){if(!needed)return false;const had=await chrome.permissions.contains({origins:[pattern]});const granted=had||await chrome.permissions.request({origins:[pattern]});if(!granted)throw new Error('未获得该服务域名的访问权限，配置尚未保存。');return !had;}
function optionsCurrentProviderService({allowEmptyModel=false}={}){
  const before=optionsState.settings,current=optionsDraftServiceId?null:(optionsState.settings.apiServices?.find(s=>s.id===optionsDisplayedServiceId)||activeApiProvider(before)),providerId=optionsEls.providerId.value,options=optionsProviderOptions(),baseUrl=optionsEls.providerUrl.value.trim()||apiProviderBaseUrl(providerId,options),pattern=optionsOriginPattern(baseUrl),sameCredentialScope=(current?.providerId||'openai-compatible')===providerId&&optionsOriginPattern(current?.baseUrl)===pattern;
  const draftKeys=[...new Set(optionsEls.providerKeys.value.split('\n').map(line=>line.trim()).filter(Boolean))].slice(0,8);
  const priorKeys=sameCredentialScope?(current?.apiKeys||[]):[];
  const keptKeys=draftKeys.length?draftKeys:priorKeys;
  const service=normalizeApiService({id:optionsDraftServiceId||current?.id||crypto.randomUUID(),name:optionsEls.providerName.value.trim()||getApiProvider(providerId)?.name||'',providerId,baseUrl,model:optionsEls.providerModel.value.trim(),apiKey:(keptKeys[0])||'',apiKeys:keptKeys,options,fallbackServiceId:optionsEls.providerFallback.value});
  if(!allowEmptyModel&&!service.model)throw new Error('请填写模型 ID。');if(service.name.length>60||service.model.length>150||service.apiKeys.some(key=>key.length>4096)||service.apiKeys.length>8)throw new Error('请检查服务名称、模型和密钥（每行一个，最多 8 个）。');if(!getApiProvider(providerId)?.keyOptional&&!service.apiKey)throw new Error('请填写此服务的 API Key。');return service;
}
async function optionsCleanupDraftPermissions(){for(const pattern of optionsDraftPermissionPatterns){if(!optionsCredentialPatterns(optionsState.settings).has(pattern))await chrome.permissions.remove({origins:[pattern]}).catch(()=>{});}optionsDraftPermissionPatterns.clear();}
async function optionsListProviderModels(){setResult(optionsEls.providerResult,'正在获取模型…');optionsEls.listProviderModels.disabled=true;let service,pattern,granted=false;try{service=optionsCurrentProviderService({allowEmptyModel:true});pattern=apiServiceOrigins(service)[0]+'/*';granted=await optionsEnsurePermission(pattern,true);if(granted)optionsDraftPermissionPatterns.add(pattern);const result=await request('API_MODELS_LIST',{service});optionsProviderModels=Array.isArray(result.models)?result.models.filter(model=>model&&typeof model.id==='string'):[];optionsRenderProvider();setResult(optionsEls.providerResult,optionsProviderModels.length?'已获取模型。可从列表选择，或继续手动填写 ID。':'服务商返回了空模型列表，请手动填写模型 ID。');}catch(error){if(granted){optionsDraftPermissionPatterns.delete(pattern);await chrome.permissions.remove({origins:[pattern]}).catch(()=>{});}setResult(optionsEls.providerResult,'无法获取模型：'+errorText(error)+' 仍可手动填写模型 ID。',true);}finally{optionsEls.listProviderModels.disabled=false;}}
async function optionsSaveProvider(event){
  event.preventDefault();setResult(optionsEls.providerResult,'');let service,pattern,granted=false;const before=structuredClone(optionsState.settings),current=optionsDraftServiceId?null:(optionsState.settings.apiServices?.find(s=>s.id===optionsDisplayedServiceId)||activeApiProvider(before));
  try{
    service=optionsCurrentProviderService();
    pattern=apiServiceOrigins(service)[0]+'/*';
    granted=await optionsEnsurePermission(pattern,true);
    const services=before.apiServices||[],apiServices=services.some(item=>item.id===service.id)?services.map(item=>item.id===service.id?service:item):[...services,service];
    if(!await optionsSavePatch({providerKind:'api',apiServices,activeApiServiceId:service.id},'服务已保存并切换')){
      if(granted&&!optionsCredentialPatterns(before).has(pattern))await chrome.permissions.remove({origins:[pattern]});
      return;
    }
    optionsDraftPermissionPatterns.delete(pattern);
    optionsDraftServiceId=null;
    optionsDisplayedServiceId=service.id;
    optionsProviderDirty=false;
    await optionsRemoveUnusedPermissions(before,optionsState.settings);
    if(serviceCatalog){
      serviceCatalog.userSelected=false;
      serviceCatalog.selectedKey=service.providerId||`saved:${service.id}`;
      serviceCatalog.sync();
    }
    optionsRenderProvider();
    document.getElementById('api-editor').open=false;
    setResult(optionsEls.providerResult,'已保存；其他服务配置保持不变。');
  }
  catch(error){
    if(granted&&!optionsCredentialPatterns(optionsState.settings).has(pattern))await chrome.permissions.remove({origins:[pattern]}).catch(()=>{});
    setResult(optionsEls.providerResult,errorText(error),true);
  }
}
async function optionsSaveDetection(){const mode=document.querySelector('input[name="domain-detection-mode"]:checked')?.value||'local',before=structuredClone(optionsState.settings),current=optionsDetectionSettings(),useTranslationApi=optionsEls.detectionUseTranslationApi.checked;let api=current.api||{baseUrl:'https://api.openai.com/v1',apiKey:''},parsed=null,granted=false,jevParsed=null,jevGranted=false;try{if(mode==='api'&&!useTranslationApi){parsed=optionsParseProviderURL(optionsEls.detectionApiUrl.value);const entered=optionsEls.detectionApiKey.value.trim();if(entered.length>4096)throw new Error('识别 API Key 过长。');api={baseUrl:parsed.baseUrl,apiKey:entered||(optionsOriginPattern(api.baseUrl)===`${parsed.url.origin}/*`?api.apiKey||'':'')};if(!optionsEls.detectionApiModel.value.trim())throw new Error('请填写识别模型。');granted=await optionsEnsurePermission(`${parsed.url.origin}/*`,Boolean(api.apiKey));}let jevBaseUrl=current.jevBaseUrl||'https://router.requesty.ai/v1',jevModel=optionsEls.detectionJevModel.value.trim()||current.jevModel||'typesafe/jev-1.13.0',jevApiKey=current.jevApiKey||'';
    if(mode==='jev'){
      if(!optionsEls.detectionJevModel.value.trim())throw new Error('请填写 Jev 模型。');
      jevParsed=optionsParseProviderURL(optionsEls.detectionJevUrl.value.trim()||'https://router.requesty.ai/v1');
      const entered=optionsEls.detectionJevKey.value.trim();
      if(entered.length>4096)throw new Error('Jev API Key 过长。');
      jevBaseUrl=jevParsed.baseUrl;jevApiKey=entered||(optionsOriginPattern(current.jevBaseUrl)===`${jevParsed.url.origin}/*`?current.jevApiKey||'':'');
      jevGranted=await optionsEnsurePermission(`${jevParsed.url.origin}/*`,Boolean(jevApiKey));
    }
    const saved=await optionsSavePatch({domainDetection:{mode,subscriptionModel:optionsEls.detectionSubscriptionModel.value,apiModel:optionsEls.detectionApiModel.value.trim(),useTranslationApi,api,jevModel,jevBaseUrl,jevApiKey}},'领域识别设置已保存');if(!saved)return;optionsDetectionDirty=false;await optionsRemoveUnusedPermissions(before,optionsState.settings);optionsRenderDetection();}catch(error){optionsShowError(error);}finally{const needed=optionsCredentialPatterns(optionsState.settings);if(granted&&parsed&&!needed.has(`${parsed.url.origin}/*`))await chrome.permissions.remove({origins:[`${parsed.url.origin}/*`]}).catch(()=>{});if(jevGranted&&jevParsed&&!needed.has(`${jevParsed.url.origin}/*`))await chrome.permissions.remove({origins:[`${jevParsed.url.origin}/*`]}).catch(()=>{});}}
async function optionsTestProvider(element){setResult(element,'正在测试当前服务…');optionsEls.testProvider.disabled=true;optionsEls.testSubscription.disabled=true;try{const result=await request('PROVIDER_TEST');setResult(element,`测试提示：${result.hint}`);}catch(error){setResult(element,`测试失败：${errorText(error)}`,true);}finally{optionsRenderProvider();}}
async function optionsSyncState(){if(optionsCurrentSection==='diagnostics')return;[optionsState,optionsAutomation]=await Promise.all([request('STATE_GET'),request('AUTOMATION_GET')]);globalThis.optionsState=optionsState;optionsState.settings.automation=optionsAutomation.automation;optionsRenderAll();}
async function optionsLoadModels(refresh=false){let loaded=true;try{const result=await request('MODELS_LIST',{refresh});optionsModels=Array.isArray(result.models)?result.models:[];}catch(error){loaded=false;setResult(optionsEls.subscriptionResult,'模型列表刷新失败：'+errorText(error),true);}if(optionsState){optionsRenderSubscription();optionsRenderDetection();}return loaded;}
async function optionsRefreshSubscription(refresh=false){if(optionsSubscriptionBusy)return;optionsSubscriptionBusy=true;optionsRenderSubscription();try{const subscription=await request('SUBSCRIPTION_STATUS');optionsState.subscription=subscription;await optionsSyncState();if(!subscription.connected||subscription.error){setResult(optionsEls.subscriptionResult,'');return;}if(await optionsLoadModels(refresh))setResult(optionsEls.subscriptionResult,'账户与模型已更新。');}catch(error){setResult(optionsEls.subscriptionResult,errorText(error),true);}finally{optionsSubscriptionBusy=false;optionsRenderSubscription();}}
async function optionsSubscriptionAction(type){if(optionsSubscriptionBusy)return;optionsSubscriptionBusy=true;optionsRenderSubscription();try{optionsState.subscription=await request(type);await optionsSyncState();setResult(optionsEls.subscriptionResult,type==='SUBSCRIPTION_LOGOUT'?'已退出 ChatGPT 登录。':'状态已更新。');}catch(error){setResult(optionsEls.subscriptionResult,errorText(error),true);}finally{optionsSubscriptionBusy=false;optionsRenderSubscription();}}
async function optionsExportData(){setResult(optionsEls.dataResult,'正在导出…');try{const payload=await request('READING_DATA_EXPORT');downloadJson(payload,`relyless-support-data-${new Date().toISOString().slice(0,10)}.json`);setResult(optionsEls.dataResult,'本机支持数据已导出。');}catch(error){setResult(optionsEls.dataResult,errorText(error),true);}}
function optionsDiagnosticNumber(value){return Number.isFinite(value)&&value>=0?String(value):'—';}
function optionsDiagnosticTime(value){if(!Number.isFinite(value))return '时间未知';const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleString('zh-CN',{hour12:false}):'时间未知';}
function optionsDiagnosticFingerprint(event){const ref=event.modelRef||event.providerRef;return typeof ref==='string'?ref.slice(0,12)+'…':'';}
function optionsDiagnosticLabel(code){return diagnosticCodeLabels[code]||'其他异常';}
function optionsRenderDiagnostics(payload){
  const summary=payload?.summary||{},native=payload?.native||{};
  optionsEls.diagnosticsEnabled.checked=payload?.enabled!==false;
  optionsEls.diagnosticsRecordingNote.textContent=payload?.enabled===false?'诊断记录已关闭；已有记录会按保留规则清理。':'已开启，仅记录去除正文与响应后的结构化信息。';
  optionsEls.diagnosticsStorageError.hidden=!payload?.storageError;
  optionsEls.diagnosticsNativeDot.classList.toggle('active',Boolean(native.connected));
  optionsEls.diagnosticsNativeState.textContent=native.connected?'连接器已连接':'连接器未连接';
  optionsEls.diagnosticsNativeNote.textContent=native.pendingClear?'连接器文件的清空请求待下次连接执行；不会为此启动连接器。':native.connected?(native.mirror?'本机诊断镜像通道已就绪。':'连接器可用；诊断设置尚未同步，请更新连接器后刷新连接。'):'可导出扩展诊断；连接器开关将在下次连接同步，查看诊断不会拉起连接器。';
  optionsEls.diagnosticsRequests.textContent=optionsDiagnosticNumber(summary.requests);
  optionsEls.diagnosticsFailures.textContent=optionsDiagnosticNumber(summary.failures);
  optionsEls.diagnosticsSlow.textContent=optionsDiagnosticNumber(summary.slow);
  optionsEls.diagnosticsPending.textContent=optionsDiagnosticNumber(summary.pending);
  const issues=Array.isArray(summary.issues)?summary.issues:[];
  optionsEls.diagnosticsIssues.replaceChildren();
  for(const issue of issues){const row=document.createElement('div');row.className='diagnostics-issue';const text=document.createElement('div');const title=document.createElement('b');title.textContent=optionsDiagnosticLabel(issue.code);const operation=document.createElement('span');operation.textContent=diagnosticOperationLabels[issue.operation]||'其他操作';text.append(title,operation);const count=document.createElement('strong');count.textContent=optionsDiagnosticNumber(issue.count);count.setAttribute('aria-label',`${count.textContent} 次`);row.append(text,count);optionsEls.diagnosticsIssues.append(row);}
  optionsEls.diagnosticsIssuesEmpty.hidden=issues.length>0;
  const events=(Array.isArray(payload?.events)?payload.events:[]).slice().sort((a,b)=>(Number(b?.at)||0)-(Number(a?.at)||0)).slice(0,50);
  optionsEls.diagnosticsEvents.replaceChildren();
  for(const event of events){const row=document.createElement('article');row.className=`diagnostics-event status-${event.status||'unknown'}`;const head=document.createElement('div');const operation=document.createElement('b');operation.textContent=diagnosticOperationLabels[event.operation]||'其他操作';const status=document.createElement('span');status.textContent=diagnosticStatusLabels[event.status]||'状态未知';head.append(operation,status);const details=document.createElement('dl');const values=[['失败条目',Number.isInteger(event.itemIndex)?'第 '+(event.itemIndex+1)+' 项':''],['字符数',Number.isInteger(event.translationLength)?String(event.translationLength):''],['批次 ID',event.inputIds?.join(', ')],['返回 ID',event.outputIds?.join(', ')],['字段',event.fields?.join(', ')],['HTTP 状态',event.httpStatus?String(event.httpStatus):''],['请求类型',({word:'单词',phrase:'短语',passage:'选段'})[event.kind]],['时间',optionsDiagnosticTime(event.at)],['追踪 ID',event.traceId],['阶段',diagnosticStageLabels[event.stage]||'其他阶段'],['耗时',Number.isFinite(event.durationMs)?`${event.durationMs} ms`:''],['模型指纹',optionsDiagnosticFingerprint(event)]];for(const [label,value] of values){if(!value)continue;const group=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value;group.append(dt,dd);details.append(group);}row.append(head,details);optionsEls.diagnosticsEvents.append(row);}
  optionsEls.diagnosticsEventsEmpty.hidden=events.length>0;
  optionsEls.diagnosticsUpdated.textContent='刚刚更新';
}
function optionsDiagnosticsVisible(){return optionsCurrentSection==='diagnostics'&&!document.hidden;}
async function optionsRefreshDiagnostics(){if(!optionsDiagnosticsVisible()||optionsDiagnosticsBusy)return;const sequence=++optionsDiagnosticsSequence;optionsDiagnosticsBusy=true;try{const payload=await request('DIAGNOSTICS_GET');if(sequence===optionsDiagnosticsSequence)optionsRenderDiagnostics(payload);}catch(error){if(sequence===optionsDiagnosticsSequence)setResult(optionsEls.diagnosticsResult,errorText(error),true);}finally{if(sequence===optionsDiagnosticsSequence)optionsDiagnosticsBusy=false;}}
async function optionsSetDiagnosticsEnabled(){const enabled=optionsEls.diagnosticsEnabled.checked,sequence=++optionsDiagnosticsSequence;optionsDiagnosticsBusy=true;optionsEls.diagnosticsEnabled.disabled=true;setResult(optionsEls.diagnosticsResult,'正在保存…');try{const payload=await request('DIAGNOSTICS_SET',{enabled});if(sequence===optionsDiagnosticsSequence){optionsRenderDiagnostics(payload);setResult(optionsEls.diagnosticsResult,enabled?'诊断记录已开启。':'诊断记录已关闭。');}}catch(error){if(sequence===optionsDiagnosticsSequence){optionsEls.diagnosticsEnabled.checked=!enabled;setResult(optionsEls.diagnosticsResult,errorText(error),true);}}finally{if(sequence===optionsDiagnosticsSequence){optionsDiagnosticsBusy=false;optionsEls.diagnosticsEnabled.disabled=false;}}}
async function optionsExportDiagnostics(){optionsEls.exportDiagnostics.disabled=true;setResult(optionsEls.diagnosticsResult,'正在导出…');try{const payload=await request('DIAGNOSTICS_EXPORT');downloadJson(payload,`relyless-diagnostics-${new Date().toISOString().slice(0,10)}.json`);setResult(optionsEls.diagnosticsResult,'诊断 JSON 已导出。');}catch(error){setResult(optionsEls.diagnosticsResult,errorText(error),true);}finally{optionsEls.exportDiagnostics.disabled=false;}}
async function optionsClearDiagnostics(){if(!confirm('确定清空全部诊断记录吗？此操作不会清除阅读记忆或个人词档案。'))return;const sequence=++optionsDiagnosticsSequence;optionsDiagnosticsBusy=true;optionsEls.clearDiagnostics.disabled=true;try{const payload=await request('DIAGNOSTICS_CLEAR');if(sequence===optionsDiagnosticsSequence){optionsRenderDiagnostics(payload);setResult(optionsEls.diagnosticsResult,payload.native?.pendingClear?'扩展诊断已清空；连接器日志待下次连接清空。阅读记忆保持不变。':'诊断记录已清空；阅读记忆保持不变。');}}catch(error){if(sequence===optionsDiagnosticsSequence)setResult(optionsEls.diagnosticsResult,errorText(error),true);}finally{if(sequence===optionsDiagnosticsSequence){optionsDiagnosticsBusy=false;optionsEls.clearDiagnostics.disabled=false;}}}

optionsEls.readingStylePreview.addEventListener('load',optionsObserveStylePreview);
for(const layer of optionsReadingLayers){const controls=optionsReadingControls[layer];for(const input of [controls.style,controls.size])input.addEventListener('change',()=>{const readingStyle=optionsReadingStyleValue();optionsPreviewReadingStyle(readingStyle);void optionsSaveReadingStyle(readingStyle);});controls.palette.addEventListener('click',event=>{const button=event.target.closest('button[data-color]');if(!button)return;const color=button.dataset.color;controls.group.dataset.color=color;if(color!=='auto'){controls.color.value=color;if(controls.style.value==='plain'||(layer!=='original'&&controls.style.value==='default'))controls.style.value='color';}optionsUpdateReadingColorUI(layer);const readingStyle=optionsReadingStyleValue();optionsPreviewReadingStyle(readingStyle);void optionsSaveReadingStyle(readingStyle);});controls.color.addEventListener('input',()=>{controls.group.dataset.color=controls.color.value;if(controls.style.value==='plain'||(layer!=='original'&&controls.style.value==='default'))controls.style.value='color';optionsUpdateReadingColorUI(layer);optionsPreviewReadingStyle(optionsReadingStyleValue());});controls.color.addEventListener('change',()=>{const readingStyle=optionsReadingStyleValue();optionsPreviewReadingStyle(readingStyle);void optionsSaveReadingStyle(readingStyle);});}
optionsEls.resetReadingStyle.addEventListener('click',()=>void optionsSaveReadingStyle(structuredClone(globalThis.ShisuiReadingStyle.defaults),'已恢复默认样式'));
optionsEls.newApiService.addEventListener('click',async()=>{if(!optionsDiscardProviderDraft())return;await optionsCleanupDraftPermissions();optionsDraftServiceId=crypto.randomUUID();optionsDisplayedServiceId=null;optionsProviderDirty=false;optionsProviderModels=[];if(serviceCatalog){serviceCatalog.userSelected=true;serviceCatalog.selectedKey='openai-compatible';serviceCatalog.renderRailList();}optionsRenderProvider();setResult(optionsEls.providerResult,'正在新增服务；保存前不会改变当前服务。');document.getElementById('provider-trigger').focus();});
optionsEls.cancelApiService.addEventListener('click',async()=>{if(!optionsDiscardProviderDraft())return;await optionsCleanupDraftPermissions();optionsDraftServiceId=null;optionsProviderDirty=false;optionsProviderModels=[];if(serviceCatalog){serviceCatalog.userSelected=false;serviceCatalog.sync();}optionsRenderProvider();setResult(optionsEls.providerResult,'');});
optionsEls.apiServiceSelect.addEventListener('change',async()=>{const id=optionsEls.apiServiceSelect.value;if(!optionsDiscardProviderDraft()){optionsEls.apiServiceSelect.value=optionsDisplayedServiceId||optionsState.settings.activeApiServiceId||'';return;}const service=optionsState.settings.apiServices.find(item=>item.id===id);if(!service)return;try{await optionsCleanupDraftPermissions();await optionsEnsurePermission(optionsOriginPattern(service.baseUrl),true);optionsDraftServiceId=null;optionsDisplayedServiceId=id;optionsProviderDirty=false;optionsProviderModels=[];await optionsSavePatch({providerKind:'api',activeApiServiceId:id},'已切换到 '+service.name);if(serviceCatalog){serviceCatalog.userSelected=false;serviceCatalog.selectedKey=service.providerId||`saved:${service.id}`;serviceCatalog.sync();}optionsRenderProvider();}catch(error){optionsShowError(error);optionsRenderProvider();}});
optionsEls.deleteApiService.addEventListener('click',async()=>{const services=optionsState.settings.apiServices||[];const target=services.find(s=>s.id===optionsDisplayedServiceId)||activeApiProvider(optionsState.settings);if(!target)return;const before=structuredClone(optionsState.settings),apiServices=before.apiServices.filter(service=>service.id!==target.id),next=apiServices[0];if(!confirm('删除“'+target.name+'”及其密钥？'+(next?'当前服务将切换到“'+next.name+'”。':'将不再使用任何 API 服务。')+'其他服务配置不会删除。'))return;const activeApiServiceId=optionsState.settings.activeApiServiceId===target.id?(next?.id||''):optionsState.settings.activeApiServiceId;if(await optionsSavePatch({apiServices,activeApiServiceId},'服务已删除')){optionsDisplayedServiceId=next?.id||null;optionsProviderDirty=false;await optionsRemoveUnusedPermissions(before,optionsState.settings);if(serviceCatalog){serviceCatalog.userSelected=false;serviceCatalog.sync();}optionsRenderProvider();}});
optionsEls.providerName.addEventListener('input',()=>{optionsProviderDirty=true;});
optionsEls.providerId.addEventListener('change',async()=>{if(!optionsDiscardProviderDraft()){optionsProviderDirty=false;optionsRenderProvider();return;}await optionsCleanupDraftPermissions();const meta=getApiProvider(optionsEls.providerId.value);optionsRenderProviderFields(meta);optionsEls.providerName.value=meta.name;optionsEls.providerUrl.value=apiProviderBaseUrl(meta.id,optionsProviderOptions());optionsEls.providerModel.value=meta.defaultModel||'';optionsEls.providerKeys.value='';optionsProviderModels=[];optionsProviderDirty=false;optionsRenderProvider();setResult(optionsEls.providerResult,'服务商已更改；密钥不会从原服务带入。');});

const optionsSearchIndex={};
let optionsSearchReady=false,optionsSearchHits=[];
function optionsBuildSearchIndex(){
  if(optionsSearchReady)return;
  for(const name of optionsSections){
    const root=document.getElementById(name);if(!root)continue;
    const labels=[];
    root.querySelectorAll('legend, summary, .field > span, .choice-cards b, .adaptive-setting b, h3').forEach(element=>{
      if(element.closest('[data-video-feature][hidden]'))return;
      const label=element.textContent.replace(/\s+/g,' ').trim();
      if(label)labels.push({section:name,label,element});
    });
    optionsSearchIndex[name]=labels;
  }
  optionsSearchReady=true;
}
function optionsApplySearch(){
  const query=optionsEls.settingsSearch.value.trim().toLowerCase();
  const links=[...document.querySelectorAll('.sidebar nav a')],groups=[...document.querySelectorAll('.sidebar .nav-group-label')];
  const results=optionsEls.searchResults;
  if(!query){optionsSearchHits=[];links.forEach(a=>a.hidden=false);groups.forEach(g=>g.hidden=false);results.hidden=true;results.replaceChildren();return;}
  optionsBuildSearchIndex();
  const hits=[];let anyVisible=false;
  for(const a of links){
    const section=a.dataset.section,navMatch=a.textContent.toLowerCase().includes(query);
    const deep=(optionsSearchIndex[section]||[]).filter(hit=>hit.label.toLowerCase().includes(query));
    a.hidden=!(navMatch||deep.length);
    if(!a.hidden)anyVisible=true;
    hits.push(...deep.slice(0,4));
  }
  groups.forEach(g=>g.hidden=true);
  optionsSearchHits=hits.slice(0,12);
  results.replaceChildren();
  if(optionsSearchHits.length){
    for(const [index,hit] of optionsSearchHits.entries()){
      const button=document.createElement('button');button.type='button';button.dataset.section=hit.section;button.dataset.searchIndex=String(index);
      const label=document.createElement('span');label.textContent=hit.label;
      const where=document.createElement('span');where.className='search-section';where.textContent=' · '+(optionsLabels[hit.section]||hit.section);
      button.append(label,where);results.append(button);
    }
  }else if(!anyVisible){const empty=document.createElement('span');empty.className='search-empty';empty.textContent='没有匹配的设置。';results.append(empty);}
  results.hidden=!results.childElementCount;
}
optionsEls.settingsSearch.addEventListener('input',optionsApplySearch);
optionsEls.settingsSearch.addEventListener('keydown',event=>{
  if(event.key==='Escape'){optionsEls.settingsSearch.value='';optionsApplySearch();return;}
  if(event.key==='Enter'){event.preventDefault();const button=optionsEls.searchResults.querySelector('button');const link=document.querySelector('.sidebar nav a:not([hidden])');if(button){button.click();}else if(link){location.hash=link.getAttribute('href');}}
});
optionsEls.searchResults.addEventListener('click',event=>{
  const button=event.target.closest('button[data-search-index]');if(!button)return;
  const hit=optionsSearchHits[Number(button.dataset.searchIndex)];if(!hit)return;
  optionsEls.settingsSearch.value='';optionsApplySearch();
  if(location.hash!=='#'+hit.section)history.pushState(null,'','#'+hit.section);
  optionsNavigate(hit);
});
window.addEventListener('hashchange',optionsNavigate);
for(const tab of optionsAppearanceTabs){
  tab.addEventListener('click',()=>optionsSelectAppearance(tab.dataset.appearanceTab));
  tab.addEventListener('keydown',event=>{
    const index=optionsAppearanceTabs.indexOf(tab),last=optionsAppearanceTabs.length-1;
    const next=event.key==='ArrowRight'?(index+1)%(last+1):event.key==='ArrowLeft'?(index+last)%(last+1):event.key==='Home'?0:event.key==='End'?last:null;
    if(next===null)return;event.preventDefault();optionsSelectAppearance(optionsAppearanceTabs[next].dataset.appearanceTab);optionsAppearanceTabs[next].focus();
  });
}
optionsEls.readingDomain.addEventListener('change',()=>void optionsSavePatch({domain:optionsEls.readingDomain.value}));
optionsEls.lookupKey.addEventListener('change',()=>{const lookupKey=optionsEls.lookupKey.value;void optionsSavePatch({lookupKey},'查词按键已设为 '+lookupKey);});
optionsEls.routingEnabled.addEventListener('change',async()=>{const enabled=optionsEls.routingEnabled.checked;optionsEls.routingFields.hidden=!enabled;await optionsSavePatch({routing:{enabled}},'模型路由已'+(enabled?'开启':'关闭'));if(enabled)void optionsRefreshRoutingStats();});
optionsEls.routingPremium.addEventListener('change',()=>void optionsSavePatch({routing:{premiumServiceId:optionsEls.routingPremium.value}},'升级目标已保存'));
optionsEls.routingConfidence.addEventListener('change',()=>void optionsSavePatch({routing:{minConfidence:Number(optionsEls.routingConfidence.value)}},'最低把握度已保存'));
optionsEls.routingTtl.addEventListener('change',()=>void optionsSavePatch({routing:{cacheTtlMinutes:Number(optionsEls.routingTtl.value)}},'缓存时长已保存'));
optionsEls.requestConcurrency.addEventListener('change',()=>void optionsSavePatch({requestConcurrency:Number(optionsEls.requestConcurrency.value)},'并发请求数已保存'));
document.querySelectorAll('input[name="routing-operation"]').forEach(input=>input.addEventListener('change',()=>void optionsSavePatch({routing:{operations:optionsRoutingOperations()}},'路由操作已保存')));
optionsEls.rulePackForm.addEventListener('submit',event=>{
  event.preventDefault();optionsClearError();
  let value=null;
  try{value=JSON.parse(optionsEls.rulePackJson.value);}catch(error){setResult(optionsEls.rulePackResult,'JSON 解析失败：'+error.message,true);return;}
  const {pack,issues}=parseRulePack(value);
  if(!pack){const message=issues.slice(0,6).map(issue=>(issue.path?issue.path+'：':'')+issue.message).join('；');setResult(optionsEls.rulePackResult,'规则包未导入：'+message+(issues.length>6?' 等 '+issues.length+' 处问题':''),true);return;}
  const packs=[...(optionsState.settings.rulePacks||[]).filter(item=>item.id!==pack.id),pack];
  void optionsSavePatch({rulePacks:packs},'规则包“'+(pack.name||pack.id)+'”已导入').then(ok=>{if(ok)optionsEls.rulePackJson.value='';});
});
optionsPassageOpenInputs.forEach(input=>input.addEventListener('change',()=>void optionsSavePatch({passageAction:{open:input.value}},'划词动作打开方式已保存')));
optionsEls.passageDelay.addEventListener('change',()=>void optionsSavePatch({passageAction:{delay:Number(optionsEls.passageDelay.value)}},'悬停等待已设为 '+optionsEls.passageDelay.value+' 毫秒'));
optionsSentenceDensityInputs.forEach(input=>input.addEventListener('change',()=>void optionsSetSentenceDensity(input.value)));
optionsSentenceLineInputs.forEach(input=>input.addEventListener('change',()=>void optionsSetSentenceLineStyle(input.value)));
optionsSentenceAllSites.addEventListener('change',async()=>{const enabled=optionsSentenceAllSites.checked;optionsSentenceAllSites.disabled=true;try{if(enabled&&!await chrome.permissions.request({origins:ALL_HOSTS}))throw new Error('未授予全部网站权限，原设置保持不变。');await optionsPatchAutomation({sentenceGroupsAllSites:enabled},enabled?'所有网站阅读解构已开启':'所有网站阅读解构已关闭');}catch(error){optionsShowError(error);optionsRenderSentenceAllSites();void optionsRefreshStructurePreview();}finally{optionsSentenceAllSites.disabled=false;}});
document.querySelectorAll('input[name="assistance-mode"]').forEach(input=>input.addEventListener('change',()=>void optionsSavePatch({assistanceMode:input.value},input.value==='on-demand'?'已切换为仅在需要时':'已恢复阅读时辅助')));
optionsLookupDisplayInputs.forEach(input=>input.addEventListener('change',()=>void optionsSavePatch({lookupDisplay:input.value},'查词显示方式已保存')));
optionsHintDisplayInputs.forEach(input=>input.addEventListener('change',()=>void optionsSavePatch({hintDisplay:input.value},'行内提示显示已保存')));
optionsEls.rememberSupport.addEventListener('change',()=>void optionsSavePatch({rememberSupport:optionsEls.rememberSupport.checked},optionsEls.rememberSupport.checked?'已开启本机支持记忆':'已关闭本机支持记忆'));
optionsEls.persistTranslationCache.addEventListener('change',()=>void optionsSavePatch({persistTranslationCache:optionsEls.persistTranslationCache.checked},optionsEls.persistTranslationCache.checked?'已开启跨会话缓存':'已关闭并删除持久缓存'));
optionsEls.clearTranslationCache.addEventListener('click',async()=>{if(!confirm('清空本次会话与本机持久的帮助和译文缓存？'))return;try{await request('CACHE_CLEAR');setResult(optionsEls.translationCacheResult,'缓存已清空。');}catch(error){setResult(optionsEls.translationCacheResult,errorText(error),true);}});
optionsEls.keyboardNav?.addEventListener('change',()=>void optionsSavePatch({keyboardNav:{enabled:optionsEls.keyboardNav.checked}},optionsEls.keyboardNav.checked?'已开启键盘导航':'已关闭键盘导航'));
optionsEls.usageBudget.addEventListener('change',()=>{const value=Math.max(0,Math.floor(Number(optionsEls.usageBudget.value)||0));optionsEls.usageBudget.value=String(value);void optionsSavePatch({usageBudget:{monthlyTokens:value}},value?'月度预算已设为 '+value+' tokens':'已取消月度预算限制');});
optionsEls.automationAllSites.addEventListener('change',async()=>{const enabled=optionsEls.automationAllSites.checked;try{if(enabled&&!await chrome.permissions.request({origins:['http://*/*','https://*/*']}))throw new Error('未授予全部网站权限，原设置保持不变。');await optionsPatchAutomation({allSites:enabled},enabled?'全部网站自动辅助已开启':'全部网站自动辅助已关闭');}catch(error){optionsShowError(error);optionsRenderAutomation();}});
optionsEls.automationVideoSites.addEventListener('change',async()=>{const enabled=optionsEls.automationVideoSites.checked;try{if(enabled&&!await chrome.permissions.request({origins:['https://www.youtube.com/*','https://m.youtube.com/*']}))throw new Error('未授予视频网站权限，原设置保持不变。');await optionsPatchAutomation({videoSites:enabled},enabled?'视频入口已开启':'视频入口已关闭');}catch(error){optionsShowError(error);optionsRenderAutomation();}});
async function optionsRestoreKeywordHint(origin){const current=optionsAutomation.automation.keywordHints;await optionsPatchAutomation({keywordHints:{...current,dismissed:current.dismissed.filter(entry=>entry!==origin)}},'已恢复此网站的提示');}
optionsEls.keywordHintsBadge.addEventListener('change',async()=>{const badge=optionsEls.keywordHintsBadge.checked;try{await optionsPatchAutomation({keywordHints:{...optionsAutomation.automation.keywordHints,badge}},badge?'图标提示已开启':'图标提示已关闭');}catch(error){optionsShowError(error);optionsRenderAutomation();}});
optionsEls.keywordHintsForm.addEventListener('submit',async event=>{event.preventDefault();optionsClearError();const current=optionsAutomation.automation.keywordHints,keywords=[...new Set(optionsEls.keywordHintsKeywords.value.split(/[\s,，、]+/).map(entry=>entry.trim().toLowerCase()).filter(Boolean))];try{optionsAutomation=await request('AUTOMATION_PATCH',{patch:{keywordHints:{...current,keywords}}});optionsState.settings.automation=optionsAutomation.automation;optionsRenderAutomation();optionsRenderSentenceAllSites();void optionsRefreshStructurePreview();optionsShowSaved('关键词已保存');setResult(optionsEls.keywordHintsResult,'关键词已保存。');}catch(error){setResult(optionsEls.keywordHintsResult,errorText(error),true);}});
optionsEls.automationSiteForm.addEventListener('submit',async event=>{event.preventDefault();try{const origin=parseOrigin(optionsEls.automationSiteOrigin.value);if(!await chrome.permissions.request({origins:[`${origin}/*`]}))throw new Error('未授予此网站权限，网站未添加。');if(await optionsPatchAutomation({sites:upsertSiteEntry(optionsAutomation.automation.sites,origin,true)},'网站自动辅助已开启')){event.target.reset();setResult(optionsEls.automationResult,'网站已添加并启用。');}}catch(error){setResult(optionsEls.automationResult,errorText(error),true);}});
[[optionsEls.videoFontSize,'fontSize',Number],[optionsEls.videoTheme,'theme',String]].forEach(([input,key,convert])=>input.addEventListener('change',async()=>{try{const result=await request('VIDEO_SETTINGS_PATCH',{patch:{[key]:convert(input.value)}});optionsState.settings.video=result.video;optionsRenderAll();optionsShowSaved('视频原文样式已保存');}catch(error){optionsShowError(error);optionsRenderAll();}}));
document.querySelectorAll('input[name="domain-detection-mode"]').forEach(input=>input.addEventListener('change',()=>{optionsDetectionDirty=true;optionsEls.detectionChatgpt.hidden=input.value!=='chatgpt';optionsEls.detectionApi.hidden=input.value!=='api';}));
[optionsEls.detectionSubscriptionModel,optionsEls.detectionApiModel,optionsEls.detectionApiUrl,optionsEls.detectionApiKey].forEach(input=>input.addEventListener('input',()=>{optionsDetectionDirty=true;optionsEls.detectionApiFields.hidden=optionsEls.detectionUseTranslationApi.checked;}));
optionsEls.detectionUseTranslationApi.addEventListener('change',()=>{optionsDetectionDirty=true;optionsEls.detectionApiFields.hidden=optionsEls.detectionUseTranslationApi.checked;});
optionsEls.saveRecognition.addEventListener('click',()=>void optionsSaveDetection());
optionsEls.clearDetectionKey.addEventListener('click',async()=>{const current=optionsDetectionSettings();if(!current.api?.apiKey||!confirm('确定清除单独保存的识别 API Key 吗？'))return;const before=structuredClone(optionsState.settings);if(await optionsSavePatch({domainDetection:{...current,api:{...current.api,apiKey:''}}},'识别密钥已清除'))await optionsRemoveUnusedPermissions(before,optionsState.settings);});
optionsEls.detectionJevModel.addEventListener('change',()=>void optionsSaveDetection());
optionsEls.detectionJevUrl.addEventListener('change',()=>void optionsSaveDetection());
optionsEls.detectionJevKey.addEventListener('change',()=>void optionsSaveDetection());
optionsEls.clearDetectionJevKey.addEventListener('click',async()=>{const current=optionsDetectionSettings();if(!current.jevApiKey||!confirm('确定清除已保存的 Jev API Key 吗？'))return;const before=structuredClone(optionsState.settings);if(await optionsSavePatch({domainDetection:{...current,jevApiKey:''}},'Jev 密钥已清除'))await optionsRemoveUnusedPermissions(before,optionsState.settings);});
optionsEls.runDomainTest.addEventListener('click',async()=>{const text=optionsEls.domainTestText.value.trim();if(!text){setResult(optionsEls.domainTestResult,'请输入正文样本。',true);return;}optionsEls.runDomainTest.disabled=true;try{const result=await request('DOMAIN_TEST',{text});const details=[`领域：${optionsDomainName(result.domain)}`,`来源：${optionsSourceLabels[result.source]||result.source}`];if(result.confident===false&&result.suggested&&Object.hasOwn(DOMAINS,result.suggested))details.push(`本机识别不确定；可在网站规则中手动选择${optionsDomainName(result.suggested)}`);if(result.warning)details.push(result.warning);setResult(optionsEls.domainTestResult,details.join(' · '));}catch(error){setResult(optionsEls.domainTestResult,errorText(error),true);}finally{optionsEls.runDomainTest.disabled=false;}});
optionsEls.domainRuleForm.addEventListener('submit',async event=>{event.preventDefault();const host=optionsEls.ruleHost.value.trim().toLowerCase(),pathPrefix=optionsEls.rulePath.value.trim();const hostPattern=/^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:\d{1,5})?$/;if(!host||!hostPattern.test(host)||!pathPrefix.startsWith('/')){setResult(optionsEls.domainRuleResult,'请填写正确的主机名（不含协议和路径，可含端口）和以 / 开头的路径。',true);return;}const rules=optionsState.settings.domainRules||[];const rule={host,pathPrefix,domain:optionsEls.ruleDomain.value,includeSubdomains:optionsEls.ruleSubdomains.checked};if(await optionsSavePatch({domainRules:[...rules,rule]},'站点规则已添加'))event.target.reset();});
optionsEls.termForm.addEventListener('submit',async event=>{event.preventDefault();const term=optionsEls.termSource.value.trim(),translation=optionsEls.termTranslation.value.trim();if(!term||!translation)return;const terms=optionsState.settings.customTerms||[];if(await optionsSavePatch({customTerms:[...terms,{term,translation,domain:optionsEls.termDomain.value}]},'术语已添加'))event.target.reset();});
const PROVIDER_KIND_LABELS={chatgpt:'ChatGPT 订阅',grok:'Grok 订阅',antigravity:'Google 订阅',api:'API',local:'本机模型'};
document.querySelectorAll('input[name="provider-kind"]').forEach(input=>input.addEventListener('change',()=>void optionsSavePatch({providerKind:input.value},'已切换至 '+(PROVIDER_KIND_LABELS[input.value]||'服务'))));
optionsEls.subscriptionModel.addEventListener('change',()=>void optionsSavePatch({subscriptionModel:optionsEls.subscriptionModel.value},'辅助模型已保存'));
optionsEls.refreshSubscription.addEventListener('click',()=>void optionsRefreshSubscription(true));optionsEls.loginSubscription.addEventListener('click',()=>void optionsSubscriptionAction('SUBSCRIPTION_LOGIN'));optionsEls.cancelSubscription.addEventListener('click',()=>void optionsSubscriptionAction('SUBSCRIPTION_CANCEL'));optionsEls.logoutSubscription.addEventListener('click',()=>void optionsSubscriptionAction('SUBSCRIPTION_LOGOUT'));optionsEls.testSubscription.addEventListener('click',()=>void optionsTestProvider(optionsEls.subscriptionResult));

// 本机模型（Gemini Nano）：探测与下载都在设置页完成——下载需要用户手势，不能由后台发起。
async function optionsRenderNano(){
  const dot=optionsEls.nanoDot,stateEl=optionsEls.nanoState,detail=optionsEls.nanoDetail,download=optionsEls.nanoDownload,progress=optionsEls.nanoProgress;
  if(!dot)return;
  dot.classList.remove('active','connected');
  if(typeof LanguageModel==='undefined'){stateEl.textContent='此浏览器不支持本机模型';detail.textContent='需要支持内置 AI 的 Chrome（Gemini Nano）。';download.hidden=true;progress.hidden=true;return;}
  let availability='unavailable';
  try{availability=await LanguageModel.availability();}catch{availability='unavailable';}
  if(availability==='available'){dot.classList.add('active');stateEl.textContent='本机模型已就绪';detail.textContent='简短查词提示将由 Gemini Nano 在本机生成，不产生网络请求。';download.hidden=true;progress.hidden=true;}
  else if(availability==='downloading'){dot.classList.add('connected');stateEl.textContent='本机模型下载中';detail.textContent='下载完成后即可离线使用。';download.hidden=true;}
  else if(availability==='downloadable'){dot.classList.add('connected');stateEl.textContent='本机模型可下载';detail.textContent='首次使用需下载模型文件（约 2GB），之后完全离线。';download.hidden=false;}
  else{stateEl.textContent='本机模型不可用';detail.textContent='此设备不满足本机模型的硬件要求。';download.hidden=true;progress.hidden=true;}
}
optionsEls.nanoRefresh?.addEventListener('click',()=>void optionsRenderNano());
optionsEls.nanoDownload?.addEventListener('click',()=>{
  const progress=optionsEls.nanoProgress,result=optionsEls.nanoResult;
  progress.hidden=false;progress.removeAttribute('value');
  if(result)setResult(result,'正在下载本机模型…');
  void LanguageModel.create({monitor(m){m.addEventListener('downloadprogress',event=>{progress.value=event.loaded||0;});}})
    .then(session=>session?.destroy())
    .then(()=>{if(result)setResult(result,'本机模型已就绪。');})
    .catch(error=>{if(result)setResult(result,error?.message||'下载失败，请重试。');})
    .finally(()=>{progress.hidden=true;void optionsRenderNano();});
});
void optionsRenderNano();

optionsEls.providerForm.addEventListener('submit',optionsSaveProvider);[optionsEls.providerUrl,optionsEls.providerModel,optionsEls.providerKeys].forEach(input=>input.addEventListener('input',()=>{optionsProviderDirty=true;optionsProviderModels=[];setResult(optionsEls.providerResult,'表单有尚未保存的更改；测试只使用已保存配置。');}));optionsEls.providerModelList.addEventListener('change',()=>{if(!optionsEls.providerModelList.value)return;optionsEls.providerModel.value=optionsEls.providerModelList.value;optionsProviderDirty=true;setResult(optionsEls.providerResult,'已选择模型；保存后生效。');});optionsEls.listProviderModels.addEventListener('click',()=>void optionsListProviderModels());optionsEls.testProvider.addEventListener('click',()=>void optionsTestProvider(optionsEls.providerResult));
async function optionsCheckAllKeys(){
  const current=activeApiProvider(optionsState.settings);
  const keys=(current?.apiKeys||[]);
  if(!keys.length){setResult(optionsEls.providerResult,'没有已保存的密钥可检查。',true);return;}
  optionsEls.checkAllKeys.disabled=true;
  const outcomes=[];
  try{
    for(let index=0;index<keys.length;index++){
      setResult(optionsEls.providerResult,'正在检查第 '+(index+1)+' / '+keys.length+' 个密钥…');
      try{await request('PROVIDER_TEST',{keyIndex:index});outcomes.push('第 '+(index+1)+' 个：可用');}
      catch(error){outcomes.push('第 '+(index+1)+' 个：'+errorText(error));}
    }
    const passed=outcomes.filter(line=>line.endsWith('可用')).length;
    setResult(optionsEls.providerResult,'检查完成：'+passed+' / '+keys.length+' 个可用。'+outcomes.join('；'),passed===keys.length);
  } finally { optionsEls.checkAllKeys.disabled=false; }
}
optionsEls.checkAllKeys.addEventListener('click',()=>void optionsCheckAllKeys());

optionsEls.disconnectProvider.addEventListener('click',async()=>{const current=optionsState.settings.apiServices?.find(service=>service.id===optionsDisplayedServiceId)||activeApiProvider(optionsState.settings);if(!current?.apiKey||!confirm('只清除“'+current.name+'”的密钥？其他服务不受影响。'))return;const before=structuredClone(optionsState.settings);if(await optionsSavePatch({apiServices:before.apiServices.map(service=>service.id===current.id?{...service,apiKey:'',apiKeys:[]}:service)},'此服务密钥已清除')){optionsProviderDirty=false;await optionsRemoveUnusedPermissions(before,optionsState.settings);optionsRenderProvider();}});
optionsEls.copyInstallCommand.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(optionsEls.installCommand.textContent);optionsEls.copyInstallCommand.textContent='已复制';setTimeout(()=>{optionsEls.copyInstallCommand.textContent='复制';},1600);}catch(error){setResult(optionsEls.subscriptionResult,`复制失败：${errorText(error)}`,true);}});
optionsEls.exportData.addEventListener('click',()=>void optionsExportData());optionsEls.clearMemory.addEventListener('click',async()=>{if(!confirm('确定删除词档案、阅读记录、摘要、统计和全部个性化数据吗？此操作无法撤销；服务配置、网站权限和采集开关保持不变。'))return;try{await request('MEMORY_CLEAR');setResult(optionsEls.dataResult,'全部阅读数据已清空；服务配置、网站权限和采集开关保持不变。');}catch(error){setResult(optionsEls.dataResult,errorText(error),true);}});optionsEls.openExtensionManager.addEventListener('click',()=>chrome.tabs.create({url:'chrome://extensions/?id='+chrome.runtime.id}));
optionsEls.diagnosticsEnabled.addEventListener('change',()=>void optionsSetDiagnosticsEnabled());
optionsEls.exportDiagnostics.addEventListener('click',()=>void optionsExportDiagnostics());
optionsEls.clearDiagnostics.addEventListener('click',()=>void optionsClearDiagnostics());
document.addEventListener('visibilitychange',()=>{if(optionsDiagnosticsVisible())void optionsRefreshDiagnostics();if(!document.hidden)void optionsRefreshStructurePreview();});
window.addEventListener('focus',()=>void optionsRefreshStructurePreview());


matchMedia('(prefers-color-scheme: dark)').addEventListener('change',optionsRenderStructurePreview);
chrome.storage.onChanged.addListener((changes,area)=>{if(area!=='local')return;if(changes.sentenceGroupsDensity){optionsSentenceDensity=['coarse','medium','fine'].includes(changes.sentenceGroupsDensity.newValue)?changes.sentenceGroupsDensity.newValue:'medium';optionsRenderSentenceDensity();}if(changes.sentenceGroupsLineStyle){optionsSentenceLineStyle=['solid','dashed','dotted','wavy'].includes(changes.sentenceGroupsLineStyle.newValue)?changes.sentenceGroupsLineStyle.newValue:'solid';optionsRenderSentenceLineStyle();}if(changes.sentenceGroupsDensity||changes.sentenceGroupsLineStyle)queueMicrotask(optionsRenderStructurePreview);if(!changes.settings&&!changes.subscriptionLinked)return;clearTimeout(optionsSyncTimer);optionsSyncTimer=setTimeout(()=>void optionsSyncState().catch(optionsShowError),30);});chrome.runtime.onMessage.addListener(message=>{if(message?.type==='SUBSCRIPTION_UPDATED'&&optionsState){optionsState.subscription=message.subscription||{};optionsRenderSubscription();}});
window.addEventListener('pagehide',()=>{void optionsCleanupDraftPermissions();});

globalThis.optionsDiscardProviderDraft = optionsDiscardProviderDraft;
globalThis.optionsSavePatch = optionsSavePatch;
globalThis.optionsSetDraftServiceId = id => {
  optionsDraftServiceId = id;
  optionsProviderDirty = false;
};
globalThis.optionsShowSavedService = serviceId => {
  optionsDraftServiceId = null;
  optionsDisplayedServiceId = serviceId;
  optionsProviderDirty = false;
  optionsProviderModels = [];
  optionsRenderProvider(serviceId);
};
globalThis.optionsStartDraftProvider = providerId => {
  void optionsCleanupDraftPermissions();
  optionsDraftServiceId = crypto.randomUUID();
  optionsDisplayedServiceId = null;
  optionsProviderDirty = false;
  optionsProviderModels = [];
  const meta = getApiProvider(providerId) || getApiProvider('openai-compatible');
  optionsEls.providerId.value = meta.id;
  optionsRenderProviderFields(meta);
  optionsEls.providerName.value = meta.name;
  optionsEls.providerUrl.value = apiProviderBaseUrl(meta.id, optionsProviderOptions());
  optionsEls.providerModel.value = meta.defaultModel || '';
  optionsEls.providerKeys.value = '';
  optionsRenderProvider();
  setResult(optionsEls.providerResult, '请填写此服务的 API Key；保存后生效。');
};

async function optionsConsumePendingTerm(value){
  if(!value||typeof value.term!=='string'||!value.term.trim())return;
  optionsEls.termSource.value=value.term.trim();
  optionsEls.termTranslation.value=typeof value.translation==='string'?value.translation:'';
  if([...optionsEls.termDomain.options].some(option=>option.value===value.domain))optionsEls.termDomain.value=value.domain;
  location.hash='terms';optionsNavigate();
  await chrome.storage.local.remove('pendingTerm');
}
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes.pendingTerm?.newValue)void optionsConsumePendingTerm(changes.pendingTerm.newValue);});

document.querySelectorAll('input[name="usage-days"]').forEach(input=>input.addEventListener('change',()=>{optionsUsageDays=Number(input.value);void optionsRefreshUsage();}));
optionsEls.usageClear.addEventListener('click',async()=>{if(!confirm('清空模型用量统计？只删除用量计数，不影响服务配置与阅读数据。'))return;try{await request('USAGE_CLEAR');setResult(optionsEls.usageResult,'用量统计已清空');await optionsRefreshUsage();}catch(error){setResult(optionsEls.usageResult,errorText(error),true);}});
async function optionsInit(){optionsFillDomains(optionsEls.readingDomain,true);optionsFillDomains(optionsEls.ruleDomain,false);optionsFillDomains(optionsEls.termDomain,false);optionsEls.installCommand.textContent=`node connector/install.mjs --extension-id ${chrome.runtime.id}`;optionsNavigate();try{const densityData=await chrome.storage.local.get(['sentenceGroupsDensity','sentenceGroupsLineStyle']);optionsSentenceDensity=['coarse','medium','fine'].includes(densityData.sentenceGroupsDensity)?densityData.sentenceGroupsDensity:'medium';optionsSentenceLineStyle=['solid','dashed','dotted','wavy'].includes(densityData.sentenceGroupsLineStyle)?densityData.sentenceGroupsLineStyle:'solid';await optionsSyncState();if(!['diagnostics','history','personalization'].includes(optionsCurrentSection))await optionsRefreshSubscription();const pending=(await chrome.storage.local.get('pendingTerm')).pendingTerm;if(pending)await optionsConsumePendingTerm(pending);}catch(error){optionsShowError(error);}}
void optionsInit();
