#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { endianness } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SiwcClient } from "./siwc.mjs";
import { GrokClient } from "./grok.mjs";
import { AntigravityClient } from "./antigravity.mjs";
import { DiagnosticStore } from "./diagnostics.mjs";
import { diagnosticError, validTraceId } from "../extension/diagnostics.mjs";

export const MAX_NATIVE_MESSAGE_BYTES = 1024 * 1024;
const READ_UINT32 = endianness() === "LE" ? "readUInt32LE" : "readUInt32BE";
const WRITE_UINT32 = endianness() === "LE" ? "writeUInt32LE" : "writeUInt32BE";

export class NativeMessageDecoder {
  constructor({ maxBytes = MAX_NATIVE_MESSAGE_BYTES, onMessage, onError }) {
    this.maxBytes = maxBytes;
    this.onMessage = onMessage;
    this.onError = onError;
    this.buffer = Buffer.alloc(0);
    this.failed = false;
  }

  push(chunk) {
    if (this.failed || !Buffer.isBuffer(chunk)) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      if (this.buffer.length < 4) return;
      const length = this.buffer[READ_UINT32](0);
      if (length === 0 || length > this.maxBytes) return this.#fail(new Error("原生消息长度无效"));
      if (this.buffer.length < length + 4) return;
      const body = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      let message;
      try { message = JSON.parse(body.toString("utf8")); }
      catch { return this.#fail(new Error("原生消息 JSON 无效")); }
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        return this.#fail(new Error("原生消息格式无效"));
      }
      this.onMessage(message);
      if (this.failed) return;
    }
  }

  end() {
    if (!this.failed && this.buffer.length !== 0) this.#fail(new Error("原生消息不完整"));
  }

  #fail(error) {
    this.failed = true;
    this.buffer = Buffer.alloc(0);
    this.onError(error);
  }
}

export function encodeNativeMessage(message, maxBytes = MAX_NATIVE_MESSAGE_BYTES) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length === 0 || body.length > maxBytes) throw new Error("原生消息过大");
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame[WRITE_UINT32](body.length, 0);
  body.copy(frame, 4);
  return frame;
}

export function validateExtensionOrigin(configured, actual) {
  if (typeof configured !== "string" || typeof actual !== "string" || configured !== actual) return false;
  try {
    const url = new URL(actual);
    return url.protocol === "chrome-extension:"
      && /^[a-p]{32}$/.test(url.hostname)
      && url.pathname === "/"
      && !url.username
      && !url.password
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

function validateRequest(message) {
  const validId = (Number.isSafeInteger(message.id) && message.id >= 0)
    || (typeof message.id === "string" && message.id.length > 0 && message.id.length <= 128);
  if (!validId || typeof message.type !== "string") throw new Error("请求格式无效");
  if (message.payload !== undefined && (!message.payload || typeof message.payload !== "object" || Array.isArray(message.payload))) {
    throw new Error("请求参数无效");
  }
  if (message.traceId !== undefined && !validTraceId(message.traceId)) throw new Error("请求追踪标识无效");
  return { id: message.id, type: message.type, payload: message.payload ?? {}, ...(message.traceId ? { traceId: message.traceId.toLowerCase() } : {}) };
}

async function loadConfiguration(configPath, actualOrigin) {
  let config;
  try { config = JSON.parse(await readFile(resolve(configPath), "utf8")); }
  catch { throw new Error("无法读取连接器配置"); }
  const backend = config?.backend;
  const cliPath = backend === "antigravity" ? config.agyPath : null;
  if (!config || typeof config !== "object" || Array.isArray(config)
    || !["chatgpt","grok","antigravity"].includes(backend)
    || (backend === "antigravity" && (typeof cliPath !== "string" || !cliPath))
    || typeof config.dataDir !== "string" || !config.dataDir
    || !validateExtensionOrigin(config.extensionOrigin, actualOrigin)) {
    throw new Error("连接器配置或扩展来源无效");
  }
  return backend === "antigravity"
    ? { backend, agyPath: resolve(cliPath), dataDir: resolve(config.dataDir) }
    : { backend, dataDir: resolve(config.dataDir) };
}

function parseHostArgv(argv) {
  if (!Array.isArray(argv) || argv.length < 3 || argv[0] !== "--config") throw new Error("连接器启动参数无效");
  for (const extra of argv.slice(3)) {
    if (typeof extra !== "string" || !/^--parent-window=\d+$/.test(extra)) throw new Error("连接器启动参数无效");
  }
  return { configPath: argv[1], origin: argv[2] };
}

export async function runHost({ argv = process.argv.slice(2), input = process.stdin, output = process.stdout, clientFactory } = {}) {
  const { configPath, origin } = parseHostArgv(argv);
  const configuration = await loadConfiguration(configPath, origin);
  const diagnostics = await DiagnosticStore.create(configuration.dataDir);
  const createClient = clientFactory || (options => configuration.backend === "grok" ? new GrokClient(options) : configuration.backend === "antigravity" ? new AntigravityClient(options) : new SiwcClient(options));
  const client = createClient({ ...configuration, diagnostic: record => diagnostics.append(record) });
  let closing = false;

  const write = (message) => {
    if (!closing && output.writable) output.write(encodeNativeMessage(message));
  };
  const close = async (exitCode = 0) => {
    if (closing) return;
    closing = true;
    input.destroy();
    await client.close().catch(() => {});
    await diagnostics.idle();
    process.exitCode = exitCode;
  };

  client.on("status", (status) => write({ event: "status", data: status }));
  diagnostics.on("diagnostic", (record) => write({ event: "diagnostic", data: record }));
  if(diagnostics.storageError)write({event:'diagnostic',data:{at:Date.now(),operation:'CONNECTION',stage:'connection',status:'error',code:'STORAGE_ERROR'}});

  const dispatch = async (raw) => {
    let request;
    try { request = validateRequest(raw); }
    catch (error) {
      if (raw && (typeof raw.id === "string" || Number.isSafeInteger(raw.id))) {
        const { code, ...detail } = diagnosticError(error);
        write({ id: raw.id, ok: false, error: error.message, code, detail });
        return;
      }
      await close(1);
      return;
    }
    try {
      let data;
      switch (request.type) { case "sentenceGroups": data = await client.sentenceGroups(request.payload, { traceId: request.traceId }); break; case "status": data = await client.refreshStatus(); break;
      case "login": data = await client.login(); break;
      case "cancel": data = await client.cancelLogin(); break;
      case "logout": data = await client.logout(); break;
      case "models": data = { models: await client.listModels({ refresh: request.payload.refresh === true }) }; break;
      case "classify": data = await client.classify(request.payload, { traceId: request.traceId }); break;
      case "supportBatch": data = await client.supportBatch(request.payload, { traceId: request.traceId }); break;
      case "assist": data = await client.assist(request.payload, {
        traceId: request.traceId,
        onProgress: progress => write({ event: "assistProgress", id: request.id, data: progress }),
      }); break;
      case "emergencyTranslate": data = await client.emergencyTranslate(request.payload, {
        traceId: request.traceId,
        onProgress: progress => write({ event: "translationProgress", id: request.id, data: progress }),
      }); break;
      case "historyModel": data = await client.historyModel(request.payload, { traceId: request.traceId }); break;
      case "conversationTurn": {
        if (typeof client.conversationTurn !== "function") throw new Error("当前连接器不支持多轮追问，请更新连接器。");
        data = await client.conversationTurn(request.payload, {
          traceId: request.traceId,
          onProgress: progress => write({ event: "conversationProgress", id: request.id, data: progress }),
        });
        break;
      }
      case "diagnostics": {
        if (request.payload.action === "append") {
          await diagnostics.appendMany(request.payload.events, { broadcast: false });
        } else if (request.payload.action === "clear") {
          await diagnostics.clear();
        } else if (request.payload.action === "configure") {
          await diagnostics.configure(request.payload.enabled);
        } else throw new Error("诊断同步请求无效");
        data = { enabled: diagnostics.enabled, storageError: diagnostics.storageError };
        break;
      }
      default: throw new Error("不支持的连接器请求，请更新本地连接器。"); }
      write({ id: request.id, ok: true, data });
    } catch (error) {
      const { code, ...detail } = diagnosticError(error);
      write({ id: request.id, ok: false, error: typeof error?.message === "string" ? error.message : "连接器请求失败", code, detail });
    }
  };

  const decoder = new NativeMessageDecoder({
    onMessage: (message) => { void dispatch(message); },
    onError: () => { void close(1); },
  });
  input.on("data", (chunk) => decoder.push(chunk));
  input.on("end", () => { decoder.end(); void close(decoder.failed ? 1 : 0); });
  input.on("error", () => { void close(1); });

  const onSignal = () => { void close(0); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.once("SIGHUP", onSignal);

  // Configuration and diagnostic setup are asynchronous; do not launch the CLI if Chrome closed stdin meanwhile.
  if (input.readableEnded || input.destroyed) { await close(0); return; }

  try { await client.start(); }
  catch { await close(1); }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href;
if (isMain) {
  runHost().catch(() => { process.exitCode = 1; });
}
