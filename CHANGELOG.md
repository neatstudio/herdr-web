# 更新记录

## 2026-10-24（第二轮：审查问题修复）

对照 [docs/review-2026-10-24.md](docs/review-2026-10-24.md) 逐条核实并修复仍存在的问题。

### 安全

- 更新时下载文件若无法应答 `-version`（或版本与发布不符）拒绝安装——不再接受"问了没答"的文件（SEC-01 收紧，可信发布改造仍是决策项）。
- `POST /api/v1/fleet/job/stop` 只代理本机分发过的 `host+workspaceId`，不认识的组合返回 404 `unknown_job`（部分收敛 SEC-03 的转发面）。

### 并发与逻辑

- `POST /api/v1/herdr/job`：taskId 判重与容量检查并入同一把锁的原子预留；同 ID 并发只有一个创建工作区（其余 409 `task_starting`），并发新任务不能突破 `HERDR_WEB_MAX_JOBS`；market 分发收到 409 标记 `unknown` 并停止换机。
- 工作区建好但 agent 启动/下发失败时，自动 `workspace.close` 并释放预留槽——不再留下无人计数的工作区。
- fanout 分发没有任何机器启动时同样返回 `ok:false`（此前恒真）。
- 分发 id 加随机后缀，同一秒多次发送不再撞号导致重试找错记录。
- 前端：尊重 `ok:false`，显示每台机器拒绝原因并保留输入；`retryDispatch`/`fetchDispatches` 正确处理 HTTP 200 + `ok:false` 与瞬时失败（失败轮询保留旧数据）；分发 API 的非 2xx 响应不再丢失服务端错误信息。
- UI：fleet 全屏页 z-index 低于主机面板，看板上 stop/retry 按钮被面板挡住点不到——`.sheet--fleet` 提升至 50（修复后两个原失败的 e2e 用例通过）。

### 性能

- gzip 中间件：响应头确认非可压缩类型（二进制、图片）后立即流式直通，不再把完整响应缓存进内存。
- 看板改为按任务并发查询（上限 6），单台慢机器不再拖住全部结果；前端 5 秒轮询加防重叠。

### 运维

- `deploy-remote.sh --jump`：ssh 选项移到参数解析后构建，参数实际生效（此前只有环境变量生效）。

### 验证

- `go vet` / `gofmt`：干净
- `go test ./...` 与 `go test -race ./server`：全部通过（新增 3 个并发/补偿用例、更新发布链相关用例）
- 前端：typecheck 通过，225 个单测通过；3 个相关 e2e（含新增"无人接单"用例）通过

## 2026-10-25（可信生产：签名、鉴权、checkout、门禁、HA）

### 节点身份与账本

- 节点身份从 Tailscale 节点名改为本地 ed25519 密钥（`~/.local/share/herdr-web/jobs/node.key`，0600；`HERDR_WEB_NODE_KEY` 可覆盖），节点 id 即公钥。
- `attest` 必须携带覆盖 task/role/node/commit/digest 的签名；Memory 与 NATS 适配器都验签，空签名、伪造签名、跨任务重放均返回 `ErrSignature`。
- dev/merge 的服务端 attest 改用本节点签名；原有“local”占位签名删除。

### API 鉴权

- `HERDR_WEB_TOKEN` 可选：设置后 `/api/`（health 与 webhook 除外）和 `/opendesign/` 必须带 `Authorization: Bearer`、`X-Herdr-Token` 或 HttpOnly cookie。
- `GET /auth?token=...` 验证后设置 HttpOnly cookie，现有 UI 的 EventSource/WebSocket 可直接复用。
- 同源浏览器默认免 token：UI 的 fetch/EventSource/WebSocket 带 `Sec-Fetch-Site: same-origin` 或匹配 Origin 时直接放行，不再需要逐台打开 `/auth`；curl/脚本/fleet 仍必须带 token。需要严格逐 origin 登录时设 `HERDR_WEB_TOKEN_BROWSER=require`。
- 新增 `HERDR_WEB_TRUSTED_NETS`：来自指定 CIDR（部署为 `100.89.0.0/16`）的请求视为已由 tailnet/LAN 认证，不再要求 token 或 cookie；Host/Origin/JSON 守卫仍然生效。安全边界变为 private bind + 网络 ACL。
- fleet 心跳、dispatch、job 状态、remote proxy 的出站请求自动携带同一 token；constant-time 比较。

### 仓库 checkout 与分支推送

- job 请求/任务/账本事件携带 `repo`、`cloneUrl`、`tokenEnv`、`baseBranch`；`prepareCheckout` 在 worktree 创建前 clone 或在已有仓库 fetch+checkout 基分支，脏工作区拒绝切换。
- 凭证只通过 `tokenEnv` 指定的环境变量读取，clone 后把 origin 改回不含 token 的 URL。
- dev 角色完成时先 `git push` 到远端分支再 attest；推送失败返回 `branch_push_failed`，不把未推送的结果标成完成。

### 流水线门禁与 merge 失败

- 任务新增 `testCommand`；repo 可配置测试命令，orchestrator 的 test 角色变成 `kind=command` 的命令 job（打印 `__HERDR_JOB_DONE__` 退出码），不再只依赖 agent 自述。
- review/test/audit 仍要求独立节点；merge 失败从无限重试改为 `FailMerge`：保留 `audit_approved` 重试，3 次后进入 `merge_blocked`。
- NATS 适配器支持逗号/空白分隔的集群 URL、自动重连、token/用户名密码、`HERDR_WEB_NATS_CA` 私有 CA、JetStream stream/KV 副本数（`HERDR_WEB_NATS_REPLICAS`）；启动时在集群选主期间重试 90 秒，避免崩溃循环。
- 实际部署三节点 JetStream（m9、m8s、laptop），集群路由和远程客户端走 TLS；m9/m8s 的客户端使用 `tls://` + CA，laptop 只在 loopback 使用明文监听（macOS 平台验证器拒绝私有 CA），其集群路由仍为 TLS。
- 发布 bundle 关闭 source map（`vite.config.ts`），`release-archives` 发现 `web/dist/*.map` 直接失败；Linux 二进制从 12M 降到 9.6M，桌面二进制 9.1M。

### 验证

- `go vet ./...` 干净。
- `go test ./...` 全部通过（新增签名/重放、token、checkout、push、命令 job、merge 失败有界、NATS URL 规范化用例）。
- `npm --prefix web run test:unit` 281/281。
- Playwright 79/87；8 个失败均为已提交 UI 的布局用例，与本次后端改动无关（wrap/phone/split 显示）。
