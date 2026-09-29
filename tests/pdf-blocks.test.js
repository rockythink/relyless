import {expect,test} from 'bun:test';
import {pdfLines,pdfBlocks} from '../extension/pdf-blocks.mjs';

const span=(x,y,w,h,text)=>({x,y,w,h,text});

test('items on the same row merge into one line in x order',()=>{
  const lines=pdfLines([
    span(60,100,30,10,'world'),
    span(10,100,40,10,'Hello '),
    span(95,102,20,8,'!'),// 稍高的小字仍属同一行
  ]);
  expect(lines).toHaveLength(1);
  expect(lines[0].text).toBe('Hello world!');
  expect(lines[0].x).toBe(10);
});

test('lines merge into blocks only across small gaps',()=>{
  const blocks=pdfBlocks([
    span(10,100,200,10,'First paragraph line one.'),
    span(10,112,180,10,'First paragraph line two.'),
    span(10,140,190,10,'Second paragraph starts here.'),
  ]);
  expect(blocks).toHaveLength(2);
  expect(blocks[0].text).toBe('First paragraph line one. First paragraph line two.');
  expect(blocks[1].text).toBe('Second paragraph starts here.');
  expect(blocks[0].indices).toEqual([0,1]);
});

test('empty and malformed items are dropped without breaking blocks',()=>{
  expect(pdfBlocks([])).toEqual([]);
  const blocks=pdfBlocks([
    span(10,10,50,10,'valid'),
    {x:10,y:30,w:0,h:10,text:'   '},
    {x:null,y:40,w:10,h:10,text:'bad'},
    span(10,24,60,10,' tail'),
  ]);
  expect(blocks).toHaveLength(1);
  expect(blocks[0].text).toBe('valid tail');
});

test('superscript-sized spans stay on their line and block ids are stable',()=>{
  const blocks=pdfBlocks([
    span(10,100,80,10,'see note'),
    span(92,97,12,6,'[1]'),
    span(10,114,90,10,'next line here'),
  ]);
  expect(blocks[0].lines[0].text).toBe('see note[1]');
  expect(blocks.map(block=>block.id)).toEqual(['p0']);
});

test('heading and body become separate blocks when spacing differs',()=>{
  const blocks=pdfBlocks([
    span(10,40,120,22,'Chapter One'),
    span(10,90,200,10,'Body text begins after the title gap.'),
  ]);
  expect(blocks).toHaveLength(2);
  expect(blocks[0].text).toBe('Chapter One');
});

const twoColumnItems=()=>[
  span(50,100,200,10,'Left column opening line.'),
  span(350,104,200,10,'Right column opening line.'),
  span(50,112,200,10,'Left column continues here.'),
  span(350,116,200,10,'Right column continues here.'),
  span(50,124,180,10,'Left column final line.'),
  span(350,128,190,10,'Right column final line.'),
];

test('two-column pages never merge columns into one block',()=>{
  const blocks=pdfBlocks(twoColumnItems());
  expect(blocks).toHaveLength(2);
  for(const block of blocks){
    expect(/Left/.test(block.text)&&/Right/.test(block.text)).toBe(false);
  }
  // 阅读顺序：左栏整块在前
  expect(blocks[0].text).toBe('Left column opening line. Left column continues here. Left column final line.');
  expect(blocks[1].text).toBe('Right column opening line. Right column continues here. Right column final line.');
});

test('pdfLines keeps columns apart so selection stays per-column',()=>{
  const lines=pdfLines(twoColumnItems());
  expect(lines).toHaveLength(6);
  expect(lines.slice(0,3).every(line=>line.text.startsWith('Left'))).toBe(true);
  expect(lines.slice(3).every(line=>line.text.startsWith('Right'))).toBe(true);
});

// 评审复现：通栏标题把两栏的 x 投影缝堵死，修复前同行左右栏被错误拼接。
test('a full-width title splits the page into bands so columns stay ordered',()=>{
  const blocks=pdfBlocks([
    span(50,20,540,16,'Full Width Title'),
    span(50,60,200,10,'L0'),span(350,60,200,10,'R0'),
    span(50,72,200,10,'L1'),span(350,72,200,10,'R1'),
    span(50,84,200,10,'L2'),span(350,84,200,10,'R2'),
    span(50,96,200,10,'L3'),span(350,96,200,10,'R3'),
  ]);
  expect(blocks.map(block=>block.text)).toEqual(['Full Width Title','L0 L1 L2 L3','R0 R1 R2 R3']);
});

test('a full-width heading followed by one line in each column never combines their translations',()=>{
  const spans=[span(50,20,540,16,'Full Width Title'),span(50,60,200,10,'Left paragraph.'),span(350,60,200,10,'Right paragraph.')];
  expect(pdfBlocks(spans).map(block=>block.text)).toEqual(['Full Width Title','Left paragraph.','Right paragraph.']);
  expect(pdfLines(spans).map(line=>line.text)).toEqual(['Full Width Title','Left paragraph.','Right paragraph.']);
});

// 单栏文档里撑满版心的长行不得被误判为分隔带。
test('a single-column long line is not treated as a band separator',()=>{
  const blocks=pdfBlocks([
    span(50,20,540,10,'A justified line that spans almost the whole text measure.'),
    span(50,32,300,10,'Next line.'),
  ]);
  expect(blocks).toHaveLength(1);
  expect(blocks[0].text).toContain('Next line.');
});

test('a too-narrow side strip is not treated as a column',()=>{
  const lines=pdfLines([
    span(50,100,500,10,'Main line one. '),
    span(600,100,20,10,'¹'),
    span(50,112,500,10,'Main line two. '),
    span(600,112,20,10,'²'),
  ]);
  expect(lines.map(line=>line.text)).toEqual(['Main line one. ¹','Main line two. ²']);
});
