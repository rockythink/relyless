import {expect,test} from 'bun:test';
import {API_PROVIDERS,apiProviderBaseUrl,apiServiceOrigins,apiServiceReady,normalizeApiService} from '../extension/api-providers.mjs';

test('catalog exposes the complete unique supported LLM provider set',()=>{
  expect(API_PROVIDERS).toHaveLength(33);
  expect(new Set(API_PROVIDERS.map(provider=>provider.id)).size).toBe(33);
  expect(API_PROVIDERS.map(provider=>provider.id)).toEqual([
    'openai','deepseek','google','anthropic','xai','requesty','openai-compatible','open-responses','jalapenocloud','atlascloud','openrouter','minimax','siliconflow','siliconflow-systemone','tensdaq','azure','bedrock','groq','deepinfra','mistral','togetherai','cohere','fireworks','cerebras','replicate','perplexity','vercel','ollama','volcengine','alibaba','moonshotai','stepfun','huggingface',
  ]);
  expect(API_PROVIDERS.every(provider=>provider.apiKeyUrl===''||!/[?&](?:ref|aff|utm_)/i.test(provider.apiKeyUrl))).toBe(true);
});

test('legacy service migration preserves its endpoint and assigns only the historical compatible protocol',()=>{
  expect(normalizeApiService({id:'legacy',name:'Legacy',baseUrl:'https://private.example/custom/v7/',model:'private-model',apiKey:'secret'})).toEqual({
    id:'legacy',name:'Legacy',providerId:'openai-compatible',baseUrl:'https://private.example/custom/v7',model:'private-model',apiKey:'secret',apiKeys:['secret'],options:{},
  });
});

test('provider options are strict and dynamic endpoints remain on their provider origin',()=>{
  expect(apiProviderBaseUrl('azure',{resourceName:'team-prod',apiMode:'chat',apiVersion:'2025-01-01-preview'})).toBe('https://team-prod.openai.azure.com/openai/v1');
  expect(apiProviderBaseUrl('bedrock',{region:'us-west-2'})).toBe('https://bedrock-runtime.us-west-2.amazonaws.com');
  expect(()=>normalizeApiService({id:'x',name:'X',providerId:'bedrock',baseUrl:'',model:'m',apiKey:'k',options:{region:'us-west-2',secretAccessKey:'secret'}})).toThrow('未知选项');
});

test('service origins reject credential exfiltration URLs and allow keyless loopback only',()=>{
  const service={id:'local',name:'Local',providerId:'ollama',baseUrl:'http://localhost:11434/api',model:'gemma3:4b',apiKey:'',options:{}};
  expect(apiServiceOrigins(service)).toEqual(['http://localhost:11434']);
  expect(apiServiceReady(service)).toBe(true);
  expect(apiServiceReady({...service,providerId:'openai-compatible'})).toBe(false);
  for(const baseUrl of ['http://remote.example/v1','https://user:pass@safe.example/v1','https://safe.example/v1?next=https://evil.example','https://safe.example/v1#secret']){
    expect(()=>apiServiceOrigins({...service,baseUrl})).toThrow();
  }
});

