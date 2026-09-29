# 开发记录：PDF 阅读支持

- 日期：2026-09-26
- 状态：已交付
- 相关 Issue：#39
- 相关 PR：#40
- 相关 ADR：docs/development/decisions/0005-pdf-reader-surface.md

## 背景

浏览器原生 PDF 查看器是隔离扩展页，网页辅助管线无法进入。用户需要在 PDF 上获得与网页一致的单词求助、选段翻译和整页对照翻译，同时保持「英文优先、翻译按需、失败如实」的产品边界。

## 目标

- 默认沿用原生查看器；.pdf 链接右键「在阅读器中打开 PDF」单次进入，或设置开启「在 RelyLess 阅读器中打开 PDF」后点击链接进入，原文排版完整、文本可选。
- 单击单词打开求助卡片；选中文字出现翻译/解释操作；工具栏可逐块或整页翻译，译文对照显示且不移除原文。
- 无服务端时各入口明确报错；不自动扫描或翻译文档。
- 可回退原生查看器（设置开关与 `#relyless-native`）。

## 非目标

- 不解析扫描版/图片型 PDF 的 OCR；不支持表单填写、批注、签章。
- 不改变网页侧既有查词/翻译行为；不新增持久数据类别。
- 不做 PDF 内目录、缩略图、打印等完整查看器功能。

## 实现边界

- `background.js`：`webNavigation.onBeforeNavigate` 仅在 `pdfReader` 开启时拦截主框架 `.pdf`（http/https）→ `tabs.update` 到 `pdf-viewer.html?src=`；`.pdf` 链接右键菜单提供与设置无关的单次明确入口（`targetUrlPatterns` 限定）。`readingSource` 放行扩展 viewer 页、文档身份取 `src`；`tabPage`/`emergencyBegin` 对扩展页统一 `tab.url || sender.url` 回落（扩展页对 `chrome.tabs` 不暴露 `url` 是实测平台行为）。`isPdfViewerUrl`/`pdfSourceUrl` 集中校验，拒绝伪造 viewer 地址（origin+pathname+src 协议三重检查）。
- `pdf-blocks.mjs`：纯几何分块（基线容差聚行 → 行距/缩进/栏宽聚块 → 上限裁剪），DOM 无关，Bun 直接测。
- `pdf-viewer.*`：vendored PDF.js（`vendor/pdfjs/`，Apache-2.0，NOTICE.txt 已登记）。画布层负责视觉，TextLayer 负责选择与几何。覆盖层 `pointer-events:none`，仅块级「译」按钮可点；单词命中用 `caretPositionFromPoint` 解到 span→块映射。渲染按 `renderGen` 代次失效：缩放清空 wrap 前取消在途 `renderTask`，过期任务的写回被守卫丢弃（修审查指出的 rezoom 竞态）。`SS_EMERGENCY_COUNT`/`SS_TRANSLATION_PROGRESS` 监听让后台用量探针与流式进度正常工作。
- 权限：直接 `fetch` 先试（覆盖带 CORS 的站点），`TypeError` 后才渲染授权按钮申请该站 origin；拒绝时提示可改原生查看器。

## 数据、权限与费用

- 新增持久化：无。`pdfReader` 是布尔设置（默认 false，按审查意见改为显式开启），随 `settings` 常规迁移与导出。
- 新请求面：与网页一致的 ASSIST/PASSAGE_TRANSLATE/EMERGENCY_*；PDF 文本只在点击单词、划词翻译、块/页翻译时发送，走同样的预算估算、会话缓存与无痕排除。
- 文档地址 `src` 只存在于标签页 URL；不写入历史、诊断或日志。
- 远程抓取：先零权限直接拉取，失败再逐站可选授权（`optional_host_permissions` 已有 http/https，不新增权限声明）。

## 风险与回滚

- 导航拦截误伤：仅限主框架 + `.pdf` 结尾 + http/https；`#relyless-native` 与设置开关可即时回退。
- 扩展页 URL 不可见导致的身份校验问题已实测修复；若平台行为变化，`sender.url` 回落仍保持「页面断言当前文档地址」的校验强度。
- 回滚方式：`pdfReader:false` 即恢复原生行为；删除 viewer 文件不影响其余代码路径。

## 验证证据

- 自动检查：`npm run check` —— 471 pass / 0 fail，含 `tests/pdf-blocks.test.js`、`tests/pdf-viewer.test.js` 与预算声明值回归测试（StepFun 输出上限改动按评审要求拆出本 PR，另见独立分支）。
- 评审修复（2026-10 复核轮）：预算估算改为查看器随 `EMERGENCY_BEGIN` 自带 `chars`（`tabs.sendMessage` 探针到不了扩展页，此前预算被静默归零）；通栏元素按水平条带先切再分栏，修复跨栏标题下左右栏同行错拼；超长块显式跳过并在对照栏计数、选段 >4000 字符明确拒绝（不再静默截断），「翻译本页」状态如实报告失败/跳过块数且重试只补发未译块；401/403 提示登录后重试或回退原生；词卡/选段卡加请求序号守卫，旧响应不再覆盖新卡片；对照行可 Tab 聚焦、Enter/Space 回跳；块上「译」按钮改为悬停/聚焦才显示（不再常驻遮挡标题）；文档标题改为 `h1`。

复核补充：补上逐页待译块预算二次确认，旧 PDF 导航异步回调代次校验，稀疏双栏一行也不混译；下载、页数、画布均有上限。真实 Chrome for Testing 两页 PDF：默认原生、明确开启后画布/文本层渲染，第一页提交 120 字符、第二页 112 字符另行触发超预算确认，取消不发送第二页，明确确认后才发送；模型响应为受控夹具，不证明真实模型质量。
- 浏览器冒烟（Playwright Chromium + `--load-extension`，本地 HTTP 服务提供自生成单栏/双栏/跨栏标题三份 PDF，模型服务为真实 StepFun 套餐端点 `step-3.5-flash`）：
  - `.pdf` 导航重定向到 `pdf-viewer.html?src=…`；canvas 渲染、textLayer span、几何分块正常，无 console 错误。
  - 块「译」→ 真实中文译文同时写入块下内嵌译文与右侧对照栏；「文」按钮可收起/展开内嵌译文。
  - 单击单词 → 卡片返回真实英文提示（默认 hint；中文释义按钮实测返回 `{"translation":"查询规划器","sense":"…"}`）；× 按钮与 Escape 均可关闭。
  - 划选 → 操作条 → PASSAGE_TRANSLATE 返回真实译文；「翻译本页」→ EMERGENCY_BEGIN → 逐块内嵌译文 + 右侧栏对照行，行点击平滑滚动回原文块并高亮 1.2s。
  - `←`/`→` 翻页，页码指示同步；连续缩放后再渲染，内嵌译文按块 id 恢复不丢失。
  - 双栏样张：左右栏分块不混杂、块序左栏先于右栏；通栏标题样张作为水平分隔带，标题自成一块且左右栏序正确。
  - `#relyless-native` 与 `pdfReader:false` → 原生查看器接管；无 CORS 站点 → 授权按钮；损坏 PDF / 缺 src → 明确报错。
- 无障碍/视觉：工具按钮原生 `<button>` 可键盘聚焦；沿用 design token（`data-shisui-page` 已接入）。

## 后续事项

- 授权成功路径已在真实窗口 Chromium 中由用户点击「允许」验证（选项页保存与查看器内授权按钮两条路径，见 PR #40 评论）。
- 阶跃星辰推理模型单次查词实测可达 40–100s（推理耗时的输出上限修复已拆为独立分支 `fix/stepfun-tokens`），卡片 12s 后显示「模型仍在思考」提示。
- 多栏分块：全宽元素先切成水平条带，条带内按 x 投影净空缝切栏（≤3 栏）；片段充足时两侧各至少两项，稀疏页在足够宽的栏间净空下允许各一项。无法可靠判定的版式不应把相隔很远的文本拼为同一译块；竖排 PDF 仍需真实样张回归，遇到乱序块应反馈样本。
