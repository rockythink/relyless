export const AUTO_SCRIPT_ID = 'ss-auto-start';
export const ALL_HOSTS = ['http://*/*','https://*/*'];
export const VIDEO_HOSTS = ['https://www.youtube.com/*','https://m.youtube.com/*'];
// Temporarily hide video support without erasing saved preferences.
export const VIDEO_SUPPORT_ENABLED = false;

export function pageOrigin(value) {
  try {
    const url = value instanceof URL ? value : new URL(value);
    return ['http:','https:'].includes(url.protocol) && !url.username && !url.password ? url.origin : null;
  } catch { return null; }
}

export function sitePattern(origin) {
  const normalized = pageOrigin(origin);
  if (!normalized || normalized !== origin) throw new Error('站点必须是完整的 HTTP 或 HTTPS origin。');
  return `${normalized}/*`;
}

export const DEFAULT_KEYWORD_HINTS = {badge:false,keywords:['docs','developer','developers','learn','wiki'],dismissed:[]};
export const KEYWORD_PATTERN = /^(?=.*[a-z])[a-z0-9]{2,32}$/;

export function hostKeyword(hostname, keywords) {
  const segments = String(hostname || '').toLowerCase().split(/[.-]/);
  return (keywords || []).find(keyword => segments.includes(keyword)) || null;
}

export function normalizeKeywordHints(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const keywords = Array.isArray(source.keywords) ? [...new Set(source.keywords.map(entry => typeof entry === 'string' ? entry.trim().toLowerCase() : '').filter(entry => KEYWORD_PATTERN.test(entry)))].slice(0,20) : [...DEFAULT_KEYWORD_HINTS.keywords];
  const seen = new Set();
  const dismissed = (Array.isArray(source.dismissed) ? source.dismissed : []).filter(entry => typeof entry === 'string' && pageOrigin(entry) === entry && !seen.has(entry) && seen.add(entry)).slice(0,500);
  return {badge:source.badge === true,keywords,dismissed};
}

export function validateAutomation(value, base) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效的自动开启设置。');
  const allowed = new Set(['allSites','sentenceGroupsAllSites','sites','videoSites','keywordHints']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error('未知的自动开启设置。');
  const result = {...base,sentenceGroupsAllSites:base?.sentenceGroupsAllSites === true,keywordHints:normalizeKeywordHints(base?.keywordHints)};
  if (value.allSites !== undefined) {
    if (typeof value.allSites !== 'boolean') throw new Error('无效的全部网站设置。');
    result.allSites = value.allSites;
  }
  if (value.videoSites !== undefined) {
    if (typeof value.videoSites !== 'boolean') throw new Error('无效的视频网站设置。');
    result.videoSites = value.videoSites;
  }
  if (value.sentenceGroupsAllSites !== undefined) {
    if (typeof value.sentenceGroupsAllSites !== 'boolean') throw new Error('无效的全部网站阅读解构设置。');
    result.sentenceGroupsAllSites = value.sentenceGroupsAllSites;
  }
  if (value.sites !== undefined) {
    if (!Array.isArray(value.sites) || value.sites.length > 500) throw new Error('无效的站点规则。');
    const seen = new Set();
    result.sites = value.sites.map(entry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !['origin','enabled'].includes(key))) throw new Error('无效的站点规则。');
      const origin = pageOrigin(entry.origin);
      if (!origin || origin !== entry.origin || typeof entry.enabled !== 'boolean' || seen.has(origin)) throw new Error('站点规则必须使用唯一且完整的 HTTP 或 HTTPS origin。');
      seen.add(origin);
      return {origin,enabled:entry.enabled};
    });
  }
  if (value.keywordHints !== undefined) {
    const hints = value.keywordHints;
    if (!hints || typeof hints !== 'object' || Array.isArray(hints)) throw new Error('无效的域名关键词提示设置。');
    const keys = Object.keys(hints);
    if (keys.length !== 3 || keys.some(key => !['badge','keywords','dismissed'].includes(key))) throw new Error('无效的域名关键词提示设置。');
    if (typeof hints.badge !== 'boolean') throw new Error('无效的域名关键词提示设置。');
    if (!Array.isArray(hints.keywords) || hints.keywords.length > 20 || new Set(hints.keywords).size !== hints.keywords.length || hints.keywords.some(keyword => typeof keyword !== 'string' || !KEYWORD_PATTERN.test(keyword))) throw new Error('关键词只能包含 2–32 个小写字母或数字，且至少含一个字母，最多 20 个且不能重复。');
    if (!Array.isArray(hints.dismissed) || hints.dismissed.length > 500 || new Set(hints.dismissed).size !== hints.dismissed.length || hints.dismissed.some(entry => typeof entry !== 'string' || pageOrigin(entry) !== entry)) throw new Error('忽略列表必须使用唯一且完整的 HTTP 或 HTTPS origin。');
    result.keywordHints = {badge:hints.badge,keywords:[...hints.keywords],dismissed:[...hints.dismissed]};
  }
  return result;
}

export function validateVideo(value, base) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效的视频设置。');
  const allowed = new Set(['fontSize','theme']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error('未知的视频设置。');
  const result = {...base};
  if (value.fontSize !== undefined) {
    if (![16,20,24,28].includes(value.fontSize)) throw new Error('无效的字幕字号。');
    result.fontSize = value.fontSize;
  }
  if (value.theme !== undefined) {
    if (!['auto','light','dark'].includes(value.theme)) throw new Error('无效的字幕主题。');
    result.theme = value.theme;
  }
  return result;
}

export function resolveAutomation(automation,activationUrl,paused = false) {
  const origin = pageOrigin(activationUrl);
  const site = origin ? automation.sites.find(entry => entry.origin === origin) : undefined;
  const siteRule = site ? site.enabled : null;
  const effective = Boolean(origin && !paused && (site ? site.enabled : automation.allSites));
  const sentenceGroupsEffective = Boolean(origin && !paused && automation.sentenceGroupsAllSites && siteRule !== false);
  const hostname = origin ? new URL(origin).hostname : '';
  const videoAvailable = Boolean(VIDEO_SUPPORT_ENABLED && !paused && automation.videoSites && ['www.youtube.com','m.youtube.com'].includes(hostname));
  const hints = automation.keywordHints;
  const keywordHint = origin && siteRule === null && !automation.allSites && !hints?.dismissed.includes(origin) ? hostKeyword(hostname,hints?.keywords) : null;
  return {origin,siteRule,effective,sentenceGroupsEffective,paused:Boolean(paused),videoAvailable,keywordHint};
}

export function registrationMatches(automation) {
  const matches = new Set();
  if (automation.allSites || automation.sentenceGroupsAllSites) ALL_HOSTS.forEach(pattern => matches.add(pattern));
  for (const site of automation.sites) if (site.enabled) matches.add(sitePattern(site.origin));
  if (VIDEO_SUPPORT_ENABLED && automation.videoSites) VIDEO_HOSTS.forEach(pattern => matches.add(pattern));
  return [...matches].sort();
}

export function requiredPermissionOrigins(automation) {
  return registrationMatches(automation);
}
