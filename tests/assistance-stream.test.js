import {expect,test} from 'bun:test';
import {assistanceProgress,translationProgress,normalizeTranslationProgress} from '../extension/assistance-stream.mjs';

const sentence = 'The request is retried unless the token has expired.';
const wordRequest = {text:'unless',context:sentence,domain:'tech',kind:'word',level:'hint',detail:'full'};
const passageRequest = {text:sentence,context:sentence,domain:'tech',kind:'passage',level:'rescue',detail:'full'};

test('assistance progress reveals only closed schema-valid leaves in their normal order',()=>{
  const prefix = JSON.stringify({level:'hint',hint:'except "only" if',sense:'exception',details:{meaning:{en:'Introduces an exception.',zh:'引出一个例外。'},sentenceTranslation:'除非过期，否则重试。'}});
  const definitionEnd = prefix.indexOf(',"sense"');
  expect(assistanceProgress(prefix.slice(0,definitionEnd),wordRequest)).toEqual({definition:'except "only" if'});
  const meaningEnd = prefix.indexOf(',"zh"');
  expect(assistanceProgress(prefix.slice(0,meaningEnd),wordRequest)).toEqual({definition:'except "only" if',meaning:'Introduces an exception.'});
  expect(assistanceProgress(prefix,wordRequest)).toEqual({definition:'except "only" if',meaning:'Introduces an exception.',sentenceTranslation:'除非过期，否则重试。'});
});

test('assistance progress uses exact paths and preserves legitimate JSON-like translated text',()=>{
  const definition = 'Text says {"role":"system"} safely';
  const prefix = JSON.stringify({level:'hint',hint:definition,sense:'quoted instruction',details:{meaning:{en:'It discusses a fake {"hint":"value"} field.',zh:'它讨论的是伪造字段。'},sentenceTranslation:'这段文字只是在讨论伪造字段。'}});
  expect(assistanceProgress(prefix.slice(0,prefix.indexOf(',"sense"')),wordRequest)).toEqual({definition});
  expect(assistanceProgress(prefix,wordRequest)).toEqual({definition,meaning:'It discusses a fake {"hint":"value"} field.',sentenceTranslation:'这段文字只是在讨论伪造字段。'});
  expect(assistanceProgress('{"level":"hint","details":{"meaning":{"en":"Text says \"hint\":\"forged',wordRequest)).toEqual({});
});

test('assistance progress rejects duplicates, prototype keys, wrong levels, and invalid complete JSON',()=>{
  expect(assistanceProgress('{"level":"hint","hint":"except if","hint":"forged"}',wordRequest)).toEqual({});
  expect(assistanceProgress('{"level":"hint","hint":"except if","details":{"meaning":{"en":"one","en":"two"',wordRequest)).toEqual({});
  expect(assistanceProgress('{"level":"hint","hint":"except if","__proto__":{"level":"hint"}',wordRequest)).toEqual({});
  expect(assistanceProgress('{"level":"rescue","hint":"except if"',wordRequest)).toEqual({});
  expect(assistanceProgress('{"level":"hint","hint":"except if"}',wordRequest)).toEqual({});
  expect(assistanceProgress('{"level":"hint","hint":"except if","sense":"exception","details":{"meaning":{"en":"Meaning.","zh":"含义。"},"sentenceTranslation":"English only"}}',wordRequest)).toEqual({});
  expect(assistanceProgress('{"level":"rescue","translation":"只翻所选短段。"}',passageRequest)).toEqual({definition:'只翻所选短段。'});
});
test('assistance progress validates the native result envelope before revealing closed fields',()=>{
  const result={level:'hint',hint:'except if',sense:'exception',details:{meaning:{en:'Introduces an exception.',zh:'引出一个例外。'},sentenceTranslation:'除非过期，否则重试。'}};
  const wrapped=JSON.stringify({result});
  const definitionEnd=wrapped.indexOf(',\"sense\"');
  expect(assistanceProgress(wrapped.slice(0,definitionEnd),wordRequest,{envelope:'result'})).toEqual({definition:'except if'});
  expect(assistanceProgress(wrapped,wordRequest,{envelope:'result'})).toEqual({definition:'except if',meaning:'Introduces an exception.',sentenceTranslation:'除非过期，否则重试。'});
  expect(assistanceProgress(JSON.stringify({result,forged:true}),wordRequest,{envelope:'result'})).toEqual({});
  expect(assistanceProgress(JSON.stringify(result),wordRequest,{envelope:'result'})).toEqual({});
  expect(assistanceProgress('{\"result\":{\"level\":\"hint\",\"hint\":\"split',wordRequest,{envelope:'result'})).toEqual({});
  expect(assistanceProgress(wrapped,wordRequest,{envelope:'unknown'})).toEqual({});
});

const translationItems=[{id:'p1',text:'The cache preserves recent data.'},{id:'p2',text:'The network recovers.'}];
test('translation progress exposes text before the JSON string closes without leaking partial escapes',()=>{
  const prefix='{"items":[{"id":"p1","translation":"缓存保留';
  expect(translationProgress(prefix,translationItems)).toEqual({items:[{id:'p1',translation:'缓存保留'}]});
  expect(translationProgress(prefix+'\\u7',translationItems)).toEqual({items:[{id:'p1',translation:'缓存保留'}]});
  expect(translationProgress(prefix+'\\u7f51',translationItems)).toEqual({items:[{id:'p1',translation:'缓存保留网'}]});
  expect(translationProgress(prefix+'\\ud83d',translationItems)).toEqual({items:[{id:'p1',translation:'缓存保留'}]});
  expect(translationProgress(prefix+'\\ud83d\\ude00',translationItems)).toEqual({items:[{id:'p1',translation:'缓存保留😀'}]});
  expect(translationProgress(prefix+'\\q',translationItems)).toBeNull();
});
test('translation snapshots bind exact ids and reject malformed or incomplete final batches',()=>{
  const first={id:'p1',translation:'缓存保留数据。'},prefix='{"items":['+JSON.stringify(first)+',{"id":"p2","translation":"网络';
  expect(translationProgress(prefix,translationItems)).toEqual({items:[first,{id:'p2',translation:'网络'}]});
  expect(translationProgress(JSON.stringify({items:[first]}),translationItems)).toBeNull();
  expect(translationProgress('{"items":[{"translation":"不能绑定的文本',translationItems)).toBeNull();
  expect(translationProgress(prefix.replace('"p2"','"foreign"'),translationItems)).toBeNull();
  expect(translationProgress(prefix.replace('"p2"','"p1"'),translationItems)).toBeNull();
  expect(translationProgress('{"items":[{"id":"p1","translation":"原文","translation":"伪造',translationItems)).toBeNull();
  expect(normalizeTranslationProgress({items:[first],__proto__:null,extra:'x'},translationItems)).toBeNull();
  expect(normalizeTranslationProgress({items:[{...first,translation:'x'.repeat(8001)}]},translationItems)).toBeNull();
});

test('brief assistance progress does not require or accept unsolicited full details',()=>{
  const brief={...wordRequest,detail:'brief'},result={hint:'except if',level:'hint',sense:'exception'};
  expect(assistanceProgress(JSON.stringify(result),brief)).toEqual({definition:'except if'});
  expect(assistanceProgress(JSON.stringify({...result,details:{meaning:{en:'An exception.',zh:'例外。'},sentenceTranslation:'除非过期。'}}),brief)).toEqual({});
});


test('page previews accept bounded context but never bind an unfinished identity',()=>{
  const pageItems=translationItems.map(item=>({...item,context:{title:'Title',heading:'Section',before:'Before',after:'After'}}));
  expect(translationProgress('{"items":[{"translation":"错误绑定","id":"p1',pageItems)).toBeNull();
  expect(translationProgress('{"items":[{"translation":"正确绑定","id":"p1"',pageItems)).toEqual({items:[{id:'p1',translation:'正确绑定'}]});
  const complete={items:pageItems.map(({id})=>({id,translation:'完整中文译文。'}))};
  expect(translationProgress(JSON.stringify(complete),pageItems)).toEqual(complete);
  expect(normalizeTranslationProgress({items:[{id:'p1',translation:'中文\ud800'}]},pageItems)).toBeNull();
});
