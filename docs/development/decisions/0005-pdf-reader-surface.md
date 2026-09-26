# ADR 0005：扩展自有 PDF 阅读表面

- 状态：proposed
- 日期：2026-09-26
- 参与讨论：无（未开独立 Issue）
- 取代：无
- 被取代：无

## 背景

用户希望在 PDF 文档上获得与网页一致的阅读辅助：单词求助、选段翻译和整页对照翻译。浏览器自带 PDF 查看器运行在隔离的扩展内部页面（`chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/`），内容脚本和 `chrome.scripting` 都无法进入其 DOM——网页辅助管线无法原样复用。

## 决策驱动因素

- 英文原文必须保持首要地位：PDF 视觉排版不能破坏，文本必须可选可复制。
- 不引入第二套模型请求链路；查词与翻译必须复用 `ASSIST`/`PASSAGE_TRANSLATE`/`EMERGENCY_*` 契约及其守卫。
- 不自动扫描、不自动翻译 PDF 内容；发送文本的边界与网页一致。
- 不持久化 PDF 网址或正文；会话规则与网页一致。
- 权限最小化：扩展页抓取远程 PDF 受主机权限约束时，必须由用户明确动作触发申请，而不是声明宽泛主机权限。
- PDF.js 必须 vendored 本地加载，CSP `script-src 'self'` 不允许远程脚本。

## 备选方案

### 方案 A：向浏览器原生 PDF 查看器注入

不可行：原生查看器是浏览器自带的隔离扩展页，第三方扩展不能向其注入脚本或读取其 DOM。

### 方案 B：`webNavigation` 拦截主框架 `.pdf` 导航，重定向到扩展自有 `pdf-viewer.html`

扩展页内由 vendored PDF.js 渲染画布层与文本层，文本层按几何规则聚合为翻译块。`readingSource` 放行扩展 viewer 页并把文档身份绑定到 `src` 参数；求助与翻译消息原样复用。

代价：接管浏览器原有 PDF 入口，需要提供明确退出（`pdfReader` 设置与 `#relyless-native` 逃逸标记）；`chrome.tabs` 对扩展页不暴露 `url`，身份校验需回落 `sender.url`。

### 方案 C：仅做 PDF「导入到专注阅读」

用户手动把 PDF 文本导入现有阅读器。不拦截导航，但依赖不可靠的全文提取，丢失版面与分页，且无法原位展示译文。

## 决策

采用方案 B：

- `onBeforeNavigate` 在主框架 `.pdf` 导航（http/https）时 `tabs.update` 到 `pdf-viewer.html?src=`；`pdfReader` 设置或 `#relyless-native` 时放行原生查看器。
- `pdf-viewer.html` + vendored `pdf.min.mjs`/`pdf.worker.min.mjs`：canvas + `TextLayer`；`pdf-blocks.mjs` 纯函数按基线/间距/缩进聚合成块。
- `readingSource` 识别 viewer 页：文档哈希取自 `src` 地址；`tab.url` 对扩展页不可见时回落 `sender.url`，`emergencyBegin`/`tabPage` 同样回落，校验强度不变（仍要求 sender 断言当前文档地址）。
- viewer 抓取远程 PDF：先尝试直接 `fetch`（兼容带 CORS 的站点），`TypeError` 后才在阅读器内显示授权按钮并 `chrome.permissions.request` 该站 origin。
- 整页翻译走 `EMERGENCY_BEGIN`+`EMERGENCY_TRANSLATE`，译文显示在原文块下方，不移除原文。

## 结果

### 正面影响

- PDF 获得与网页一致的求助/翻译能力和同样的明确动作边界。
- 零新增权限（`webNavigation` 原本就有）；主机访问仍是可选且逐站、由用户动作触发。
- 无第二请求链路：所有文本都经过既有 provider、预算、缓存与错误通道。
- PDF 网址和正文不进入任何持久存储。

### 代价与风险

- 接管 `.pdf` 导航改变了浏览器默认行为：靠 `pdfReader` 设置（默认开）和 `#relyless-native` 逃生口兜底；回归风险集中在导航拦截条件。
- 新增约 1.8MB vendored PDF.js，升级时需同步 `NOTICE.txt` 与版本号。
- 文本层几何分块对复杂排版（多栏、表格、竖排）保守处理——分不出来的块不译而不是乱译。
- 扩展页 `tab.url` 不可见这一平台行为若变化，需回归 `readingSource`/`emergencyBegin` 的回落路径。

## 实施与验证

- `npm run check` 全绿（466 pass / 0 fail），含 `pdf-blocks` 几何分块与 viewer/background 消息契约单测。
- 真机（Playwright Chromium + `--load-extension`）验证：`.pdf` 导航重定向、文本层渲染、点击求助、划词翻译、`EMERGENCY_BEGIN` 授权、整页翻译面板、权限拒绝提示、损坏 PDF 报错、`#relyless-native` 与 `pdfReader:false` 回退原生查看器。
- 未连接模型时各入口诚实报错（「请先连接服务。」），不伪造结果。
