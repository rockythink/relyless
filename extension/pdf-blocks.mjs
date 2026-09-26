// PDF 文本层的几何分块：输入已定位的文本片段（视口坐标），输出行与段落块。
// 只依赖矩形与文字，不依赖 pdf.js 内部结构，可直接被 Bun 测试覆盖。

// items: [{x,y,w,h,text}]（x/y 为左上视口坐标，y 向下增大；h>0）。
// 返回 [{x,y,w,h,text,parts:[item,...]}]，行内片段已按 x 排序并拼接。
export function pdfLines(items, {overlap = 0.5} = {}) {
  const sorted = (items || [])
    .filter(item => item && typeof item.text === 'string' && item.text.trim()
      && Number.isFinite(item.x) && Number.isFinite(item.y)
      && Number.isFinite(item.w) && item.w >= 0 && Number.isFinite(item.h) && item.h > 0)
    .map((item, index) => ({...item, index}))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const item of sorted) {
    const line = lines[lines.length - 1];
    // 同一行：垂直重叠足够（同一基线上的上下标/字体差异不会断行）
    const covered = line
      ? Math.min(item.y + item.h, line.y + line.h) - Math.max(item.y, line.y)
      : 0;
    if (line && covered >= Math.min(item.h, line.h) * overlap) {
      line.parts.push(item);
      const right = Math.max(line.x + line.w, item.x + item.w);
      line.x = Math.min(line.x, item.x);
      line.w = right - line.x;
      line.h = Math.max(line.h, item.y + item.h - line.y);
    } else {
      lines.push({x: item.x, y: item.y, w: item.w, h: item.h, parts: [item]});
    }
  }
  for (const line of lines) {
    line.parts.sort((a, b) => a.x - b.x);
    line.text = line.parts.map(part => part.text).join('');
    if (!line.text.trim()) line.text = line.text.trim();
  }
  return lines.filter(line => line.text.trim());
}

// lines 输入为 pdfLines 的输出；相邻行垂直间距大于行高阈值即分段。
// 返回 [{x,y,w,h,text,lines:[...],indices:[item.index,...]}]，
// text 为行文本以单个空格拼接后的整块正文。
export function pdfBlocks(items, {gapRatio = 0.9, overlap = 0.5} = {}) {
  const lines = pdfLines(items, {overlap});
  if (!lines.length) return [];
  const heights = lines.map(line => line.h).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)] || 1;
  const blocks = [];
  for (const line of lines) {
    const block = blocks[blocks.length - 1];
    const gap = block ? line.y - (block.y + block.h) : Infinity;
    if (block && gap <= median * gapRatio) {
      block.lines.push(line);
      const right = Math.max(block.x + block.w, line.x + line.w);
      block.x = Math.min(block.x, line.x);
      block.w = right - block.x;
      block.h = line.y + line.h - block.y;
    } else {
      blocks.push({x: line.x, y: line.y, w: line.w, h: line.h, lines: [line]});
    }
  }
  return blocks.map((block, order) => ({
    ...block,
    id: 'p' + order,
    text: block.lines.map(line => line.text).join(' ').replace(/\s+/g, ' ').trim(),
    indices: block.lines.flatMap(line => line.parts.map(part => part.index)),
  })).filter(block => block.text);
}
