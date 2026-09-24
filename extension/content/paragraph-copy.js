/**
 * @file content/paragraph-copy.js
 * 段落干净复制：通过右键菜单选中原文执行。
 * 复制的永远是原文：textMap 只走原始文本节点，提示、词注和译文容器都在排除列表里。
 */
(() => {
  'use strict';
  const kernel = globalThis.ShisuiContent;
  if (!kernel || globalThis.ShisuiCopy) return;
  function selectedBlock() {
    const selection = kernel.currentSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    const block = kernel.nodeElement(range.startContainer)?.closest(kernel.BLOCK_SELECTOR);
    if (!block || !kernel.inReadingSurface(block) || !kernel.inReadingSurface(range.endContainer) || !kernel.isVisible(block)) return null;
    if (kernel.isReaderContent(block)) {
      const root = kernel.readingScope();
      for (let node = block; node && node !== root; node = node.parentElement) if (node.matches(kernel.SKIP)) return null;
      return block;
    }
    return block.closest(kernel.SKIP) ? null : block;
  }
  async function writeClipboard(text) {
    try { await navigator.clipboard.writeText(text); return; } catch {}
    // 页面可能拦截 Clipboard API，退回 execCommand；隐藏输入框不得抢占当前焦点语义。
    const holder = document.createElement('textarea');
    holder.value = text; holder.setAttribute('readonly', ''); holder.setAttribute('aria-hidden', 'true');
    holder.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;pointer-events:none';
    kernel.uiMountRoot().append(holder); holder.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch {}
    holder.remove();
    if (!copied) throw new Error('此页面不允许写入剪贴板，请手动选择复制。');
  }
  async function copyParagraph() {
    const block = selectedBlock();
    if (!block) throw new Error('没有找到可复制的段落。');
    const text = kernel.normalizeText(kernel.blockText(block));
    if (!text) throw new Error('这个段落没有可复制的文字。');
    await writeClipboard(text);
    kernel.hooks.setPageStatus?.('copy', '已复制本段原文 · ' + text.length + ' 字符', {duration: 2500});
    return kernel.hooks.status?.();
  }

  globalThis.ShisuiCopy = Object.freeze({copyParagraph, selectedBlock, writeClipboard});
})();
