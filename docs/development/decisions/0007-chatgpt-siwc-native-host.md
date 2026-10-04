# ADR 0007：ChatGPT SIWC 开源 OAuth 与本机直接 Responses

- 状态：accepted
- 日期：2026-10-03
- 参与讨论：本次用户授权的 ChatGPT 订阅完整切换需求；未关联 Issue
- 取代：ChatGPT 订阅通道的 Codex CLI 实现（无独立 ADR）
- 被取代：无

## 背景

ChatGPT 订阅通道原先依赖本机安装并登录 Codex CLI，由 Native Messaging 主机管理 CLI 进程与 thread。用户要求完整改为官方 Sign in with ChatGPT（SIWC）开源 OAuth，并直接使用 OAuth Bearer 令牌调用 Responses API；仍保留本机 Node Native Messaging 主机，不把凭证搬进浏览器，也不改变 Grok、Google 或自备 API 通道。

官方 SIWC 开源流程不要求共享客户端密钥或用户粘贴 API Key。合资格的 ChatGPT Plus/Pro 用户可明确授权应用使用计划，但账户、模型及额度仍受 OpenAI 限制。HTTP 预览要求流式消费与完整请求上下文，不能把旧 CLI thread 身份当作远端持久 Responses 会话。

## 决策驱动因素

- 移除 ChatGPT 对 Codex CLI 安装、版本、进程和私有 thread 生命周期的依赖。
- OAuth 注册、凭证交换、刷新、撤销与推理留在本机主机，浏览器不持有访问/刷新令牌。
- 登录使用官方 loopback OAuth，不读取、导入或修改其他应用的 Codex 凭证。
- 继续复用扩展的结构化结果、失败分类、预算与最小化上下文边界。
- 只迁移 ChatGPT；保留 Grok/Antigravity CLI 与现有 API 服务。

## 备选方案

### 继续使用 Codex CLI 或 app-server

可以沿用进程与 thread 管理，但仍要求额外安装并受 CLI 版本与协议约束，不满足完整直接 OAuth 切换。官方 app-server 文档是可选集成，不是此实现的运行时依赖。

### 在扩展内完成 OAuth 与 Responses

减少本机组件，但把访问/刷新令牌带入浏览器扩展存储及消息边界，并改变现有凭证保管与浏览器权限模型。不采用。

### 使用中转服务器或用户 API Key 代替订阅

中转改变隐私与部署边界；API Key 是不同计费路径，不能冒充 ChatGPT 计划授权。自备 API 继续作为用户明确选择的独立通道，不是 SIWC 的隐式替代。

## 决策

1. `connector/host.mjs` 继续作为 Node Native Messaging 入口；ChatGPT 由 `connector/siwc.mjs` 实现官方开源 SIWC，直接访问 OpenAI Models 与 Responses API。不保留 Codex CLI 回退或旧凭证导入路径。
2. 登录由主机启动临时 loopback 监听器，生成独立 state、nonce、PKCE S256；回调与身份验证、授权范围检查及令牌交换在主机完成。浏览器只接收登录入口、账户状态、模型列表及任务结果，不接收令牌、授权码或 PKCE verifier。
3. 主机数据目录的 `siwc.json` 保存主机 ID、签发的客户端注册、账户映射及凭证；POSIX 文件模式为 0600。Windows 的访问控制依赖系统账户及目录权限，不把 POSIX 模式包装成跨平台安全保证。日志、诊断、导出不得包含秘密。退出在锁内重读共享记录，清除当前账户与捕获的旧账户令牌，保留主机身份及非令牌注册。内存/磁盘捕获的不同刷新授权逐一尝试撤销，同一 client_id 下的不同轮换授权也不合并；撤销未确认时如实提示在 ChatGPT 设置中断开应用，不恢复已清除的本机授权。
4. 推理携带 OAuth `Authorization: Bearer` 直接请求 `https://api.openai.com/v1/responses`，固定 `store:false`、`stream:true`、`input` 数组。主机读取 SSE 到 `response.completed`，再接受结构化结果；`response.failed`、`response.incomplete`、提前断流不能成为成功缓存。
5. HTTP 不发送 `previous_response_id`、`conversation` 或预览不支持的 `temperature`、`max_output_tokens` 等参数。当前任务与所需有界历史随每轮 `input` 发送，不依赖远端持久会话；不扩展到音视频、Files 上传、转录或完整代理工具能力。
6. 主机追问历史只在内存，闲置 30 分钟过期，最多 50 会话、每会话最近 12 组问答；退出登录、切换账户或主机退出清除。扩展最多 30 天/每会话 40 轮的主动追问记录是独立本机数据，重启主机后可用有限已完成回合重建；无痕不写入此持久记录。
7. 扩展与主机一起更新并重新运行安装命令，再完成 SIWC 登录。保留实际扩展 ID 与来源校验；不要求安装 Codex。Grok/Google 仍检查各自 CLI，自备 API 的凭证与调用路径不迁移。
8. 凭证修改使用跨进程互斥：先完成含 PID 的私有 owner 文件，再以原子硬链接发布完整所有者 inode。活进程或空/无效 PID 锁不按年龄回收；仅确认 PID 已死才在每个旧 inode 的独立 recovery 互斥下重新核对并回收。中断或无法验证的恢复保守失败，不通过抢锁继续写凭证，错误不泄露私有路径。首次初始化与旧记录迁移也在同一锁内完成；共享记录的 authorizationEpoch 是非秘密 UUID，旧记录仅在缺少此字段时补写，保留主机身份、注册、令牌及其他字段，无效记录或世代值不覆盖。登录启动在锁内重读并捕获世代，回调提交在锁内重读并逐次核对；退出在清除令牌的同次原子写入中换新世代，即使尚无账户也留下取消墓碑。退出前其他进程的登录不能恢复令牌，退出后主动登录捕获新世代并可成功；刷新维持世代并在锁内拒绝旧世代请求。本地取消归属、generation 与写后回滚仍保留，不增加通用授权抽象。
9. Native 诊断开关和清空必须明确确认：configure(false) 先停当前进程记录再持久化，失败返回安全的 STORAGE_ERROR；扩展保存期望设置并报告 NATIVE_RPC，而不是成功。写入失败后重启可能读到旧开启配置，下次连接重试同步。清空标记仅在所有当前已连接主机明确确认后移除，任一失败保留请求；断开后下次连接重试，不为诊断暗中启动主机，不承诺清理未参与连接的独立主机。

## 结果

### 正面影响

- ChatGPT 订阅使用官方开源 OAuth 与直接 HTTP/SSE，不再依赖 CLI。
- Native 主机维持明确的凭证与网络边界；扩展不新增 token 保管路径或中转服务器。
- 有界历史和明确完成事件让重启、断流与失败行为可解释，不把部分结果当作完整交付。

### 代价与风险

- 主机承担 OAuth/OIDC 校验、注册持久化、刷新并发与撤销的维护责任。
- Loopback 登录需要浏览器与主机在同一台电脑；回调监听或网络受限会造成真实登录失败。
- 预览模型与参数限制可能变化，模型目录不保证账户访问；Plus/Pro 不代表无限调用。
- 每轮重发必要历史会增加请求量；扩展月度预算不代表 OpenAI 的真实额度或账单。
- `store:false` 只是不请求 Responses 持久存储，不能承诺服务商不处理或保留任何数据。

## 实施与验证

实现边界及数据生命周期见 [架构概览](../architecture.md)，迁移上下文见 [开发记录](../records/2026-10-03-chatgpt-siwc.md)。最终验收需运行 `npm run check`，并覆盖 [验证清单 5.15](../../verification-checklist.md#515-chatgpt-siwc-开源-oauth-与直接-responses) 的无 Codex 安装、登录/拒绝/超时、令牌刷新与撤销、SSE 失败与断流、多轮及重启恢复、凭证不出主机和 Grok/Google 回归。清单是验收要求，不是已执行证据。

退出方案是切换用户已配置的 API 或其他可用服务；若必须回退旧版本，应同时回退匹配的扩展与主机并使用该版本的登录方式，不在新实现中保留隐藏 CLI 兼容层。

官方协议依据：

- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
