# 开发记录：Grok 兼容 OAuth 直连替换 CLI

- 日期：2026-10-04
- 状态：实现完成，自动检查、Native 夹具与真实设置页验收通过；真实订阅授权未执行
- 相关 Issue：[#49](https://github.com/rockythink/relyless/issues/49)（发布前补充维护者对话决策追踪）
- 相关 PR：[#50](https://github.com/rockythink/relyless/pull/50)
- 相关 ADR：[ADR 0008](../decisions/0008-grok-oauth-direct.md)

## 背景

用户在获知公开客户端复用不等于正式第三方授权、订阅权益可能失败之后，明确选择「接受 Grok 兼容直连」。目标是移除 Grok CLI，而不是移除本机 Node Native Messaging 主机。ChatGPT 已有 SIWC 直连保持不变，Google 既有服务与配置不迁移、不删除。

## 目标

- 安装 Grok Native 连接器不要求安装或运行 Grok CLI；从旧 CLI 通道迁移后在设置发起新的设备码 OAuth 登录，不导入旧 CLI 认证；后续主机更新保留有效直连授权。
- 浏览器仅拿到可信验证地址、短用户码与脱敏账户/模型状态，凭证与设备授权轮询留在主机。
- Grok 分类、支持、主动求助、翻译、句组与历史模型请求直接使用 xAI 订阅代理 HTTP，失败保留真实类别。
- 说明公开官方 CLI 客户端 ID 复用、第三方支持不保证、套餐/权限限制、数据去向与远端保留。

## 非目标

- 不注册或宣称拥有 RelyLess 自有 xAI OAuth 客户端，不声称官方批准或已用真实账户登录成功。
- 不新增 Grok 多轮追问、远端持久会话、工具代理或音视频能力。
- 不自动切换到 API Key 消费，不增加自动推理重试。
- 不改变 ChatGPT SIWC，不迁移、删除或改写 Google 配置，不清理用户旧 CLI 数据。
- 不创建虚构 Issue/PR，不改写既有历史 ADR/开发记录，不提交、推送或发布。

## 实现边界

`connector/grok.mjs` 承担设备授权、OIDC 验证、账户/令牌生命周期、目录与 HTTP/SSE；`connector/host.mjs` 继续是 Native 消息验证与请求生命周期入口。安装器与设置页移除 Grok CLI 安装/登录指示，保持既有按订阅种类的状态与消息契约。ChatGPT 和 Google 适配不因本次切换改变。

授权服务为 `https://auth.x.ai`：`/oauth2/device/code`、`/oauth2/token`、官方 JWKS 和 `/oauth2/revoke`。申请 `openid profile email offline_access grok-cli:access api:access`，核实官方 userinfo 身份与必要范围；返回 ID token 时验证 ES256 签名、issuer、audience、subject、有效期并核对 userinfo subject。复用公开官方 Grok CLI 客户端 ID，但请求标识、版本与 User-Agent 明确标识 RelyLess；`X-XAI-Token-Auth: xai-grok-cli` 是代理要求的兼容令牌方案，不是冒充 CLI 来源。

账户身份来自 `https://auth.x.ai/oauth2/userinfo`，返回的 ID token 经 ES256/claims 校验后与 subject 核对。目录 `/models-v2` 与推理 `/responses` 使用 `https://cli-chat-proxy.grok.com/v1`；目录不得把隐藏/API-key-only 项显示为订阅权益。HTTP/SSE 结果只有明确完成且结构化内容有效才成功，failed/incomplete/提前断流不伪装完成。额度、权限、套餐层级和认证失败不能自动转为 API 支出。

## 数据、权限与费用

- 访问令牌、轮换刷新令牌和账户记录只在 Native 数据目录 `grok-oauth.json`，POSIX 0600，刷新记录原子更新。Windows 访问控制依赖系统账户与目录权限；浏览器、网页、诊断、导出与错误不持有凭证。
- 从旧 CLI 通道迁移须重新安装主机并重新授权，后续主机更新保留有效直连授权；旧 CLI 数据保留且不读取、不删除。不写请求提示词文件。
- 本机模型请求携带任务所需的有限文本与认证，直接发给 xAI，服务商还能获得正常网络元数据；无 RelyLess 中转云服务。`store:false` 不保证零保留，正常账户、安全、用量、内容处理仍依服务商政策。
- 退出清除本机授权并尝试远端撤销；远端失败如实提示但不阻止本机退出。清理扩展阅读数据不是退出账户，也不能删除服务商已接收内容。
- 不增加浏览器直连 OAuth 凭证存储，不增加 Grok 会话授权范围或隐式 API Key 消费。现有用户显式配置的路由、故障转移与预算确认边界不变。
- [Antigravity 官方 FAQ](https://antigravity.google/docs/faq/) 明确警告第三方访问违反服务条款，可能导致账户暂停/终止。本次保留 Google 配置与 CLI 通道不表示官方允许此用途。

## 风险与退出条件

共享公开客户端、设备授权端点与订阅代理可能被服务商改变或拒绝；登录成功也不保证模型/套餐可用。必须保留真实错误，不自动恢复 CLI、不导入旧凭证、不冒充来源、不转为 API 消费。用户可主动选择已有其他服务。若未来有正式注册或 Google 接入变更，需另行授权与决策，不将本次兼容选择当作无限授权。

## 验证证据

### 已完成的公开资料阅读（不是运行时验收）

- 读取官方 [OIDC discovery](https://auth.x.ai/.well-known/openid-configuration) 公共 JSON，观察到 issuer `https://auth.x.ai`、device authorization、token、userinfo、revocation、JWKS 端点和 ES256 描述。没有申请设备授权、兑换令牌或登录真实账户。
- 阅读 [Kilo 固定源码](https://github.com/Kilo-Org/kilocode/blob/76bcfd40be616a72f4697b3041565f322245b462/packages/opencode/src/plugin/xai.ts)：公开 Grok CLI client ID 复用及设备码实现的第三方证据。不能据此声称官方批准。
- 阅读 [BlockedPath/pi-xai-oauth 常量源码](https://github.com/BlockedPath/pi-xai-oauth/blob/main/extensions/xai/constants.ts)：订阅代理 `/responses`、`/models-v2` 与 `/user` 的第三方兼容参考。该 `main` 链接可变，不是永久官方协议保证。
- 官方 Antigravity FAQ 的检索结果明确给出第三方访问限制及账户暂停/终止风险；文档仅提示风险，不据此迁移或删除 Google 配置。

### 已完成的实现验收（隔离夹具，不是生产订阅可用性声明）

- `npm run check`：527 pass、0 fail，46 个测试文件；包含语法检查与既有全套回归。
- `bun test tests/grok-oauth.test.js`：25 pass、0 fail。覆盖授权 pending/slow_down/拒绝/过期/取消、伪造签名和错误 claims/scopes、目录过滤、并发轮换刷新、401/403/429、超时、断流/failed/incomplete、无效结构化结果、远端撤销失败、本机退出后的迟到刷新/完成结果，以及未来凭证 schema 不覆写。
- Native 全链路冒烟：启动真实 Node Native Messaging 主机，由回环 HTTP 夹具模拟 OAuth/JWKS/userinfo/models/Responses/revoke。观察到设备授权成功、分类 `tech`、限额 `RATE_LIMIT`、凭证文件 0600、本机退出成功；浏览器消息没有令牌。临时脚本已清理；没有向真实 xAI 兑换令牌或发起模型请求。
- 安装与升级：全套回归中的 `tests/cli-spawn.test.js` 在 macOS 隔离 HOME/PATH 下执行真实安装器、启动安装后的 Native 主机，并检查旧 CLI 数据保留及来源限制。Windows/Linux 的真实安装与账户登录未执行；跨平台辅助测试不替代实机证据。
- 浏览器：真实加载未打包扩展的设置页，只有订阅响应使用 UI 夹具。浅色 390×844 验证设备码完整可见、面板不被横向裁切、polite 状态播报；深色 1365×768 验证已授权提示仍明确“不保证模型/套餐可用”。键盘 Enter 执行登录、取消与退出；取消/退出移除设备码。当前详情动作只指向 Grok，浏览目录不修改默认 ChatGPT 配置。
- 无障碍与错误：两种上述状态的订阅面板 axe-core WCAG 2 A/AA 均为 0 violations、0 incomplete；页面没有捕获到错误。结论仅限所检查面板与状态，不代表整个扩展通过完整无障碍审计。

真实账户登录、交互授权、生产令牌刷新/撤销与订阅推理本次未执行；共享客户端兼容性与实际套餐权益仍需真实账户验证。没有提交、推送、创建 PR 或发布。验收场景见 [手动验证清单 5.16](../../verification-checklist.md#516-grok-兼容设备码-oauth-与订阅代理直连)。

## 文档同步范围

- `README.md`
- `PRIVACY.md`
- `PRIVACY.en.md`
- `docs/development/architecture.md`
- `docs/verification-checklist.md`
- `docs/development/decisions/0008-grok-oauth-direct.md`
- `docs/development/records/2026-10-04-grok-oauth-direct.md`

历史记录保留原有时点事实，不追溯覆写。
