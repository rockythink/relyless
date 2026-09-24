import {request, errorText, upsertSiteEntry} from '../shared.js';

const popupEls={status:document.querySelector('#page-status'),hostname:document.querySelector('#site-hostname'),siteAuto:document.querySelector('#site-auto'),siteAutoNote:document.querySelector('#site-auto-note'),siteAutoError:document.querySelector('#site-auto-error'),toggle:document.querySelector('#toggle-page'),toggleLabel:document.querySelector('#toggle-label'),pageNote:document.querySelector('#page-note'),actionError:document.querySelector('#action-error'),readerToggle:document.querySelector('#toggle-reader'),readerNote:document.querySelector('#reader-note'),readerError:document.querySelector('#reader-error'),sentenceGroups:document.querySelector('#sentence-groups'),sentenceGroupsNote:document.querySelector('#sentence-groups-note'),sentenceGroupsError:document.querySelector('#sentence-groups-error'),options:document.querySelector('#open-options'),serviceWarning:document.querySelector('#service-warning'),serviceWarningCopy:document.querySelector('#service-warning-copy'),repairService:document.querySelector('#repair-service'),emergencyEstimate:document.querySelector('#emergency-estimate'),emergencyBudget:document.querySelector('#emergency-budget')};
const popupUnsupported=document.querySelector('#unsupported-page');
const popupPageControls=document.querySelector('#page-controls');
for(const name of ['panel','open','confirm','start','cancel','progress','progress-copy','counts','actions','stop','resume','retry','clear','result','status']){
  const key='emergency'+name.split('-').map(part=>part[0].toUpperCase()+part.slice(1)).join('');
  popupEls[key]=document.querySelector('#emergency-'+name);
}
const popupLookupKeyCopies=[...document.querySelectorAll('[data-lookup-key]')];
let popupState=null;
let popupAutomation=null;
let popupTab=null;
let popupEnabled=false;
let popupSentenceGroups={enabled:false,status:'off',error:'',processed:0};
let popupReaderActive=false;
let popupSentenceGroupsLoaded=false;
let popupBusy=false;
let popupEmergency={active:false,displayed:false,phase:'off',total:0,completed:0,failed:0,pending:0,skipped:0,error:''};
let popupEmergencyResume=false;

function popupSetLive(element, value) { if (element.textContent !== value) element.textContent = value; }
function popupShowError(element,error){element.textContent=errorText(error);element.hidden=false;}
function popupClearError(element){element.textContent='';element.hidden=true;}
function popupSupported(){return Boolean(popupTab?.id&&/^https?:\/\//i.test(popupTab.url||''));}
function popupOrigin(){try{return popupSupported()?new URL(popupTab.url).origin:'';}catch{return'';}}
function popupHostname(){try{return popupSupported()?new URL(popupTab.url).hostname:'当前标签页';}catch{return'当前标签页';}}
function popupEmergencySnapshot(value={}){
  const count=name=>Number.isInteger(value[name])&&value[name]>=0?value[name]:0;
  const phases=new Set(['off','translating','waiting','complete','partial','stopped','error']);
  return {active:Boolean(value.active),displayed:Boolean(value.displayed),phase:phases.has(value.phase)?value.phase:'off',total:count('total'),completed:count('completed'),failed:count('failed'),pending:count('pending'),skipped:count('skipped'),error:typeof value.error==='string'?value.error:''};
}
function popupEmergencyPhaseText(){
  if(!popupSupported())return '当前页不可用；请在普通网页中使用。';
  if(!popupState?.providerConfigured)return '连接辅助服务后才能翻译本页。';
  if(popupEmergency.phase==='translating')return '正在翻译读到附近的正文。';
  if(popupEmergency.phase==='waiting')return '当前附近已处理，继续阅读时再翻译。';
  if(popupEmergency.phase==='complete')return '已处理所有已识别段落，英文仍保留。';
  if(popupEmergency.phase==='partial')return '部分段落未译完，可重试失败段落。';
  if(popupEmergency.phase==='stopped')return '已停止发送新请求，现有译文仍保留。';
  if(popupEmergency.phase==='error')return popupEmergency.error||'翻译已停止，可确认后继续。';
  return '保留英文，按阅读位置翻译附近正文。';
}
function popupRender(){
  popupEls.hostname.textContent=popupHostname();
  const lookupKey=typeof popupState?.settings?.lookupKey==='string'&&/^[A-Z]$/.test(popupState.settings.lookupKey)?popupState.settings.lookupKey:'D';
  for(const copy of popupLookupKeyCopies)copy.textContent=lookupKey;
  const supported=popupSupported();
  popupUnsupported.hidden=supported;
  popupPageControls.hidden=!supported;
  if(!supported)return;
  const allSites=Boolean(popupAutomation?.automation?.allSites);
  const configured=popupAutomation?.siteRule??allSites;
  popupEls.siteAuto.disabled=popupBusy||!supported||!popupAutomation;
  popupEls.siteAuto.checked=Boolean(supported&&configured);
  if(popupAutomation?.paused&&configured)popupEls.siteAutoNote.textContent='此网站已授权；当前标签页已暂停。';
  else if(allSites&&popupAutomation?.siteRule===false)popupEls.siteAutoNote.textContent='全部网站已开启；当前网站已排除。';
  else if(allSites)popupEls.siteAutoNote.textContent='全部网站已开启；关闭可排除当前网站。';
  else popupEls.siteAutoNote.textContent=configured?'下次打开此网站会自动辅助。':'授权后自动开始；有限上下文用于准备，支持记录只在本机。';
  popupEls.toggle.disabled=popupBusy||!supported;
  popupEls.readerToggle.disabled=popupBusy||!supported;popupEls.readerToggle.textContent=popupReaderActive?'退出专注阅读':'进入专注阅读';popupEls.readerNote.textContent=popupReaderActive?'当前正文快照；退出后回到原网页。':'本地提取当前正文快照，不保存文章；退出返回原网页。';
  popupEls.status.classList.toggle('active',popupEnabled);
  if(popupEnabled){popupSetLive(popupEls.status,'本页已开启');popupEls.toggleLabel.textContent='暂停本页';popupEls.pageNote.textContent=popupState?.settings?.assistanceMode==='on-demand'?'当前为仅在需要时；保留主动求助。':'保留英文，只在当前位置提供少量支撑。';}
  else{popupSetLive(popupEls.status,popupAutomation?.paused?'本页已暂停':'等待开启');popupEls.toggleLabel.textContent=popupAutomation?.paused?'继续辅助':'开启本页';popupEls.pageNote.textContent='开启不会改变网站的长期授权规则。';}
  const serviceProblem=popupState?.providerError||(['chatgpt','grok','antigravity'].includes(popupState?.settings?.providerKind)?popupState?.subscription?.error:'')||(!popupState?.providerConfigured?'辅助服务尚未连接。':'');
  popupEls.serviceWarning.hidden=!serviceProblem;
  popupEls.serviceWarningCopy.textContent=serviceProblem||'';
  popupEls.sentenceGroups.checked=Boolean(popupSentenceGroupsLoaded&&popupSentenceGroups.enabled);
  popupEls.sentenceGroups.disabled=popupBusy||!supported||!popupSentenceGroupsLoaded||Boolean(!popupSentenceGroups.enabled&&!popupState?.providerConfigured);
  if(!popupState?.providerConfigured)popupSetLive(popupEls.sentenceGroupsNote,popupSentenceGroups.enabled?'服务未就绪，阅读解构已停止；仍可关闭本页阅读解构。':'连接辅助服务后才能开启阅读解构。');
  else if(popupSentenceGroups.status==='queued')popupSetLive(popupEls.sentenceGroupsNote,'正在准备分析当前可见正文。');
  else if(popupSentenceGroups.status==='analyzing')popupSetLive(popupEls.sentenceGroupsNote,'正在分析当前可见正文；滚动后只分析新出现的句子。');
  else if(popupSentenceGroups.status==='error')popupSetLive(popupEls.sentenceGroupsNote,'阅读解构出错，可在扩展中关闭后重新开启。');
  else if(popupSentenceGroups.status==='paused')popupSetLive(popupEls.sentenceGroupsNote,'分析暂缓；页面恢复阅读状态后按需继续。');
  else if(popupSentenceGroups.enabled)popupSetLive(popupEls.sentenceGroupsNote,popupSentenceGroups.processed?'已开启，已处理 '+popupSentenceGroups.processed+' 句；滚动时按需继续。':'已开启，等待分析可见正文。');
  else popupSetLive(popupEls.sentenceGroupsNote,'已关闭；可随时为当前页面开启。');
  if(popupSentenceGroups.error){popupEls.sentenceGroupsError.textContent=popupSentenceGroups.error;popupEls.sentenceGroupsError.hidden=false;}else{popupEls.sentenceGroupsError.textContent='';popupEls.sentenceGroupsError.hidden=true;}
  const emergencyVisible=Boolean(popupEmergency.active||popupEmergency.displayed||popupEmergency.phase!=='off');
  const resumable=!popupEmergency.active&&popupEmergency.total>0&&['stopped','error'].includes(popupEmergency.phase);
  popupSetLive(popupEls.emergencyStatus,popupReaderActive?'请先退出专注阅读，再使用本页双语翻译。':popupEmergencyPhaseText());
  popupEls.emergencyOpen.hidden=emergencyVisible||!popupEls.emergencyConfirm.hidden;
  popupEls.emergencyOpen.disabled=popupBusy||!supported||popupReaderActive||!popupState?.providerConfigured;
  popupEls.emergencyProgress.hidden=!emergencyVisible;
  popupEls.emergencyProgressCopy.textContent='已译 '+popupEmergency.completed+' / 已识别 '+popupEmergency.total+' 段';
  popupEls.emergencyCounts.textContent='待阅读 '+popupEmergency.pending+' · 失败 '+popupEmergency.failed+' · 跳过 '+popupEmergency.skipped;
  popupEls.emergencyActions.hidden=!emergencyVisible||!popupEls.emergencyConfirm.hidden;
  popupEls.emergencyStop.hidden=!popupEmergency.active;
  popupEls.emergencyStop.disabled=popupBusy||!popupEmergency.active;
  popupEls.emergencyResume.hidden=!resumable;
  popupEls.emergencyResume.disabled=popupBusy||popupReaderActive||!resumable||!popupState?.providerConfigured;
  popupEls.emergencyRetry.hidden=!(popupEmergency.active&&popupEmergency.failed>0);
  popupEls.emergencyRetry.disabled=popupBusy||!popupEmergency.active||popupEmergency.failed===0;
  popupEls.emergencyClear.disabled=popupBusy||!emergencyVisible;
  popupEls.emergencyStart.textContent=popupEmergencyResume?'确认并继续':'确认并翻译本页';
  popupEls.emergencyStart.disabled=popupBusy||popupReaderActive||!supported||!popupState?.providerConfigured;
  popupEls.emergencyCancel.disabled=popupBusy;
}
async function popupGetPageStatus(){if(!popupSupported())return;const snapshot=popupSentenceGroups;const result=await chrome.tabs.sendMessage(popupTab.id,{type:'SS_STATUS'},{frameId:0}).catch(()=>null);if(snapshot!==popupSentenceGroups||!result?.ok)return;popupEnabled=Boolean(result.data?.enabled);popupReaderActive=Boolean(result.data?.reader?.active);if(result.data?.sentenceGroups)popupSentenceGroups={...popupSentenceGroups,...result.data.sentenceGroups};if(result.data?.emergency)popupEmergency=popupEmergencySnapshot(result.data.emergency);}
async function popupGetSentenceGroups(){const result=await request('SENTENCE_GROUPS_GET',{tabId:popupTab?.id});popupSentenceGroups={enabled:Boolean(result?.enabled),status:result?.enabled?'idle':'off',error:'',processed:0};popupSentenceGroupsLoaded=true;}
async function popupToggleSite(){
  if(!popupSupported()||popupBusy||!popupAutomation)return;
  const enabled=popupEls.siteAuto.checked,origin=popupOrigin();
  popupBusy=true;popupClearError(popupEls.siteAutoError);popupRender();
  try{
    if(enabled&&!await chrome.permissions.request({origins:[origin+'/*']}))throw new Error('未授予此网站权限，设置未更改。');
    const sites=upsertSiteEntry(popupAutomation.automation.sites,origin,enabled);
    popupAutomation=await request('AUTOMATION_PATCH',{patch:{sites},tabId:popupTab.id});
    await popupGetPageStatus();
  }catch(error){popupShowError(popupEls.siteAutoError,error);}
  finally{popupBusy=false;popupRender();}
}
async function popupToggleReader(){
  if(!popupSupported()||popupBusy)return;
  popupBusy=true;popupClearError(popupEls.readerError);popupRender();
  try{
    const current=await chrome.tabs.get(popupTab.id);
    if(current.url!==popupTab.url)throw new Error('页面已变化，请重新打开扩展。');
    await request('PAGE_UI_INJECT',{tabId:popupTab.id});
    const result=await chrome.tabs.sendMessage(popupTab.id,{type:'SS_READER_SET',enabled:!popupReaderActive,pageUrl:current.url},{frameId:0});
    if(!result?.ok)throw new Error(result?.error||'请刷新网页后重试。');
    popupReaderActive=Boolean(result.data?.reader?.active);
    await popupGetPageStatus();
  }catch(error){popupShowError(popupEls.readerError,error);popupEls.readerError.focus();}
  finally{popupBusy=false;popupRender();}
}
async function popupTogglePage(){if(!popupSupported()||popupBusy)return;popupBusy=true;popupClearError(popupEls.actionError);popupRender();try{await request('PAGE_UI_INJECT',{tabId:popupTab.id});const result=await chrome.tabs.sendMessage(popupTab.id,{type:'SS_SET_ENABLED',enabled:!popupEnabled});if(!result?.ok)throw new Error(result?.error||'请刷新网页后重试。');popupEnabled=Boolean(result.data?.enabled);popupAutomation=await request('AUTOMATION_GET',{tabId:popupTab.id});}catch(error){popupShowError(popupEls.actionError,new Error(`无法更新当前页：${errorText(error)}`));}finally{popupBusy=false;popupRender();}}
async function popupToggleSentenceGroups(){
  if(!popupSupported()||popupBusy||!popupSentenceGroupsLoaded)return;const enabled=popupEls.sentenceGroups.checked;
  popupBusy=true;popupSentenceGroups.error='';popupRender();
  try{
    await request('PAGE_UI_INJECT',{tabId:popupTab.id});
    await request('SENTENCE_GROUPS_SET',{tabId:popupTab.id,enabled});
    const result=await chrome.tabs.sendMessage(popupTab.id,{type:'SS_SET_SENTENCE_GROUPS',enabled},{frameId:0});
    if(!result?.ok)throw new Error(result?.error||'网页未能应用阅读解构设置，请刷新后重试。');
    popupSentenceGroups={...popupSentenceGroups,...result.data?.sentenceGroups};popupEnabled=Boolean(result.data?.enabled);
    popupAutomation=await request('AUTOMATION_GET',{tabId:popupTab.id});
  }catch(error){try{await popupGetSentenceGroups();}catch{}popupSentenceGroups.error='无法更新阅读解构：'+errorText(error);}
  finally{popupBusy=false;popupRender();}
}
function popupFocusEmergency(){const button=!popupEls.emergencyConfirm.hidden?popupEls.emergencyStart:popupEmergency.active?popupEls.emergencyStop:!popupEls.emergencyResume.hidden?popupEls.emergencyResume:popupEmergency.phase==='off'?popupEls.emergencyOpen:popupEls.emergencyClear;if(!button.disabled)button.focus();}
function popupEmergencyPrompt(show,{resume=false,focus=true}={}){
  popupEmergencyResume=Boolean(show&&resume&&!popupEmergency.active&&popupEmergency.total>0&&['stopped','error'].includes(popupEmergency.phase));
  popupEls.emergencyConfirm.hidden=!show;popupRender();
  if(show){popupClearError(popupEls.emergencyResult);popupBudgetConfirmed=false;popupEls.emergencyBudget.hidden=true;popupEls.emergencyStart.textContent='确认并翻译本页';if(focus)popupEls.emergencyStart.focus();void popupEmergencyEstimate();}
  else if(focus)popupFocusEmergency();
}
async function popupEmergencyEstimate(){
  try{
    await request('PAGE_UI_INJECT',{tabId:popupTab.id});
    const view=await request('EMERGENCY_ESTIMATE',{tabId:popupTab.id,url:popupTab.url});
    if(!view?.estimate)return;
    popupEls.emergencyEstimate.textContent=`预计约 ${view.estimate} tokens${view.budget?` · 本月已用约 ${view.monthlyUsed} / 限额 ${view.budget}`:''}`;
    popupEls.emergencyEstimate.hidden=false;
    if(view.budgetExceeded){popupEls.emergencyBudget.textContent=`按预估将超出本月预算限额 ${view.budget} tokens。`;popupEls.emergencyBudget.hidden=false;}
  }catch{popupEls.emergencyEstimate.hidden=true;}
}
let popupBudgetConfirmed=false;
async function popupEmergencyStart(){
  if(popupBusy||!popupSupported()||popupEls.emergencyConfirm.hidden)return;
  const resume=popupEmergencyResume;
  popupBusy=true;popupClearError(popupEls.emergencyResult);popupRender();let token;
  try{
    const current=await chrome.tabs.get(popupTab.id);
    if(current.url!==popupTab.url)throw new Error('网页已切换，请重新打开扩展弹窗后确认。');
    await request('PAGE_UI_INJECT',{tabId:popupTab.id});
    const begin=await request('EMERGENCY_BEGIN',{tabId:popupTab.id,url:popupTab.url,confirmed:popupBudgetConfirmed});
    if(begin?.budgetExceeded){popupBudgetConfirmed=true;popupEls.emergencyBudget.textContent=`超出本月用量预算（已用约 ${begin.monthlyUsed} tokens + 预计 ${begin.estimate} > 限额 ${begin.budget}），仍要继续？`;popupEls.emergencyBudget.hidden=false;popupEls.emergencyStart.textContent='仍要翻译本页';return;}
    ({token}=begin);
    const result=await chrome.tabs.sendMessage(popupTab.id,{type:'SS_EMERGENCY_START',token,resume},{frameId:0});
    if(!result?.ok)throw new Error(result?.error||'无法启动本页翻译，请刷新网页后重试。');
    popupEmergency=popupEmergencySnapshot(result.data?.emergency||{active:true,displayed:resume,phase:'translating'});
    popupEmergencyPrompt(false,{focus:false});
    popupEls.emergencyResult.classList.remove('error');
    popupEls.emergencyResult.textContent=resume?'已继续，仅处理尚未完成的段落。':'已开始，仅处理读到附近的正文。';
    popupEls.emergencyResult.hidden=false;
  }catch(error){
    if(token)await request('EMERGENCY_END',{tabId:popupTab.id,token}).catch(()=>{});
    popupEls.emergencyResult.classList.add('error');popupShowError(popupEls.emergencyResult,error);
  }finally{popupBusy=false;popupRender();popupFocusEmergency();}
}
async function popupEmergencyAction(type){
  if(popupBusy||!popupSupported())return;popupBusy=true;popupClearError(popupEls.emergencyResult);popupRender();
  try{
    const result=await chrome.tabs.sendMessage(popupTab.id,{type},{frameId:0});
    if(!result?.ok)throw new Error(result?.error||'网页未能完成操作，请刷新后重试。');
    popupEmergency=popupEmergencySnapshot(result.data?.emergency||{});
    popupEls.emergencyResult.classList.remove('error');
    popupEls.emergencyResult.textContent=type==='SS_EMERGENCY_STOP'?'已停止发送新请求；已显示的中文仍保留。':type==='SS_EMERGENCY_RETRY'?'正在重试失败段落。':'已移除本页译文，页面已返回英文。';
    popupEls.emergencyResult.hidden=false;
  }catch(error){popupEls.emergencyResult.classList.add('error');popupShowError(popupEls.emergencyResult,error);}
  finally{popupBusy=false;popupRender();popupFocusEmergency();}
}
function popupOpenOptions(section=''){chrome.runtime.openOptionsPage(()=>{if(section)chrome.tabs.query({url:chrome.runtime.getURL('ui/options.html*')},tabs=>{const tab=tabs.at(-1);if(tab?.id)chrome.tabs.update(tab.id,{url:chrome.runtime.getURL('ui/options.html#'+section)});});});}
async function popupInit(){
  try{
    [popupTab]=await chrome.tabs.query({active:true,currentWindow:true});
    popupState=await request('STATE_GET');
    if(!popupSupported()){popupRender();return;}
    popupAutomation=await request('AUTOMATION_GET',{tabId:popupTab.id});
    try{await popupGetSentenceGroups();}
    catch(error){popupSentenceGroupsLoaded=false;popupSentenceGroups.error='无法读取阅读解构设置：'+errorText(error);}
    await popupGetPageStatus();
    popupRender();
  }catch(error){if(popupSupported())popupShowError(popupEls.actionError,error);popupRender();}
}
async function popupWatchPage(){
  try{if(!popupBusy&&(popupSentenceGroups.enabled||popupReaderActive||popupEmergency.phase!=='off')&&document.visibilityState==='visible'){await popupGetPageStatus();popupRender();}}
  catch{/* 轮询为尽力而为，失败下一秒重试，不写入界面 */}
  finally{setTimeout(()=>void popupWatchPage(),1000);}
}
popupEls.toggle.addEventListener('click',()=>void popupTogglePage());popupEls.readerToggle.addEventListener('click',()=>void popupToggleReader());popupEls.siteAuto.addEventListener('change',()=>void popupToggleSite());popupEls.sentenceGroups.addEventListener('change',()=>void popupToggleSentenceGroups());popupEls.options.addEventListener('click',()=>popupOpenOptions());popupEls.repairService.addEventListener('click',()=>popupOpenOptions('service'));popupEls.emergencyOpen.addEventListener('click',()=>popupEmergencyPrompt(true));popupEls.emergencyCancel.addEventListener('click',()=>popupEmergencyPrompt(false));popupEls.emergencyStart.addEventListener('click',()=>void popupEmergencyStart());popupEls.emergencyStop.addEventListener('click',()=>void popupEmergencyAction('SS_EMERGENCY_STOP'));popupEls.emergencyResume.addEventListener('click',()=>popupEmergencyPrompt(true,{resume:true}));popupEls.emergencyRetry.addEventListener('click',()=>void popupEmergencyAction('SS_EMERGENCY_RETRY'));popupEls.emergencyClear.addEventListener('click',()=>void popupEmergencyAction('SS_EMERGENCY_END'));
popupEls.emergencyConfirm.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();popupEmergencyPrompt(false);}});
chrome.storage.onChanged.addListener((changes,area)=>{if(area!=='local'||!changes.settings)return;void Promise.all([request('STATE_GET'),request('AUTOMATION_GET',{tabId:popupTab?.id}).catch(()=>null)]).then(([state,automation])=>{popupState=state;if(automation)popupAutomation=automation;popupRender();}).catch(()=>{});});
void popupInit().then(()=>setTimeout(()=>void popupWatchPage(),1000));
