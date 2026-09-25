const azureFields = [
  {key:'apiMode',label:'API 模式',type:'select',defaultValue:'responses',options:[{value:'responses',label:'Responses API'},{value:'chat',label:'Chat Completions'}]},
  {key:'resourceName',label:'资源名称',type:'text',placeholder:'my-azure-openai-resource'},
  {key:'apiVersion',label:'API 版本',type:'text',placeholder:'v1',defaultValue:'v1'},
];
const bedrockFields = [{key:'region',label:'区域',type:'text',placeholder:'us-east-1',defaultValue:'us-east-1'}];
const stepfunFields = [{key:'plan',label:'接入方式',type:'select',defaultValue:'api',options:[{value:'api',label:'按量付费 API'},{value:'step_plan',label:'Step Plan 订阅套餐'}]}];

// 思考模式经 per-service options 下发；replicate 预测与 jev 判定通道没有对应参数，不提供该选项。
const THINKING_FIELD = {key:'thinking',label:'思考模式',type:'select',defaultValue:'auto',options:[{value:'auto',label:'自动'},{value:'off',label:'关闭'},{value:'low',label:'低'},{value:'medium',label:'中'},{value:'high',label:'高'}]};
const THINKING_PROTOCOLS = new Set(['chat','responses','anthropic','google','bedrock','cohere','ollama']);

// Provider names and ordering follow the supported service catalog. Hosted defaults are
// selected independently for general reading, explanation, and structured JSON without
// forced reasoning. Empty apiKeyUrl values avoid referral links and guessed console URLs.
export const API_PROVIDERS = [
  {id:'openai',name:'OpenAI',protocol:'responses',baseUrl:'https://api.openai.com/v1',defaultModel:'gpt-5.6-luna',apiKeyUrl:'',keyOptional:false,fields:[]},
  {id:'deepseek',name:'DeepSeek',protocol:'chat',baseUrl:'https://api.deepseek.com',defaultModel:'deepseek-v4-flash',apiKeyUrl:'',keyOptional:false,fields:[]},
  {id:'google',name:'Gemini',protocol:'google',baseUrl:'https://generativelanguage.googleapis.com/v1beta',defaultModel:'gemini-2.5-flash-lite',apiKeyUrl:'',keyOptional:false,fields:[]},
  {id:'anthropic',name:'Anthropic',protocol:'anthropic',baseUrl:'https://api.anthropic.com/v1',defaultModel:'claude-haiku-4-5',apiKeyUrl:'',keyOptional:false,fields:[]},
  {id:'xai',name:'Grok',protocol:'responses',baseUrl:'https://api.x.ai/v1',defaultModel:'grok-4.20-0309-non-reasoning',apiKeyUrl:'',keyOptional:false,fields:[]},
  {id:'requesty',name:'Requesty · Jev 判定',protocol:'jev',baseUrl:'https://router.requesty.ai/v1',defaultModel:'typesafe/jev-1.13.0',apiKeyUrl:'https://app.requesty.ai',keyOptional:false,fields:[]},
  {id:'openai-compatible',name:'自定义 Chat Completions',protocol:'chat',baseUrl:'https://api.example.com/v1',defaultModel:'',apiKeyUrl:'',keyOptional:false,fields:[]},
  {id:'open-responses',name:'自定义 Responses',protocol:'responses',baseUrl:'https://api.example.com/v1/responses',defaultModel:'',apiKeyUrl:'',keyOptional:false,fields:[]},
  {id:'jalapenocloud',name:'Jalapeno Cloud',protocol:'chat',baseUrl:'https://api.jalapeno-cloud.ai/v1',defaultModel:'GLM-5.2',apiKeyUrl:'',keyOptional:false,fields:[]},
  {id:'atlascloud',name:'Atlas Cloud',protocol:'chat',baseUrl:'https://api.atlascloud.ai/v1',defaultModel:'deepseek-ai/deepseek-v4-flash',apiKeyUrl:'',keyOptional:false,fields:[]},
  {id:'openrouter',name:'OpenRouter',protocol:'chat',baseUrl:'https://openrouter.ai/api/v1',defaultModel:'google/gemma-4-31b-it:free',apiKeyUrl:'',keyOptional:false,fields:[]},
  {id:'minimax',name:'MiniMax',protocol:'chat',baseUrl:'https://api.minimax.io/v1',defaultModel:'MiniMax-M3',apiKeyUrl:'',keyOptional:false,fields:[]},
  {id:'siliconflow',name:'SiliconFlow',protocol:'chat',baseUrl:'https://api.siliconflow.cn/v1',defaultModel:'Qwen/Qwen3-Next-80B-A3B-Instruct',apiKeyUrl:'',keyOptional:false,fields:[]},
  {id:'tensdaq',name:'Tensdaq',protocol:'chat',baseUrl:'https://tensdaq-api.x-aio.com/v1',defaultModel:'Qwen3-30B-A3B-Instruct-2507',apiKeyUrl:'',keyOptional:false,fields:[]},
  {id:'azure',name:'Azure OpenAI',protocol:'responses',baseUrl:'',defaultModel:'gpt-5.6-luna',apiKeyUrl:'',keyOptional:false,fields:azureFields},
  {id:'bedrock',name:'Amazon Bedrock',protocol:'bedrock',baseUrl:'',defaultModel:'us.amazon.nova-micro-v1:0',apiKeyUrl:'',keyOptional:false,fields:bedrockFields},
  {id:'groq',name:'Groq',protocol:'chat',baseUrl:'https://api.groq.com/openai/v1',defaultModel:'llama-3.3-70b-versatile',apiKeyUrl:'',keyOptional:false,fields:[]},
  {id:'deepinfra',name:'DeepInfra',protocol:'chat',baseUrl:'https://api.deepinfra.com/v1/openai',defaultModel:'meta-llama/Llama-3.3-70B-Instruct-Turbo',apiKeyUrl:'',keyOptional:false,fields:[]},
  {id:'mistral',name:'Mistral AI',protocol:'chat',baseUrl:'https://api.mistral.ai/v1',defaultModel:'mistral-small-latest',apiKeyUrl:'',keyOptional:false,fields:[]},
  {id:'togetherai',name:'Together.ai',protocol:'chat',baseUrl:'https://api.together.xyz/v1',defaultModel:'meta-llama/Llama-3.3-70B-Instruct-Turbo',apiKeyUrl:'',keyOptional:false,fields:[]},
  {id:'cohere',name:'Cohere',protocol:'cohere',baseUrl:'https://api.cohere.com/v2',defaultModel:'command-a-03-2025',apiKeyUrl:'',keyOptional:false,fields:[]},
  {id:'fireworks',name:'Fireworks AI',protocol:'chat',baseUrl:'https://api.fireworks.ai/inference/v1',defaultModel:'accounts/fireworks/models/llama-v3p3-70b-instruct',apiKeyUrl:'',keyOptional:false,fields:[]},
  {id:'cerebras',name:'Cerebras',protocol:'chat',baseUrl:'https://api.cerebras.ai/v1',defaultModel:'qwen-3.8-27b',apiKeyUrl:'',keyOptional:false,fields:[]},
  {id:'replicate',name:'Replicate',protocol:'replicate',baseUrl:'https://api.replicate.com/v1',defaultModel:'meta/meta-llama-3.1-70b-instruct',apiKeyUrl:'',keyOptional:false,fields:[]},
  {id:'perplexity',name:'Perplexity',protocol:'chat',baseUrl:'https://api.perplexity.ai',defaultModel:'sonar',apiKeyUrl:'',keyOptional:false,fields:[]},
  {id:'vercel',name:'Vercel',protocol:'chat',baseUrl:'https://api.v0.dev/v1',defaultModel:'v0-1.5-md',apiKeyUrl:'',keyOptional:false,fields:[]},
  {id:'ollama',name:'Ollama',protocol:'ollama',baseUrl:'http://localhost:11434/api',defaultModel:'gemma3:4b',apiKeyUrl:'',keyOptional:true,fields:[]},
  {id:'volcengine',name:'Volcengine',protocol:'chat',baseUrl:'https://ark.cn-beijing.volces.com/api/v3',defaultModel:'doubao-seed-1-6-flash-250828',apiKeyUrl:'',keyOptional:false,fields:[]},
  {id:'alibaba',name:'Alibaba Cloud',protocol:'chat',baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',defaultModel:'qwen3.8-flash',apiKeyUrl:'',keyOptional:false,fields:[]},
  {id:'moonshotai',name:'Moonshot AI',protocol:'chat',baseUrl:'https://api.moonshot.ai/v1',defaultModel:'kimi-k2.6',apiKeyUrl:'',keyOptional:false,fields:[]},
  {id:'stepfun',name:'StepFun (阶跃星辰)',protocol:'chat',baseUrl:'https://api.stepfun.com/v1',defaultModel:'step-1-flash',apiKeyUrl:'',keyOptional:false,fields:stepfunFields},
  {id:'huggingface',name:'Hugging Face',protocol:'chat',baseUrl:'https://router.huggingface.co/v1',defaultModel:'Qwen/Qwen2.5-7B-Instruct-1M',apiKeyUrl:'',keyOptional:false,fields:[]},
].map(provider => THINKING_PROTOCOLS.has(provider.protocol) ? {...provider,fields:[...provider.fields,THINKING_FIELD]} : provider);

const providersById = new Map(API_PROVIDERS.map(provider => [provider.id,provider]));

export function getApiProvider(id) {
  return providersById.get(id) || null;
}

function cleanOption(value,key) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`服务选项 ${key} 必须是文本。`);
  return value.trim();
}

function normalizedOptions(provider,source) {
  if (source === undefined) source={};
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('API 服务选项无效。');
  const allowed=new Set(provider.fields.map(field=>field.key));
  for (const key of Object.keys(source)) if (!allowed.has(key)) throw new Error('API 服务包含未知选项。');
  const result={};
  for (const field of provider.fields) {
    let value=cleanOption(source[field.key],field.key);
    if (!value && field.defaultValue) value=field.defaultValue;
    if (field.type==='select' && !field.options.some(option=>option.value===value)) throw new Error(`服务选项 ${field.label} 无效。`);
    if (value) result[field.key]=value;
  }
  return result;
}

export function apiProviderBaseUrl(providerId,options={}) {
  const provider=getApiProvider(providerId);
  if (!provider) throw new Error('不支持的 API 服务商。');
  const normalized=normalizedOptions(provider,options);
  if (providerId==='azure') {
    const resourceName=normalized.resourceName || '';
    if (!resourceName) return '';
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(resourceName)) throw new Error('Azure 资源名称无效。');
    return `https://${resourceName}.openai.azure.com/openai/v1`;
  }
  if (providerId==='bedrock') {
    const region=normalized.region || 'us-east-1';
    if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/.test(region)) throw new Error('Bedrock 区域无效。');
    return `https://bedrock-runtime.${region}.amazonaws.com`;
  }
  if (providerId==='stepfun' && normalized.plan==='step_plan') return 'https://api.stepfun.com/step_plan/v1';
  return provider.baseUrl;
}

function normalizedBaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('API 地址不能为空。');
  let url;
  try { url=new URL(value.trim()); } catch { throw new Error('请输入有效的 API 地址。'); }
  const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if ((url.protocol!=='https:' && !(url.protocol==='http:'&&loopback)) || url.username || url.password || url.search || url.hash) throw new Error('API 地址必须使用 HTTPS；仅本机服务允许 HTTP，不允许内嵌凭据或查询参数。');
  url.pathname=url.pathname==='/' ? '/' : url.pathname.replace(/\/+$/,'');
  return url.href.replace(/\/$/,'');
}

// 多 Key 归一化：去空白、去重、保序、限量；空列表等价于未配置。apiKey 继续作为首个 Key 的镜像，
// 让既有的单 Key 读取路径无需改动，轮询以 apiKeys 为源。
export const API_KEY_LIMIT = 8;
export function normalizeApiKeys(value, fallbackKey='') {
  const raw = Array.isArray(value) ? value : [];
  const keys = [];
  const seen = new Set();
  for (const entry of raw) {
    if (typeof entry!=='string') continue;
    const key = entry.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
    if (keys.length >= API_KEY_LIMIT) break;
  }
  if (keys.length) return keys;
  const fallback = typeof fallbackKey==='string' ? fallbackKey.trim() : '';
  return fallback ? [fallback] : [];
}

export function normalizeApiService(row) {
  if (!row || typeof row!=='object' || Array.isArray(row)) throw new Error('无效的 API 服务。');
  const legacy=!Object.hasOwn(row,'providerId');
  const allowed=new Set(legacy?['id','name','baseUrl','model','apiKey','apiKeys']:['id','name','providerId','baseUrl','model','apiKey','apiKeys','options','fallbackServiceId']);
  for (const key of Object.keys(row)) if (!allowed.has(key)) throw new Error('API 服务包含未知字段。');
  for (const key of ['id','name','baseUrl','model','apiKey']) if (typeof row[key]!=='string') throw new Error('无效的 API 服务。');
  const providerId=legacy?'openai-compatible':row.providerId;
  if (typeof providerId!=='string' || !getApiProvider(providerId)) throw new Error('不支持的 API 服务商。');
  const provider=getApiProvider(providerId),options=normalizedOptions(provider,legacy?{}:row.options);
  const configuredBase=row.baseUrl.trim() || apiProviderBaseUrl(providerId,options);
  if(row.apiKeys!==undefined && !Array.isArray(row.apiKeys)) throw new Error('无效的 API 密钥列表。');
  const apiKeys=normalizeApiKeys(row.apiKeys,row.apiKey);
  const fallbackServiceId=typeof row.fallbackServiceId==='string'?row.fallbackServiceId.trim():'';
  return {id:row.id.trim(),name:row.name.trim(),providerId,baseUrl:normalizedBaseUrl(configuredBase),model:row.model.trim(),apiKey:apiKeys[0]||'',apiKeys,options,...(fallbackServiceId?{fallbackServiceId}:{})};
}

export function apiServiceReady(service) {
  try {
    const normalized=normalizeApiService(service),provider=getApiProvider(normalized.providerId);
    return Boolean(normalized.model && (provider.keyOptional || normalized.apiKey));
  } catch { return false; }
}

export function apiServiceOrigins(service) {
  const normalized=normalizeApiService(service);
  return [new URL(normalized.baseUrl).origin];
}
