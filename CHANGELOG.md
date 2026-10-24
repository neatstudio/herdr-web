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
