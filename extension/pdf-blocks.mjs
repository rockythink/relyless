// PDF 文本层的几何分块：输入已定位的文本片段（视口坐标），输出行与段落块。
// 只依赖矩形与文字，不依赖 pdf.js 内部结构，可直接被 Bun 测试覆盖。

// 过滤无效片段并保留其在原始数组中的下标（index 供调用方回指 DOM）。
function normItems(items) {
  return (items || [])
    .map((item, index) => ({index, ...item}))
    .filter(item => item && typeof item.text === 'string' && item.text.trim()
      && Number.isFinite(item.x) && Number.isFinite(item.y)
      && Number.isFinite(item.w) && item.w >= 0 && Number.isFinite(item.h) && item.h > 0);
}

// 在 x 投影中寻找左右有实质宽度的净空缝；稀疏页左右各一行时也不能把两栏混译。
// 对少于四片段的区域要求更宽缝隙，宁可拆开而不把远距离文本串成一行。
function columnCut(items) {
  if (items.length < 2) return null;
  const byX = [...items].sort((a, b) => a.x - b.x || a.y - b.y);
  const heights = items.map(item => item.h).sort((a, b) => a - b);
  const minGap = Math.max(items.length<4?40:12, heights[Math.floor(heights.length / 2)] * (items.length<4?3:1.5));
  const n = byX.length;
  const rightEdge = new Array(n);
  let run = 0;
  for (let i = n - 1; i >= 0; i--) {
    run = Math.max(run, byX[i].x + byX[i].w);
    rightEdge[i] = run;
  }
  const left = byX[0].x, totalW = rightEdge[0] - left || 1;
  let edge = byX[0].x + byX[0].w, cut = -1, widest = minGap;
  for (let i = 1; i < n; i++) {
    const gap = byX[i].x - edge;
    if (gap > widest && i >= (n<4?1:2) && n - i >= (n<4?1:2) && edge - left > totalW * 0.1 && rightEdge[i] - byX[i].x > totalW * 0.1) {
      widest = gap;
      cut = i;
    }
    edge = Math.max(edge, byX[i].x + byX[i].w);
  }
  if (cut < 0) return null;
  return {byX, cut, gap: widest};
}

// 全宽元素（通栏标题/分隔条）会把左右栏的 x 投影缝堵死，使 columnCut 失效、
// 两栏被同行合并。先按全宽元素把版面切成水平条带，再在条带内做竖切。
// 判定按宽度占版心比例（≥60%），不要求贴齐两边——居中标题同样生效。
// 仅当移除全宽元素后确实能分出多栏才启用，避免单栏文档里偶然的长行被当作分隔。
function splitBands(items) {
  const minX = Math.min(...items.map(item => item.x));
  const maxX = Math.max(...items.map(item => item.x + item.w));
  const totalW = maxX - minX || 1;
  const isWide = item => item.w >= totalW * 0.6;
  if (!items.some(isWide)) return [items];
  const rest = items.filter(item => !isWide(item));
  if (rest.length < 2 || splitColumns(rest).length < 2) return [items];
  const bands = [];
  let band = [];
  for (const item of [...items].sort((a, b) => a.y - b.y || a.x - b.x)) {
    if (isWide(item)) {
      if (band.length) bands.push(band);
      bands.push([item]);
      band = [];
    } else band.push(item);
  }
  if (band.length) bands.push(band);
  return bands;
}

// XY 切分的竖切阶段：最多两轮（≤3 栏），每轮在所有区域中取最大净空缝。
function splitColumns(items) {
  let regions = [items];
  for (let round = 0; round < 2; round++) {
    let pick = null;
    for (const region of regions) {
      const cut = columnCut(region);
      if (cut && (!pick || cut.gap > pick.gap)) pick = {region, cut};
    }
    if (!pick) break;
    regions = regions.flatMap(region => region === pick.region
      ? [pick.cut.byX.slice(0, pick.cut.cut), pick.cut.byX.slice(pick.cut.cut)]
      : [region]);
  }
  return regions;
}

// 单个栏区域内按（y,x) 排序逐行合并；行内片段按 x 排序拼接。
function linesIn(column, overlap) {
  column.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  let line = null;
  for (const item of column) {
    // 同一行：垂直重叠足够（同一基线上的上下标/字体差异不会断行）
    const covered = line ? Math.min(item.y + item.h, line.y + line.h) - Math.max(item.y, line.y) : 0;
    if (line && covered >= Math.min(item.h, line.h) * overlap) {
      line.parts.push(item);
      const right = Math.max(line.x + line.w, item.x + item.w);
      line.x = Math.min(line.x, item.x);
      line.w = right - line.x;
      line.h = Math.max(line.h, item.y + item.h - line.y);
    } else {
      line = {x: item.x, y: item.y, w: item.w, h: item.h, parts: [item]};
      lines.push(line);
    }
  }
  for (const line of lines) {
    line.parts.sort((a, b) => a.x - b.x);
    line.text = line.parts.map(part => part.text).join('');
    if (!line.text.trim()) line.text = line.text.trim();
  }
  return lines.filter(line => line.text.trim());
}

// items: [{x,y,w,h,text}]（x/y 为左上视口坐标，y 向下增大；h>0）。
// 返回 [{x,y,w,h,text,parts:[item,...]}]，多栏页面按栏序（先左栏自上而下）拼接。
export function pdfLines(items, {overlap = 0.5} = {}) {
  const lines = [];
  for (const band of splitBands(normItems(items)))
    for (const column of splitColumns(band)) lines.push(...linesIn(column, overlap));
  return lines;
}

// 相邻行垂直间距大于行高阈值即分段；栏内独立成块后再按栏序拼接。
// 返回 [{x,y,w,h,text,lines:[...],indices:[item.index,...]}]，
// text 为行文本以单个空格拼接后的整块正文。
export function pdfBlocks(items, {gapRatio = 0.9, overlap = 0.5} = {}) {
  const blocks = [];
  for (const band of splitBands(normItems(items))) {
    for (const column of splitColumns(band)) {
    const lines = linesIn(column, overlap);
    if (!lines.length) continue;
    const heights = lines.map(line => line.h).sort((a, b) => a - b);
    const median = heights[Math.floor(heights.length / 2)] || 1;
    const local = [];
    for (const line of lines) {
      const block = local[local.length - 1];
      const gap = block ? line.y - (block.y + block.h) : Infinity;
      if (block && gap <= median * gapRatio) {
        block.lines.push(line);
        const right = Math.max(block.x + block.w, line.x + line.w);
        block.x = Math.min(block.x, line.x);
        block.w = right - block.x;
        block.h = line.y + line.h - block.y;
      } else {
        local.push({x: line.x, y: line.y, w: line.w, h: line.h, lines: [line]});
      }
    }
    blocks.push(...local);
    }
  }
  return blocks.map((block, order) => ({
    ...block,
    id: 'p' + order,
    text: block.lines.map(line => line.text).join(' ').replace(/\s+/g, ' ').trim(),
    indices: block.lines.flatMap(line => line.parts.map(part => part.index)),
  })).filter(block => block.text);
}
