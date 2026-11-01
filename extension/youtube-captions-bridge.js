/*
 * Native timedtext Resource Timing capture adapted from yt-dual-subs:
 * https://github.com/Gythiro/yt-dual-subs/blob/5657c8a18ca30c84b5d4662bca58e3e9214ffdff/inject.js
 * Copyright (c) 2026 Gythiro. MIT License; see vendor/LICENSE.yt-dual-subs.txt.
 */
(function startShadowBridgeApp() {
  'use strict';

  // 纯函数集合：URL 与轨道判断不依赖页面，单独暴露以便在测试里直接校验。
  function youtubeVideoId(pathname, search) {
    const pathMatch = pathname.match(/^\/(?:shorts|embed|live)\/(?!videoseries\b|live_stream\b)([A-Za-z0-9_-]{6,})/);
    return pathMatch?.[1] || new URLSearchParams(search || '').get('v') || '';
  }
  function timedtextUrl(rawUrl, base) {
    try {
      const url = new URL(rawUrl, base || 'https://www.youtube.com/');
      return url.protocol === 'https:' && url.hostname === 'www.youtube.com' && url.pathname === '/api/timedtext' ? url.href : '';
    } catch { return ''; }
  }
  function isEnglishLanguageCode(value) { return /^en(?:-|$)/i.test(typeof value === 'string' ? value : ''); }
  function chooseEnglishTrack(tracks, selected) {
    if (selected && isEnglishLanguageCode(selected.languageCode)) return selected;
    return tracks.find(track => isEnglishLanguageCode(track?.languageCode) && track.kind !== 'asr')
      || tracks.find(track => isEnglishLanguageCode(track?.languageCode) && track.kind === 'asr')
      || null;
  }
  const trackUtils = Object.freeze({youtubeVideoId, timedtextUrl, isEnglishLanguageCode, chooseEnglishTrack});
  if (typeof globalThis !== 'undefined') globalThis.ShisuiYoutubeTrackUtils = trackUtils;
  const {youtubeVideoId: videoIdOf, timedtextUrl: captionUrl, chooseEnglishTrack: pickEnglishTrack} = trackUtils;
  const hasPage = typeof location !== 'undefined' && typeof document !== 'undefined';

  const GLOBAL_NAME = 'ShisuiYoutubeCaptionsBridge';
  const REQUEST_EVENT = 'shisui:youtube-captions-request';
  const RESPONSE_EVENT = 'shisui:youtube-captions-response';
  const DISPOSE_EVENT = 'shisui:youtube-captions-dispose';
  if (typeof globalThis === 'undefined' || globalThis[GLOBAL_NAME]) return;
  // 没有页面环境时只暴露上面的纯函数，供测试使用。
  if (!hasPage || location.protocol !== 'https:' || !['www.youtube.com', 'm.youtube.com'].includes(location.hostname)) return;

  let disposed = false;
  let performanceObserver = null;
  let capturedTrack = null;
  let cachedCaption = null;
  let originalFetch = null;
  let wrappedFetch = null;
  let originalXhrOpen = null;
  let wrappedXhrOpen = null;
  let originalXhrSend = null;
  let wrappedXhrSend = null;
  let preparedState = null;
  const xhrUrls = new WeakMap();

  function stringValue(value, maxLength = 256) { return typeof value === 'string' ? value.slice(0, maxLength) : ''; }
  function displayText(value) {
    if (typeof value === 'string') return value;
    if (typeof value?.simpleText === 'string') return value.simpleText;
    if (Array.isArray(value?.runs)) return value.runs.map(run => stringValue(run?.text)).join('');
    return '';
  }
  function videoIdFromLocation() { return videoIdOf(location.pathname, location.search); }
  function safeCaptionUrl(rawUrl) { return captionUrl(rawUrl, location.href); }
  function noteTimedtext(rawUrl) {
    if (disposed) return;
    const safeUrl = safeCaptionUrl(rawUrl);
    if (!safeUrl) return;
    const url = new URL(safeUrl);
    const currentVideoId = videoIdFromLocation();
    const capturedVideoId = url.searchParams.get('v') || currentVideoId;
    if (!currentVideoId || capturedVideoId !== currentVideoId) return;
    capturedTrack = {videoId: currentVideoId, url: url.href, languageCode: url.searchParams.get('lang') || '', kind: url.searchParams.get('kind') || '', targetLanguage: url.searchParams.get('tlang') || ''};
  }
  function rememberCaption(rawUrl, text) {
    const raw = typeof rawUrl === 'string' ? rawUrl : rawUrl?.url || '';
    if (!raw.includes('timedtext')) return;
    noteTimedtext(raw);
    const safeUrl = safeCaptionUrl(raw);
    if (!safeUrl || !capturedTrack || typeof text !== 'string') return;
    if (capturedTrack.url !== new URL(safeUrl).href || capturedTrack.targetLanguage) return;
    const body = text.length > 1500000 ? '' : text;
    if (!body || body.trimStart().startsWith('<') || !/"events"|wireMagic/.test(body)) return;
    cachedCaption = {videoId: capturedTrack.videoId, languageCode: capturedTrack.languageCode, kind: capturedTrack.kind, text: body};
  }
  function captionFor(track) {
    if (!cachedCaption || cachedCaption.videoId !== videoIdFromLocation() || !cachedCaption.text) return '';
    const wanted = stringValue(track?.languageCode, 32).toLowerCase();
    const got = stringValue(cachedCaption.languageCode, 32).toLowerCase();
    if (wanted && got !== wanted) return '';
    if (stringValue(track?.kind) !== (cachedCaption.kind || '')) return '';
    return cachedCaption.text;
  }
  function bodyFromXhr(xhr) {
    try { if (typeof xhr.responseText === 'string' && xhr.responseText) return xhr.responseText; } catch { /* 非文本 responseType 没有 responseText。 */ }
    if (typeof xhr.response === 'string') return xhr.response;
    if (xhr.response && typeof xhr.response === 'object') { try { return JSON.stringify(xhr.response); } catch { return ''; } }
    return '';
  }
  function scanResources(entries) {
    for (const entry of entries) if (typeof entry?.name === 'string' && entry.name.includes('/api/timedtext')) noteTimedtext(entry.name);
  }
  function currentPlayer() {
    const playerId = location.pathname.startsWith('/shorts/') ? 'shorts-player' : 'movie_player';
    const player = document.getElementById(playerId);
    return player && typeof player.getPlayerResponse === 'function' ? player : null;
  }
  function responseTracks(player) {
    let response = null;
    try { response = player?.getPlayerResponse?.(); } catch { response = null; }
    const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    return Array.isArray(tracks) ? tracks : [];
  }
  function trackIdentity(track) {
    return `${stringValue(track?.vssId || track?.vss_id)}\u0000${stringValue(track?.languageCode || track?.language_code)}\u0000${stringValue(track?.kind)}`;
  }
  function readSelectedTrack(player, tracks) {
    let selected = null;
    try { selected = player.getOption?.('captions', 'track') || null; } catch { selected = null; }
    const identity = trackIdentity(selected);
    return tracks.find(track => trackIdentity(track) === identity)
      || tracks.find(track => stringValue(selected?.vss_id || selected?.vssId) && stringValue(track?.vssId) === stringValue(selected?.vss_id || selected?.vssId))
      || tracks.find(track => stringValue(selected?.languageCode || selected?.language_code) && stringValue(track?.languageCode) === stringValue(selected?.languageCode || selected?.language_code))
      || null;
  }
  function captionsVisible(player, selectedTrack) {
    try { if (typeof player?.isSubtitlesOn === 'function') return player.isSubtitlesOn() === true; } catch { /* Fall through to control state. */ }
    const button = player?.querySelector?.('.ytp-subtitles-button') || document.querySelector('.ytp-subtitles-button');
    if (button) return button.getAttribute('aria-pressed') === 'true';
    return Boolean(selectedTrack);
  }
  function playerTrackValue(track) {
    return {languageCode: stringValue(track?.languageCode, 32), kind: stringValue(track?.kind, 32), vss_id: stringValue(track?.vssId || track?.vss_id, 128)};
  }
  function capturedUrlFor(videoId, track) {
    if (!capturedTrack || capturedTrack.videoId !== videoId || capturedTrack.targetLanguage) return '';
    if (track?.languageCode && capturedTrack.languageCode && track.languageCode !== capturedTrack.languageCode) return '';
    const expectedKind = track?.kind === 'asr' ? 'asr' : '';
    return capturedTrack.kind === expectedKind ? capturedTrack.url : '';
  }
  function snapshot() {
    const player = currentPlayer();
    if (!player) return {videoId: '', captionVisible: false, track: null};
    let videoData = null;
    let response = null;
    try { videoData = player.getVideoData?.(); } catch { videoData = null; }
    try { response = player.getPlayerResponse?.(); } catch { response = null; }
    const videoId = stringValue(videoData?.video_id || response?.videoDetails?.videoId, 32);
    const tracks = responseTracks(player);
    const selected = readSelectedTrack(player, tracks);
    const chosen = pickEnglishTrack(tracks, selected);
    const baseUrl = safeCaptionUrl(capturedUrlFor(videoId, chosen) || chosen?.baseUrl);
    return {
      videoId,
      captionVisible: captionsVisible(player, selected),
      track: chosen && baseUrl ? {
        key: stringValue(chosen.vssId || chosen.languageCode || chosen.kind, 128),
        languageCode: stringValue(chosen.languageCode, 32),
        label: stringValue(displayText(chosen.name), 128),
        baseUrl,
      } : null,
    };
  }
  function clickCaptionButton(player) {
    const button = player?.querySelector?.('.ytp-subtitles-button') || document.querySelector('.ytp-subtitles-button');
    if (!(button instanceof HTMLElement)) return false;
    try { button.click(); return true; } catch { return false; }
  }
  function setTrack(player, track) {
    if (typeof player?.setOption !== 'function') return false;
    try { player.setOption('captions', 'track', playerTrackValue(track)); return true; } catch { return false; }
  }
  function sameSelectedTrack(player, expected) {
    const selected = readSelectedTrack(player, responseTracks(player));
    return Boolean(selected && trackIdentity(selected) === trackIdentity(expected));
  }
  function sleep(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }

  function restoreCaptions() {
    const state = preparedState;
    preparedState = null;
    if (!state?.player?.isConnected || videoIdFromLocation() !== state.videoId) return;
    if (state.switchedTrack && sameSelectedTrack(state.player, state.englishTrack) && state.previousTrack) setTrack(state.player, state.previousTrack);
    if (state.toggledVisibility && captionsVisible(state.player, readSelectedTrack(state.player, responseTracks(state.player)))) clickCaptionButton(state.player);
  }
  async function prepareCaptions(language) {
    if (typeof language !== 'string' || (!/^en(?:-|$)/i.test(language) && language !== '*')) return false;
    const player = currentPlayer();
    const videoId = videoIdFromLocation();
    if (!player || !videoId) return false;
    if (preparedState?.player === player && preparedState.videoId === videoId && sameSelectedTrack(player, preparedState.englishTrack)) return true;
    restoreCaptions();
    const tracks = responseTracks(player);
    const previousTrack = readSelectedTrack(player, tracks);
    const englishTrack = pickEnglishTrack(tracks, previousTrack);
    if (!englishTrack) return false;
    const wasVisible = captionsVisible(player, previousTrack);
    const switchedTrack = !previousTrack || trackIdentity(previousTrack) !== trackIdentity(englishTrack);
    if (switchedTrack && !setTrack(player, englishTrack)) return false;
    let selected = !switchedTrack || sameSelectedTrack(player, englishTrack);
    for (let elapsed = 0; !selected && elapsed < 1500; elapsed += 150) {
      await sleep(150);
      if (disposed || player !== currentPlayer() || videoId !== videoIdFromLocation()) return false;
      selected = sameSelectedTrack(player, englishTrack);
    }
    if (!selected) {
      if (previousTrack && sameSelectedTrack(player, englishTrack)) setTrack(player, previousTrack);
      return false;
    }
    let toggledVisibility = false;
    if (!wasVisible) toggledVisibility = clickCaptionButton(player);
    preparedState = {player, videoId, previousTrack, englishTrack, switchedTrack, toggledVisibility};
    return true;
  }
  async function readCaption() {
    let shot = snapshot();
    let text = captionFor(shot.track);
    if (text) return {...shot, text};
    const prepared = await prepareCaptions(shot.track?.languageCode || '*');
    const waitForBody = async milliseconds => {
      const started = Date.now();
      while (Date.now() - started < milliseconds) {
        shot = snapshot();
        text = captionFor(shot.track);
        if (text || disposed) return text;
        await sleep(150);
      }
      return '';
    };
    text = await waitForBody(2000);
    if (!text) {
      const player = currentPlayer();
      const visible = player && captionsVisible(player, readSelectedTrack(player, responseTracks(player)));
      if (player && visible) {
        clickCaptionButton(player);
        await sleep(200);
        clickCaptionButton(player);
        text = await waitForBody(2500);
      } else if (player && clickCaptionButton(player)) {
        text = await waitForBody(2500);
        if (captionsVisible(player, readSelectedTrack(player, responseTracks(player)))) clickCaptionButton(player);
      }
    }
    if (prepared) restoreCaptions();
    shot = snapshot();
    return {...shot, prepared, text: text || captionFor(shot.track) || ''};
  }
  function innertubeConfig() {
    const cfg = globalThis.ytcfg;
    const read = key => {
      try { if (typeof cfg?.get === 'function') return cfg.get(key); } catch { /* 页面配置读不到时改走播放器响应。 */ }
      return cfg?.data_?.[key];
    };
    return {key: read('INNERTUBE_API_KEY'), context: read('INNERTUBE_CONTEXT')};
  }
  async function discoverTracks() {
    if (disposed) return null;
    const videoId = videoIdFromLocation();
    const {key, context} = innertubeConfig();
    if (typeof key !== 'string' || !key || !context || !videoId) return null;
    let response;
    try {
      response = await fetch(`https://www.youtube.com/youtubei/v1/player?prettyPrint=false&key=${encodeURIComponent(key)}`, {
        method: 'POST', credentials: 'include', headers: {'content-type': 'application/json'},
        body: JSON.stringify({context, videoId, contentCheckOk: true, racyCheckOk: true}),
      });
    } catch { return null; }
    if (!response?.ok) return null;
    let data = null;
    try { data = await response.json(); } catch { return null; }
    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!Array.isArray(tracks) || !tracks.length || videoId !== videoIdFromLocation()) return null;
    const chosen = pickEnglishTrack(tracks, null);
    const baseUrl = safeCaptionUrl(chosen?.baseUrl);
    if (!chosen || !baseUrl) return null;
    return {
      videoId,
      captionVisible: false,
      track: {
        key: stringValue(chosen.vssId || chosen.languageCode || chosen.kind, 128),
        languageCode: stringValue(chosen.languageCode, 32),
        kind: stringValue(chosen.kind, 32),
        label: stringValue(displayText(chosen.name), 128),
        baseUrl,
      },
    };
  }
  async function onRequest(event) {
    const requestId = event.detail?.requestId;
    if (typeof requestId !== 'string' || requestId.length > 96 || !/^shisui-[a-z0-9-]+$/.test(requestId)) return;
    const command = event.detail?.command || 'snapshot';
    if (!['snapshot', 'prepare', 'restore', 'discover', 'caption'].includes(command)) return;
    if (command === 'caption') {
      const result = await readCaption();
      dispatchEvent(new CustomEvent(RESPONSE_EVENT, {detail: {requestId, ...result}}));
      return;
    }
    let prepared = false;
    if (command === 'prepare') prepared = await prepareCaptions(event.detail?.language);
    else if (command === 'restore') restoreCaptions();
    const shot = snapshot();
    const found = command === 'discover' && !shot.track ? await discoverTracks() : null;
    dispatchEvent(new CustomEvent(RESPONSE_EVENT, {detail: {requestId, prepared, ...shot, ...(found || {})}}));
  }

  function installNetworkObservers() {
    try {
      originalFetch = globalThis.fetch;
      if (typeof originalFetch === 'function') {
        wrappedFetch = function (input) {
          const pending = originalFetch.apply(this, arguments);
          try {
            const rawUrl = typeof input === 'string' ? input : input?.url;
            if (safeCaptionUrl(rawUrl)) Promise.resolve(pending).then(response => { response.clone().text().then(text => rememberCaption(rawUrl, text)).catch(() => {}); }).catch(() => {});
          } catch { /* Preserve page fetch behavior. */ }
          return pending;
        };
        globalThis.fetch = wrappedFetch;
      }
    } catch { originalFetch = null; wrappedFetch = null; }
    try {
      const prototype = XMLHttpRequest.prototype;
      originalXhrOpen = prototype.open;
      originalXhrSend = prototype.send;
      wrappedXhrOpen = function (_method, url) {
        try { xhrUrls.set(this, url); } catch { /* Preserve page XHR behavior. */ }
        return originalXhrOpen.apply(this, arguments);
      };
      wrappedXhrSend = function () {
        try {
          const rawUrl = xhrUrls.get(this);
          this.addEventListener('load', () => { try { rememberCaption(rawUrl, bodyFromXhr(this)); } catch { /* Preserve page XHR behavior. */ } });
        } catch { /* Preserve page XHR behavior. */ }
        return originalXhrSend.apply(this, arguments);
      };
      prototype.open = wrappedXhrOpen;
      prototype.send = wrappedXhrSend;
    } catch { /* Partial installation is safely restored below. */ }
  }
  function dispose() {
    disposed = true;
    restoreCaptions();
    removeEventListener(REQUEST_EVENT, onRequest);
    removeEventListener(DISPOSE_EVENT, dispose);
    performanceObserver?.disconnect(); performanceObserver = null;
    if (wrappedFetch && globalThis.fetch === wrappedFetch) globalThis.fetch = originalFetch;
    const xhrPrototype = globalThis.XMLHttpRequest?.prototype;
    if (xhrPrototype && wrappedXhrOpen && xhrPrototype.open === wrappedXhrOpen) xhrPrototype.open = originalXhrOpen;
    if (xhrPrototype && wrappedXhrSend && xhrPrototype.send === wrappedXhrSend) xhrPrototype.send = originalXhrSend;
    capturedTrack = null;
    cachedCaption = null;
    delete globalThis[GLOBAL_NAME];
  }

  try {
    scanResources(performance.getEntriesByType('resource'));
    if (typeof PerformanceObserver === 'function') {
      performanceObserver = new PerformanceObserver(list => scanResources(list.getEntries()));
      performanceObserver.observe({type: 'resource', buffered: true});
    }
  } catch { performanceObserver = null; }
  installNetworkObservers();
  addEventListener(REQUEST_EVENT, onRequest);
  addEventListener(DISPOSE_EVENT, dispose);
  globalThis[GLOBAL_NAME] = Object.freeze({dispose});
})();
