import {afterEach,beforeEach,expect,test} from 'bun:test';
import {performProviderRequest} from '../extension/api-transport.mjs';
import {translationProgress} from '../extension/assistance-stream.mjs';
import {EMERGENCY_SCHEMA} from '../extension/gloss.mjs';

const realFetch=globalThis.fetch;
let installedFetch=realFetch;
const requestBody=init=>{try{return JSON.parse(init?.body||'null');}catch{return null;}};
const capabilityFormat=body=>body?.response_format?.json_schema?.name==='relyless_capability'?body.response_format.json_schema:body?.text?.format?.name==='relyless_capability'?body.text.format:null;
const capabilityToken=format=>format?.schema?.properties?.probe?.enum?.[0];
const capabilitySuccess=body=>{
  const token=capabilityToken(capabilityFormat(body)),content=JSON.stringify({probe:token});
  return body?.text?.format?Response.json({status:'completed',output_text:content}):Response.json({choices:[{finish_reason:'stop',message:{content}}]});
};
const rawFetch=handler=>{installedFetch=handler;};
beforeEach(()=>{
  installedFetch=realFetch;
  Object.defineProperty(globalThis,'fetch',{configurable:true,get:()=>installedFetch,set:handler=>{installedFetch=async(url,init)=>{const body=requestBody(init);return capabilityFormat(body)?capabilitySuccess(body):handler(url,init);};}});
});
afterEach(()=>{Object.defineProperty(globalThis,'fetch',{configurable:true,writable:true,value:realFetch});});
const schema={type:'object',additionalProperties:false,required:['value'],properties:{value:{type:'string'}}};
const service=(providerId,baseUrl,model='model')=>({id:'test',name:'Test',providerId,baseUrl,model,apiKey:'secret-key',options:{}});
const sse=chunks=>new Response(new ReadableStream({start(controller){const encoder=new TextEncoder();for(const chunk of chunks)controller.enqueue(typeof chunk==='string'?encoder.encode(chunk):chunk);controller.close();}}),{headers:{'content-type':'text/event-stream'}});
test('JSON replies remain usable when a provider declines a streaming request',async()=>{
  const text='{"value":"完整结果"}',cases=[
    ['mistral','mistral-small-latest',{choices:[{finish_reason:'stop',message:{content:text}}]}],
    ['open-responses','private-model',{status:'completed',output:[{type:'message',content:[{type:'output_text',text}]}]}],
    ['anthropic','claude-haiku-4-5',{stop_reason:'end_turn',content:[{type:'text',text}]}],
    ['google','gemini-2.5-flash-lite',{candidates:[{finishReason:'STOP',content:{parts:[{text}]}}]}],
    ['cohere','command-a-03-2025',{finish_reason:'COMPLETE',message:{content:[{type:'text',text}]}}],
  ];
  for(const [providerId,model,reply] of cases){let calls=0;globalThis.fetch=async()=>{calls++;return Response.json(reply);};expect(await performProviderRequest(service(providerId,'https://api.example.test/v1',model),{},'Explain.',schema,{onContent:()=>{}})).toEqual({value:'完整结果'});expect(calls).toBe(1);}
});

test('Azure chat works with legacy non-reasoning models and explicitly disables unknown deployment reasoning',async()=>{
  for(const [model,requiresOff] of [['gpt-4o',false],['my-deployment',true]]){let calls=0;globalThis.fetch=async(_url,init)=>{calls++;const body=JSON.parse(init.body),accepted=requiresOff?body.reasoning_effort==='none':body.reasoning_effort===undefined&&body.thinking===undefined;return accepted?Response.json({choices:[{finish_reason:'stop',message:{content:'{"value":"直接结果"}'}}]}):new Response('',{status:400});};const azure={...service('azure','https://resource.openai.azure.com',model),options:{apiMode:'chat',apiVersion:'v1'}};expect(await performProviderRequest(azure,{},'Explain.',schema)).toEqual({value:'直接结果'});expect(calls).toBe(1);}
});

test('streaming transport exposes safe translation text before the producer finishes',async()=>{
  let controller,firstContent;const seen=new Promise(resolve=>{firstContent=resolve;});
  const response=new Response(new ReadableStream({start(value){controller=value;}}),{headers:{'content-type':'text/event-stream'}});
  globalThis.fetch=async()=>response;
  const items=[{id:'p1',text:'The cache preserves recent data.'}],encoder=new TextEncoder();
  const event=(content,finish_reason=null)=>encoder.encode('data: '+JSON.stringify({choices:[{delta:{content},finish_reason}]})+'\n\n');
  let finished=false;const result=performProviderRequest(service('mistral','https://api.example.test/v1','mistral-small'),{items},'Translate.',EMERGENCY_SCHEMA,{onContent:text=>{const progress=translationProgress(text,items);if(progress)firstContent(progress);}}).then(value=>{finished=true;return value;});
  controller.enqueue(event('{"items":[{"id":"p1","translation":"缓存'));expect(await seen).toEqual({items:[{id:'p1',translation:'缓存'}]});expect(finished).toBe(false);
  controller.enqueue(event('保留数据。"}]}','stop'));controller.close();expect(await result).toEqual({items:[{id:'p1',translation:'缓存保留数据。'}]});
});

test('stream limits reject oversized content before exposure and oversized pending events before valid output',async()=>{
  const event=content=>'data: '+JSON.stringify({choices:[{delta:{content},finish_reason:'stop'}]})+'\n\n';let exposed=false;
  globalThis.fetch=async()=>sse([event(JSON.stringify({value:'x'.repeat(24_000)}))]);
  await expect(performProviderRequest(service('mistral','https://api.example.test/v1','mistral-small'),{},'Explain.',schema,{onContent:()=>{exposed=true;}})).rejects.toMatchObject({code:'INVALID_RESPONSE'});expect(exposed).toBe(false);
  globalThis.fetch=async()=>sse([...Array.from({length:65},()=>': '+'x'.repeat(1023)+'\n'),'\n',event('{"value":"ok"}')]);
  await expect(performProviderRequest(service('mistral','https://api.example.test/v1','mistral-small'),{},'Explain.',schema,{onContent:()=>{}})).rejects.toMatchObject({code:'INVALID_RESPONSE'});
});

test('a failed streaming consumer stops its producer and releases the response body',async()=>{
  let cancelled=false;const response=new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{content:'{"value":"ok"}'},finish_reason:null}]})+'\n\n'));},cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}});
  globalThis.fetch=async()=>response;
  await expect(performProviderRequest(service('mistral','https://api.example.test/v1','mistral-small'),{},'Explain.',schema,{onContent:()=>{throw new Error('consumer failed');}})).rejects.toThrow();
  expect(cancelled).toBe(true);expect(response.body.locked).toBe(false);
});

test('Responses SSE survives fragmented events and only reveals accumulated model text',async()=>{
  const first=JSON.stringify({type:'response.output_text.delta',delta:'{"value":"除😀'}),second=JSON.stringify({type:'response.output_text.delta',delta:'非"}'});
  const source=`event: response.output_text.delta\r\ndata: ${first}\r\n\r\nevent: response.output_text.delta\ndata: ${second}\n\nevent: response.completed\ndata: {"type":"response.completed"}\n\n`;
  const bytes=new TextEncoder().encode(source),emoji=new TextEncoder().encode(source.slice(0,source.indexOf('😀'))).length;
  globalThis.fetch=async()=>sse([bytes.slice(0,emoji+2),bytes.slice(emoji+2,emoji+3),bytes.slice(emoji+3)]);
  const seen=[];
  const result=await performProviderRequest(service('open-responses','https://api.example.test/v1/responses'),{source:'private text'},'Translate.',schema,{onContent:value=>seen.push(value)});
  expect(result).toEqual({value:'除😀非'});
  expect(seen.at(-1)).toBe('{"value":"除😀非"}');
});

test('Replicate creates one paid prediction and refuses a cross-origin polling URL without leaking its key',async()=>{
  const calls=[];
  globalThis.fetch=async(url,init)=>{calls.push({url:String(url),authorization:init.headers.Authorization,method:init.method});return Response.json({id:'prediction',status:'starting',urls:{get:'https://attacker.example/predictions/1'}});};
  await expect(performProviderRequest(service('replicate','https://api.replicate.com/v1','owner/model'),{source:'private'},'Translate.',schema)).rejects.toMatchObject({code:'UNSAFE_URL'});
  expect(calls).toEqual([{url:'https://api.replicate.com/v1/models/owner/model/predictions',authorization:'Bearer secret-key',method:'POST'}]);
});

test('aborting Replicate polling never creates or sends a second prediction request',async()=>{
  const controller=new AbortController();
  let calls=0;
  globalThis.fetch=async()=>{calls++;controller.abort();return Response.json({id:'prediction',status:'starting',urls:{get:'https://api.replicate.com/v1/predictions/1'}});};
  await expect(performProviderRequest(service('replicate','https://api.replicate.com/v1','owner/model'),{source:'private'},'Translate.',schema,{signal:controller.signal})).rejects.toHaveProperty('name','AbortError');
  expect(calls).toBe(1);
});

test('HTTP failures do not read or expose a provider body that may echo secrets',async()=>{
  let bodyRead=false;
  globalThis.fetch=async()=>({ok:false,status:500,json:async()=>{bodyRead=true;return {error:{message:'secret-key private prompt'}};},text:async()=>{bodyRead=true;return 'secret-key private prompt';}});
  let error;
  try{await performProviderRequest(service('mistral','https://api.mistral.ai/v1','mistral-small-latest'),{source:'private prompt'},'Translate.',schema);}catch(caught){error=caught;}
  expect(error).toMatchObject({code:'HTTP',detail:{httpStatus:500}});
  expect(error.message).not.toContain('secret-key');
  expect(error.message).not.toContain('private prompt');
  expect(bodyRead).toBe(false);
});


test('hosted chat protocols send their documented no-thinking controls without retrying',async()=>{
  const cases=[
    ['deepseek','deepseek-v4-flash',{thinking:{type:'disabled'}}],
    ['moonshotai','kimi-k2.6',{thinking:{type:'disabled'}}],
    ['volcengine','doubao-seed-1-6-flash-250828',{thinking:{type:'disabled'}}],
    ['minimax','MiniMax-M3',{thinking:{type:'disabled'}}],
    ['jalapenocloud','GLM-5.2',{thinking:{type:'disabled'}}],
    ['atlascloud','deepseek-ai/deepseek-v4-flash',{thinking:{type:'disabled'}}],
    ['alibaba','qwen3.8-flash',{enable_thinking:false}],
    ['siliconflow','Qwen/Qwen3-Next-80B-A3B-Instruct',{enable_thinking:false}],
    ['openrouter','zai-org/GLM-5.2',{reasoning:{effort:'none'}}],
    ['openrouter','x-ai/grok-4.3',{reasoning:{effort:'none'}}],
    ['openrouter','google/gemini-2.5-flash',{reasoning:{effort:'none'}}],
    ['deepinfra','Qwen/Qwen3.5-9B',{reasoning_effort:'none'}],
    ['togetherai','Qwen/Qwen3.5-9B',{reasoning:{enabled:false}}],
    ['huggingface','Qwen/Qwen3.5-9B',{reasoning_effort:'none'}],
    ['cerebras','qwen-3.8-27b',{reasoning_effort:'none'}],
  ];
  for(const [providerId,model,expected] of cases){let sent,calls=0;globalThis.fetch=async(_url,init)=>{calls++;sent=JSON.parse(init.body);return Response.json({choices:[{finish_reason:'stop',message:{content:'{"value":"ok"}'}}]});};const result=await performProviderRequest(service(providerId,'https://api.example.test/v1',model),{},'Explain.',schema);expect(result).toEqual({value:'ok'});expect(calls).toBe(1);for(const [key,value] of Object.entries(expected))expect(sent[key]).toEqual(value);}
});

test('non-reasoning hosted chat models do not receive unsupported reasoning fields',async()=>{
  const cases=[['openrouter','google/gemma-3-27b-it'],['deepinfra','meta-llama/Llama-3.3-70B-Instruct'],['togetherai','meta-llama/Llama-3.3-70B-Instruct-Turbo'],['huggingface','meta-llama/Llama-3.3-70B-Instruct'],['cohere','command-a-03-2025']];
  for(const [providerId,model] of cases){let sent;globalThis.fetch=async(_url,init)=>{sent=JSON.parse(init.body);return providerId==='cohere'?Response.json({finish_reason:'COMPLETE',message:{content:[{text:'{"value":"ok"}'}]}}):Response.json({choices:[{finish_reason:'stop',message:{content:'{"value":"ok"}'}}]});};await performProviderRequest(service(providerId,'https://api.example.test/v1',model),{},'Explain.',schema);expect(sent.reasoning).toBeUndefined();expect(sent.reasoning_effort).toBeUndefined();expect(sent.thinking).toBeUndefined();}
});

test('custom OpenAI-compatible protocols always request thinking off',async()=>{
  const sent=[];globalThis.fetch=async(_url,init)=>{sent.push(JSON.parse(init.body));return Response.json({choices:[{finish_reason:'stop',message:{content:'{"value":"ok"}'}}]});};
  await performProviderRequest(service('openai-compatible','https://custom.example/v1','custom-model'),{},'Explain.',schema);
  await performProviderRequest(service('openai-compatible','https://deepseek.example/v1','deepseek-chat'),{},'Explain.',schema);
  expect(sent[0].reasoning_effort).toBe('none');expect(sent[1].thinking).toEqual({type:'disabled'});
});

test('Responses protocols distinguish reasoning-capable and non-reasoning models',async()=>{
  const cases=[
    ['openai','gpt-5.6-luna',{reasoning:{effort:'none'}}],
    ['openai','gpt-4.1-mini',{}],
    ['xai','grok-4.3',{reasoning:{effort:'none'}}],
    ['xai','grok-4.20-0309-non-reasoning',{}],
    ['open-responses','private-model',{reasoning:{effort:'none'}}],
  ];
  for(const [providerId,model,expected] of cases){let sent;globalThis.fetch=async(_url,init)=>{sent=JSON.parse(init.body);return Response.json({status:'completed',output_text:'{"value":"ok"}'});};await performProviderRequest(service(providerId,'https://api.example.test/v1',model),{},'Explain.',schema);expect(sent.reasoning).toEqual(expected.reasoning);}
});

test('Gemini sends budget zero only for models that can actually turn thinking off',async()=>{
  let sent;globalThis.fetch=async(_url,init)=>{sent=JSON.parse(init.body);return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'{"value":"ok"}'}]}}]});};
  await performProviderRequest(service('google','https://generativelanguage.googleapis.com/v1beta','gemini-2.5-flash-lite'),{},'Explain.',schema);
  expect(sent.generationConfig.thinkingConfig).toEqual({thinkingBudget:0});
  let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({});};
  await expect(performProviderRequest(service('google','https://generativelanguage.googleapis.com/v1beta','gemini-3.5-flash-lite'),{},'Explain.',schema)).rejects.toMatchObject({code:'THINKING_REQUIRED'});expect(calls).toBe(0);
});

test('google uses streamGenerateContent only for streamed requests',async()=>{
  const urls=[],gemini=service('google','https://generativelanguage.googleapis.com/v1beta','gemini-2.5-flash-lite');
  globalThis.fetch=async(target)=>{urls.push(String(target));return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'{"value":"ok"}'}]}}]});};
  await performProviderRequest(gemini,{},'Explain.',schema);
  expect(urls.at(-1)).toContain(':generateContent');expect(urls.at(-1)).not.toContain(':streamGenerateContent');expect(urls.at(-1)).not.toContain('alt=sse');
  globalThis.fetch=async(target)=>{urls.push(String(target));return sse(['data: '+JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:'{"value":"ok"}'}]}}]})+'\n\n']);};
  await performProviderRequest(gemini,{},'Explain.',schema,{onContent:()=>{}});
  expect(urls.at(-1)).toContain(':streamGenerateContent');expect(urls.at(-1)).toContain('alt=sse');
});

test('known always-reasoning models fail before any paid request',async()=>{
  const cases=[['minimax','MiniMax-M2.7'],['xai','grok-4.6'],['xai','grok-4'],['openai','o3'],['openrouter','openai/o3'],['openrouter','x-ai/grok-4'],['togetherai','deepseek-ai/DeepSeek-R1'],['groq','openai/gpt-oss-20b'],['jalapenocloud','GLM-5.3']];let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({});};
  for(const [providerId,model] of cases)await expect(performProviderRequest(service(providerId,'https://api.example.test/v1',model),{},'Explain.',schema)).rejects.toMatchObject({code:'THINKING_REQUIRED'});expect(calls).toBe(0);
});

test('Anthropic, Cohere, and Bedrock only send native thinking controls to capable models',async()=>{
  let sent;globalThis.fetch=async(_url,init)=>{sent=JSON.parse(init.body);return Response.json({stop_reason:'end_turn',content:[{text:'{"value":"ok"}'}]});};
  await performProviderRequest(service('anthropic','https://api.anthropic.com/v1','claude-haiku-4-5'),{},'Explain.',schema);expect(sent.thinking).toEqual({type:'disabled'});
  globalThis.fetch=async(_url,init)=>{sent=JSON.parse(init.body);return Response.json({finish_reason:'COMPLETE',message:{content:[{text:'{"value":"ok"}'}]}});};
  await performProviderRequest(service('cohere','https://api.cohere.com/v2','command-a-reasoning-08-2025'),{},'Explain.',schema);expect(sent.thinking).toEqual({type:'disabled'});
  globalThis.fetch=async(_url,init)=>{sent=JSON.parse(init.body);return Response.json({stopReason:'end_turn',output:{message:{content:[{text:'{"value":"ok"}'}]}}});};
  await performProviderRequest(service('bedrock','https://bedrock-runtime.us-east-1.amazonaws.com','anthropic.claude-haiku-4-5-v1:0'),{},'Explain.',schema);expect(sent.additionalModelRequestFields).toEqual({thinking:{type:'disabled'}});
  await performProviderRequest(service('bedrock','https://bedrock-runtime.us-east-1.amazonaws.com','us.amazon.nova-micro-v1:0'),{},'Explain.',schema);expect(sent.additionalModelRequestFields).toBeUndefined();
});

test('Azure v1 URLs omit the obsolete api-version query while legacy deployment URLs retain dated versions',async()=>{
  const urls=[];globalThis.fetch=async(url)=>{urls.push(String(url));return Response.json({status:'completed',output_text:'{"value":"ok"}'});};
  const v1={...service('azure','https://resource.openai.azure.com/openai/v1','gpt-5.6-luna'),options:{apiMode:'responses',apiVersion:'v1'}};
  await performProviderRequest(v1,{},'Explain.',schema);
  const legacy={...service('azure','https://resource.openai.azure.com','gpt-5.6-luna'),options:{apiMode:'responses',apiVersion:'2025-04-01-preview'}};
  await performProviderRequest(legacy,{},'Explain.',schema);
  expect(urls[0]).toBe('https://resource.openai.azure.com/openai/v1/responses');expect(urls[1]).toContain('api-version=2025-04-01-preview');
});

test('provider error payloads and SSE handler errors never expose raw messages',async()=>{
  for(const providerResponse of [Response.json({error:{message:'secret-key private prompt'}}),sse(['event: response.failed\ndata: {"type":"response.failed","response":{"error":{"message":"secret-key private prompt"}}}\n\n'])]){
    globalThis.fetch=async()=>providerResponse;let error;try{await performProviderRequest(service('open-responses','https://api.example.test/v1/responses','private-model'),{source:'private prompt'},'Explain.',schema,{onContent:providerResponse.headers.get('content-type')==='text/event-stream'?()=>{}:undefined});}catch(caught){error=caught;}expect(error.code).toBe('PROVIDER_ERROR');expect(error.message).not.toContain('secret-key');expect(error.message).not.toContain('private prompt');
  }
});

test('stream completion markers cannot turn truncation or missing finish reasons into success',async()=>{
  globalThis.fetch=async()=>sse(['data: {"choices":[{"delta":{"content":"{\\"value\\":\\"partial"}}]}\n\ndata: [DONE]\n\n']);
  await expect(performProviderRequest(service('mistral','https://api.example.test/v1','mistral-small'),{},'Explain.',schema,{onContent:()=>{}})).rejects.toMatchObject({code:'INVALID_RESPONSE'});
  globalThis.fetch=async()=>Response.json({status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output_text:'{"value":"partial"}'});
  await expect(performProviderRequest(service('open-responses','https://api.example.test/v1/responses','private-model'),{},'Explain.',schema)).rejects.toMatchObject({code:'PROVIDER_ERROR'});
  globalThis.fetch=async()=>Response.json({choices:[{finish_reason:'length',message:{content:'{"value":"partial"}'}}]});
  await expect(performProviderRequest(service('mistral','https://api.example.test/v1','mistral-small'),{},'Explain.',schema)).rejects.toMatchObject({code:'OUTPUT_LIMIT'});
});

test('Replicate refuses missing polling URLs instead of requesting its base URL or creating again',async()=>{
  const calls=[];globalThis.fetch=async(url,init)=>{calls.push({url:String(url),method:init.method});return Response.json({id:'prediction',status:'starting',urls:{}});};
  await expect(performProviderRequest(service('replicate','https://api.replicate.com/v1','owner/model'),{},'Explain.',schema)).rejects.toMatchObject({code:'INVALID_RESPONSE'});
  expect(calls).toEqual([{url:'https://api.replicate.com/v1/models/owner/model/predictions',method:'POST'}]);
});


test('an incompatible no-thinking request is never retried without its control',async()=>{
  let calls=0,sent;globalThis.fetch=async(_url,init)=>{calls++;sent=JSON.parse(init.body);return new Response('',{status:400});};
  await expect(performProviderRequest(service('openai-compatible','https://custom.example/v1','custom-model'),{},'Explain.',schema)).rejects.toMatchObject({code:'INCOMPATIBLE_REQUEST'});
  expect(calls).toBe(1);expect(sent.reasoning_effort).toBe('none');
});

test('Azure v1 chat uses the common v1 route and keeps the deployment name in model',async()=>{
  let url,sent;globalThis.fetch=async(target,init)=>{url=String(target);sent=JSON.parse(init.body);return Response.json({choices:[{finish_reason:'stop',message:{content:'{"value":"ok"}'}}]});};
  const azure={...service('azure','https://resource.openai.azure.com','my-deployment'),options:{apiMode:'chat',apiVersion:'v1'}};
  await performProviderRequest(azure,{},'Explain.',schema);expect(url).toBe('https://resource.openai.azure.com/openai/v1/chat/completions');expect(sent.model).toBe('my-deployment');
});

test('unknown Chat and Responses targets probe privately before using strict structured output',async()=>{
  for(const [providerId,baseUrl,model] of [
    ['openai-compatible','https://probe-chat.example.test/v1','private-chat-model'],
    ['open-responses','https://probe-responses.example.test/v1/responses','private-responses-model'],
  ]){
    const bodies=[],seen=[];
    rawFetch(async(_url,init)=>{const body=requestBody(init);bodies.push(body);if(capabilityFormat(body))return capabilitySuccess(body);return body.text?.format?Response.json({status:'completed',output_text:'{"value":"ok"}'}):Response.json({choices:[{finish_reason:'stop',message:{content:'{"value":"ok"}'}}]});});
    const result=await performProviderRequest(service(providerId,baseUrl,model),{source:'private business payload'},'Private business instructions.',schema,{onContent:value=>seen.push(value)});
    expect(result).toEqual({value:'ok'});expect(bodies).toHaveLength(2);expect(seen).toEqual([]);
    const [probe,formal]=bodies,format=capabilityFormat(probe),probeSchema=format.schema;
    expect(probeSchema).toMatchObject({type:'object',additionalProperties:false,required:['probe']});
    expect(Object.keys(probeSchema.properties)).toEqual(['probe']);expect(probeSchema.properties.probe.enum).toHaveLength(1);expect(typeof capabilityToken(format)).toBe('string');
    const probePrompt=probe.messages?.[0]?.content??probe.input;expect(probePrompt).not.toContain(capabilityToken(format));expect(probePrompt).not.toContain('"type"');expect(JSON.stringify(probe)).not.toContain('private business');expect(probe.stream).toBeUndefined();
    expect(formal.stream).toBe(true);expect(JSON.stringify(formal)).toContain('private business payload');expect(JSON.stringify(formal)).toContain('Private business instructions.');
    expect(formal.response_format?.json_schema?.schema||formal.text?.format?.schema).toEqual(schema);
    if(providerId==='openai-compatible')expect(formal.reasoning_effort).toBe('none');else expect(formal.reasoning).toEqual({effort:'none'});
  }
});

test('a successful ordinary JSON probe with the wrong shape falls back to json_object',async()=>{
  const bodies=[];rawFetch(async(_url,init)=>{const body=requestBody(init);bodies.push(body);if(capabilityFormat(body))return Response.json({choices:[{finish_reason:'stop',message:{content:'{"probe":"wrong","extra":true}'}}]});return Response.json({choices:[{finish_reason:'stop',message:{content:'{"value":"fallback"}'}}]});});
  expect(await performProviderRequest(service('openai-compatible','https://wrong-probe.example.test/v1','wrong-probe-model'),{},'Explain.',schema)).toEqual({value:'fallback'});
  expect(bodies).toHaveLength(2);expect(bodies[1].response_format).toEqual({type:'json_object'});
});

test('an explicit structured-output rejection falls back once and remembers the decision',async()=>{
  const bodies=[];rawFetch(async(_url,init)=>{const body=requestBody(init);bodies.push(body);if(capabilityFormat(body))return Response.json({error:{type:'invalid_request_error',message:'This response_format type is unavailable now'}},{status:400});return Response.json({choices:[{finish_reason:'stop',message:{content:'{"value":"fallback"}'}}]});});
  const target=service('openai-compatible','https://unsupported-format.example.test/v1','unsupported-format-model');
  expect(await performProviderRequest(target,{},'Explain.',schema)).toEqual({value:'fallback'});
  expect(await performProviderRequest(target,{},'Explain.',schema)).toEqual({value:'fallback'});
  expect(bodies.filter(capabilityFormat)).toHaveLength(1);expect(bodies.filter(body=>body.response_format?.type==='json_object')).toHaveLength(2);
});

test('auth, rate, server, network, and invalid-schema probe failures never trigger downgrade requests',async()=>{
  const failures=[
    ['auth',()=>new Response('',{status:401})],
    ['forbidden',()=>new Response('',{status:403})],
    ['rate',()=>new Response('',{status:429})],
    ['server',()=>new Response('',{status:503})],
    ['invalid-schema',()=>Response.json({error:{type:'invalid_request_error',code:'invalid_schema'}},{status:400})],
    ['network',()=>{throw new TypeError('offline');}],
  ];
  for(const [label,failure] of failures){let calls=0;rawFetch(async()=>{calls++;return failure();});const baseUrl='https://'+label+'.probe-failure.example.test/v1';await expect(performProviderRequest(service('openai-compatible',baseUrl,'failure-'+label),{},'Explain.',schema)).rejects.toBeDefined();expect(calls).toBe(1);}
});

test('capability memory is reused only for the same provider, endpoint, model, credential, and thinking controls',async()=>{
  const bodies=[];rawFetch(async(_url,init)=>{const body=requestBody(init);bodies.push(body);if(capabilityFormat(body))return capabilitySuccess(body);return Response.json({choices:[{finish_reason:'stop',message:{content:'{"value":"ok"}'}}]});});
  const base=service('openai-compatible','https://cache-a.example.test/v1','cache-model-a'),variants=[
    base,base,
    {...base,baseUrl:'https://cache-b.example.test/v1'},
    {...base,model:'cache-model-b'},
    {...base,apiKey:'different-secret'},
    {...base,providerId:'deepseek'},
  ];
  for(const target of variants)expect(await performProviderRequest(target,{},'Explain.',schema)).toEqual({value:'ok'});
  expect(bodies.filter(capabilityFormat)).toHaveLength(5);expect(bodies.filter(body=>!capabilityFormat(body))).toHaveLength(6);
});

test('concurrent callers share a probe while cancellation is isolated until its last subscriber leaves',async()=>{
  let probeCalls=0,formalCalls=0,releaseProbe,sharedSignal;const probeReady=new Promise(resolve=>{releaseProbe=resolve;});
  rawFetch(async(_url,init)=>{const body=requestBody(init);if(capabilityFormat(body)){probeCalls++;sharedSignal=init.signal;return await new Promise((resolve,reject)=>{probeReady.then(()=>resolve(capabilitySuccess(body)));init.signal?.addEventListener('abort',()=>reject(init.signal.reason),{once:true});});}formalCalls++;return Response.json({choices:[{finish_reason:'stop',message:{content:'{"value":"ok"}'}}]});});
  const target=service('openai-compatible','https://shared-probe.example.test/v1','shared-probe-model'),firstController=new AbortController();
  const first=performProviderRequest(target,{},'Explain.',schema,{signal:firstController.signal}),second=performProviderRequest(target,{},'Explain.',schema);
  await new Promise(resolve=>setTimeout(resolve,0));firstController.abort();await expect(first).rejects.toHaveProperty('name','AbortError');expect(sharedSignal.aborted).toBe(false);releaseProbe();expect(await second).toEqual({value:'ok'});expect(probeCalls).toBe(1);expect(formalCalls).toBe(1);

  let loneProbeAborted=false,loneFormal=0;rawFetch(async(_url,init)=>{const body=requestBody(init);if(capabilityFormat(body))return await new Promise((_,reject)=>init.signal.addEventListener('abort',()=>{loneProbeAborted=true;reject(init.signal.reason);},{once:true}));loneFormal++;return Response.json({});});
  const loneController=new AbortController(),lone=performProviderRequest(service('openai-compatible','https://lone-probe.example.test/v1','lone-probe-model'),{},'Explain.',schema,{signal:loneController.signal});
  await new Promise(resolve=>setTimeout(resolve,0));loneController.abort();await expect(lone).rejects.toHaveProperty('name','AbortError');expect(loneProbeAborted).toBe(true);expect(loneFormal).toBe(0);
});

test('invalid_schema after a valid probe is a request failure, not evidence for json_object downgrade',async()=>{
  const bodies=[];rawFetch(async(_url,init)=>{const body=requestBody(init);bodies.push(body);if(capabilityFormat(body))return capabilitySuccess(body);return Response.json({error:{type:'invalid_request_error',code:'invalid_schema'}},{status:400});});
  await expect(performProviderRequest(service('openai-compatible','https://formal-invalid-schema.example.test/v1','formal-invalid-schema-model'),{},'Explain.',schema)).rejects.toBeDefined();
  expect(bodies).toHaveLength(2);expect(bodies[1].response_format?.json_schema?.name).toBe('result');expect(bodies.some(body=>body.response_format?.type==='json_object')).toBe(false);
});

const jevService = (reply, overrides = {}) => ({
  id: 'domain-detection-jev', name: 'Jev 领域识别', providerId: 'requesty',
  baseUrl: 'https://router.requesty.ai/v1', model: 'typesafe/jev-1.13.0', apiKey: 'jev-key', ...overrides,
});

test('the jev protocol posts questions and normalizes choice, score, and probability answers', async () => {
  let body = null;
  globalThis.fetch = async (_url, init) => { body = JSON.parse(init.body); return Response.json({choices: [{finish_reason: 'stop', message: {content: JSON.stringify({domain: {selected: 'tech', confidence: 0.83}, tone: {score: 7.5}, enough: {probability: '0.42'}})}}]}); };
  const questions = {
    domain: {type: 'choice', instructions: 'Pick one domain.', criteria: {tech: 'software and AI', general: 'everything else'}},
    tone: {type: 'score', instructions: 'Rate the tone.'},
    enough: {type: 'noul', instructions: 'Is there enough context?'},
  };
  const result = await performProviderRequest(jevService(), {state: 'Title: T\n\nPassage:\nThe query uses an index.', questions}, undefined, undefined, {});
  expect(body.model).toBe('typesafe/jev-1.13.0');
  expect(body.response_format).toEqual({type: 'questions', questions});
  expect(body.messages).toEqual([{role: 'user', content: 'Title: T\n\nPassage:\nThe query uses an index.'}]);
  expect(result).toEqual({
    answers: {
      domain: {kind: 'choice', selected: 'tech', confidence: 0.83, probabilities: null},
      tone: {kind: 'score', score: 7.5},
      enough: {kind: 'noul', probability: 0.42},
    },
  });
});

test('the jev protocol rejects empty state, malformed questions, and invalid answers', async () => {
  const questions = {domain: {type: 'choice', instructions: 'Pick one.'}};
  globalThis.fetch = async () => Response.json({choices: [{finish_reason: 'stop', message: {content: 'not json'}}]});
  await expect(performProviderRequest(jevService(), {state: '   ', questions}, undefined, undefined, {})).rejects.toMatchObject({code: 'JEV_EMPTY'});
  await expect(performProviderRequest(jevService(), {state: 'text', questions: {}}, undefined, undefined, {})).rejects.toMatchObject({code: 'JEV_QUESTIONS'});
  await expect(performProviderRequest(jevService(), {state: 'text', questions: {a: {type: 'choice', instructions: ' '}}}, undefined, undefined, {})).rejects.toMatchObject({code: 'JEV_QUESTIONS'});
  await expect(performProviderRequest(jevService(), {state: 'text', questions}, undefined, undefined, {})).rejects.toMatchObject({code: 'JEV_FORMAT'});
  globalThis.fetch = async () => Response.json({choices: [{finish_reason: 'stop', message: {content: '{"domain": {"selected": ""}}'}}]});
  await expect(performProviderRequest(jevService(), {state: 'text', questions}, undefined, undefined, {})).rejects.toMatchObject({code: 'JEV_ANSWER'});
  globalThis.fetch = async () => Response.json({choices: [{finish_reason: 'stop', message: {content: '{"domain": {"probability": 1.7}}'}}]});
  await expect(performProviderRequest(jevService(), {state: 'text', questions: {domain: {type: 'noul', instructions: 'x'}}}, undefined, undefined, {})).rejects.toMatchObject({code: 'JEV_ANSWER'});
});

test('StepFun reasoning models request the lowest effort instead of a thinking switch',async()=>{
  const sent=[];globalThis.fetch=async(_url,init)=>{sent.push(requestBody(init));return Response.json({choices:[{finish_reason:'stop',message:{content:'{"value":"ok"}'}}]});};
  await performProviderRequest(service('stepfun','https://api.stepfun.com/v1','step-3.7-flash'),{},'Explain.',schema);
  expect(sent[0].reasoning_effort).toBe('low');expect(sent[0].thinking).toBeUndefined();
  await performProviderRequest(service('stepfun','https://api.stepfun.com/v1','step-1-flash'),{},'Explain.',schema);
  expect(sent.at(-1).reasoning_effort).toBeUndefined();
});

test('always-reasoning chat models skip the strict-schema probe and request json_object directly',async()=>{
  const bodies=[];rawFetch(async(_url,init)=>{const body=requestBody(init);bodies.push(body);return Response.json({choices:[{finish_reason:'stop',message:{content:'{"value":"ok"}'}}]});});
  const result=await performProviderRequest(service('stepfun','https://api.stepfun.com/v1','step-3.5-flash'),{},'Explain.',schema);
  expect(result).toEqual({value:'ok'});expect(bodies.length).toBe(1);expect(bodies[0].response_format).toEqual({type:'json_object'});
});

test('a truncated capability probe falls back to json_object instead of failing',async()=>{
  const bodies=[];rawFetch(async(_url,init)=>{const body=requestBody(init);bodies.push(body);
    if(capabilityFormat(body))return Response.json({choices:[{finish_reason:'length',message:{content:'{"probe'}}]});
    return Response.json({choices:[{finish_reason:'stop',message:{content:'{"value":"ok"}'}}]});});
  const result=await performProviderRequest(service('mistral','https://api.example.test/v1','truncated-probe-model'),{},'Explain.',schema);
  expect(result).toEqual({value:'ok'});expect(bodies[1].response_format).toEqual({type:'json_object'});
});

test('a probe aborted by content filtering still fails the capability check',async()=>{
  rawFetch(async()=>Response.json({choices:[{finish_reason:'content_filter',message:{content:''}}]}));
  await expect(performProviderRequest(service('mistral','https://api.example.test/v1','filtered-probe-model'),{},'Explain.',schema)).rejects.toMatchObject({code:'INVALID_RESPONSE'});
});
