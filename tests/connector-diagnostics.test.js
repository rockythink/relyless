import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { DIAGNOSTIC_MAX_BYTES, DiagnosticStore } from '../connector/diagnostics.mjs';
import { encodeNativeMessage, NativeMessageDecoder, runHost } from '../connector/host.mjs';

const event = (overrides = {}) => ({
  operation: 'CONNECTION',
  stage: 'stderr',
  status: 'error',
  code: 'STDERR_AUTH',
  stderrBytes: 17,
  ...overrides,
});

test('connector diagnostics sanitize secrets, mirror silently, and persist disable independently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shisui-diagnostics-'));
  const authPath = join(directory, 'codex-auth-fixture.json');
  await writeFile(authPath, 'login-data-must-remain', { mode: 0o600 });
  try {
    const store = await DiagnosticStore.create(directory);
    const broadcasts = [];
    store.on('diagnostic', value => broadcasts.push(value));
    await store.append(event({ traceId: '12345678-1234-1234-1234-123456789abc', message: 'secret-message', stack: 'secret-stack', stderr: 'secret-stderr', url: 'https://secret.test' }));
    await store.appendMany([event({ code: 'STDERR_TIMEOUT', stderrBytes: 3 })], { broadcast: false });
    await store.idle();

    const text = await readFile(join(directory, 'diagnostics.jsonl'), 'utf8');
    expect(text).not.toMatch(/secret-message|secret-stack|secret-stderr|secret\.test/);
    expect(text.trim().split('\n').map(JSON.parse)).toHaveLength(2);
    expect(broadcasts).toHaveLength(1);
    if (process.platform !== 'win32') {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(join(directory, 'diagnostics.jsonl'))).mode & 0o777).toBe(0o600);
    }

    await store.configure(false);
    const before = await readFile(join(directory, 'diagnostics.jsonl'), 'utf8');
    expect(await store.append(event({ stderrBytes: 99 }))).toBe(false);
    expect(await readFile(join(directory, 'diagnostics.jsonl'), 'utf8')).toBe(before);
    const restarted = await DiagnosticStore.create(directory);
    expect(restarted.enabled).toBe(false);
    await restarted.clear();
    expect(await readFile(authPath, 'utf8')).toBe('login-data-must-remain');
    if (process.platform !== 'win32') {
      expect((await stat(join(directory, 'diagnostics-config.json'))).mode & 0o777).toBe(0o600);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('connector diagnostics rotate one file only after the 256 KiB boundary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shisui-diagnostics-'));
  try {
    const store = await DiagnosticStore.create(directory);
    const path = join(directory, 'diagnostics.jsonl');
    await store.append(event());
    const line = await readFile(path);
    await writeFile(path, Buffer.alloc(DIAGNOSTIC_MAX_BYTES - line.length), { mode: 0o600 });

    await store.append(event());
    expect((await stat(path)).size).toBe(DIAGNOSTIC_MAX_BYTES);
    await store.append(event({ code: 'STDERR_UNKNOWN' }));
    expect((await stat(path)).size).toBeLessThanOrEqual(DIAGNOSTIC_MAX_BYTES);
    expect((await stat(`${path}.1`)).size).toBe(DIAGNOSTIC_MAX_BYTES);
    if (process.platform !== 'win32') {
      expect((await stat(`${path}.1`)).mode & 0o777).toBe(0o600);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('native diagnostics sync emits framed stdout only and never invokes a model operation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shisui-host-diagnostics-'));
  const configPath = join(directory, 'config.json');
  const dataDir = join(directory, 'data');
  const origin = 'chrome-extension://' + 'a'.repeat(32) + '/';
  await writeFile(configPath, JSON.stringify({ backend: 'chatgpt', dataDir, extensionOrigin: origin }));
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = [];
  const framingErrors = [];
  const decoder = new NativeMessageDecoder({ onMessage: message => messages.push(message), onError: error => framingErrors.push(error) });
  output.on('data', chunk => decoder.push(chunk));
  let nativeDiagnostic;
  let closed = false;
  let modelCalls = 0;

  class FakeClient extends EventEmitter {
    async start() {}
    async close() { closed = true; }
    async assist() { modelCalls++; }
    async emergencyTranslate(payload, context) {

      const error = new Error('用户可见错误');
      error.code = 'ITEM_ID';
      error.detail = { itemIndex: 2, secret: 'must-not-cross-native' };
      throw error;
    }
  }
  try {
    await runHost({
      argv: ['--config', configPath, origin], input, output,
      clientFactory: options => { nativeDiagnostic = options.diagnostic; return new FakeClient(); },
    });
    input.write(encodeNativeMessage({ id: 1, type: 'diagnostics', payload: { action: 'append', events: [event()] } }));
    for (let i = 0; i < 50 && !messages.some(message => message.id === 1); i++) await new Promise(resolve => setTimeout(resolve, 2));
    expect(messages.find(message => message.id === 1)).toMatchObject({id:1,ok:true});
    expect(JSON.parse((await readFile(join(dataDir,'diagnostics.jsonl'),'utf8')).trim()).code).toBe('STDERR_AUTH');
    expect(messages.some(message => message.event === 'diagnostic')).toBe(false);

    await nativeDiagnostic(event({ code: 'STDERR_TIMEOUT', stderrBytes: 8 }));
    expect(messages.filter(message => message.event === 'diagnostic')).toHaveLength(1);
    expect(modelCalls).toBe(0);
    input.write(encodeNativeMessage({ id: 2, type: 'emergencyTranslate', traceId: '12345678-1234-1234-1234-123456789abc', payload: { items: [] } }));
    for (let i = 0; i < 50 && !messages.some(message => message.id === 2); i++) await new Promise(resolve => setTimeout(resolve, 2));
    expect(messages.find(message => message.id === 2)).toMatchObject({id:2,ok:false,code:'ITEM_ID',detail:{itemIndex:2}});
    expect(framingErrors).toHaveLength(0);
    input.end();
    for (let i = 0; i < 50 && !closed; i++) await new Promise(resolve => setTimeout(resolve, 2));
    decoder.end();
    expect(closed).toBe(true);
    expect(framingErrors).toHaveLength(0);
  } finally {
    input.destroy(); output.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});

test('diagnostic initialization does not start a client after native stdin already closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shisui-host-closed-'));
  const configPath = join(directory, 'config.json');
  const dataDir = join(directory, 'data');
  const origin = 'chrome-extension://' + 'a'.repeat(32) + '/';
  await writeFile(configPath,JSON.stringify({backend:'chatgpt',dataDir,extensionOrigin:origin}));
  const input = new PassThrough();
  input.resume();
  input.end();
  await new Promise(resolve => input.once('end', resolve));
  let starts = 0;
  let closes = 0;
  class FakeClient extends EventEmitter {
    async start() { starts++; }
    async close() { closes++; }
  }
  try {
    await runHost({
      argv: ['--config', configPath, origin], input, output: new PassThrough(),
      clientFactory: () => new FakeClient(),
    });
    expect(starts).toBe(0);
    expect(closes).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('native storage failures remain recoverable without leaking filesystem errors',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'shisui-diagnostic-failure-'));
  try{
    const store=await DiagnosticStore.create(directory),events=[];store.on('diagnostic',value=>events.push(value));
    await mkdir(store.path);
    expect(await store.append(event())).toBe(false);expect(store.storageError).toBe(true);
    expect(events.map(value=>value.code)).toEqual(['STORAGE_ERROR']);expect(JSON.stringify(events)).not.toContain(directory);
    await rm(store.path,{recursive:true});
    expect(await store.append(event())).toBe(true);expect(store.storageError).toBe(false);
    expect(JSON.parse((await readFile(store.path,'utf8')).trim()).code).toBe('STDERR_AUTH');
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('corrupt native configuration fails closed until explicitly configured',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'shisui-diagnostic-config-'));
  try{
    await writeFile(join(directory,'diagnostics-config.json'),'{broken');
    const store=await DiagnosticStore.create(directory);expect(await store.append(event())).toBe(false);
    expect(store.storageError).toBe(true);await store.configure(false);expect(store.storageError).toBe(false);
    expect((await DiagnosticStore.create(directory)).enabled).toBe(false);
    await store.configure(true);expect(await store.append(event())).toBe(true);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('native startup removes expired events and sanitizes retained disk records',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'shisui-diagnostic-retention-'));
  try{
    const path=join(directory,'diagnostics.jsonl');
    await writeFile(path,[event({at:Date.now()-8*86400000,code:'STDERR_TIMEOUT'}),event({at:Date.now(),message:'private-source'})].map(JSON.stringify).join('\n')+'\ninvalid-json\n');
    await DiagnosticStore.create(directory);const text=await readFile(path,'utf8');
    expect(text.trim().split('\n').map(JSON.parse).map(value=>value.code)).toEqual(['STDERR_AUTH']);
    expect(text).not.toContain('private-source');
    if (process.platform !== 'win32') expect((await stat(path)).mode&0o777).toBe(0o600);
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('native assistance progress is framed without settling the pending request',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'shisui-host-progress-'));
  const configPath=join(directory,'config.json'),dataDir=join(directory,'data');
  const origin='chrome-extension://'+'a'.repeat(32)+'/';
  await writeFile(configPath,JSON.stringify({backend:'chatgpt',dataDir,extensionOrigin:origin}));
  const input=new PassThrough(),output=new PassThrough(),messages=[];
  const decoder=new NativeMessageDecoder({onMessage:message=>messages.push(message),onError:()=>{}});
  output.on('data',chunk=>decoder.push(chunk));
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  class FakeClient extends EventEmitter {
    async start() {}
    async close() {}
    async assist(_payload,{onProgress}) {
      onProgress({definition:'used to find data quickly'});
      await gate;
      return {level:'hint',hint:null};
    }
  }
  try {
    await runHost({argv:['--config',configPath,origin],input,output,clientFactory:()=>new FakeClient()});
    input.write(encodeNativeMessage({id:'assist-1',type:'assist',payload:{}}));
    for(let i=0;i<50&&!messages.some(message=>message.event==='assistProgress');i++)await new Promise(resolve=>setTimeout(resolve,2));
    expect(messages).toContainEqual({event:'assistProgress',id:'assist-1',data:{definition:'used to find data quickly'}});
    expect(messages.some(message=>message.id==='assist-1'&&message.ok!==undefined)).toBe(false);
    release();
    for(let i=0;i<50&&!messages.some(message=>message.id==='assist-1'&&message.ok===true);i++)await new Promise(resolve=>setTimeout(resolve,2));
    expect(messages.find(message=>message.id==='assist-1'&&message.ok===true)?.data).toEqual({level:'hint',hint:null});
  } finally {
    release();input.destroy();output.destroy();
    await rm(directory,{recursive:true,force:true});
  }
});
