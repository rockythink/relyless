// Session-only by default; optional local persistence holds bounded, expiring model outputs.
// Keys are hashes of task, model and content/context, never page URLs or plaintext inputs.

export const GLOSS_CACHE_LIMIT = 500;
export const PAGE_TRANSLATION_CACHE_LIMIT = 1500;
export const GLOSS_CACHE_VERSION = 2;
export const TRANSLATION_CACHE_VERSION = 2;
export const PERSISTENT_CACHE_TTL = 30 * 86400000;

const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
const stamp = value => Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/** 词条缓存值：{hint, translation, sense, at, hits} */
export function normalizeGlossEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const hint = text(value.hint, 500), translation = text(value.translation, 500), sense = text(value.sense, 200);
  if (!hint && !translation) return null;
  return {hint, translation, sense, at: stamp(value.at), hits: Math.min(9999, stamp(value.hits))};
}

/** 译文缓存值：{zh, at} */
export function normalizeTranslationEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const zh = text(value.zh, 8000);
  if (!zh) return null;
  return {zh, at: stamp(value.at)};
}

export function normalizeGlossCache(raw, now = Date.now()) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    const entry = normalizeGlossEntry(value);
    if (/^[a-f0-9]{64}$/.test(key) && entry && entry.at <= now && now - entry.at < PERSISTENT_CACHE_TTL) out[key] = entry;
  }
  return trimCache(out, GLOSS_CACHE_LIMIT);
}

export function normalizeTranslationCache(raw, now = Date.now()) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    const entry = normalizeTranslationEntry(value);
    if (/^[a-f0-9]{64}$/.test(key) && entry && entry.at <= now && now - entry.at < PERSISTENT_CACHE_TTL) out[key] = entry;
  }
  return trimCache(out, PAGE_TRANSLATION_CACHE_LIMIT);
}

/** 命中读取：LRU 移到末尾并计次；返回新对象（未命中返回 null）。 */
export function readCache(cache, key, {counter = 'hits', ttl = Infinity, now = Date.now()} = {}) {
  const entry = cache?.[key];
  if (!entry || now - entry.at >= ttl || entry.at > now) return null;
  const next = {...cache};
  delete next[key];
  next[key] = counter === 'hits' ? {...entry, hits: stamp(entry.hits) + 1} : {...entry};
  return {cache: next, entry: next[key]};
}

/** 写入：覆盖同键并 LRU 裁剪到上限；返回新对象。 */
export function writeCache(cache, key, entry, {limit = GLOSS_CACHE_LIMIT} = {}) {
  const next = {...cache};
  delete next[key];
  next[key] = entry;
  return trimCache(next, limit);
}

function trimCache(cache, limit) {
  const keys = Object.keys(cache);
  if (keys.length <= limit) return cache;
  const next = {...cache};
  for (const key of keys.slice(0, keys.length - limit)) delete next[key];
  return next;
}
