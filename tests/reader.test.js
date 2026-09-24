import {expect,test,afterAll} from 'bun:test';
import {Window} from 'happy-dom';
import {readFileSync} from 'node:fs';

const originals = new Map();
const keys = ['window','document','location','Node','NodeFilter','HTMLElement','MutationObserver','getComputedStyle','ShisuiContent','ShisuiReader','ShisuiDesign'];
for (const key of keys) originals.set(key,globalThis[key]);
afterAll(() => { for (const [key,value] of originals) {if (value === undefined) delete globalThis[key];else globalThis[key]=value;} });
const source = name => readFileSync(new URL('../extension/'+name,import.meta.url),'utf8');
function page(html) {
  const window=new Window({url:'https://example.test/article'});
  Object.assign(globalThis,{window,document:window.document,location:window.location,Node:window.Node,NodeFilter:window.NodeFilter,HTMLElement:window.HTMLElement,MutationObserver:window.MutationObserver});
  window.Element.prototype.getClientRects=function(){return this.hidden||this.closest('[hidden]')?[]:[{width:100,height:20}];};
  const computed=window.getComputedStyle.bind(window);
  globalThis.getComputedStyle=element=>({...computed(element),opacity:element.style.opacity||'1',display:element.hidden?'none':element.style.display||'block',visibility:element.style.visibility||'visible',contentVisibility:'visible',clip:'auto',clipPath:'none',overflow:'visible'});
  delete globalThis.ShisuiContent;delete globalThis.ShisuiReader;
  globalThis.ShisuiDesign={cssFor:()=>''};
  new Function(source('content/kernel.js'))();new Function(source('content/reader.js'))();
  document.body.innerHTML=html;
  return {window,reader:globalThis.ShisuiReader};
}
const long=seed=>seed.repeat(30);

test('English and Chinese articles preserve ordered prose and nested content without duplicate parent text',()=>{
  for(const sentence of ['The original article remains readable. ','这是中文正文，包含连续的叙述。']) {
    const html='<nav>'+long('Navigation content. ')+'</nav><article><h1>Article title</h1><p>'+long(sentence)+'</p><ul><li>First point <strong>with emphasis</strong></li><li>Second point</li></ul><p>'+long(sentence)+'</p><pre>const x = 1;</pre><table><tr><td>One cell</td></tr></table><p id="footnote">Footnote text</p></article>';
    const {reader}=page(html),{article,sourceRoot,sourceMap}=reader.extract();
    expect(sourceRoot.localName).toBe('article');
    expect(article.textContent.includes('Navigation content')).toBe(false);
    expect(article.textContent.match(new RegExp(sentence.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'g'))?.length).toBe(60);
    expect(article.querySelectorAll('pre,table,li')).toHaveLength(4);
    expect(sourceMap.get(article.querySelector('strong')).textContent).toBe('with emphasis');
  }
});

test('ambiguous articles, short controls and excessive source nodes refuse without a partial article',()=>{
  let ctx=page('<article><p>'+long('Article one paragraph. ')+'</p><p>'+long('Another paragraph. ')+'</p></article><article><p>'+long('Article two paragraph. ')+'</p><p>'+long('Another paragraph. ')+'</p></article>');
  expect(()=>ctx.reader.extract()).toThrow('无法可靠识别');
  ctx=page('<main><button>Open</button><p>Short text.</p></main>');expect(()=>ctx.reader.extract()).toThrow('无法可靠识别');
  ctx=page('<article><p>'+long('Long first paragraph. ')+'</p><p>'+long('Long second paragraph. ')+'</p></article>');
  document.querySelector('article').insertAdjacentHTML('beforeend','<span></span>'.repeat(50001));
  expect(()=>ctx.reader.extract()).toThrow('正文过长');
});

test('controlled DOM strips active attributes, hidden regions and injected help while preserving safe footnotes',()=>{
  const {reader}=page('<article><p>'+long('Original visible prose. ')+'</p><p>'+long('Another visible paragraph. ')+'</p><p><span data-shisui-ui="annotation"><span data-shisui-ui="term">original</span><span data-shisui-ui="hint">unwanted hint</span></span></p><aside>unwanted aside</aside><p hidden>unwanted hidden</p><a href="javascript:alert(1)" onclick="alert(1)">unsafe text</a><a href="#foot">footnote</a><p id="foot">Note</p><iframe srcdoc="bad"></iframe><x-custom onerror="bad">safe child</x-custom><svg onload="bad"></svg><img src="/unloaded.jpg" alt="Figure"></article>');
  const {article}=reader.extract();
  expect(article.querySelector('script,iframe,style,svg,x-custom,[onclick],[onerror],[srcdoc],a[href^="javascript"]')).toBeNull();
  expect(article.textContent).toContain('original');expect(article.textContent).not.toContain('unwanted');
  expect(article.textContent).toContain('safe child');expect(article.textContent).toContain('图片请在原网页查看');
  expect(article.querySelector('a[href^="#shisui-reader-anchor-"]')).not.toBeNull();
  expect(article.querySelector('p[id^="shisui-reader-anchor-"]')).not.toBeNull();
});
test('a footnote excluded from the snapshot links back to the original page',()=>{
  const {reader}=page('<article><p>'+long('A visible English paragraph. ')+'</p><p>'+long('A second visible paragraph. ')+'</p><a href="#hidden-note">See note</a><aside id="hidden-note">Outside reader</aside></article>');
  const {article}=reader.extract();
  expect(article.querySelector('a').href).toBe('https://example.test/article#hidden-note');
  expect(article.querySelector('[id^="shisui-reader-anchor-"]')).toBeNull();
});
test('page-controlled metadata cannot produce unbounded attributes or links',()=>{
  const {reader}=page('<article><p>'+long('Original prose remains visible. ')+'</p><p>'+long('Second paragraph remains visible. ')+'</p><a id="note" href="https://example.test/ok" title="safe">ordinary link</a><a id="oversized" href="/ok">oversized link</a><img alt="figure"><svg aria-label="diagram"></svg></article>');
  const source=document.querySelector('article'),huge='x'.repeat(5000);
  source.querySelector('#oversized').setAttribute('href',huge);source.querySelector('#note').title=huge;source.querySelector('img').alt=huge;source.querySelector('svg').setAttribute('aria-label',huge);
  const {article}=reader.extract();
  expect(article.querySelector('[title]').title.length).toBe(300);
  expect(article.querySelectorAll('a[href]')).toHaveLength(2);
  expect(article.querySelector('[id^="shisui-reader-anchor-"]')).not.toBeNull();
  expect(article.textContent.length).toBeLessThan(3000);
});

test('mount is idempotent and returns source input and inert state after exit or failed popover',()=>{
  const {window,reader}=page('<input id="draft"><article><p>'+long('The original paragraph continues. ')+'</p><p>'+long('Another original paragraph continues. ')+'</p></article>');
  const input=document.querySelector('#draft');input.value='unsaved';input.focus();
  const sourceRoot=document.querySelector('article'),oldShow=window.HTMLElement.prototype.showPopover;
  window.HTMLElement.prototype.showPopover=function() {this.dataset.shown='yes';};
  try {
    const extraction=reader.extract();const host=reader.mount({...extraction});
    expect(reader.mount({...extraction})).toBe(host);
    expect(reader.active()).toBe(true);
    expect(input.inert).toBe(true);
    reader.unmount();reader.unmount();
    expect(reader.active()).toBe(false);
    expect(input.inert).toBe(false);
    expect(input.value).toBe('unsaved');expect(document.querySelector('article')).toBe(sourceRoot);
    window.HTMLElement.prototype.showPopover=function(){throw new Error('popover failed');};
    expect(()=>reader.mount({...reader.extract()})).toThrow('popover failed');
    expect(reader.active()).toBe(false);expect(document.querySelector('[data-shisui-ui="reader"]')).toBeNull();
    expect(input.inert).toBe(false);
  } finally {window.HTMLElement.prototype.showPopover=oldShow;}
});
test('Escape in the reader status panel dismisses the panel first',()=>{
  const {window,reader}=page('<article><p>'+long('Readable original prose. ')+'</p><p>'+long('Another original paragraph. ')+'</p></article>');
  const oldShow=window.HTMLElement.prototype.showPopover;window.HTMLElement.prototype.showPopover=function(){};
  let exits=0,handled=0;
  try{
    reader.mount({...reader.extract(),onEscape:()=>exits++});
    const status=document.createElement('div');status.setAttribute('data-shisui-ui','task-status');
    const button=document.createElement('button');status.append(button);reader.overlayRoot().append(status);
    button.addEventListener('keydown',()=>handled++);
    button.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,composed:true}));
    expect(handled).toBe(1);expect(exits).toBe(0);
  }finally{reader.unmount();window.HTMLElement.prototype.showPopover=oldShow;}
});
