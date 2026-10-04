import { test, expect } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, stat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrokClient } from '../connector/grok.mjs';
import { DiagnosticStore } from '../connector/diagnostics.mjs';

const CLIENT = 'b1a00492-073a-47ea-816f-4c329264a828';
const SCOPE = 'openid profile email offline_access grok-cli:access api:access';
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const complete = text => ({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] });
const event = value => `data: ${JSON.stringify(value)}\r\n\r\n`;
async function fixture({ override, claims = {}, device = {}, reply = { domain: 'tech' }, tokenChanges = {}, wait, diagnostic } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'relyless-grok-')); let now = Date.now(), tokenCount = 0;
  const requests = [], waits = [];
  const state = { get now() { return now; }, get tokenCount() { return tokenCount; }, advance(ms) { now += ms; } };
  function idToken() { const head = encode({ alg: 'ES256', kid: 'fixture' }), payload = encode({ iss: 'https://auth.x.ai', aud: CLIENT, sub: 'user-1', exp: Math.floor(now / 1000) + 3600, iat: Math.floor(now / 1000), ...claims }); return `${head}.${payload}.${sign('sha256', Buffer.from(`${head}.${payload}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`; }
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init });
    const custom = await override?.(url, init, state); if (custom !== undefined) return custom;
    const path = new URL(url).pathname;
    if (path === '/oauth2/device/code') return json({ device_code: 'private-device', user_code: 'ABCD-EFGH', verification_uri: 'https://auth.x.ai/device', expires_in: 900, interval: 1, ...device });
    if (path === '/oauth2/token') { tokenCount++; return json({ access_token: `access-${tokenCount}`, refresh_token: `refresh-${tokenCount}`, expires_in: 3600, token_type: 'Bearer', scope: SCOPE, id_token: idToken(), ...tokenChanges }); }
    if (path === '/.well-known/jwks.json') return json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'fixture', use: 'sig', alg: 'ES256' }] });
    if (path === '/oauth2/userinfo') return json({ sub: 'user-1', email: 'user@example.test', name: 'Reader' });
    if (path === '/oauth2/revoke') return new Response(null, { status: 200 });
    if (path === '/v1/models-v2') return json({ data: [{ model: 'fixture-model', name: 'Fixture', apiBackend: 'responses' }, { model: 'hidden', apiBackend: 'responses', hidden: true }, { model: 'paid-api', apiBackend: 'responses', apiKeyOnly: true }, { model: 'image', apiBackend: 'images' }] });
    if (path === '/v1/responses') return new Response(event({ type: 'response.output_text.delta', delta: JSON.stringify(reply) }) + event({ type: 'response.completed', response: complete(JSON.stringify(reply)) }), { headers: { 'Content-Type': 'text/event-stream' } });
    throw new Error('unexpected fixture route');
  };
  const client = new GrokClient({ dataDir: dir, fetchImpl, now: () => now, wait: wait ?? (async ms => { waits.push(ms); now += ms; await new Promise(resolve => setTimeout(resolve, 0)); }), requestTimeoutMs: 30, diagnostic });
  await client.start();
  return { client, dir, requests, waits, state, authorize: async () => { const login = await client.login(); const promise = client.loginTask?.promise; if (promise) await promise; return login; }, close: async () => { await client.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('Grok device authorization stores verified identity privately and uses subscription-only models', async () => {
  const f = await fixture(); try {
    const login = await f.authorize(); expect(login).toEqual({ authUrl: 'https://auth.x.ai/device', userCode: 'ABCD-EFGH' });
    expect(f.client.status()).toMatchObject({ authenticated: true, email: 'user@example.test', loginPending: false, error: null });
    expect(JSON.stringify(f.client.status())).not.toContain('access-'); expect(JSON.stringify(login)).not.toContain('private-device');
    expect((await stat(join(f.dir, 'grok-oauth.json'))).mode & 0o777).toBe(0o600);
    expect(await f.client.listModels()).toEqual([{ id: 'fixture-model', name: 'Fixture', isDefault: false }]);
    expect(await f.client.classify({ text: 'A data pipeline.' })).toEqual({ domain: 'tech', source: 'grok' });
    const request = f.requests.find(v => v.url.endsWith('/responses')); expect(JSON.parse(request.init.body)).toMatchObject({ store: false, model: 'fixture-model' });
    expect(request.init.headers.Authorization).toBe('Bearer access-1'); expect(request.init.headers['x-grok-client-identifier']).toBe('relyless'); expect(request.init.redirect).toBe('error');
    await f.client.logout(); expect(f.client.status().authenticated).toBe(false); expect(await readFile(join(f.dir, 'grok-oauth.json')).catch(e => e.code)).toBe('ENOENT');
    expect(new URLSearchParams(f.requests.find(v => v.url.endsWith('/revoke')).init.body).get('token')).toBe('refresh-1');
  } finally { await f.close(); }
});

for (const [name, changes] of [ ['foreign audience', { claims: { aud: 'other-client' } }], ['foreign issuer', { claims: { iss: 'https://attacker.example' } }], ['expired identity', { claims: { exp: 1 } }], ['wrong identity', { claims: { sub: 'other-user' } }], ['missing inference grant', { tokenChanges: { scope: 'openid profile' } }], ['foreign login URL', { device: { verification_uri: 'https://attacker.example/device' } }] ]) {
  test(`Grok rejects ${name} without saving credentials`, async () => { const f = await fixture(changes); try { try { await f.authorize(); } catch {} expect(f.client.status().authenticated).toBe(false); expect(f.client.status().error).not.toBeNull(); expect(await readFile(join(f.dir, 'grok-oauth.json')).catch(e => e.code)).toBe('ENOENT'); } finally { await f.close(); } });
}

test('Grok device polling respects authorization_pending and slow_down without returning false success', async () => {
  let poll = 0; const f = await fixture({ override: (url, init) => { if (url.endsWith('/token') && new URLSearchParams(init.body).get('grant_type') !== 'refresh_token') { poll++; if (poll <= 2) return json({ error: poll === 1 ? 'authorization_pending' : 'slow_down' }, 400); } } });
  try { await f.authorize(); expect(f.waits).toEqual([1000,1000,6000]); expect(f.client.status().authenticated).toBe(true); } finally { await f.close(); }
});

test('Grok cancellation while device request is in flight never restores a pending login', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }); const f = await fixture({ override: async url => { if (url.endsWith('/device/code')) { await gate; return json({ device_code: 'device', user_code: 'ABCD', verification_uri: 'https://auth.x.ai/device', interval: 1, expires_in: 900 }); } } });
  try { const login = f.client.login(); await f.client.cancelLogin(); release(); await expect(login).rejects.toMatchObject({ code: 'CANCELLED' }); expect(f.client.status()).toMatchObject({ authenticated: false, loginPending: false, userCode: null }); expect(await readFile(join(f.dir, 'grok-oauth.json')).catch(e => e.code)).toBe('ENOENT'); } finally { await f.close(); }
});

test('Grok rotating refresh serializes concurrent consumers and preserves refreshed credentials', async () => {
  const f = await fixture(); try {
    await f.authorize(); f.state.advance(3500000); await Promise.all([f.client.listModels(), f.client.classify({ text: 'A pipeline.' })]);
    const refreshes = f.requests.filter(v => v.url.endsWith('/token') && new URLSearchParams(v.init.body).get('grant_type') === 'refresh_token');
    expect(refreshes).toHaveLength(1); expect(new URLSearchParams(refreshes[0].init.body).get('refresh_token')).toBe('refresh-1');
    const stored = JSON.parse(await readFile(join(f.dir, 'grok-oauth.json'), 'utf8')); expect(stored.refreshToken).toBe('refresh-2'); expect(stored.account.subject).toBe('user-1');
    const restored = new GrokClient({ dataDir: f.dir, fetchImpl: async () => { throw new Error('must not fetch during startup'); } }); await restored.start(); expect(restored.status().email).toBe('user@example.test'); await restored.close();
  } finally { await f.close(); }
});

for (const [status, code] of [[401,'AUTH'],[403,'AUTH'],[429,'RATE_LIMIT']]) test(`Grok HTTP ${status} is an error, not an answer or API-key fallback`, async () => {
  const f = await fixture({ override: url => url.endsWith('/responses') ? json({ error: { message: 'private remote detail' } }, status) : undefined }); try { await f.authorize(); await expect(f.client.classify({ text: 'Pipeline.' })).rejects.toMatchObject({ code }); expect(f.requests.filter(v => v.url.endsWith('/responses'))).toHaveLength(1); expect(f.requests.some(v => new URL(v.url).hostname === 'api.x.ai')).toBe(false); } finally { await f.close(); }
});

test('Grok refuses a truncated stream even if its partial JSON is a valid answer', async () => {
  const f = await fixture({ override: url => url.endsWith('/responses') ? new Response(event({ type: 'response.output_text.delta', delta: '{"domain":"tech"}' }), { headers: { 'Content-Type': 'text/event-stream' } }) : undefined });
  try { await f.authorize(); await expect(f.client.classify({ text: 'Pipeline.' })).rejects.toMatchObject({ code: 'OUTPUT_INVALID' }); } finally { await f.close(); }
});

test('Grok emits validated help progress before the terminal event arrives', async () => {
  const sentence = 'The request is retried unless the token has expired.', result = { level: 'hint', hint: 'except if', sense: 'exception', details: { meaning: { en: 'Introduces an exception.', zh: '引出一个例外。' }, sentenceTranslation: '除非过期，否则重试。' } }, text = JSON.stringify({ result });
  let release, progressResolve; const gate = new Promise(resolve => { release = resolve; }), progressed = new Promise(resolve => { progressResolve = resolve; });
  const f = await fixture({ override: url => { if (url.endsWith('/responses')) return new Response(new ReadableStream({ async start(controller) { const bytes = new TextEncoder(); controller.enqueue(bytes.encode(event({ type: 'response.output_text.delta', delta: text }))); await gate; controller.enqueue(bytes.encode(event({ type: 'response.completed', response: complete(text) }))); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } }); } });
  try { await f.authorize(); const answer = f.client.assist({ text: 'unless', context: sentence, domain: 'tech', kind: 'word', level: 'hint', detail: 'full' }, { onProgress: value => progressResolve(value) }); const progress = await progressed; expect(progress.definition).toBe('except if'); release(); expect(await answer).toEqual(result); } finally { release(); await f.close(); }
});

test('Grok timeout aborts direct inference rather than yielding a partial answer', async () => {
  const f = await fixture({ override: (url, init) => url.endsWith('/responses') ? new Promise((resolve, reject) => { init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }) : undefined });
  try { await f.authorize(); f.client.inferenceTimeoutMs = 20; await expect(f.client.classify({ text: 'Pipeline.' })).rejects.toMatchObject({ code: 'TIMEOUT' }); } finally { await f.close(); }
});

test('Grok logout during refresh removes credentials without late resurrection', async () => {
  let release, started; const gate = new Promise(resolve => { release = resolve; }), refreshing = new Promise(resolve => { started = resolve; });
  const f = await fixture({ override: async (url, init) => { if (url.endsWith('/token') && new URLSearchParams(init.body).get('grant_type') === 'refresh_token') { started(); await gate; return json({ access_token: 'late-access', refresh_token: 'late-refresh', expires_in: 3600, scope: SCOPE }); } } });
  try { await f.authorize(); f.state.advance(3500000); const refresh = f.client.listModels(); await refreshing; const logout = f.client.logout(); release(); await expect(refresh).rejects.toMatchObject({ code: 'CANCELLED' }); await logout; expect(f.client.status().authenticated).toBe(false); expect(await readFile(join(f.dir, 'grok-oauth.json')).catch(e => e.code)).toBe('ENOENT'); } finally { release(); await f.close(); }
});

test('Grok does not import legacy CLI state or overwrite an unsupported future credential schema', async () => {
  const f = await fixture(); try { await writeFile(join(f.dir, 'grok-oauth.json'), JSON.stringify({ version: 99, refreshToken: 'future' })); await expect(f.client.refreshStatus()).rejects.toMatchObject({ code: 'AUTH' }); expect(JSON.parse(await readFile(join(f.dir, 'grok-oauth.json'), 'utf8')).version).toBe(99); } finally { await f.close(); }
});

for (const failure of ['access_denied','expired_token']) test(`Grok ${failure} terminates device authorization without a saved login`, async () => {
  const f = await fixture({ override: url => url.endsWith('/token') ? json({ error: failure }, 400) : undefined });
  try { await f.authorize(); expect(f.client.status()).toMatchObject({ authenticated: false, loginPending: false }); expect(f.client.status().error).not.toBeNull(); expect(await readFile(join(f.dir, 'grok-oauth.json')).catch(e => e.code)).toBe('ENOENT'); } finally { await f.close(); }
});

test('Grok forged identity signature cannot establish an account', async () => {
  const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const f = await fixture({ override: url => url.endsWith('/jwks.json') ? json({ keys: [{ ...other.publicKey.export({ format: 'jwk' }), kid: 'fixture', use: 'sig', alg: 'ES256' }] }) : undefined });
  try { await f.authorize(); expect(f.client.status().authenticated).toBe(false); expect(await readFile(join(f.dir, 'grok-oauth.json')).catch(e => e.code)).toBe('ENOENT'); } finally { await f.close(); }
});

for (const type of ['response.failed','response.incomplete']) test(`Grok ${type} never commits partial text`, async () => {
  const f = await fixture({ override: url => url.endsWith('/responses') ? new Response(event({ type: 'response.output_text.delta', delta: '{"domain":"tech"}' }) + event({ type, response: { status: 'incomplete' } }), { headers: { 'Content-Type': 'text/event-stream' } }) : undefined });
  try { await f.authorize(); await expect(f.client.classify({ text: 'Pipeline.' })).rejects.toMatchObject({ code: 'OUTPUT_INVALID' }); } finally { await f.close(); }
});

test('Grok malformed inference is rejected and remote revoke failure does not undo local logout', async () => {
  const f = await fixture({ reply: { domain: 'unrecognized' }, override: url => url.endsWith('/revoke') ? json({ error: 'upstream_unavailable' }, 503) : undefined });
  try { await f.authorize(); await expect(f.client.classify({ text: 'Pipeline.' })).rejects.toMatchObject({ code: 'OUTPUT_INVALID' }); const status = await f.client.logout(); expect(status.authenticated).toBe(false); expect(status.error).not.toBeNull(); expect(await readFile(join(f.dir, 'grok-oauth.json')).catch(e => e.code)).toBe('ENOENT'); } finally { await f.close(); }
});

test('Grok late completed response after logout is cancelled, not delivered as an answer', async () => {
  let release, started; const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { started = resolve; });
  const f = await fixture({ override: async url => { if (url.endsWith('/responses')) { started(); await gate; return json(complete('{"domain":"tech"}')); } } });
  try { await f.authorize(); const answer = f.client.classify({ text: 'Pipeline.' }); await entered; await f.client.logout(); release(); await expect(answer).rejects.toMatchObject({ code: 'CANCELLED' }); expect(f.client.status().authenticated).toBe(false); } finally { release(); await f.close(); }
});

test('Grok native provider diagnostics keep trace, status and safe failure metadata without content',async()=>{
  let store,failed=false;const traceId='12345678-1234-1234-1234-123456789abc';const f=await fixture({diagnostic:record=>store.append(record),override:url=>failed&&url.endsWith('/responses')?new Response('private body',{status:429}):undefined});
  try{store=await DiagnosticStore.create(f.dir);await f.authorize();await f.client.classify({text:'private reading excerpt'},{traceId});failed=true;await expect(f.client.classify({text:'private reading excerpt'},{traceId})).rejects.toMatchObject({code:'RATE_LIMIT'});await store.idle();const text=await readFile(join(f.dir,'diagnostics.jsonl'),'utf8');const rows=text.trim().split('\n').map(JSON.parse);expect(rows.map(row=>[row.operation,row.stage,row.status,row.code,row.traceId])).toEqual([['RESOLVE_DOMAIN','provider','start','NATIVE_START',traceId],['RESOLVE_DOMAIN','provider','ok','OK',traceId],['RESOLVE_DOMAIN','provider','start','NATIVE_START',traceId],['RESOLVE_DOMAIN','provider','error','RATE_LIMIT',traceId]]);expect(rows[1].durationMs).toBeGreaterThanOrEqual(0);expect(rows[3].httpStatus).toBe(429);expect(text).not.toMatch(/private|access-1|refresh-1|user@example|fixture-model/);}
  finally{await store?.idle();await f.close();}
});
