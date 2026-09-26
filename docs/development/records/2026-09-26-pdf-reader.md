# 开发记录：PDF 阅读支持

- 日期：2026-09-26
- 状态：已交付
- 相关 Issue：无
- 相关 PR：待提交
- 相关 ADR：docs/development/decisions/0005-pdf-reader-surface.md

## 背景

浏览器原生 PDF 查看器是隔离扩展页，网页辅助管线无法进入。用户需要在 PDF 上获得与网页一致的单词求助、选段翻译和整页对照翻译，同时保持「英文优先、翻译按需、失败如实」的产品边界。

## 目标

- 点击 .pdf 链接进入扩展自有阅读器，原文排版完整、文本可选。
- 单击单词打开求助卡片；选中文字出现翻译/解释操作；工具栏可逐块或整页翻译，译文对照显示且不移除原文。
- 无服务端时各入口明确报错；不自动扫描或翻译文档。
- 可回退原生查看器（设置开关与 `#relyless-native`）。

## 非目标

- 不解析扫描版/图片型 PDF 的 OCR；不支持表单填写、批注、签章。
- 不改变网页侧既有查词/翻译行为；不新增持久数据类别。
- 不做 PDF 内目录、缩略图、打印等完整查看器功能。

## 实现边界

- `background.js`：`webNavigation.onBeforeNavigate` 拦截主框架 `.pdf`（http/https）→ `tabs.update` 到 `pdf-viewer.html?src=`。`readingSource` 放行扩展 viewer 页、文档身份取 `src`；`tabPage`/`emergencyBegin` 对扩展页统一 `tab.url || sender.url` 回落（扩展页对 `chrome.tabs` 不暴露 `url` 是实测平台行为）。`isPdfViewerUrl`/`pdfSourceUrl` 集中校验，拒绝伪造 viewer 地址（origin+pathname+src 协议三重检查）。
- `pdf-blocks.mjs`：纯几何分块（基线容差聚行 → 行距/缩进/栏宽聚块 → 上限裁剪），DOM 无关，Bun 直接测。
- `pdf-viewer.*`：vendored PDF.js（`vendor/pdfjs/`，Apache-2.0，NOTICE.txt 已登记）。画布层负责视觉，TextLayer 负责选择与几何。覆盖层 `pointer-events:none`，仅块级「译」按钮可点；单词命中用 `caretPositionFromPoint` 解到 span→块映射。`SS_EMERGENCY_COUNT`/`SS_TRANSLATION_PROGRESS` 监听让后台用量探针与流式进度正常工作。
- 权限：直接 `fetch` 先试（覆盖带 CORS 的站点），`TypeError` 后才渲染授权按钮申请该站 origin；拒绝时提示可改原生查看器。

## 数据、权限与费用

- 新增持久化：无。`pdfReader` 是布尔设置（默认 true），随 `settings` 常规迁移与导出。
- 新请求面：与网页一致的 ASSIST/PASSAGE_TRANSLATE/EMERGENCY_*；PDF 文本只在点击单词、划词翻译、块/页翻译时发送，走同样的预算估算、会话缓存与无痕排除。
- 文档地址 `src` 只存在于标签页 URL；不写入历史、诊断或日志。
- 远程抓取：先零权限直接拉取，失败再逐站可选授权（`optional_host_permissions` 已有 http/https，不新增权限声明）。

## 风险与回滚

- 导航拦截误伤：仅限主框架 + `.pdf` 结尾 + http/https；`#relyless-native` 与设置开关可即时回退。
- 扩展页 URL 不可见导致的身份校验问题已实测修复；若平台行为变化，`sender.url` 回落仍保持「页面断言当前文档地址」的校验强度。
- 回滚方式：`pdfReader:false` 即恢复原生行为；删除 viewer 文件不影响其余代码路径。

## 验证证据

- 自动检查：`npm run check` —— 466 pass / 0 fail / 2457 expect()，新增 `tests/pdf-blocks.test.js`、`tests/pdf-viewer.test.js`（分块几何、viewer 消息放行、伪造扩展页拒绝、EMERGENCY_BEGIN 对 viewer 发 token）。
- 浏览器冒烟（Playwright Chromium 153 + `--load-extension`，真实本地 HTTP PDF 服务）：
  - `.pdf` 导航重定向到 `pdf-viewer.html?src=…`；canvas 渲染、textLayer 9+ span、几何分块 3 块。
  - 单击单词 → ASSIST → 卡片显示「请先连接服务。」（无服务时诚实错误）。
  - 划选 → 「翻译所选/解释所选」操作条 → PASSAGE_TRANSLATE 同样诚实报错。
  - 「翻译本页」→ EMERGENCY_BEGIN 返回 token → 译文面板 3 行对照，原文保留。
  - `#relyless-native` 与 `pdfReader:false` → 原生查看器接管。
  - 无 CORS 站点 → 授权按钮出现；拒绝 → 「未获得权限」提示。
  - 损坏 PDF → 「文档解析失败」；缺 src → 「缺少有效的文档地址。」
- 无障碍/视觉：工具按钮原生 `<button>` 可键盘聚焦；状态文本不经颜色单独表达；沿用 design token。

## 后续事项

- 授权成功路径在 headless 无法覆盖（权限对话框需要真实窗口）；`chrome.permissions.request` → `boot()` 是标准调用，需人工在正常浏览器过一次。
- 多栏/竖排 PDF 的分块质量依赖真实样张回归；遇到乱序块应反馈样本。
