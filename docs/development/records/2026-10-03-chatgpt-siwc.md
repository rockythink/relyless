# 开发记录：ChatGPT 订阅切换到 SIWC 开源 OAuth

- 日期：2026-10-03
- 状态：实现与本机验收完成；真实账户授权和 OpenAI 在线推理未验证
- 相关 Issue：[#49](https://github.com/rockythink/relyless/issues/49)（发布前补充维护者对话决策追踪）
- 相关 PR：[#50](https://github.com/rockythink/relyless/pull/50)
- 相关 ADR：[0007：ChatGPT SIWC 开源 OAuth 与本机直接 Responses](../decisions/0007-chatgpt-siwc-native-host.md)

## 背景

用户要求 ChatGPT 订阅通道不再调用本机 Codex CLI，而使用官方 SIWC 开源 OAuth 的账户注册与授权，通过 OAuth Bearer 令牌直接调用 Responses API。既有浏览器扩展与 Node Native Messaging 主机的信任边界必须保留，不能把 token 写入浏览器，也不能用自备 API Key 或中转服务冒充订阅计划调用。

## 目标

- 本机只需 Node.js 20+ 与注册到实际扩展 ID 的 Native 主机，不要求 Codex 安装或登录。
- 合资格的 ChatGPT Plus/Pro 用户从设置发起官方登录，在同机 loopback 回调中完成明确计划授权，随后刷新账户与可用模型。
- 求助、领域识别、选段/本页翻译、摘要、个性化和追问继续使用原有任务与结构化结果契约。
- 认证、额度、模型访问、网络、断流和结构化结果错误保持真实失败，不提交伪成功。
- 文档区分 OAuth 凭证、主机临时会话、扩展主动追问记录与第三方数据保留。

## 非目标

- 不改 Grok/Google（Antigravity）的 CLI 适配或自备 API 通道。
- 不导入 Codex 凭证、不提供新旧协议兼容层、不增加云端中转。
- 不扩大阅读范围、改变按需模式或增加被动请求。
- 不将 SIWC 实现为音视频、Files 上传、转录或通用代理工具平台。
- 不改写旧 ADR、旧开发记录或已有用户工作区说明。

## 实现边界

- `connector/host.mjs` 仍负责 Native Messaging 来源、消息与生命周期；ChatGPT 客户端切换为 `connector/siwc.mjs`，Grok/Antigravity 继续由原有适配处理。
- 主机内完成注册、state/nonce/PKCE、loopback 回调与身份校验、令牌交换/刷新/撤销。登录入口与脱敏状态可返回扩展；访问/刷新令牌、授权码及 PKCE verifier 不走扩展消息。
- 安装程序不查找或验证 Codex 可执行文件；ChatGPT 安装与检查只验证所需 Node/Native 配置，其他 CLI 后端仍保留各自检查。
- 直接 Responses 请求使用 OAuth Bearer、`store:false`、`stream:true`、`input` 数组。主机完整读取 SSE，并在明确完成后验证任务结果；不依赖 CLI thread、`conversation` 或 HTTP `previous_response_id`，也不发送 SIWC 预览不支持的参数。
- HTTP 每轮重发必要历史。主机内存会话过期或主机重启后，通过扩展提供的有限已完成追问重建，而不是伪造可续接的服务端 thread。
- 升级需要扩展与主机配套更新、用实际扩展 ID 重新运行安装命令并 SIWC 登录；旧 Codex 登录状态不迁移。

## 数据、权限与费用

- **主机凭证**：`dataDir/siwc.json` 保存主机 ID、签发的注册/账户映射与 OAuth 令牌；POSIX 文件模式 0600，Windows 依赖账户与目录访问控制。秘密不进入浏览器存储、网页、日志、诊断或导出。
- **主机临时历史**：只在内存保留，闲置 30 分钟过期，最多 50 会话、每会话最近 12 组问答；退出登录、切换账户、主机退出清除，不落盘。
- **扩展追问记录**：沿用本机 IndexedDB 最多 30 天/每会话 40 轮的主动问答记录与无痕不落盘边界；它不属于默认关闭的阅读记录，也不随阅读记录导出。模型仅接收所需有限历史。
- **清理与撤销**：清理扩展阅读数据不等于 ChatGPT 退出；订阅面板退出清除本机账户令牌并尝试远程撤销，远程撤销未确认时提示用户在 ChatGPT 设置中断开应用。主机 ID 与非令牌注册信息可复用。
- **远程处理**：认证与推理直接访问 OpenAI，不增加 RelyLess 服务器。`store:false` 不是第三方零保留承诺，正常账户/安全/网络元数据与内容处理仍受服务商条款约束。
- **权限与费用**：继续使用已有 Native Messaging 边界，ChatGPT 不要求浏览器保管 OAuth 凭证或以 API Key 计费。计划授权与额度由 OpenAI 决定；扩展预算只是本机估算，不等于计划可用量。用户显式配置的故障转移按既有配置与确认边界执行。

## 风险与回滚

- Loopback 监听、回调校验、OIDC 身份或计划授权失败会阻断登录；不能绕过验证或仅凭模型目录宣布可用。
- 凭证刷新/撤销、文件权限与账户切换需覆盖失败场景；不能把服务端原始敏感错误直接导出。
- SSE 失败、incomplete、提前 EOF 与无效任务结果不能缓存为成功；停止后迟到结果不能覆盖已停止 UI，已发送请求仍可能计费。
- 主机内历史与扩展持久追问记录寿命不同，删除/重启/无痕/账户切换需分别验收，避免串会话或误宣称远端持续存储。
- 如 SIWC 不可用，用户可明确切换已配置的 API 或其他可用服务。整版回退必须同时回退匹配的扩展与主机；新实现不保留 Codex 兼容路径。

## 验证证据

- 官方协议资料：已查阅 [登录](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)、[模型与推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)、[预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)；资料约束与实现验收要求分开记录。
- 自动检查：ChatGPT 切换时 `npm run check` 通过（503 pass、0 fail，45 个测试文件）；订阅专用夹具覆盖 state/nonce、缺失授权范围、OIDC 签名、刷新令牌轮换与并发、退出撤销、Responses Bearer 请求字段、额度失败、不完整流、提前 EOF、本页翻译错误及多轮追问。
- 发布前全量检查：527 pass、0 fail，46 个测试文件。Ubuntu CI 暴露既有路由与 PDF 测试未还原全局 `fetch`、替换了真实 loopback 请求；已补充路由的每测试还原边界及 PDF 的有效 `afterAll` 清理，同时还原 PDF Chrome 夹具，未放宽 OAuth 校验。路由与 SIWC 两文件组合由 9 fail 修复至 23 pass、0 fail。
- 本机主机冒烟：实际启动 `connector/host.mjs`，发送 Native Messaging 帧；未登录 `status` 返回已连接/未认证，`models` 返回 `AUTH`；凭证文件初始化为无账户的主机 ID。隔离 HOME 安装后从 Native manifest 的启动器再次收到上述未登录状态，覆盖 macOS `/var` 软链接路径；安装/升级/卸载由回归测试覆盖。
- 浏览器/视觉：Chrome for Testing 加载解包扩展，设置中的 ChatGPT 卡片显示“本机连接器未连接”和安装指引；卡片截图与 axe-core 检查（0 违反）通过。没有安装测试浏览器对应的 Native Host，也未使用真实 Plus/Pro 账户完成官方登录或在线 Responses；已授权、停止和退出状态未进行真实浏览器演练。

- 发布前审查修复（#50）：取消/退出/关闭以尝试归属与 generation 阻断迟到登录、刷新及推理；凭证写入串行化并恢复死进程刷新锁；终止性刷新错误清除令牌而保留注册，临时服务失败保留授权；存储错误不返回路径，非 JSON HTTP 错误仍按状态分类。
- 修复回归：两个 OAuth 测试文件修复前 34 pass、20 fail，修复后 54 pass、0 fail；全套 `npm run check` 为 547 pass、0 fail。SIWC 共 28 项，覆盖 token/JWKS 阶段的取消、退出、关闭，旧回调不关闭新登录、退出后重启不恢复令牌、失效/临时刷新、死锁所有者、跨客户端刷新、HTTP 分类和存储路径脱敏。
- 发布前原生冒烟：真实 Node 子进程、Native 帧与实际 loopback 回调，OAuth/模型服务使用隔离响应夹具；观察取消旧回调返回 400 且保留新登录尝试、随后登录成功、模型目录、分类 `tech`、空响应体限额 `RATE_LIMIT` 和退出后无令牌。不代表真实 Plus/Pro 在线验证。

## #51 审查追加修复（#53 初始版本）

- 登录启动阶段也持有可取消的尝试归属；listen 完成后检查 generation/关闭状态，失效尝试关闭自己的服务器，不创建新的待授权流程。
- 该阶段的失效刷新锁恢复策略已由下述 #53 的原子发布与按 inode 互斥回收替代；空/无效 PID 锁不再允许按年龄回收。
- 退出以锁内持久化的当前账户为准，清除令牌并撤销该账户；其他主机切换账户后，退出及重启仍保持未认证。
- POSIX 只读目录测试在 Windows/root 环境跳过，不用 chmod 假设限制 root。
- 当时新增启动取消/退出/关闭、共享账户退出与无主锁回归；四项失败前回归均失败，修复后 SIWC 33/33、全套 552/552。真实 Node Native 子进程冒烟再次通过；OAuth/HTTP 均为响应夹具，真实订阅未验证。此为 #53 初始版本 63d7d33 的证据，不代表最终修复检查。

## 最终发布安全语义同步（#53）

- SIWC 互斥先写完含 PID 的私有 owner 文件，再以原子硬链接发布完整所有者 inode；活进程锁与空/无效 PID 锁均不按年龄回收。仅确认 PID 已死才通过每个旧 inode 独立的 recovery 硬链接保护回收，删除前再次核对 inode；中断后无法确认安全的恢复保守失败，不强抢锁或泄露私有路径。
- 退出在锁内重读共享账户，清除当前及捕获的旧账户令牌并保留非令牌注册；内存与磁盘捕获的不同刷新授权逐一尝试撤销，同一 client_id 的不同轮换授权也不合并。远端未确认如实报告，不恢复本机授权。
- Native 诊断 configure(false) 先停止当前进程内记录，再持久化配置；磁盘失败返回安全的 STORAGE_ERROR。扩展期望设置已保存，但主机未确认时报告 NATIVE_RPC，不伪装同步成功。写入失败后的主机重启仍可能读取旧开启配置，下次连接重新同步。
- 清空先删除扩展日志并持久保留待清空请求；所有当前已连接主机均明确确认成功后才移除标记，任一失败报告未完成并保留请求。无连接时下次连接重试，不暗中启动主机；其他独立主机不在本次删除范围内。
- 上文 552/552 与 Native 冒烟是 #53 初始版本 63d7d33 的历史证据；本次最终修复验收单列如下，真实 ChatGPT 订阅仍未验证。

### #53 已执行验收（由发布验收工作提供）

- `npm run check`：556 pass、0 fail，46 个测试文件；定向 SIWC/诊断回归：55 pass。不把本 PR 初始版本的 552 项计数当作最终检查。
- 真实 Node Native Messaging 帧冒烟覆盖 ChatGPT 与 Grok 两通道：OAuth/HTTP 服务使用隔离响应夹具，观察模型目录、分类、429 失败脱敏及退出；真实启动阶段 cancel/logout/close 场景均通过。不代表真实订阅授权或在线推理验证。
- 两个真实 Node 子进程运行生产 `runHost`，以生产 `subscription.js` 和 `diagnostic-service.js` 走诊断 RPC：配置路径被目录占用时，两主机实际 enabled:false、迟到 append 不写文件，扩展报告 NATIVE_RPC 且期望关闭设置持久保存；单主机日志路径非空目录导致清空失败时，另一主机删除成功，待清空标记仍跨存储保留；修复存储后 connected() 重试、两主机均删除确认，标记才移除。安全错误不暴露私有路径。
- Chrome 实际加载源码设置页（当时 manifest 仍为 0.6.0，不是最终 0.7.0 发布包）：用键盘 Space 操作诊断开关，DIAG_SET 失败由响应夹具强制触发；checkbox 保持关闭、红色错误和未同步说明保留。axe-core 为 0 violations、1 incomplete，页面错误为 0；此 UI 证据不是生产 Native 存储失败链路，后者由上一项单独覆盖。

### #53 跨进程退出授权世代修复（评论 4176095540）

- 共享 siwc.json 增加非秘密 UUID authorizationEpoch：登录启动在原有凭证锁内重读并捕获世代，回调提交在锁内核对；退出在清除令牌的同次原子写入中换新世代，没有账户时也留下取消墓碑。旧世代回调返回 400 / Authorization cancelled，不写令牌；退出后主动登录捕获新世代并可成功。本地尝试归属、generation 和写后回滚不变。
- 首次初始化与旧记录缺少世代时的补写改为同锁串行化，防止另一进程先读取不存在文件、稍后初始化覆盖主机身份或退出墓碑。保留既有注册、令牌与未知字段，无效 JSON、不支持的记录形状及无效世代值不覆盖。刷新保留世代，并在锁内拒绝退出前旧进程的刷新请求，不借用退出后新登录的授权。
- 失败前最小行为回归实际输出：0 pass / 3 fail；token 与 JWKS 两阶段的旧回调均 Expected 400 / Received 200，真实 Node 并发首次启动得到两个不同 hostId。修复后 bun test tests/siwc.test.js：44 pass / 0 fail / 177 expect() calls，覆盖初次与已有注册登录、跨客户端退出、磁盘和重启无令牌、新登录成功、旧记录迁移、坏记录不覆盖、世代保持与旧进程刷新取消，以及真实 Node 初始化竞争。
- 本次真实 Node Native 帧与 loopback 的 ChatGPT 冒烟覆盖模型目录、分类、空响应体 RATE_LIMIT、退出及取消旧回调保留新尝试；启动 cancel/logout/close 均正常退出，不返回 auth URL。OAuth/HTTP 使用隔离响应夹具，无真实账户网络。
- 发布主控实际运行两个 Node 生产 runHost，共享 dataDir：A 的真实 HTTP 回调在 JWKS 响应前由 IPC 暂停，B 完成 logout，恢复 A 后旧回调 400、磁盘无令牌，A 后续主动登录 200，最后退出与两个进程正常关闭。不代表真实订阅授权或 OpenAI 在线推理。
- 最终整合后 `npm run check`：568 pass / 0 fail，46 个文件；真实双主机退出回调和完整双主机诊断 RPC 再次通过，包括配置失败但清空成功时 mirror:false、修复配置后 mirror:true。

### 有效令牌缓存与撤销时限复审

- 三项未过期令牌的模型缓存/推理/状态回归，以及双 grant 撤销并发回归，修复前 0 pass / 4 fail。令牌未过期也在锁内校验共享世代，目录缓存先取得有效授权；状态查询重读共享记录。相关 grant 并发撤销，不按 grant 数累加既有网络超时。
- 修复后 SIWC 48 pass / 0 fail；完整 `npm run check` 572 pass / 0 fail（46 文件）。真实双 Native 子进程证明两个 grant 在任一完成前均进入撤销，另一主机的未过期令牌/模型缓存被 CANCELLED 拒绝，随后状态未认证；旧回调取消和退出后新登录继续通过。OAuth/HTTP 为隔离响应夹具，不代表真实订阅账户。

### 迟到授权远端清理复审

- 已取得但未成功提交的回调 grant 在凭证锁外尝试撤销，涵盖共享退出代次拒绝与本地取消/验证失败；撤销未确认在回调页和适用账户状态中明确提示，不覆盖新的尝试，不持久保存被拒令牌。复用同一有界并发撤销流程，移除旧重复实现。
- 两项撤销成功/503 回归修复前 0 pass / 2 fail，修复后通过；SIWC 50 pass / 0 fail，完整 `npm run check` 574 pass / 0 fail。真实两个 Native 子进程分别证明迟到 grant 撤销成功与失败告警，均不恢复本机账户，后续新登录成功，未过期缓存拒绝与双 grant 并发撤销继续通过。响应为隔离夹具，不代表真实账户或在线撤销验证。

#### 回调清理等待与取消归属（评论 4176211612）

- 每次处理中的回调记录独立 completion/outcome；取消立即分离监听器和尝试归属，只等待已捕获的本进程回调清理，不再通过无关凭证锁猜测完成。新的主动登录可独立开始；旧回调不能清除新尝试或覆盖后续已完成登录的状态。关闭也等待先前已分离的回调，凭证写入失败或回调页响应失败仍在 finally 中结算 completion。
- 取消/关闭与退出使用 35 秒整体清理预算，低于 Native RPC 的 45 秒；同一退出预算传入凭证锁等待与撤销网络。退出同时推进回调清理、本机 grant 清除及已捕获 grant 撤销，不因回调 503 或等待超时跳过本机退出；本机写入已完成后，远端未确认如实报告，不能返回成功或恢复本机令牌。此预算不宣称解决首次启动、文件系统挂起或不可验证活进程锁的所有情形，文件锁仍保守失败。
- 六项 cancel/logout/close × 撤销成功/503 的门控行为回归修复前为 0 pass / 6 fail，均因动作在清理完成前返回而失败；修复后通过。原有 token/JWKS 取消测试改为先证明动作仍 pending，再释放受控响应门并等待结果。回调专项最终 12 pass / 0 fail / 67 expect() calls，另覆盖无关活锁不阻塞取消、关闭等待已分离清理、新登录不受旧 503 状态污染、HTTP finish 异常结算、整体预算超时仍保持本机退出。额外计时器归属回归先失败于旧 cleanup 的 503 覆盖新登录 error:null，修复后通过：正常到期仍取消原尝试，但只允许所属尝试发布最终错误。SIWC 文件整套较早一次执行为 65 pass / 0 fail；最终整合检查由发布主控单列，不以此替代。
- 临时 /tmp/relyless-callback-cleanup-smoke.mjs 使用真实生产 Node runHost、Native Messaging 帧及 loopback HTTP：cancel/logout 回复和 graceful stdin close 均在回调与撤销两个门放开前保持未完成，200 才成功，503 返回/记录明确未确认；logout 在迟到 grant 撤销门仍关闭时，磁盘已有账户令牌已清除。另注入真实生产凭证 rename 写入失败，验证取消结算为脱敏 STORAGE_ERROR、不遗留回调清理。既有 Native startup cancel/logout/close、ChatGPT OAuth/模型/分类/RATE_LIMIT、跨主机迟到回调成功/失败 smoke 均继续通过，未修改跨主机脚本。所有 OAuth/HTTP 使用签名响应夹具，无真实账户或 OpenAI 在线请求。


### 私有锁所有者崩溃清理复审（评论 4176211620）

- 凭证锁和刷新锁发布后立即移除私有 owner 名称。启动只清理严格匹配命名且 PID 已确认死亡的普通私有文件；包括尚未发布的空文件，不碰活进程、无法验证的所有者、符号链接、规范锁与 recovery guard。
- 两项真实子进程中断回归修复前 0 pass / 2 fail，修复后通过。真实 Node Native 主机分别在私有 owner 写入前、规范锁发布后的持锁阶段被强制中断；下一主机状态成功且未认证，私有文件不遗留，活进程/recovery guard/无关文件保持原状。没有账户或网络请求。

### 刷新网络与本机退出锁分离（评论 4176211616）

- 刷新沿用跨进程锁实现，但单独串行于 siwc.json.refresh.lock；siwc.json.lock 只负责共享授权快照、提交前核对与原子写入，不跨越 token、discovery、JWKS 或撤销网络。未过期令牌和模型缓存仍先校验共享授权；同客户端合并与多客户端旋转后复用有效令牌不变，不增加隐藏重试。
- 网络前及提交前核对捕获的 authorizationEpoch、generation、active account、subject 与 refresh grant。退出、取消或被更新的授权拒绝迟到结果；已取得但未提交的新 grant 在凭证锁外尝试撤销，未确认通过安全错误和适用的未认证状态提示，不覆盖新账户。terminalAuth 仅清除仍匹配的捕获授权，不能抹除另一客户端刚完成的新登录。
- 失败前 gated refresh 回归为 0 pass / 5 fail：token/JWKS × 撤销成功/503 四项都证明另一客户端 logout 被网络门阻塞；新登录与旧 terminal refresh 交错项因同一凭证锁阻塞而超时。改为真实另一客户端退出、磁盘清空后才放开网络门，并保留本地取消、迟到 grant 撤销、重启无令牌及带门的多客户端单次旋转覆盖。等待独立刷新锁时退出的附加回归先失败于 TIMEOUT 而非 CANCELLED；通过 generation 核对保留取消类别，不影响真正时限错误。刷新/未过期共享验证定向测试最终为 18 pass / 0 fail / 94 expect() calls。
- 临时 /tmp/relyless-refresh-logout-smoke.mjs 使用两个真实生产 Node runHost、共享隔离 dataDir、Native 帧与签名 OAuth/HTTP 响应夹具。四项 token/JWKS × 撤销成功/503 场景，另一主机 logout 在网络门放开前 3–9ms 返回且磁盘已清空；放开后刷新 CANCELLED、新 grant 尝试撤销、503 安全报告未确认、磁盘未复活，两进程正常关闭。原有 ChatGPT Native OAuth smoke、跨主机迟到回调成功/失败 smoke 均通过。无真实账户或 OpenAI 在线请求；完整整合检查由发布主控另行记录。

### 最新整合验收（回调清理、刷新锁分离、崩溃清理）

- `npm run check`：594 pass / 0 fail，47 文件、3085 assertions；SIWC 与锁清理定向回归 70 pass / 0 fail。此前 556/568/572/574 计数只对应各阶段快照，不是本次最终整合结果。
- 主控重跑真实 Node Native 主机：cancel/logout/graceful close × 撤销 200/503，真实 rename 失败 completion 结算，token/JWKS 网络挂起时另一主机退出仍先返回并清除磁盘授权，两个崩溃 owner 阶段恢复；既有 ChatGPT/Grok OAuth、启动取消、跨主机退出及诊断真实 RPC 失败与重试冒烟继续通过。OAuth/HTTP 是隔离签名响应夹具；没有真实订阅账户、在线模型调用或真实远端撤销验证。

## 后续事项

无已确认的额外范围；上述集成验收属于本次切换的交付要求，不是额外功能。
