# ADR 0008：Grok 兼容设备码 OAuth 与订阅代理直连

- 状态：accepted（兼容方案获用户明确接受；实现验收证据另见开发记录）
- 日期：2026-10-04
- 参与讨论：本次用户对话，明确选择「接受 Grok 兼容直连」
- 相关 Issue：无（未创建或声称存在 GitHub Issue）
- 取代：现有 Grok CLI 执行路径；不改写历史 ADR 或开发记录
- 被取代：无

## 背景

Grok 原有订阅通道依赖本机 Grok CLI 的安装、登录与执行。用户要求移除 Grok CLI，但仍保留本机 Node Native Messaging 连接器；在已说明授权与可用性风险后，用户接受复用官方 CLI 公开 OAuth 客户端 ID 的兼容直连，而非要求 RelyLess 拥有自己的 xAI 第三方客户端注册。

必须区分三个事实：官方授权服务器公开设备码/OIDC 协议；公开第三方源码采用官方 CLI 客户端；RelyLess 是否得到官方批准、是否能用某个真实账户完成推理。前两个不是第三个的证据。本次没有真实登录、付费推理或官方第三方支持确认。

## 决策驱动因素

- 去掉 CLI 安装、子进程执行与请求提示词文件，保留现有 Native 边界和阅读功能。
- 凭证仅由本机主机持有，浏览器不得得到令牌、原始身份响应或 device code。
- 不隐藏客户端复用、套餐/权限失败或服务商数据保留风险。
- 不改变 ChatGPT SIWC，不迁移或删除 Google 用户配置，不新增 Grok 会话功能或 API Key 消费。

## 备选方案

### 保留 Grok CLI

可以继续复用原 CLI 执行，但不满足用户明确要求，且仍有外部安装、CLI 行为与提示词文件依赖。此路径从当前 Grok 实现中移除，不保留兼容分支。

### RelyLess 自有正式注册

有利于独立客户端身份与正式支持边界，但没有本次可用的注册或支持凭据。不能把复用公开客户端包装成自有注册。若未来获得正式接入，应另行决策与授权迁移。

### 用户接受的兼容直连（选择）

公开客户端 ID 与设备码授权可用于实现无 CLI 的 Native 连接器，但服务商可改变策略或拒绝账户/套餐权益；必须如实说明，不声称官方批准。

## 决策

1. **客户端与来源身份。**复用公开 Grok CLI OAuth client ID `b1a00492-073a-47ea-816f-4c329264a828`。这是公开标识，不是共享客户端密钥，也不是 RelyLess 自有注册。请求客户端标识、版本和 User-Agent 如实标识 RelyLess，不冒充官方 CLI、Kilo 或 pi-xai-oauth。代理头 `X-XAI-Token-Auth: xai-grok-cli` 仅表达兼容的令牌认证方案，不是来源身份声明。
2. **设备码登录。**主机向 `https://auth.x.ai/oauth2/device/code` 申请设备授权，在 `/oauth2/token` 按设备授权协议轮询；浏览器只获得可信验证地址、短用户码与脱敏状态。拒绝、过期、取消、`authorization_pending` 和 `slow_down` 按真实类别处理，不把待授权显示为已登录。申请 `openid profile email offline_access grok-cli:access api:access`，不增加会话读写范围。
3. **可信身份与刷新。**通过官方 userinfo 核实账户身份并检查必要授权范围；返回 ID token 时，先使用官方 JWKS 验证 OIDC ES256 签名及 issuer、audience、subject、有效期，再与 userinfo subject 核对。JWT 未验证解码不能建立身份。访问/轮换刷新令牌及账户记录只保存在 Native 数据目录 `grok-oauth.json`，POSIX 0600，刷新记录原子替换；Windows 保密边界还依赖账户与目录访问控制。浏览器存储、网页、消息、诊断、导出和错误不包含凭证。并发刷新、取消或退出后的旧结果不能重新建立已失效账户。
4. **订阅 HTTP。**账户身份通过 `https://auth.x.ai/oauth2/userinfo` 核实，返回的 ID token 需通过 ES256/claims 校验并与 userinfo subject 一致。目录 `/models-v2`、推理 `/responses` 直接访问 `https://cli-chat-proxy.grok.com/v1`。目录过滤隐藏、API-key-only 及不适用 Responses 的项；显示目录不是模型权限或订阅权益保证。请求使用 `store:false`，但 xAI 接收必要文本、账户认证与正常元数据，正常安全、用量、内容保留仍遵循服务商政策，不承诺零保留。只有明确完成的 HTTP/SSE 且结构化结果有效才成功；failed、incomplete、提前断流不得提交伪成功。不新增自动推理重试，不自动转为 API Key 消费；用户显式配置的既有路由/故障转移边界不变。
5. **迁移与退出。**Grok 不再安装、查找或执行 CLI，不生成请求提示词文件。从旧 CLI 通道迁移时重新安装 Native 主机并完成新的设备码授权；后续主机更新保留有效的直连授权；不导入旧 CLI 凭证，旧安装数据不读取、不删除。退出清除本机授权，并尝试 `/oauth2/revoke`；远端失败必须如实提示，不能阻止本机退出或声称远端已撤销。清理扩展阅读数据不等于退出账户，撤销也不删除已发送的服务商数据。
6. **其他通道与能力。**ChatGPT SIWC 保持不变；Google 保留既有 Antigravity CLI 和用户配置，不迁移、不删除。官方 Antigravity FAQ 明确警告第三方访问违反其条款且可能暂停/终止账户，保留配置不是官方允许声明。Grok 仅实现既有分类、批量支持、主动求助、翻译、句组与历史模型等契约，不新增多轮追问、工具代理、音视频或远端持久会话。

## 结果

### 正面影响

- Grok 去掉 CLI 安装与执行依赖，同时保留现有 Node Native 连接器部署方式。
- 凭证、刷新、HTTP/SSE 完成判定与故障分类集中在主机；浏览器无令牌。
- 客户端来源、费用与数据去向更明确，旧凭证不会被隐式导入。

### 代价与风险

- 官方 discovery 和公开源码不构成第三方授权保证。端点、公开客户端策略、账户权益或订阅层级改变可能使登录或推理失败。
- 主机需要承担签名校验、轮换刷新、原子凭证写入与取消/退出竞态的正确性。
- `store:false` 不能消除服务商保留；本机退出成功不保证远端撤销成功。
- Google 现有通道有官方条款警告；本次不借 Grok 改动扩大为 Google 迁移或删除。

## 公开依据与证据边界

- [xAI 官方 OIDC discovery](https://auth.x.ai/.well-known/openid-configuration)：公开 device authorization、token、userinfo、revocation 与 JWKS 端点，以及 ES256 和设备码 grant。该元数据不是 RelyLess 官方支持或某账户权益证明。
- [Kilo 固定源码](https://github.com/Kilo-Org/kilocode/blob/76bcfd40be616a72f4697b3041565f322245b462/packages/opencode/src/plugin/xai.ts)：公开客户端 ID 复用与设备码流程的第三方实现证据，不是官方许可。
- [pi-xai-oauth 常量](https://github.com/BlockedPath/pi-xai-oauth/blob/main/extensions/xai/constants.ts)、[代理 wire](https://github.com/BlockedPath/pi-xai-oauth/blob/main/extensions/xai/wire.ts)、[目录 codec](https://github.com/BlockedPath/pi-xai-oauth/blob/main/extensions/xai/catalog/model-codec.ts)：第三方代理与目录兼容参考；`main` 是可变引用，不能作为永久协议保证。本次不引入该项目的额外工具、会话权限或 API 付费功能。
- [Antigravity 官方 FAQ](https://antigravity.google/docs/faq/)：第三方访问条款限制与账户暂停/终止风险。

## 实施与验证

实施范围：Grok 主机适配、Native 主机契约、安装/设置说明、隐私文档与回归测试。验收见 [手动验证清单 5.16](../../verification-checklist.md#516-grok-兼容设备码-oauth-与订阅代理直连)；[开发记录](../records/2026-10-04-grok-oauth-direct.md) 明确区分公开资料阅读与待主代理补充的实现证据。真实账户授权和请求本次不执行。

若服务商拒绝兼容客户端或订阅访问，应显示真实失败，用户可主动选择已有其他服务；不能自动恢复 CLI、导入旧令牌、冒充来源或改为 API Key 支出。未来正式注册或 Google 接入变化须另行授权与决策。
