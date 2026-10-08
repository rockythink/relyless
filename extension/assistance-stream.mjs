import {normalizeAssistanceRequest,normalizeAssistanceResult,normalizeEmergencyResult} from './gloss.mjs';
const CONTENT_LIMIT = 24_000;

const HAN = /[\u3400-\u9fff\uf900-\ufaff]/u;
const ENGLISH = /[A-Za-z]/;

const INCOMPLETE = Symbol('incomplete');
const INVALID = Symbol('invalid');

function parsePrefix(text,{partialStrings=false}={}) {
  let at=0;
  const ws=()=>{while(/\s/.test(text[at]||''))at++;};
  const string=(partial=false)=>{
    if(text[at]!=='"')return INVALID;
    const start=at++;let safeEnd=at;
    while(at<text.length){
      const ch=text[at++];
      if(ch==='"'){try{return JSON.parse(text.slice(start,at));}catch{return INVALID;}}
      if(ch==='\\'){
        if(at>=text.length)break;
        if(text[at]==='u'){
          if(at+4>=text.length)break;
          if(!/^[0-9a-fA-F]{4}$/.test(text.slice(at+1,at+5)))return INVALID;
          at+=5;
        }else if('"\\/bfnrt'.includes(text[at]))at++;
        else return INVALID;
      }else if(ch.charCodeAt(0)<0x20)return INVALID;
      safeEnd=at;
    }
    if(!partial)return INCOMPLETE;
    try{let value=JSON.parse(text.slice(start,safeEnd)+'"');const last=value.charCodeAt(value.length-1);if(last>=0xd800&&last<=0xdbff)value=value.slice(0,-1);return{value,complete:false};}catch{return INVALID;}
  };
  const value=(depth,partial=partialStrings)=>{
    ws();if(at>=text.length)return INCOMPLETE;if(depth>8)return INVALID;
    if(text[at]==='"')return string(partial);
    if(text[at]==='{')return object(depth);
    if(text[at]==='[')return array(depth);
    for(const[literal,result]of [['null',null],['true',true],['false',false]]){const remaining=text.slice(at);if(remaining.startsWith(literal)){at+=literal.length;return result;}if(literal.startsWith(remaining))return INCOMPLETE;}
    return INVALID;
  };
  const array=depth=>{
    at++;const result=[];ws();if(text[at]===']'){at++;return{value:result,complete:true};}
    while(true){
      const item=value(depth+1);if(item===INVALID)return INVALID;if(item===INCOMPLETE)return{value:result,complete:false};
      if(item&&typeof item==='object'&&Object.hasOwn(item,'complete')){result.push(item.value);if(!item.complete)return{value:result,complete:false};}else result.push(item);
      ws();if(at>=text.length)return{value:result,complete:false};const separator=text[at++];if(separator===']')return{value:result,complete:true};if(separator!==',')return INVALID;
    }
  };
  const object=depth=>{
    at++;const result=Object.create(null),keys=new Set();ws();if(text[at]==='}'){at++;return{value:result,complete:true};}
    while(true){
      ws();if(at>=text.length)return{value:result,complete:false};const key=string();if(key===INCOMPLETE)return{value:result,complete:false};if(key===INVALID||keys.has(key))return INVALID;keys.add(key);
      ws();if(at>=text.length)return{value:result,complete:false};if(text[at++]!==':')return INVALID;
      const item=value(depth+1,partialStrings&&key!=='id');if(item===INVALID)return INVALID;if(item===INCOMPLETE)return{value:result,complete:false};
      if(item&&typeof item==='object'&&Object.hasOwn(item,'complete')){result[key]=item.value;if(!item.complete)return{value:result,complete:false};}else result[key]=item;
      ws();if(at>=text.length)return{value:result,complete:false};const separator=text[at++];if(separator==='}')return{value:result,complete:true};if(separator!==',')return INVALID;
    }
  };
  ws();if(text[at]!=='{')return INVALID;const root=object(0);if(root===INVALID)return INVALID;if(root.complete){ws();if(at!==text.length)return INVALID;}return root;
}

function validEnglish(value,max,words=Infinity) {
  return typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= max
    && ENGLISH.test(value) && !HAN.test(value) && value.split(/\s+/).length <= words;
}
function validChinese(value,max) {
  return typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= max && HAN.test(value);
}

/** Extract only fully closed, schema-valid leaf strings from an assistance JSON prefix. */
export function assistanceProgress(text,request,{envelope}={}) {
  if (typeof text !== 'string' || text.length > CONTENT_LIMIT) return {};
  let selected;
  try { selected = normalizeAssistanceRequest(request); } catch { return {}; }
  const parsed = parsePrefix(text);
  if (parsed === INVALID) return {};
  let root = parsed.value;

  if (envelope !== undefined && envelope !== 'result') return {};
  if (envelope === 'result') {
    if (Object.keys(root).some(key=>key!=='result') || !Object.hasOwn(root,'result')) return {};
    if (!root.result || typeof root.result !== 'object' || Array.isArray(root.result)) return {};
    if (parsed.complete) {
      try {
        const complete = normalizeAssistanceResult(root.result,selected);
        const field = selected.level === 'hint' ? 'hint' : 'translation';
        if (complete[field] === null) return {};
        if (selected.kind === 'passage' || selected.detail === 'brief') return {definition:complete[field]};
        return {definition:complete[field],meaning:selected.level === 'hint' ? complete.details.meaning.en : complete.details.meaning.zh,sentenceTranslation:complete.details.sentenceTranslation};
      } catch { return {}; }
    }
    root = root.result;
  }

  if (parsed.complete) {
    try {
      const complete = normalizeAssistanceResult(root,selected);
      const field = selected.level === 'hint' ? 'hint' : 'translation';
      if (complete[field] === null) return {};
      if (selected.kind === 'passage' || selected.detail === 'brief') return {definition:complete[field]};
      return {
        definition:complete[field],
        meaning:selected.level === 'hint' ? complete.details.meaning.en : complete.details.meaning.zh,
        sentenceTranslation:complete.details.sentenceTranslation,
      };
    } catch { return {}; }
  }

  const expectedField = selected.level === 'hint' ? 'hint' : 'translation';
  const allowedRoot = selected.kind === 'passage' ? ['level',expectedField] : ['level',expectedField,'sense',...(selected.detail==='full'?['details']:[])];
  if (Object.keys(root).some(key=>!allowedRoot.includes(key)) || root.level !== selected.level) return {};

  const result = {};
  const definition = root[expectedField];
  const definitionValid = selected.level === 'hint'
    ? validEnglish(definition,selected.kind === 'passage' ? 240 : 80,selected.kind === 'passage' ? 30 : 8)
    : validChinese(definition,1200);
  if (definitionValid) result.definition = definition;
  if (selected.kind === 'passage' || selected.detail === 'brief') return result;

  if (root.details !== undefined) {
    if (!root.details || typeof root.details !== 'object' || Array.isArray(root.details)
      || Object.keys(root.details).some(key=>!['meaning','sentenceTranslation'].includes(key))) return {};
    const details = root.details;
    if (details.meaning !== undefined) {
      if (!details.meaning || typeof details.meaning !== 'object' || Array.isArray(details.meaning)
        || Object.keys(details.meaning).some(key=>!['en','zh'].includes(key))) return {};
      const meaning = selected.level === 'hint' ? details.meaning.en : details.meaning.zh;
      if (selected.level === 'hint' ? validEnglish(meaning,600) : validChinese(meaning,400)) result.meaning = meaning;
    }
    if (validChinese(details.sentenceTranslation,2000)) result.sentenceTranslation = details.sentenceTranslation;
  }
  return result;
}

/** 追问回答只有一个自由文本字段：只透传已闭合或部分合法的 answer 字符串。 */
export function conversationProgress(text) {
  if (typeof text !== 'string' || text.length > CONTENT_LIMIT) return {};
  const parsed = parsePrefix(text,{partialStrings:true});
  if (parsed === INVALID) return {};
  const root = parsed.value;
  if (Object.keys(root).some(key=>key!=='answer')) return {};
  const answer = root.answer;
  if (typeof answer !== 'string' || !answer.trim() || answer.length > 1200) return {};
  return {answer};
}

/** Only source-bound text snapshots cross the native/page boundary, never raw JSON. */
export function normalizeTranslationProgress(value,items){
  if(!Array.isArray(items)||!items.length||items.length>4||!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||!Array.isArray(value.items)||value.items.length>items.length)return null;
  const seen=new Set(),result=[];
  for(const item of value.items){
    if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).length!==2||typeof item.id!=='string'||!items.some(source=>source.id===item.id)||seen.has(item.id)||typeof item.translation!=='string'||!item.translation.trim()||item.translation.length>8000||!item.translation.isWellFormed())return null;
    seen.add(item.id);result.push({id:item.id,translation:item.translation});
  }
  return result.length?{items:result}:null;
}

/** Decode a translation string while it is still being generated, retaining schema boundaries. */
export function translationProgress(text,items){
  if(typeof text!=='string'||text.length>CONTENT_LIMIT)return null;
  const parsed=parsePrefix(text,{partialStrings:true});if(parsed===INVALID)return null;
  const root=parsed.value;if(Object.keys(root).some(key=>key!=='items')||!Array.isArray(root.items)||!Array.isArray(items)||root.items.length>items.length)return null;
  if(parsed.complete){try{return normalizeTranslationProgress(normalizeEmergencyResult(root,items.map(({id,text})=>({id,text}))),items);}catch{return null;}}
  const progress=[],seen=new Set();
  for(const item of root.items){
    if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).some(key=>!['id','translation'].includes(key)))return null;
    if(item.id===undefined)continue;
    if(typeof item.id!=='string'||!items.some(source=>source.id===item.id)||seen.has(item.id))return null;seen.add(item.id);
    if(item.translation===undefined||item.translation==='')continue;
    progress.push({id:item.id,translation:item.translation});
  }
  return normalizeTranslationProgress({items:progress},items);
}
