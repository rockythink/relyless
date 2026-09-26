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
