import {test,expect} from 'bun:test';
import {prepareSupportItems} from '../extension/gloss.mjs';
const unlessDetails = {meaning:{en:'Introduces the condition that prevents the retry.',zh:'引出阻止重试的条件。'},sentenceTranslation:'除非请求失败，否则会重试。'};
test('subscription validates rich support, assistance, emergency, and sentence hierarchy responses',async()=>{
  const meaning = {en:'Introduces the expiration condition that prevents a retry.',zh:'引出阻止重试的过期条件。'};
  const sentenceTranslation = '除非已过期，否则重试。';
  let response = {items:[{id:'one',target:{text:'unless',start:10,end:16,hint:'except if',translation:'除非',sense:'except if'},meaning,sentenceTranslation}],invalid:[]};
  let onMessage; let lastMessage;
  const fakePort = {onDisconnect:{addListener:()=>{}},onMessage:{addListener:listener=>{ onMessage=listener; }},postMessage:message=>{lastMessage=message;queueMicrotask(()=>{if(message.type==='emergencyTranslate'){onMessage({event:'assistProgress',id:message.id,data:{items:[{id:'block',translation:'错误通道'}]}});onMessage({event:'translationProgress',id:message.id,data:{items:[{id:'block',translation:'紧急译'}]}});onMessage({event:'translationProgress',id:message.id,data:{items:[{id:'forged',translation:'伪造'}]}});queueMicrotask(()=>onMessage({id:message.id,ok:true,data:response}));return;}onMessage({id:message.id,ok:true,data:response});});},disconnect:()=>{}};
  globalThis.chrome = {runtime:{connectNative:()=>fakePort,lastError:null}};
  try {
    const {supportSubscription,assistSubscription,emergencyTranslateSubscription,sentenceGroupsSubscription} = await import(`../extension/subscription.js?provider-validation=${Date.now()}`);
    const items = prepareSupportItems([{id:'one',sentence:'Retry it unless expired.',domain:'tech',candidates:[{text:'unless'}]}]);
    await expect(supportSubscription(items,'quick')).rejects.toThrow('无效目标');
    response = {items:[{id:'one',target:{text:'unless',start:9,end:15,hint:'except if',translation:'除非',sense:'except if'},meaning,sentenceTranslation}],invalid:[]};
    expect(await supportSubscription(items,'quick')).toEqual(response);
    expect(lastMessage.payload.article).toEqual({key:'',text:'',coverage:'excerpt'});
    response = {level:'hint',hint:'except if',sense:'except if',details:unlessDetails};
    expect(await assistSubscription({text: 'unless', context: items[0].sentence, domain: 'tech', kind: 'word', level: 'hint', detail: 'full'},'quick')).toEqual(response);
    response = {level:'hint',hint:null};
    expect(await assistSubscription({text: 'unless', context: items[0].sentence, domain: 'tech', kind: 'word', level: 'hint', detail: 'full'},'quick')).toEqual(response);
    response = {level:'hint',hint:'except if',sense:'except if',details:unlessDetails,revision:1};
    await expect(assistSubscription({text: 'unless', context: items[0].sentence, domain: 'tech', kind: 'word', level: 'hint', detail: 'full'},'quick')).rejects.toThrow('格式');
    response = {items:[{id:'block',translation:'紧急翻译。'}]};
    const translationProgress=[];
    expect(await emergencyTranslateSubscription({scope:'passage',items:[{id:'block',text:'Emergency translation.'}],model:'quick',onProgress:value=>translationProgress.push(value)})).toEqual(response);
    expect(translationProgress).toEqual([{items:[{id:'block',translation:'紧急译'}]}]);
    expect(lastMessage.type).toBe('emergencyTranslate');
    expect(lastMessage.payload.scope).toBe('passage');
    response={items:[{id:'page',translation:'页面译文。'}],errors:[]};
    const pageProgress=[];
    const pageContext={title:'Title',heading:'Heading',before:'Before',after:'After'};
    expect(await emergencyTranslateSubscription({scope:'page',items:[{id:'page',text:'Page text.',context:pageContext}],model:'quick',onProgress:value=>pageProgress.push(value)})).toEqual(response);
    expect(lastMessage.payload.scope).toBe('page');
    expect(pageProgress).toEqual([]);
    response={items:[{id:'sentence',groups:[
      {role:'adverbial',first:1,last:3},{role:'object',first:3,last:4},
      {role:'subject',first:1,last:1},{role:'subject',first:1,last:1},
      {role:'object',first:2,last:2},{role:'complement',first:2,last:2},
      {role:'predicate',first:3,last:3},{role:'object',first:4,last:4},{role:'subject',first:0,last:1}
    ]}]};
    expect(await sentenceGroupsSubscription([{id:'sentence',sentence:'Teams carefully ship products.'}],'quick')).toEqual({items:[{id:'sentence',groups:[
      {start:0,end:30,role:'clause',parent:-1},
      {start:0,end:5,role:'subject',parent:0},
      {start:16,end:20,role:'predicate',parent:0},
      {start:21,end:29,role:'object',parent:0}
    ]}]});

  } finally { delete globalThis.chrome; }
});

test('subscription refresh replaces an obsolete host, coalesces refreshes, and isolates late messages',async()=>{
  const previousChrome = globalThis.chrome;
  const ports = [];
  const account = {connected:true,authenticated:true,email:'fixture@example.test',plan:'plus'};
  const answer = {level:'hint',hint:'except if this happens',sense:'condition exception',details:unlessDetails};
  globalThis.chrome = {runtime:{lastError:null,connectNative:()=>{
    const generation = ports.length;
    let onMessage, onDisconnect;
    const connection = {
      onMessage:{addListener:listener=>{onMessage=listener;}},
      onDisconnect:{addListener:listener=>{onDisconnect=listener;}},
      postMessage(message){
        if(message.type==='classify')return;
        queueMicrotask(()=>onMessage(message.type==='status'
          ? {id:message.id,ok:true,data:account}
          : generation===0
            ? {id:message.id,ok:false,error:'不支持的连接器请求，请更新本地连接器。'}
            : {id:message.id,ok:true,data:answer}));
      },
      disconnect(){queueMicrotask(()=>onDisconnect());},
      stale(){onMessage({event:'status',data:{connected:false,error:'stale host'}});onDisconnect();},
    };
    ports.push(connection);return connection;
  }}};
  try {
    const subscription = await import('../extension/subscription.js?refresh-lifecycle='+Date.now());
    await subscription.ensureSubscription();
    const request = {text: 'unless', context: 'Retry unless it fails.', domain: 'tech', kind: 'word', level: 'hint', detail: 'full'};
    await expect(subscription.assistSubscription(request)).rejects.toThrow();
    let pendingError;
    const pending = subscription.classifySubscription('pending context','', '').catch(error=>{pendingError=error;});
    const refreshed = await Promise.all([subscription.refreshSubscription(),subscription.refreshSubscription()]);
    expect(refreshed.every(value=>value.connected&&value.authenticated&&!value.error)).toBe(true);
    expect(await subscription.assistSubscription(request)).toEqual(answer);
    await pending;
    expect(pendingError).toBeInstanceOf(Error);
    expect(ports.length).toBe(2);
    ports[0].stale();
    expect(subscription.subscriptionStatus().authenticated).toBe(true);
    expect(await subscription.assistSubscription(request)).toEqual(answer);
  } finally { if(previousChrome===undefined)delete globalThis.chrome;else globalThis.chrome=previousChrome; }
});
