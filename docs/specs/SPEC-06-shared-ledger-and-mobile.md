# SPEC-06：共享任务账本、任意机器看板、单入口移动控制台

> 状态：**草案，待负责人批准**。日期：2026-10-24。
> **Phase 1 已落地（2026-10-24）**：契约与内存实现 `server/sharedledger/`，含并发认领、租约过期、独立评审、签名、状态机、事件与列表测试；`go test ./server/sharedledger` 通过。真实节点签名、UI 尚未开始。
> **Phase 2 已落地（2026-10-24）**：NATS JetStream 适配器 `server/sharedledger/nats.go`、共享看板只读 API `GET /api/v1/ledger/tasks`、`HERDR_WEB_LEDGER_NATS` 注入；NATS 生命周期与并发认领测试通过。
> **Phase 2.5 已落地（2026-10-24）**：job start 创建/认领 `dev_claimed` 共享任务，status `done/error` attest `dev_done` 并释放本地执行槽，stop 取消共享任务；测试覆盖。
> **Phase 5a 已落地（2026-10-24）**：同一仓库单 merge writer（`ErrMergeBusy`），Tailscale node key 作为账本/ fleet 身份，节点签名进入 job attest；内存与 NATS 测试覆盖。
> **Phase 5b 已落地（2026-10-24）**：job/dispatch 增加 `role`（dev/review/test/audit/merge），offer 检查共享任务是否到达该角色；本地 ledger 记录角色；review 角色端到端测试通过。
> **Phase 5c 已落地（2026-10-24）**：orchestrator 每 10s 从共享账本自动启动下一角色（dev_done→review→test→audit→merge），`HERDR_WEB_ORCHESTRATOR=off` 可关闭；offer 增加独立节点检查；测试通过。
> **Phase 6 已落地（2026-10-24）**：GitHub/Gitea 仓库注册（token 仅从环境变量读取）、issue 列表（过滤 PR）、从 issue 创建共享任务；任务记录 `repo`/`issue`；测试覆盖。
> **Phase 6b 已落地（2026-10-25）**：pull request 创建/合并 API、GitHub/Gitea webhook（HMAC 校验、issue opened 建任务、重放幂等）、任务 `pr` 关联；测试覆盖。
> **Phase 6c 已落地（2026-10-25）**：orchestrator 对 `audit_approved` 任务自动开 PR（无 PR 时）并通过 provider 合并、attest `merged`；provider 失败释放 merge lease 供重试；测试覆盖。
> 上位约束：[SPECS](../SPECS.md) 的不变量与安全边界仍然有效；本规格只扩展“任务状态与入口”，不改变“仅本人受控设备”的前提。
> 本文的目标是防止跑偏：先定契约，再写代码；每个阶段都有可执行验收。

## 0. 要解决的问题

当前 herdr-web 是“每台机器一个控制台”：

- 看 N 台机器的任务，要开 N 个 Tab；
- 发布任务要登录指定的机器；
- 手机上是 herdr 的终端界面，快捷指令、`/` 指令、`@` 指令、文件上传都很别扭；
- 任务状态在每台机器的本地 ledger，没有全局视图；
- 评审、开发、测试、审核、合并靠 operator 在机器之间指挥。

目标不是“再做一个跳板机”，而是：

1. 任务状态进入**共享追加账本**，任何机器都能读、按能力认领、签名提交；
2. **一个 PWA** 连接 N 台机器，切换服务器像切换工作区，不再开 N 个 Tab；
3. **任意机器发布任务**，任务由账本路由到能执行的机器，而不是由某台中心机指挥；
4. 手机端有**移动优先的输入层**：快捷动作、`/` 命令、`@` 提及、文件上传、草稿；
5. Hermes 只作为**可选的人类入口**，不做唯一调度中心。

## 1. 目标与非目标

### 目标

- 共享账本：任务、认领、租约、评审/测试/审核签名、合并队列；
- 任意机器看板：只读视图一致，断线重连后收敛；
- 单入口：一个 PWA 内切换服务器、统一任务看板、统一发布表单；
- 移动输入：快捷动作、命令面板、`@`、上传、草稿、语音（可选）；
- 端到端可审计：每个状态迁移都有节点身份和产物摘要。

### 非目标（本规格不做）

- 公链/拜占庭共识/代币；
- 多租户、公网暴露、匿名贡献者；
- 跨机器自动合并**任意**代码（只做受控 merge queue，冲突仍交人工）；
- 任务沙箱（仍按 SPECS 的“仅本人受控设备”边界）；
- 用 Hermes 替代账本或成为唯一入口。

## 2. 新增/修改的不变量

| ID | 约束 |
| --- | --- |
| INV-07 | 共享账本是任务状态的唯一事实来源；本地 ledger 只作为离线缓存和审计副本。 |
| INV-08 | 认领必须 CAS + 租约；同一 taskId 在同一角色上最多一个有效租约。 |
| INV-09 | 开发、评审、测试、审核不能由同一节点自证；合并由单写者队列串行执行。 |
| INV-10 | 任何节点都可以读账本和看板；写账本必须带节点身份签名。 |
| INV-11 | 网络不明/租约过期不等于任务失败；进入 `unknown`，人工或超时回收，不自动复制。 |
| INV-12 | 移动端入口不得降低安全边界；PWA 仍只连接私网/Tailscale 地址。 |

## 3. 共享账本

### 3.1 传输选型（建议，待批准）

**建议：NATS JetStream（KV + Stream）**，3 节点集群，作为共享账本。

- KV 提供 `Create/Update` 的 revision CAS，正好用于认领；
- Stream 保存完整事件，供审计和回放；
- Go 客户端轻量，适合现有 Go 服务；
- 3 节点可放在任意 3 台 Tailscale 机器上，不引入“唯一中心机”；
- 1C1G 节点可以只做客户端，不跑 NATS。

备选：git 仓库 + 签名提交（无新服务，但实时性和 CAS 较弱）；SQLite + Litestream（简单，但多写者协调差）。**未批准前不写死实现**；接口按下面的抽象定义。

### 3.2 数据模型

```text
Task {
  id, title, prompt, cwd, branch, kind, weight
  state, version, role
  ownerNode, leaseUntil, attempts
  artifacts: { commit, tests, report, diff }
  attestations: [{ role, node, commit, digest, signature, at }]
  createdAt, updatedAt
}
```

KV key：`tasks.<id>`；事件 stream：`task.<id>.<state>`。

### 3.3 状态机

```text
proposed
  -> dev_claimed -> dev_done
  -> review_claimed -> review_approved | changes_requested
  -> test_claimed -> test_passed | test_failed
  -> audit_claimed -> audit_approved | audit_rejected
  -> merge_queued -> merged
任意状态 -> cancelled | unknown
```

- `changes_requested` / `test_failed` / `audit_rejected` 回到 `proposed` 或 `dev_claimed`，保留历史；
- 每个迁移写一条事件，带 `fromVersion`，CAS 失败即重读重试；
- `unknown` 只能由租约过期或节点心跳丢失进入，不能由普通错误直接进入。

### 3.4 认领与租约

- 节点按 `role` + `kind` + `cwd`/资源能力过滤可认领任务；
- 认领：`KV.Update(key, newValue, revision)`；失败即别人先到；
- 租约默认 30 分钟，心跳 60 秒；过期后任务回到 `proposed`，记录 `attempts++`；
- 同一节点不能同时持有同一任务的 dev 和 review 租约；review/test/audit 必须不同节点；
- 任务完成/失败必须显式 `attest`，不能只靠 workspace 关闭。

### 3.5 评审、测试、审核、合并

- 开发提交：commit SHA + 变更摘要 + 自测结果；
- 评审：独立节点读 diff，写 `review_approved` 或 `changes_requested`；
- 测试：独立节点在干净 worktree 跑指定命令，记录命令、退出码、日志摘要；
- 审核：独立节点检查前两者签名与产物摘要；
- 合并：`merge_queued` 由单写者按顺序 rebase/merge；冲突转人工，不自动猜；
- 所有 attestation 用节点密钥签名；账本只接受签名匹配的迁移。

## 4. 任意机器看板

- 看板是账本的只读投影：`GET /api/v1/ledger/tasks?state=&role=&node=`；
- 每台机器的 herdr-web 都提供同一视图；数据来自账本，不来自本机 ledger；
- 断线时显示最后快照 + `stale` 时间，不显示空列表；
- 任何机器可以打开同一个任务详情：状态、租约、attestation、commit、diff、日志摘要；
- 写操作（认领、attest、cancel）必须带节点身份；只读看板可以匿名（在私网内）。

## 5. 单入口 PWA：服务器切换

- 一个 PWA 保存多个 herdr-web 地址（Tailscale 主机名/IP），masthead 提供服务器切换；
- 切换服务器不刷新页面：连接池按地址复用；每个服务器显示在线/离线/版本；
- 统一任务看板：账本视图与服务器无关；本机 pane/terminal 视图跟随当前服务器；
- 发布任务：在任意服务器/任意机器填写，写入账本；目标由账本按能力/租约选择；
- 深链接：`/tasks/<id>`、`/servers/<host>/panes/<pane>` 可分享；
- PWA：manifest + service worker；离线壳、缓存只读看板；写操作离线时排队并明确显示“未提交”。

## 6. 移动端输入层

移动端不再依赖 herdr 的全屏 TUI 作为唯一输入：

- **快捷动作**：新建任务、认领、评审通过/打回、测试、审核、停止、收集；
- **命令面板**：`/` 触发，支持 `/task`、`/claim`、`/review`、`/test`、`/audit`、`/merge`、`/stop`、`/collect`；
- **`@` 提及**：agent、workspace、pane、文件、任务；
- **文件上传**：相机/相册/文件，走现有 upload 接口，显示进度和失败重试；
- **草稿**：按任务/pane 保存，切换服务器不丢；
- **语音输入**（可选）：Web Speech API，失败回退键盘；
- **终端镜头**：需要全屏 TUI 时切 xterm，不在移动端默认展示；
- 所有动作有触控目标 ≥ 44px、safe-area 适配、键盘不遮挡输入。

## 7. Hermes 的定位（可选）

- Hermes 是**人类入口/控制面**：Telegram/Slack 等 gateway、记忆、skills、cron；
- 它读写共享账本，不拥有账本；不承担唯一调度；
- 任意节点可以临时起一个 Hermes，或没有 Hermes 也能工作；
- 新机器引导：Tailscale 短期 auth key + 签名 bootstrap skill；Hermes 可触发，脚本可手动执行；
- 不给 Hermes 唯一的 SSH/发布密钥；按节点最小权限。

## 8. 验收标准

### 8.1 账本

- [ ] 两个并发认领同一任务：只有一个成功，另一个得到 `conflict`，账本只有一个租约；
- [ ] 租约过期后任务回到可认领，`attempts` 增加，旧节点后续 attest 被拒绝；
- [ ] 同一节点不能同时认领同一任务的 dev 和 review；
- [ ] 未签名/签名不匹配的迁移被拒绝；
- [ ] 账本重启/节点重连后看板收敛到同一状态；
- [ ] 事件可回放，能从空状态重建当前任务视图；
- [ ] 合并队列串行；冲突进入人工，不自动覆盖。

### 8.2 看板与入口

- [ ] 任意两台机器打开同一任务，状态/租约/attestation 一致；
- [ ] 一个 PWA 内切换 3 台服务器，不刷新、不丢草稿；
- [ ] 任意服务器发布任务，账本可见，目标按能力认领；
- [ ] 离线时看板显示 stale，写操作显示“未提交”，恢复后不重复提交；
- [ ] 深链接可打开任务/服务器/pane。

### 8.3 移动端

- [ ] iPhone Safari / Android Chrome：快捷动作、`/`、`@`、文件上传可用；
- [ ] 键盘弹出不遮挡输入；横竖屏切换不丢草稿；
- [ ] PWA 可安装；service worker 更新不导致白屏；
- [ ] 终端镜头可按需打开，默认不加载全屏 TUI。

### 8.4 回归

- [ ] `go test ./...`、`npm --prefix web run test:unit`、Playwright 通过；
- [ ] 现有 SPEC-01..05 的验收不回退；
- [ ] 新增 HTTP/浏览器用例在专用 `.env.test` 环境执行（当前仓库尚无 `.env.test`，先建立测试装置）。

## 9. 实施阶段

1. **账本契约与假实现**：定义 Go 接口、事件 schema、CAS/租约语义；用内存/NATS 假实现写并发测试；不改 UI。
2. **共享账本落地**：NATS JetStream（或批准的备选）；本地 ledger 迁移为缓存；看板只读 API。
3. **单入口 PWA**：服务器切换、统一看板、深链接；现有 console 作为连接目标。
4. **移动输入层**：快捷动作、命令面板、`@`、上传、草稿；PWA 安装。
5. **任务流水线**：dev/review/test/audit/merge；签名与合并队列；故障注入。
6. **Hermes 可选入口**：gateway 读写账本；bootstrap skill；不做唯一入口。

每阶段结束必须更新 `docs/SPECS.md` 的状态，并附可执行验收结果；未通过的阶段不进入下一阶段。

## 10. 风险与待决策

| 风险/决策 | 说明 | 建议 |
| --- | --- | --- |
| 账本选型 | NATS 引入新服务；git/SQLite 更简单但实时/CAS 弱 | 先批准 NATS 3 节点，或明确备选 |
| 节点身份 | 现有服务无认证；账本写入必须签名 | Tailscale node key/SSH key + 签名事件；不把私网可达当授权 |
| 自证与串谋 | 同一人控制多节点仍可串谋 | 评审/测试/审核不同节点 + 抽样人工；不宣称绝对防串谋 |
| 合并冲突 | 自动合并可能破坏代码 | 单写者队列 + 冲突人工；不自动猜 |
| 移动端范围 | 全功能移动端成本高 | 先做“看板 + 发布 + 审批 + 上传 + 草稿”，终端为镜头 |
| Hermes 中心化 | 唯一入口会重新中心化 | 可选、可多实例、账本不依赖它 |
| 1C1G 资源 | NATS/浏览器/PWA 都有成本 | NATS 只在 3 台较大节点；1C1G 只做客户端 |

## 11. 批准门槛

本规格在以下条件满足前不进入实现：

- 负责人确认账本选型（NATS / git / SQLite）；
- 确认节点身份方案（Tailscale key / SSH key / 其他）；
- 确认“评审/测试/审核必须不同节点”的强度；
- 确认移动端第一阶段范围（是否包含终端镜头）；
- 在专用测试环境建立 `.env.test` 与并发/断线用例。
