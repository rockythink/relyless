# ADR 0004：判定通道开放多接入方（新增 SiliconFlow System One）

- 状态：accepted
- 日期：2026-09-25
- 参与讨论：rockythink/relyless#30
- 取代：无
- 被取代：无

## 背景

领域识别的“Jev 判定”与模型路由的判卷共用同一条结构化判定通道，原先硬编码为 Requesty（`protocol: 'jev'`，`POST /chat/completions`，问题包进 `response_format`）。SiliconFlow 上线了同类的 System One 快速决策端点（`POST /v1/systemone`），使用 TypeSafe 原生报文：`{model, state, questions}` 直接下发，响应为 `{answers: {问题名: 答案}}`，与 chat/completions 包装形状不同，且提供更新的判定模型。

通道能力本身是抽象的（1–16 个 typed 问题 → 归一化答案），两个服务的差别只在报文封装，因此具备在同一边界内切换接入方的条件。

## 决策驱动因素

- 用户需要可选地使用 SiliconFlow 上更新的判定模型，而不是被锁定在 Requesty；
- 判定接入必须显式选择、可回退，默认行为（Requesty）不能被悄悄改变；
- 两种报文形状必须保持诚实区分，不能把 System One 伪装成普通 Chat Completions；
- 判定凭据与端点仍走既有的同源权限与密钥保留语义，不能引入第二条凭据通道；
- 新增远程接收方需要隐私与验证文档同步。

## 备选方案

### 方案 A：把 SiliconFlow 当作自定义 Chat Completions 端点

让用户在现有 `requesty` 服务上改 baseUrl。不可行：System One 的 `{state, questions}`/`{answers}` 报文与 chat/completions 包装互不兼容，拼出来的请求必然失败或产生错误答案。

### 方案 B：为 SiliconFlow 写一条独立的判定通道（独立设置、独立凭据）

可行但重复：领域识别设置、判卷服务构建、密钥保留、权限模式都需要第二份实现，违反单一入口约定。

### 方案 C（采纳）：判定通道抽象出 `jevProvider`，按服务商的 `protocol` 分发报文

`domainDetection.jevProvider` 记录所选接入方（默认 `requesty`）；`judgmentProvider()`/`judgmentService()` 在 background 内统一解析服务商定义并构建服务；`systemone` 作为新协议加入 transport 分发，复用与 `jev` 相同的入参校验（`jevPayload`）和答案归一化（`normalizeJevAnswer`）。

## 决策

采纳方案 C：

- `api-providers.mjs` 新增 `siliconflow-systemone`（`protocol: 'systemone'`），与现有 `siliconflow`（普通 Chat）严格区分；
- `api-transport.mjs` 新增 `performSystemOne`：`POST {baseUrl}/systemone`，body `{model, state, questions}`，响应 `answers` 映射走同一套答案归一化与错误类别（`JEV_*`）；
- `shared.js` 默认 `jevProvider: 'requesty'`，存量设置无需迁移；
- `background.js` 的四处判定服务构建点（领域识别运行时、路由判卷、凭据模式、设置校验）统一经 `judgmentService()`，补丁校验拒绝非判定协议的服务商；
- 设置页「Jev 判定」新增「判定接入」下拉（Requesty / SiliconFlow · System One），切换时把仍等于某接入方默认值的地址/模型自动换成新接入方默认值，自定义值保留；跨接入方切换按既有同源规则丢弃已存密钥，需重新填写。

## 结果

### 正面影响

- 判定通道可以在不改动路由语义的情况下使用 SiliconFlow 的更新判定模型；
- Requesty 默认与既有凭据完全兼容，无迁移成本；
- 判定协议差异集中在 transport 边界内，UI、路由、缓存层只感知抽象答案；
- 后续新增同类判定服务只需一条 provider 定义和一个协议分支。

### 代价与风险

- `domainDetection` 新增一个持久化字段，需要与地址/模型保持配套一致性（经补丁校验保证）；
- System One 端点处于 Alpha 期，模型目录、报文形状或可用性可能变化，需要跟随官方文档维护；
- 判定结果缓存按设置版本失效，切换接入方后旧缓存不适用，属预期行为；
- 「判定接入」依赖下拉与默认值替换逻辑，切换行为需要按验证清单人工核对。

## 实施与验证

- Issue：rockythink/relyless#30；
- 实现分支：`feat/siliconflow-systemone`；
- 测试：`npm run check`（455 项）；新增 systemone 报文/错误测试、provider 白名单、设置归一化（含非法接入方拒绝）、SiliconFlow 判卷路由集成测试；
- 人工验证按 `docs/verification-checklist.md` §5.8–5.9：两种接入方的保存、权限、识别 source、清钥后权限回收；
- 文档：README 模型路由与远程内容章节、PRIVACY.md/PRIVACY.en.md 判定条目、验证清单同步；
- 退出条件：若 System One 端点停用或报文不兼容，回退选项始终保留（改回 `jevProvider: 'requesty'` 即恢复）。
