(() => {
  'use strict';

  const GLOBAL_NAME = 'ShisuiVideoSubtitles';
  if (globalThis[GLOBAL_NAME]) return;

  const YOUTUBE_REQUEST_EVENT = 'shisui:youtube-captions-request';
  const YOUTUBE_RESPONSE_EVENT = 'shisui:youtube-captions-response';
  const HOST_ATTRIBUTE = 'data-shisui-ui';
  const SOURCE_REFRESH_MS = 1600;
  const RENDER_PAGE_SIZE = 100;
  const MAX_TARGET_LENGTH = 600;
  const MAX_CONTEXT_LENGTH = 2000;
  const DEFAULT_SETTINGS = Object.freeze({fontSize: 20, theme: 'auto', bilingual: false});
  const TRANSLATE_LOOK_AHEAD_SECONDS = 30;
  const TRANSLATE_BATCH_SIZE = 4;
  const TRANSLATE_RETRY_MS = 8000;
  const TRANSLATE_MAX_ATTEMPTS = 3;
  const FONT_SIZES = new Set([16, 20, 24, 28]);
  const THEMES = new Set(['auto', 'light', 'dark']);
  const MAX_GROUP_LENGTH = 130;
  const MAX_GROUP_WORDS = 20;
  const CLAUSE_BREAK_LENGTH = 60;
  const CONNECTIVE_BREAK_WORDS = 12;
  const MIN_GROUP_WORDS = 3;
  const CONNECTIVES = new Set(['and', 'but', 'so', 'because', 'which', 'who', 'when', 'where', 'while', 'if', 'or', 'although', 'though', 'then', 'that\'s', 'unless', 'until', 'since']);
  const SLOW_TRANSLATE_MS = 6000;

  function wordCount(text) { return String(text).split(/\s+/).filter(word => /[A-Za-z0-9]/.test(word)).length; }
  function groupKey(group) { return `${Number(group.startTime).toFixed(2)}\u0000${group.text}`; }
  function groupCues(cues) {
    const groups = [];
    let bucket = null;
    const flush = () => { if (bucket) groups.push(bucket); bucket = null; };
    cues.forEach((cue, index) => {
      if (!bucket) {
        bucket = {startTime: cue.startTime, endTime: cue.endTime, text: cue.text, cueIndex: index, cueEnd: index};
        return;
      }
      const gap = cue.startTime - bucket.endTime;
      const combined = `${bucket.text} ${cue.text}`.trim();
      const bucketWords = wordCount(bucket.text);
      const tooShort = bucketWords < MIN_GROUP_WORDS && gap <= 0.85 && !/^\[[^\]]+\]$/.test(bucket.text) && !/^\[[^\]]+\]$/.test(cue.text);
      const sentenceDone = /[.!?…]["'”’)]*$/u.test(bucket.text);
      const clauseDone = bucket.text.length >= CLAUSE_BREAK_LENGTH && /[,;:—–]["'”’)]*$/u.test(bucket.text);
      const connectiveBreak = bucketWords >= CONNECTIVE_BREAK_WORDS && CONNECTIVES.has(cue.text.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z']/g, ''));
      const tooLong = combined.length > MAX_GROUP_LENGTH || wordCount(combined) > MAX_GROUP_WORDS;
      if (!tooShort && (gap > 0.85 || sentenceDone || clauseDone || connectiveBreak || tooLong)) {
        flush();
        bucket = {startTime: cue.startTime, endTime: cue.endTime, text: cue.text, cueIndex: index, cueEnd: index};
        return;
      }
      bucket.endTime = Math.max(bucket.endTime, cue.endTime);
      bucket.text = combined;
      bucket.cueEnd = index;
    });
    flush();
    return groups;
  }
  function mostlyHan(text) {
    const chars = [...String(text || '').replace(/\s/g, '')];
    if (chars.length < 2) return false;
    return chars.filter(ch => /\p{Script=Han}/u.test(ch)).length / chars.length >= 0.6;
  }
  function localCaption(text) {
    if (mostlyHan(text)) return text;
    const sound = String(text || '').match(/^\[(music|applause|laughter|silence)\]$/i);
    if (!sound) return '';
    return {music: '[音乐]', applause: '[掌声]', laughter: '[笑声]', silence: '[静音]'}[sound[1].toLowerCase()] || '';
  }
  function acceptableTranslation(sourceText, translation) {
    if (typeof translation !== 'string' || !translation.trim()) return false;
    if (/\p{Script=Han}/u.test(translation)) return true;
    const words = String(sourceText).split(/\s+/).filter(word => /[A-Za-z]/.test(word));
    return words.length > 0 && words.length < 6;
  }
  function needsTranslationEntry(cached, now) {
    if (!cached) return true;
    if (cached.status === 'ok' || cached.status === 'pending') return false;
    return cached.status === 'error' && cached.attempts < TRANSLATE_MAX_ATTEMPTS && now - cached.at >= TRANSLATE_RETRY_MS;
  }
  function currentGroupIndex(groups, time) {
    if (!groups?.length) return -1;
    let found = -1;
    for (let index = 0; index < groups.length; index += 1) {
      if (groups[index].startTime <= time + 0.2) found = index;
      else break;
    }
    return found;
  }
  function groupIndexAt(groups, time) {
    let found = -1;
    for (let index = 0; index < groups.length; index += 1) {
      if (groups[index].startTime <= time) found = index;
      else break;
    }
    return found;
  }
  function pendingGroups({groups, time, translations, horizon, arrival, limit, now}) {
    const index = Math.max(0, currentGroupIndex(groups, time));
    const todo = [];
    if (!groups?.length) return todo;
    for (let cursor = index; cursor < groups.length && todo.length < limit; cursor += 1) {
      if (cursor > index && groups[cursor].startTime > horizon) break;
      if (groups[cursor].endTime < arrival) continue;
      if (needsTranslationEntry(translations.get(groupKey(groups[cursor])), now)) todo.push(groups[cursor]);
    }
    return todo;
  }
  function releasePrefetch(generation, sourceGeneration, inFlight) {
    if (generation !== sourceGeneration) return inFlight;
    return Math.max(0, inFlight - 1);
  }
  function translationRecord({destroyed, generation, sourceGeneration, sourceText, translation, failed, attempts, now}) {
    if (destroyed || generation !== sourceGeneration) return null;
    if (!failed && acceptableTranslation(sourceText, translation)) return {status: 'ok', text: String(translation).trim(), attempts, at: now};
    return {status: 'error', text: '', attempts, at: now};
  }
  globalThis.ShisuiVideoCaptionPlan = Object.freeze({groupCues, localCaption, acceptableTranslation, pendingGroups, releasePrefetch, translationRecord, groupKey, currentGroupIndex, groupIndexAt});

  let instance = null;

  function normalizedSettings(value) {
    return {
      fontSize: FONT_SIZES.has(value?.fontSize) ? value.fontSize : DEFAULT_SETTINGS.fontSize,
      theme: THEMES.has(value?.theme) ? value.theme : DEFAULT_SETTINGS.theme,
      bilingual: value?.bilingual === true,
    };
  }

  function createInstance(callbacks) {
    if (typeof callbacks?.onAssist !== 'function') throw new TypeError('ShisuiVideoSubtitles.mount requires an onAssist callback');
    if (!globalThis.ShisuiDesign?.cssFor) throw new Error('ShisuiDesign must be loaded before ShisuiVideoSubtitles');

    const tokens = globalThis.ShisuiDesign.cssFor(':host');
    const controlHost = document.createElement('span');
    controlHost.setAttribute(HOST_ATTRIBUTE, 'video-subtitles-control');
    controlHost.style.setProperty('all', 'initial', 'important');
    controlHost.style.setProperty('display', 'inline-flex', 'important');
    controlHost.style.setProperty('vertical-align', 'middle', 'important');
    const controlShadow = controlHost.attachShadow({mode: 'closed'});
    controlShadow.innerHTML = `
      <style data-theme-tokens>${tokens}</style><style>
        :host{display:inline-flex;flex:0 0 auto;gap:var(--space-2);font-family:var(--sans)}
        button{min-height:36px;padding:var(--space-2) var(--space-3);border:1px solid var(--line);border-radius:var(--radius-pill);background:var(--surface);color:var(--accent);font:var(--weight-medium) var(--type-control)/var(--leading-control) var(--sans);cursor:pointer;white-space:nowrap}
        button:hover{background:var(--surface-hover);border-color:var(--accent-line)}
        button:focus-visible{outline:var(--focus-ring);outline-offset:var(--focus-offset)}
        button[aria-pressed="true"]{background:var(--action);border-color:var(--action);color:var(--on-action)}
        :host([data-youtube="true"]){gap:0}
        :host([data-youtube="true"]) button{width:48px;height:var(--native-control-size,48px);min-height:var(--native-control-size,48px);padding:0 4px;border:0;border-radius:0;background:transparent;color:#fff;font-size:var(--type-control)}
        :host([data-youtube="true"]) button:hover{background:#1967d2}
        :host([data-youtube="true"]) button[aria-pressed="true"]{box-shadow:inset 0 -3px #fff}
      </style>
      <button class="assist" type="button" aria-label="帮助理解当前字幕">这句</button>
      <button class="bilingual" type="button" aria-pressed="false" aria-label="显示双语字幕">双语</button>
      <button class="transcript" type="button" aria-label="展开英文原文稿" aria-pressed="false">原文</button>`;
    const assistButton = controlShadow.querySelector('.assist');
    const bilingualButton = controlShadow.querySelector('.bilingual');
    const transcriptButton = controlShadow.querySelector('.transcript');

    const transcriptHost = document.createElement('section');
    transcriptHost.setAttribute(HOST_ATTRIBUTE, 'video-transcript');
    transcriptHost.style.setProperty('all', 'initial', 'important');
    transcriptHost.style.setProperty('display', 'none', 'important');
    transcriptHost.style.setProperty('width', '100%', 'important');
    transcriptHost.style.setProperty('box-sizing', 'border-box', 'important');
    const transcriptShadow = transcriptHost.attachShadow({mode: 'closed'});
    transcriptShadow.innerHTML = `
      <style data-theme-tokens>${tokens}</style><style>
        :host{display:block;width:100%;color:var(--ink);font-family:var(--sans);color-scheme:light dark}
        .panel{box-sizing:border-box;margin:var(--space-3) 0;border:1px solid var(--line);border-radius:var(--radius-panel);background:var(--surface);color:var(--ink);overflow:hidden}
        header{display:flex;align-items:center;gap:var(--space-3);flex-wrap:wrap;padding:var(--space-3) var(--space-4);border-bottom:1px solid var(--line);background:var(--surface)}
        h2{margin:0;font:var(--weight-medium) var(--type-body)/var(--leading-control) var(--sans)}
        .progress{margin-right:auto;color:var(--muted-strong);font:var(--weight-medium) var(--type-support)/var(--leading-support) var(--sans)}
        label{display:inline-flex;align-items:center;gap:6px;color:var(--muted-strong);font:var(--weight-medium) var(--type-support)/var(--leading-support) var(--sans)}
        select,.close{min-height:36px;border:1px solid var(--line);border-radius:var(--radius-control);background:var(--surface);color:var(--ink);font:var(--weight-medium) var(--type-control)/var(--leading-control) var(--sans)}
        select{padding:4px 24px 4px 8px}.close{padding:4px 10px;cursor:pointer}
        select:focus-visible,button:focus-visible{outline:var(--focus-ring);outline-offset:var(--focus-offset)}
        .notice{display:none;padding:8px 16px;border-bottom:1px solid var(--line);background:var(--warning-soft);color:var(--warning);font:var(--weight-medium) var(--type-support)/var(--leading-support) var(--sans)}
        .notice[data-kind="error"]{background:var(--danger-soft);color:var(--danger)}
        .list{max-height:min(52vh,620px);overflow:auto;padding:4px 0;background:var(--paper)}
        .cue{display:grid;grid-template-columns:70px minmax(0,1fr);gap:12px;width:100%;box-sizing:border-box;border-bottom:1px solid var(--line);background:transparent;color:var(--ink)}
        .cue[data-active="true"]{background:var(--accent-soft)}
        .time,.text{border:0;background:transparent;color:inherit;cursor:pointer;text-align:left}
        .time{padding:12px 0 12px 16px;color:var(--accent);font:var(--weight-semibold) var(--type-support)/var(--leading-support) var(--mono)}
        .text{min-width:0;padding:10px 16px 10px 0;font:var(--weight-regular) var(--cue-size,20px)/1.5 var(--sans);overflow-wrap:anywhere}
        .time:hover,.text:hover{background:var(--surface-hover)}
        .more{display:block;margin:var(--space-3) auto;min-height:36px;padding:var(--space-2) var(--space-4);border:1px solid var(--line);border-radius:var(--radius-pill);background:var(--surface);color:var(--accent);font:var(--weight-medium) var(--type-control)/var(--leading-control) var(--sans);cursor:pointer}
        @media(max-width:640px){header{align-items:flex-start}.cue{grid-template-columns:56px minmax(0,1fr)}label{width:calc(50% - 8px)}}
      </style>
      <div class="panel"><header><h2>英文原文稿</h2><span class="progress">正在读取字幕…</span>
        <label>字号<select data-setting="fontSize"><option value="16">16</option><option value="20">20</option><option value="24">24</option><option value="28">28</option></select></label>
        <label>主题<select data-setting="theme"><option value="auto">跟随系统</option><option value="light">明亮</option><option value="dark">深色</option></select></label>
        <button class="close" type="button">关闭</button>
      </header><div class="notice" role="status" aria-live="polite"></div><div class="list"></div></div>`;
    const list = transcriptShadow.querySelector('.list');
    const progress = transcriptShadow.querySelector('.progress');
    const notice = transcriptShadow.querySelector('.notice');
    const overlayHost = document.createElement('div');
    overlayHost.setAttribute(HOST_ATTRIBUTE, 'video-bilingual');
    overlayHost.style.setProperty('all', 'initial', 'important');
    overlayHost.style.setProperty('position', 'fixed', 'important');
    overlayHost.style.setProperty('z-index', '2147483646', 'important');
    overlayHost.style.setProperty('pointer-events', 'none', 'important');
    overlayHost.style.setProperty('display', 'none', 'important');
    const overlayShadow = overlayHost.attachShadow({mode: 'closed'});
    overlayShadow.innerHTML = `
      <style data-theme-tokens>${tokens}</style><style>
        :host{display:block;width:100%;height:100%;pointer-events:none;font-family:var(--sans,sans-serif);--sub-size:20px;--sub-bottom:72px}
        .stack{position:absolute;left:50%;bottom:var(--sub-bottom);transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:.12em;width:min(90%,1000px);font-size:var(--sub-size);text-align:center;pointer-events:none}
        .stack[hidden]{display:none}
        .line{display:block;margin:0;padding:0;max-width:100%;border:0;background:none;text-align:center;line-height:1.36;text-wrap:balance;overflow-wrap:anywhere}
        .line>span{padding:.06em .36em;border-radius:.18em;background:rgba(0,0,0,.72);-webkit-box-decoration-break:clone;box-decoration-break:clone;text-shadow:0 0 .12em rgba(0,0,0,.6)}
        .translation{order:1;color:#fff;font:600 1em/1.36 var(--sans,sans-serif);letter-spacing:.02em;word-break:keep-all;line-break:strict}
        .notice{order:1;color:#ffd9a0;font:500 .62em/1.4 var(--sans,sans-serif)}
        .original{order:2;color:rgba(255,255,255,.9);font:500 .76em/1.4 var(--sans,sans-serif)}
        .line[hidden]{display:none}
      </style>
      <div class="stack" hidden>
        <p class="line translation" lang="zh-CN" hidden><span></span></p>
        <p class="line notice" role="status" hidden><span></span></p>
        <p class="line original" lang="en"><span></span></p>
      </div>`;
    const overlayStack = overlayShadow.querySelector('.stack');
    const overlayTranslation = overlayShadow.querySelector('.translation');
    const overlayTranslationText = overlayTranslation.querySelector('span');
    const overlayNotice = overlayShadow.querySelector('.notice');
    const overlayNoticeText = overlayNotice.querySelector('span');
    const overlayOriginal = overlayShadow.querySelector('.original');
    const overlayOriginalText = overlayOriginal.querySelector('span');
    const themeStyles = [controlShadow, transcriptShadow, overlayShadow].map(shadow => shadow.querySelector('[data-theme-tokens]'));

    let currentCallbacks = callbacks;
    let settings = normalizedSettings(callbacks.settings);
    let renderedTheme;
    let video = null;
    let source = null;
    let sourceGeneration = 0;
    let sessionGeneration = 0;
    let destroyed = false;
    let transcriptOpen = false;
    let refreshBusy = false;
    let captionAbort = null;
    let lastUrl = location.href;
    let refreshTimer = null;
    let frameId = null;
    let requestSequence = 0;
    let bridgeCleanup = null;
    let renderedCount = 0;
    let restoredTrack = null;
    let activeAssist = null;
    let translations = new Map();
    let prefetchInFlight = 0;
    let priorityRequest = null;
    let observedTranslateMs = 0;
    let translateNoticeFor = '';
    let bridgeInstalled = false;
    let bridgeFailed = false;
    let discoverAttemptedFor = '';
    let warmedVideoId = '';
    let failedVideoId = '';
    let refreshSkips = 0;
    let captionStatus = '';

    function isYoutube() { return /(^|\.)youtube\.com$/.test(location.hostname); }
    function formatTime(seconds) {
      const value = Math.max(0, Math.floor(Number(seconds) || 0));
      const hours = Math.floor(value / 3600);
      const minutes = Math.floor(value % 3600 / 60);
      const secs = value % 60;
      return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}` : `${minutes}:${String(secs).padStart(2, '0')}`;
    }
    function normalizedCue(cue) {
      const startTime = Number(cue?.startTime);
      const endTime = Number(cue?.endTime);
      const text = String(cue?.text || '').replace(/\s+/g, ' ').trim();
      if (!text || !Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime) return null;
      return {startTime: Math.max(0, startTime), endTime: Math.max(startTime, endTime), text};
    }
    function isEnglishLanguage(value) { return /^en(?:-|$)/i.test(String(value || '').trim()); }
    function sentenceCount(text) {
      const matches = String(text).match(/[^.!?]+(?:[.!?]+|$)/g);
      return matches ? matches.filter(part => part.trim()).length : 0;
    }
    function applySettingsToUi() {
      if (renderedTheme !== settings.theme) {
        const css = globalThis.ShisuiDesign.cssFor(':host', settings.theme);
        for (const host of [controlHost, transcriptHost]) host.style.setProperty('color-scheme', settings.theme === 'auto' ? 'light dark' : settings.theme, 'important');
        for (const style of themeStyles) style.textContent = css;
        renderedTheme = settings.theme;
      }
      transcriptHost.style.setProperty('--cue-size', `${settings.fontSize}px`);
      bilingualButton.setAttribute('aria-pressed', String(settings.bilingual));
      bilingualButton.setAttribute('aria-label', settings.bilingual ? '关闭双语字幕' : '显示双语字幕');
      bilingualButton.textContent = '双语';
      for (const select of transcriptShadow.querySelectorAll('[data-setting]')) select.value = String(settings[select.dataset.setting]);
    }
    function showNotice(message, kind = '') {
      notice.textContent = message;
      notice.dataset.kind = kind;
      notice.style.display = message ? 'block' : 'none';
    }

    function visibleVideo() {
      let selected = null;
      let selectedArea = 0;
      for (const candidate of document.querySelectorAll('video')) {
        if (!candidate.isConnected) continue;
        const rect = candidate.getBoundingClientRect();
        const area = Math.max(0, Math.min(innerWidth, rect.right) - Math.max(0, rect.left)) * Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top));
        if (rect.width >= 180 && rect.height >= 100 && area > selectedArea) { selected = candidate; selectedArea = area; }
      }
      return selected;
    }
    function youtubeControls() {
      const player = video?.closest('.html5-video-player') || (isYoutube() ? document.getElementById('movie_player') : null);
      return player?.querySelector('.ytp-right-controls') || null;
    }
    function customControls() {
      if (!video || video.controls || youtubeControls()) return null;
      const player = video.closest('[data-player],.video-player,.player,[class*="player"]') || video.parentElement;
      if (!player) return null;
      const videoRect = video.getBoundingClientRect();
      for (const candidate of player.querySelectorAll('[data-controls],.video-controls,.player-controls,[class*="controls"]')) {
        if (candidate === controlHost || candidate.closest(`[${HOST_ATTRIBUTE}]`)) continue;
        const rect = candidate.getBoundingClientRect();
        if (rect.width >= 120 && rect.height >= 20 && rect.height <= 100 && rect.top >= videoRect.top + videoRect.height * .55) return candidate;
      }
      return null;
    }
    function transcriptAnchor() {
      if (!video) return null;
      if (youtubeControls()) return video.closest('ytd-player') || video.closest('#player') || video.closest('.html5-video-player') || video;
      return video.closest('[data-player],.video-player,.player') || video;
    }
    function controlsClearance(rect) {
      const player = video?.closest('.html5-video-player');
      if (player) {
        const hidden = player.classList.contains('ytp-autohide') || player.classList.contains('ytp-hide-controls');
        const barHeight = player.querySelector('.ytp-chrome-bottom')?.getBoundingClientRect().height || 48;
        return hidden ? barHeight + 4 : barHeight + rect.height * 0.035;
      }
      return video?.controls ? Math.max(rect.height * 0.12, 52) : rect.height * 0.06;
    }
    function setNativeCaptionHidden(hidden) {
      const id = 'shisui-hide-native-captions';
      const existing = document.getElementById(id);
      if (!hidden) { existing?.remove(); return; }
      if (existing) return;
      const style = document.createElement('style');
      style.id = id;
      style.textContent = '.ytp-caption-window-container,.ytp-caption-window-rollup{opacity:0 !important}';
      document.documentElement.append(style);
    }
    function placeOverlay() {
      if (!settings.bilingual || !video?.isConnected) {
        overlayHost.style.setProperty('display', 'none', 'important');
        return;
      }
      const fullscreen = document.fullscreenElement;
      const parent = fullscreen && (fullscreen === video || fullscreen.contains(video)) ? fullscreen : document.documentElement;
      if (overlayHost.parentElement !== parent) parent.append(overlayHost);
      const rect = video.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) {
        overlayHost.style.setProperty('display', 'none', 'important');
        return;
      }
      const base = Math.max(14, Math.min(44, rect.height * 0.046));
      const size = Math.round(base * settings.fontSize / DEFAULT_SETTINGS.fontSize);
      overlayHost.style.setProperty('display', 'block', 'important');
      overlayHost.style.setProperty('left', `${rect.left}px`, 'important');
      overlayHost.style.setProperty('top', `${rect.top}px`, 'important');
      overlayHost.style.setProperty('width', `${rect.width}px`, 'important');
      overlayHost.style.setProperty('height', `${rect.height}px`, 'important');
      overlayHost.style.setProperty('--sub-size', `${size}px`);
      overlayHost.style.setProperty('--sub-bottom', `${Math.round(controlsClearance(rect))}px`);
    }
    function placeUi() {
      if (!video?.isConnected) { controlHost.remove(); transcriptHost.remove(); overlayHost.style.setProperty('display', 'none', 'important'); setNativeCaptionHidden(false); return; }
      const fullscreen = document.fullscreenElement;
      if (fullscreen === video) controlHost.remove();
      else {
        const ytControls = youtubeControls();
        const custom = customControls();
        if (ytControls) {
          controlHost.dataset.youtube = 'true';
          controlHost.style.setProperty('--native-control-size', `${Math.max(32, Math.min(48, ytControls.getBoundingClientRect().height || 48))}px`);
          const cc = ytControls.querySelector('.ytp-subtitles-button');
          if (cc && cc.nextElementSibling !== controlHost) cc.insertAdjacentElement('afterend', controlHost);
          else if (!cc && controlHost.parentElement !== ytControls) ytControls.prepend(controlHost);
        } else if (custom) {
          delete controlHost.dataset.youtube;
          if (controlHost.parentElement !== custom) custom.append(controlHost);
        } else if (video.controls) {
          delete controlHost.dataset.youtube;
          let row = video.nextElementSibling?.matches?.(`[${HOST_ATTRIBUTE}="video-subtitles-row"]`) ? video.nextElementSibling : null;
          if (!row) {
            row = document.createElement('div');
            row.setAttribute(HOST_ATTRIBUTE, 'video-subtitles-row');
            row.style.cssText = 'box-sizing:border-box;display:flex;align-items:center;justify-content:flex-end;gap:8px;width:100%;padding:8px 0;position:relative;z-index:1;';
            video.insertAdjacentElement('afterend', row);
          }
          if (controlHost.parentElement !== row) row.append(controlHost);
        } else controlHost.remove();
      }
      const row = controlHost.parentElement?.matches?.(`[${HOST_ATTRIBUTE}="video-subtitles-row"]`) ? controlHost.parentElement : null;
      const after = row || transcriptAnchor();
      if (after?.parentElement && transcriptHost.previousElementSibling !== after) after.insertAdjacentElement('afterend', transcriptHost);
      const fullscreenParent = fullscreen && fullscreen.contains(video) ? fullscreen : null;
      if (fullscreenParent && transcriptOpen && transcriptHost.parentElement !== fullscreenParent) fullscreenParent.append(transcriptHost);
      placeOverlay();
    }

    function restoreHtmlTrack() {
      if (!restoredTrack) return;
      const {track, mode, ownedMode} = restoredTrack;
      if (track.mode === ownedMode) {
        try { track.mode = mode; } catch { /* Detached tracks need no restoration. */ }
      }
      restoredTrack = null;
    }
    function htmlTrackSource() {
      if (!video?.textTracks) return {state: 'none'};
      const tracks = Array.from(video.textTracks).filter(track => (['subtitles', 'captions'].includes(track.kind) || !track.kind) && isEnglishLanguage(track.language));
      if (!tracks.length) return {state: 'none'};
      const track = tracks.find(item => item.mode === 'showing') || tracks.find(item => item.mode === 'hidden') || tracks[0];
      if (track.mode === 'disabled') {
        try {
          restoredTrack = {track, mode: track.mode, ownedMode: 'showing'};
          track.mode = 'showing';
        } catch { restoredTrack = null; return {state: 'unavailable'}; }
      }
      if (!track.cues) return {state: 'loading'};
      const cues = Array.from(track.cues, normalizedCue).filter(Boolean).sort((a, b) => a.startTime - b.startTime);
      if (!cues.length) return {state: 'loading'};
      return {state: 'ready', key: `html:${tracks.indexOf(track)}:${track.language}:${track.label || ''}`, cues};
    }
    function videoIdFromLocation() {
      if (!isYoutube()) return '';
      const pathMatch = location.pathname.match(/^\/(?:shorts|embed|live)\/(?!videoseries\b|live_stream\b)([A-Za-z0-9_-]{6,})/);
      return pathMatch?.[1] || new URL(location.href).searchParams.get('v') || '';
    }
    function bridgeRequest(command, language) {
      return new Promise(resolve => {
        const requestId = `shisui-${Date.now().toString(36)}-${(++requestSequence).toString(36)}`;
        const timeoutMs = command === 'discover' || command === 'prepare' || command === 'caption' ? 9000 : 2200;
        const timeout = setTimeout(() => { removeEventListener(YOUTUBE_RESPONSE_EVENT, onResponse); bridgeCleanup = null; resolve(null); }, timeoutMs);
        function onResponse(event) {
          if (event.detail?.requestId !== requestId) return;
          clearTimeout(timeout); removeEventListener(YOUTUBE_RESPONSE_EVENT, onResponse); bridgeCleanup = null; resolve(event.detail);
        }
        addEventListener(YOUTUBE_RESPONSE_EVENT, onResponse);
        bridgeCleanup = () => { clearTimeout(timeout); removeEventListener(YOUTUBE_RESPONSE_EVENT, onResponse); bridgeCleanup = null; resolve(null); };
        dispatchEvent(new CustomEvent(YOUTUBE_REQUEST_EVENT, {detail: {requestId, command, ...(language ? {language} : {})}}));
      });
    }
    async function ensureBridge() {
      if (!isYoutube()) return false;
      if (bridgeInstalled) return true;
      if (bridgeFailed || typeof currentCallbacks.onPrepareBridge !== 'function') return false;
      try {
        await currentCallbacks.onPrepareBridge();
        bridgeInstalled = true;
        return true;
      } catch {
        bridgeFailed = true;
        return false;
      }
    }
    function restoreYoutube() {
      if (!bridgeInstalled) return;
      void bridgeRequest('restore');
    }
    function safeYoutubeCaptionUrl(rawUrl) {
      try {
        const url = new URL(rawUrl);
        if (url.protocol !== 'https:' || url.hostname !== 'www.youtube.com' || url.pathname !== '/api/timedtext') return null;
        url.searchParams.set('fmt', 'json3');
        url.hash = '';
        return url.href;
      } catch { return null; }
    }
    function cuesFromText(text) {
      if (typeof text !== 'string' || !text || text.trimStart().startsWith('<')) return null;
      try {
        const parsed = globalThis.ShisuiYoutubeCaptionParser?.parseJson3(text);
        if (!Array.isArray(parsed)) return null;
        const cues = parsed.map(normalizedCue).filter(Boolean).sort((a, b) => a.startTime - b.startTime);
        return cues.length ? cues : null;
      } catch { return null; }
    }
    async function loadCueText(captionUrl) {
      const safe = safeYoutubeCaptionUrl(captionUrl);
      if (!safe || typeof currentCallbacks.onFetchCaption !== 'function') return null;
      try { return cuesFromText(await currentCallbacks.onFetchCaption(safe)); } catch { return null; }
    }
    async function youtubeSource() {
      const expectedVideoId = videoIdFromLocation();
      if (!expectedVideoId) return {state: 'none'};
      if (failedVideoId === expectedVideoId) {
        refreshSkips += 1;
        if (refreshSkips < 8) return {state: 'unavailable'};
        refreshSkips = 0;
        failedVideoId = '';
        warmedVideoId = '';
        discoverAttemptedFor = '';
      }
      if (!await ensureBridge()) return {state: 'bridge-unavailable'};
      let detail = await bridgeRequest('snapshot');
      if (!detail) return {state: 'bridge-unavailable'};
      if (detail.videoId && detail.videoId !== expectedVideoId) return {state: 'loading'};
      if (!detail.track && discoverAttemptedFor !== expectedVideoId) {
        discoverAttemptedFor = expectedVideoId;
        const discovered = await bridgeRequest('discover');
        if (discovered?.track && (!discovered.videoId || discovered.videoId === expectedVideoId)) detail = discovered;
      }
      if (!detail.track || !isEnglishLanguage(detail.track.languageCode)) return {state: 'none'};
      const key = `youtube:${expectedVideoId}:${String(detail.track.languageCode || '')}:${String(detail.track.key || '')}`;
      if (source?.key === key && source.cues?.length) {
        const last = source.cues[source.cues.length - 1];
        const duration = Number(video?.duration);
        const live = !Number.isFinite(duration) || duration === Infinity;
        const mayGrow = live || (Number.isFinite(duration) && last.endTime < duration - 20);
        if (!mayGrow || !video || video.currentTime < last.endTime - 6) return source;
        const grown = cuesFromText((await bridgeRequest('caption'))?.text);
        if (grown?.length) return {state: 'ready', key, cues: grown};
        return source;
      }
      let cues = null;
      if (warmedVideoId !== expectedVideoId) {
        warmedVideoId = expectedVideoId;
        const loaded = await bridgeRequest('caption');
        if (loaded?.track && isEnglishLanguage(loaded.track.languageCode) && (!loaded.videoId || loaded.videoId === expectedVideoId)) detail = loaded;
        cues = cuesFromText(loaded?.text);
      }
      if (!cues?.length) cues = await loadCueText(detail.track?.baseUrl);
      if (!cues?.length) {
        failedVideoId = expectedVideoId;
        return {state: 'unavailable'};
      }
      failedVideoId = '';
      refreshSkips = 0;
      return {state: 'ready', key, cues};
    }

    function sourceSignature(next) {
      let hash = 2166136261;
      for (const cue of next.cues) {
        const value = `${cue.startTime}\u0000${cue.endTime}\u0000${cue.text}`;
        for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
      }
      return `${next.key}:${next.cues.length}:${hash >>> 0}`;
    }
    function closeActiveAssist() {
      const assist = activeAssist;
      if (!assist) return;
      activeAssist = null;
      try { assist.controller?.close?.(); } catch { /* The shared card may already be gone. */ }
      finishAssist(assist);
    }
    function finishAssist(assist) {
      if (!assist || assist.finished) return;
      assist.finished = true;
      if (activeAssist === assist) activeAssist = null;
      if (assist.pausedByUs && !assist.intervened && video === assist.video && source?.key === assist.sourceKey && sourceGeneration === assist.generation && assist.video.isConnected && assist.video.paused) {
        try { void assist.video.play(); } catch { /* Autoplay policy may reject safe restoration. */ }
      }
    }
    function resetTranslationWork() {
      prefetchInFlight = 0;
      priorityRequest = null;
    }
    function installSource(next) {
      const signature = sourceSignature(next);
      if (source?.signature === signature) return false;
      const sameTrack = source?.key === next.key;
      const previous = sameTrack ? new Map(translations) : null;
      if (!sameTrack) {
        sourceGeneration += 1;
        resetTranslationWork();
        closeActiveAssist();
        translations = new Map();
        translateNoticeFor = '';
      }
      source = {...next, signature, groups: groupCues(next.cues)};
      renderedCount = Math.min(RENDER_PAGE_SIZE, source.cues.length);
      if (previous) {
        translations = new Map();
        for (const group of source.groups) {
          const key = groupKey(group);
          if (previous.has(key)) translations.set(key, previous.get(key));
        }
      }
      return true;
    }
    function clearSource() {
      sourceGeneration += 1;
      resetTranslationWork();
      closeActiveAssist();
      source = null;
      translations = new Map();
      renderedCount = 0;
      captionAbort?.abort(); captionAbort = null;
      renderTranscript(true);
    }
    function applySource(next) {
      if (!next) next = htmlTrackSource();
      if (next.state !== 'ready') {
        if (source) clearSource();
        const messages = {none:['未找到可用英文字幕','warning'],loading:['正在读取英文字幕…',''],unavailable:['英文字幕时间轴不可获得','error'],'bridge-unavailable':['YouTube 字幕读取组件未就绪','error']};
        const [message, kind] = messages[next.state] || messages.unavailable;
        showNotice(message, kind);
        captionStatus = message;
        progress.textContent = message;
        renderOverlay();
        return;
      }
      const changed = installSource(next);
      captionStatus = '';
      showNotice('');
      if (changed) renderTranscript(true);
      updateActiveCue();
    }
    async function refreshSource() {
      if (destroyed || refreshBusy || !video) return;
      refreshBusy = true;
      try {
        const generation = sessionGeneration;
        const next = isYoutube() ? await youtubeSource() : htmlTrackSource();
        if (!destroyed && generation === sessionGeneration) applySource(next);
      } finally { refreshBusy = false; }
    }

    function insertionIndex(time) {
      const cues = source?.cues || [];
      let low = 0; let high = cues.length;
      while (low < high) { const middle = (low + high) >> 1; if (cues[middle].startTime <= time) low = middle + 1; else high = middle; }
      return low - 1;
    }
    function currentCueIndex() {
      if (!source?.cues.length || !video) return -1;
      const index = insertionIndex(video.currentTime);
      if (index < 0) return 0;
      return Math.min(index, source.cues.length - 1);
    }
    function contextForCue(index) {
      const target = source.cues[index].text;
      if (target.length > MAX_TARGET_LENGTH || sentenceCount(target) > 3) return null;
      const parts = [target];
      if (index > 0 && source.cues[index - 1].text.length + 1 + target.length <= MAX_CONTEXT_LENGTH) parts.unshift(source.cues[index - 1].text);
      if (index + 1 < source.cues.length && parts.join(' ').length + 1 + source.cues[index + 1].text.length <= MAX_CONTEXT_LENGTH) parts.push(source.cues[index + 1].text);
      return parts.join(' ');
    }
    function requestAssist(index, anchor) {
      if (!source || !video || index < 0 || index >= source.cues.length) { showNotice('未找到可用英文字幕', 'warning'); return; }
      const cue = source.cues[index];
      const context = contextForCue(index);
      if (!context) { showNotice('请只选择一个句子或短段（最多 3 句、600 字符）', 'error'); return; }
      closeActiveAssist();
      const assistVideo = video;
      const assistSourceKey = source.key;
      const assistGeneration = sourceGeneration;
      const pausedByUs = !assistVideo.paused;
      const assist = {video: assistVideo, sourceKey: assistSourceKey, generation: assistGeneration, pausedByUs, intervened: false, controller: null, finished: false};
      if (pausedByUs) {
        try { assistVideo.pause(); } catch { assist.pausedByUs = false; }
      }
      activeAssist = assist;
      const isValid = () => !destroyed && activeAssist === assist && video === assistVideo && assistVideo.isConnected && source?.key === assistSourceKey && sourceGeneration === assistGeneration;
      const target = {
        text: cue.text,
        context,
        kind: sentenceCount(cue.text) > 1 ? 'passage' : (cue.text.trim().split(/\s+/).length === 1 ? 'word' : 'phrase'),
        anchorRect: anchor.getBoundingClientRect(),
        sourceKey: assistSourceKey,
        isValid,
        onClose: () => finishAssist(assist),
      };
      try {
        const controller = currentCallbacks.onAssist(target);
        assist.controller = controller && typeof controller.close === 'function' ? controller : null;
      } catch {
        finishAssist(assist);
        showNotice('暂时无法打开字幕帮助', 'error');
      }
    }

    function populateCue(row, index) {
      const cue = source.cues[index];
      row.querySelector('.time').textContent = formatTime(cue.startTime);
      row.querySelector('.text').textContent = cue.text;
      row.dataset.active = String(index === currentCueIndex());
    }
    function renderTranscript(reset = false) {
      if (!source) { list.replaceChildren(); progress.textContent = '正在读取字幕…'; return; }
      const previousScroll = list.scrollTop;
      if (reset) list.replaceChildren();
      const limit = Math.min(renderedCount || RENDER_PAGE_SIZE, source.cues.length);
      for (let index = list.querySelectorAll('.cue').length; index < limit; index += 1) {
        const row = document.createElement('div');
        row.className = 'cue'; row.dataset.index = String(index);
        row.innerHTML = '<button class="time" type="button" aria-label="跳转到字幕时间"></button><button class="text" type="button" aria-label="帮助理解这句字幕"></button>';
        populateCue(row, index); list.append(row);
      }
      let more = list.querySelector('.more');
      if (limit < source.cues.length) {
        if (!more) {
          more = document.createElement('button'); more.type = 'button'; more.className = 'more';
          more.addEventListener('click', () => { renderedCount = Math.min(source.cues.length, renderedCount + RENDER_PAGE_SIZE); renderTranscript(); });
        }
        more.textContent = `继续显示（剩余 ${source.cues.length - limit} 条）`; list.append(more);
      } else more?.remove();
      if (reset) list.scrollTop = previousScroll;
      progress.textContent = `${source.cues.length} 条英文字幕`;
    }
    function updateActiveCue() {
      if (!source) return;
      const active = currentCueIndex();
      for (const row of list.querySelectorAll('.cue')) row.dataset.active = String(Number(row.dataset.index) === active);
      renderOverlay();
      scheduleTranslation();
    }
    function clipCaption(text, max, fromEnd = false) {
      const value = String(text || '').replace(/\s+/g, ' ').trim();
      return value.length <= max ? value : fromEnd ? value.slice(value.length - max) : value.slice(0, max);
    }
    function videoTitle() {
      const heading = isYoutube() ? document.querySelector('h1.ytd-watch-metadata, #title h1')?.textContent : '';
      return String(heading || document.title || '').replace(/\s*-\s*YouTube\s*$/i, '').replace(/\s+/g, ' ').trim().slice(0, 160);
    }
    function translationContext(group) {
      const groups = source?.groups || [];
      const index = groups.indexOf(group);
      const before = index > 0 ? groups.slice(Math.max(0, index - 2), index).map(item => item.text).join(' ') : '';
      const after = index >= 0 && index + 1 < groups.length ? groups[index + 1].text : '';
      return {title: videoTitle(), heading: '', before: clipCaption(before, 400, true), after: clipCaption(after, 400)};
    }
    function wantsTranslation() { return settings.bilingual && !destroyed && Boolean(source?.groups?.length); }
    function activeGroup() {
      const groups = source?.groups || [];
      const time = video?.currentTime || 0;
      const index = currentGroupIndex(groups, time);
      if (index < 0) return null;
      const group = groups[index];
      return time <= group.endTime + 0.35 ? group : null;
    }
    async function translateGroups(groups, generation) {
      for (const group of groups) {
        const key = groupKey(group);
        const previous = translations.get(key);
        translations.set(key, {status: 'pending', text: '', attempts: (previous?.attempts || 0) + 1, at: Date.now()});
      }
      renderOverlay();
      const remote = [];
      groups.forEach((group, index) => {
        const local = localCaption(group.text);
        const key = groupKey(group);
        if (local) translations.set(key, {status: 'ok', text: local, attempts: translations.get(key)?.attempts || 1, at: Date.now()});
        else remote.push({group, id: `c${index + 1}`, text: group.text.slice(0, 4000)});
      });
      if (!remote.length || typeof currentCallbacks.onTranslate !== 'function') {
        if (remote.length && generation === sourceGeneration) {
          for (const item of remote) {
            const key = groupKey(item.group);
            translations.set(key, {status: 'error', text: '', attempts: translations.get(key)?.attempts || 1, at: Date.now()});
          }
        }
        renderOverlay();
        return;
      }
      try {
        const started = performance.now();
        const result = await currentCallbacks.onTranslate(remote.map(item => ({id: item.id, text: item.text, context: translationContext(item.group)})));
        const elapsed = performance.now() - started;
        observedTranslateMs = observedTranslateMs ? observedTranslateMs * 0.6 + elapsed * 0.4 : elapsed;
        // 关掉双语只停止新任务。同一轨的在途结果仍写入，重开时不能停在 pending。
        const byId = new Map((result?.items || []).map(item => [item.id, item.translation]));
        const failed = new Set((result?.errors || []).map(item => item.id));
        let stored = false;
        for (const item of remote) {
          const key = groupKey(item.group);
          const record = translationRecord({destroyed, generation, sourceGeneration, sourceText: item.text, translation: byId.get(item.id), failed: failed.has(item.id), attempts: translations.get(key)?.attempts || 1, now: Date.now()});
          if (!record) continue;
          translations.set(key, record);
          stored = true;
        }
        if (stored && remote.every(item => translations.get(groupKey(item.group))?.status === 'ok')) { translateNoticeFor = ''; captionStatus = ''; }
      } catch (error) {
        if (destroyed || generation !== sourceGeneration) return;
        for (const item of remote) {
          const key = groupKey(item.group);
          translations.set(key, {status: 'error', text: '', attempts: translations.get(key)?.attempts || 1, at: Date.now()});
        }
        const reason = String(error?.message || '').trim();
        const id = `${source?.key || ''}\u0000${reason}`;
        captionStatus = reason ? `字幕翻译失败：${reason}` : '字幕翻译失败';
        if (reason && translateNoticeFor !== id) { translateNoticeFor = id; showNotice(captionStatus, 'error'); }
      }
      renderOverlay();
    }
    function arrivalTime() {
      const now = video?.currentTime || 0;
      if (!video || video.paused || !observedTranslateMs) return now;
      return now + observedTranslateMs / 1000 * (video.playbackRate || 1);
    }
    function ensureCurrentTranslated() {
      if (!wantsTranslation() || priorityRequest || typeof currentCallbacks.onTranslate !== 'function') return;
      const groups = source?.groups || [];
      const current = currentGroupIndex(groups, video?.currentTime || 0);
      const landing = groupIndexAt(groups, arrivalTime());
      const now = Date.now();
      const group = [groups[landing], groups[current]].find(item => item && needsTranslationEntry(translations.get(groupKey(item)), now));
      if (!group) return;
      const generation = sourceGeneration;
      const request = {};
      priorityRequest = request;
      void (async () => {
        try { await translateGroups([group], generation); } catch { /* 失败状态由批次处理。 */ }
        finally { if (priorityRequest === request) priorityRequest = null; }
      })();
    }
    function scheduleTranslation() {
      if (!wantsTranslation() || typeof currentCallbacks.onTranslate !== 'function') return;
      ensureCurrentTranslated();
      const maxInFlight = observedTranslateMs >= SLOW_TRANSLATE_MS ? 2 : 1;
      while (prefetchInFlight < maxInFlight) {
        const generation = sourceGeneration;
        const time = video?.currentTime || 0;
        const horizon = time + Math.max(TRANSLATE_LOOK_AHEAD_SECONDS, observedTranslateMs / 1000 * 4);
        const todo = pendingGroups({groups: source?.groups || [], time, translations, horizon, arrival: arrivalTime(), limit: TRANSLATE_BATCH_SIZE, now: Date.now()});
        if (!todo.length) return;
        prefetchInFlight += 1;
        void translateGroups(todo, generation).catch(() => {}).finally(() => {
          prefetchInFlight = releasePrefetch(generation, sourceGeneration, prefetchInFlight);
          if (generation === sourceGeneration && wantsTranslation()) scheduleTranslation();
        });
      }
    }
    function renderOverlay() {
      placeOverlay();
      const group = settings.bilingual ? activeGroup() : null;
      const known = group ? translations.get(groupKey(group)) : null;
      const chinese = known?.status === 'ok' ? known.text : '';
      const status = chinese ? '' : known?.status === 'pending' ? '正在翻译…' : known?.status === 'error' ? (captionStatus || '这句翻译失败') : (group ? '' : captionStatus);
      overlayTranslationText.textContent = chinese;
      overlayTranslation.hidden = !chinese;
      overlayNoticeText.textContent = status;
      overlayNotice.hidden = !status;
      const english = group?.text || '';
      overlayOriginalText.textContent = english;
      overlayOriginal.hidden = !english;
      overlayStack.hidden = !chinese && !status && !english;
      setNativeCaptionHidden(Boolean(settings.bilingual && source?.cues?.length));
    }

    function restoreNativeState() { restoreHtmlTrack(); restoreYoutube(); }
    function markAssistIntervened() { if (activeAssist) activeAssist.intervened = true; }
    function detachVideo() {
      if (!video) return;
      closeActiveAssist();
      for (const [name, handler] of [['timeupdate',updateActiveCue],['emptied',onMediaChanged],['loadedmetadata',onMediaChanged],['play',markAssistIntervened],['seeking',markAssistIntervened],['seeked',markAssistIntervened],['ratechange',markAssistIntervened],['volumechange',markAssistIntervened]]) video.removeEventListener(name, handler);
      restoreNativeState();
      const row = controlHost.parentElement?.matches?.(`[${HOST_ATTRIBUTE}="video-subtitles-row"]`) ? controlHost.parentElement : null;
      if (row) row.remove(); else controlHost.remove();
      transcriptHost.remove(); video = null;
    }
    function attachVideo(next) {
      if (next === video) return;
      detachVideo(); clearSource(); video = next; sessionGeneration += 1;
      if (video) {
        for (const [name, handler] of [['timeupdate',updateActiveCue],['emptied',onMediaChanged],['loadedmetadata',onMediaChanged],['play',markAssistIntervened],['seeking',markAssistIntervened],['seeked',markAssistIntervened],['ratechange',markAssistIntervened],['volumechange',markAssistIntervened]]) video.addEventListener(name, handler);
      }
      placeUi(); if (video) void refreshSource();
    }
    function onMediaChanged() { sessionGeneration += 1; clearSource(); restoreNativeState(); if (video) void refreshSource(); }
    function setTranscriptOpen(next) {
      transcriptOpen = Boolean(next);
      transcriptButton.setAttribute('aria-pressed', String(transcriptOpen));
      transcriptButton.setAttribute('aria-label', transcriptOpen ? '收起英文原文稿' : '展开英文原文稿');
      transcriptHost.style.setProperty('display', transcriptOpen ? 'block' : 'none', 'important');
      placeUi(); if (transcriptOpen) { renderTranscript(true); void refreshSource(); }
    }

    async function setBilingual(next) {
      const previous = settings;
      const bilingual = next === true;
      settings = normalizedSettings({...settings, bilingual});
      applySettingsToUi();
      renderOverlay();
      if (typeof currentCallbacks.onSettingsChange !== 'function') { if (bilingual) scheduleTranslation(); return; }
      try {
        const result = await currentCallbacks.onSettingsChange({bilingual});
        settings = normalizedSettings(result?.video);
        applySettingsToUi();
        if (settings.bilingual) scheduleTranslation();
        else renderOverlay();
      } catch {
        settings = previous;
        applySettingsToUi();
        renderOverlay();
        showNotice('双语字幕没有保存，已恢复原设置', 'error');
      }
    }
    assistButton.addEventListener('click', () => requestAssist(currentCueIndex(), assistButton));
    bilingualButton.addEventListener('click', () => { void setBilingual(!settings.bilingual); });
    transcriptButton.addEventListener('click', () => setTranscriptOpen(!transcriptOpen));
    transcriptShadow.querySelector('.close').addEventListener('click', () => setTranscriptOpen(false));
    list.addEventListener('click', event => {
      const row = event.target.closest('.cue'); if (!row || !video || !source) return;
      const index = Number(row.dataset.index);
      if (event.target.closest('.time')) { video.currentTime = source.cues[index].startTime; updateActiveCue(); }
      else if (event.target.closest('.text')) requestAssist(index, event.target.closest('.text'));
    });
    for (const select of transcriptShadow.querySelectorAll('[data-setting]')) {
      select.addEventListener('change', async () => {
        const key = select.dataset.setting;
        const previous = settings;
        const candidate = normalizedSettings({...settings, [key]: key === 'fontSize' ? Number(select.value) : select.value});
        settings = candidate; applySettingsToUi(); showNotice('');
        if (typeof currentCallbacks.onSettingsChange !== 'function') { showNotice('设置仅在当前页面生效', 'warning'); return; }
        try {
          const result = await currentCallbacks.onSettingsChange({[key]: candidate[key]});
          settings = normalizedSettings(result?.video); applySettingsToUi();
        } catch {
          settings = previous; applySettingsToUi(); showNotice('设置保存失败，已恢复原设置', 'error');
        }
      });
    }

    const observer = new MutationObserver(() => {
      if (frameId !== null) return;
      frameId = requestAnimationFrame(() => { frameId = null; attachVideo(visibleVideo()); placeUi(); });
    });
    observer.observe(document.documentElement, {childList: true, subtree: true});
    function periodicRefresh() {
      if (location.href !== lastUrl) { lastUrl = location.href; sessionGeneration += 1; clearSource(); restoreNativeState(); }
      attachVideo(visibleVideo()); placeUi(); if (video) void refreshSource();
    }
    function onFullscreenChange() { placeUi(); }
    function onLayoutChange() { placeOverlay(); }
    document.addEventListener('fullscreenchange', onFullscreenChange);
    addEventListener('scroll', onLayoutChange, true);
    addEventListener('resize', onLayoutChange);
    attachVideo(visibleVideo()); applySettingsToUi(); refreshTimer = setInterval(periodicRefresh, SOURCE_REFRESH_MS);

    return {
      setCallbacks(nextCallbacks) {
        if (typeof nextCallbacks?.onAssist !== 'function') throw new TypeError('onAssist callback is required');
        currentCallbacks = nextCallbacks;
        if (nextCallbacks.settings) { settings = normalizedSettings(nextCallbacks.settings); applySettingsToUi(); renderOverlay(); if (settings.bilingual) scheduleTranslation(); }
      },
      unmount() {
        destroyed = true; sessionGeneration += 1; clearInterval(refreshTimer);
        if (frameId !== null) cancelAnimationFrame(frameId);
        observer.disconnect(); bridgeCleanup?.(); captionAbort?.abort(); closeActiveAssist(); restoreNativeState(); detachVideo();
        document.removeEventListener('fullscreenchange', onFullscreenChange);
        removeEventListener('scroll', onLayoutChange, true);
        removeEventListener('resize', onLayoutChange);
        setNativeCaptionHidden(false);
        controlHost.parentElement?.matches?.(`[${HOST_ATTRIBUTE}="video-subtitles-row"]`) ? controlHost.parentElement.remove() : controlHost.remove();
        transcriptHost.remove();
        overlayHost.remove();
      },
    };
  }

  globalThis[GLOBAL_NAME] = Object.freeze({
    mount(callbacks) { if (instance) instance.setCallbacks(callbacks); else instance = createInstance(callbacks); },
    unmount() { instance?.unmount(); instance = null; },
  });
})();
