# 会话转录契约（CONV）：把 pane 会话的解析搬到服务端

> 状态：**提案，字段与路由待服务端确认**。版本：0.1，整理日期：2026-10-25。
> 对象：`server/*`（只读参考，本次不修改）、`web/src/lib/herdr.ts`、`web/src/lib/usePaneRead.ts`、`web/src/lib/conversation.ts`、`web/src/components/session/*`；依据：当前代码（`289e3ea`）、[会话区对照](2026-10-25-ovis-session-parity.md)、参考实现 `/tmp/ovis`（v0.4.13，HEAD `7e0861f`，MIT）。
> 状态标记：`现有` = 能在代码中定位；`目标` = 本契约要求、尚未实现；`待服务端确认` = 仓库内无法确认，不得编造。

## 0. 一页结论

会话结构目前由浏览器从 ANSI 快照里**猜**；目标是由同机服务端**解析**并交付结构化会话，旧 daemon 全程无感降级。

| 维度 | 现状（`289e3ea`） | 目标（本契约） |
| --- | --- | --- |
| 数据来源 | `pane.read` 取 2000 行 ANSI，`deriveConversation()` 在浏览器里切轮次 | `GET /api/v1/herdr/panes/{paneId}/conversation`，浏览器只渲染 |
| 结构 | 只有 `user/thoughts/work/answer/recap` 五段文本 | `turns[].parts[]` 判别联合：`text/thinking/tool/image/task_result/notice/skill/compact` |
| 工具 | 一行摘要，无参数、无状态、无结果、无图片 | `name/summary/input/output/status/images/output_ref` |
| 时间 | 无逐轮时间；时长用"首次看到该轮快照的时刻"估（`ChatLens.tsx:56-72`） | `ts/end_ts/ts_source`；未知就是 `null`，不猜 |
| 分页 | `lines` 只是上限，截断即丢，只能显示"earlier lines dropped"（`TurnList.tsx:118`） | `cursor` + `before/from/since`，前插不跳行、不重复 |
| 身份 | 无 `history_id`，行身份只能靠位置 | `history_id` 跨追加稳定、替换即变；`incarnation` 由前端自增 |
| 推送 | 全仓无 SSE/WS/`EventSource`（0 命中）；靠 400/1500/4000ms 轮询 | `GET /api/v1/events` 事件流 + 序号 + 重连 + 去重 |
| 旧 daemon | — | 无新 RPC 时返回 `source:"scrollback"`，前端继续走现有启发式 |

**三条兼容性原则**：不设切换日、不做版本握手、不嗅探字段。前端只看一个开关——响应里的 `source`：`"scrollback"` 走旧路径，`"<agent>-transcript"` 走新路径；未知字段一律忽略，缺字段一律走降级分支。

`source:"scrollback"` 是**现在就能发**的答复：服务端只做 `pane.read` + 形状启发式，不依赖 daemon 任何新能力。因此 P0 没有前置条件。

## 1. 根因：快照里没有可用的结构

1. `pane.read` 的契约只是"当前滚动缓冲的文本快照"：其 `revision` 在快照里恒为 0（`ChatLens.tsx:75-80` 有专门注释说明不能拿它当依赖），且没有逐行时间、没有"取更早的行"的入口。
2. `conversation.ts` 是**形状启发式**且刻意 DOM-free、clock-free（文件头注释），输入只有一坨文本，所以天生给不出时间戳、工具参数、图片、子代理身份。
3. 因此结构必须由与 daemon 同机、有文件访问权的一方产生——也就是 Go 服务端；浏览器保留启发式作为降级路径与缺字段兜底。

**11 项能力索引**：[会话区对照](2026-10-25-ovis-session-parity.md) §3.1 是 8 条差距，本契约把它们拆成 11 条可独立验收的条目——"结构化 turn / 工具参数 / 工具结果"拆成 CONV-01/02/07，"工具卡片族"拆成 CONV-03/04，其余一条对一项，即 8+3=11；其中 01–04 是结构性、05–11 是增量。

| ID | 能力 | 主要字段 | 前端落点 | 阶段 |
| --- | --- | --- | --- | --- |
| CONV-01 | 结构化 turn | `turns[].role/parts[]` | `TurnList.tsx` → 新 `PartList` | P0 |
| CONV-02 | 工具调用 | `name/summary/input/output/status/images` | 新 `ToolCard` | P1 |
| CONV-03 | 子代理/对等消息 | `kind:"teammate"` part | 新 `TeammateMessageRow` | P1 |
| CONV-04 | 任务与清单 | `kind:"task_result"` + `metadata.plan` | 新 `TaskResultRow`、清单 pill | P1 |
| CONV-05 | 历史世代 | `history_id`（+前端 `incarnation`） | 行身份/滚动保位 | P3 |
| CONV-06 | 更早一页 | `cursor/before/from/since` | `ChatLens` 顶部 `load older` | P3 |
| CONV-07 | 逐轮时间 | `ts/end_ts/ts_source` | `TurnList` 时钟、`WorkBlock` 时长 | P2 |
| CONV-08 | 交互式提问卡 | `prompt/*`、409 `prompt_changed` | 新 `PromptCard` | P4 |
| CONV-09 | 会话历史恢复 | `history[]`、`resume` | 新 `SessionHistory` sheet | P4 |
| CONV-10 | 上下文用量 | `metadata.model/context` | 新 `UsageStrip` | P2 |
| CONV-11 | 通知推送 | SSE 事件名/序号/重连 | 新 `lib/events.ts` | P5 |

## 2. 逐项契约

字段名对齐 Ovis `shared/protocol.ts:340-462`、`540-660`，但**不复刻它的传输层**：本仓浏览器侧只有 `fetch`，没有 WebSocket，见 CONV-11。

### CONV-01 结构化 turn（P0）

| 字段 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| `turns[].id` | string | 是 | 在同一个 `history_id` 内稳定；同一轮内容真的变了才变。前端拿它做 React key 与滚动锚点 |
| `turns[].role` | `"user"\|"assistant"` | 是 | `task_result` 开新轮，但 `role` 仍是 `assistant` |
| `turns[].parts` | Part[] | 是 | 判别联合，**数组顺序即渲染顺序** |
| `parts[].kind` | enum | 是 | `text` / `thinking` / `tool` / `image` / `task_result` / `notice` / `skill` / `compact` |
| `parts[].text` | string | 视 kind | `text`/`thinking`/`notice`/`compact` 用 |
| `parts[].phase` | `"commentary"\|"final_answer"` | 否 | `text` 专用；缺省按 `final_answer` 渲染 |

兼容：`parts` 缺席时前端必须仍能渲染——用 `source==="scrollback"` 判断后走 `deriveConversation()`，**不按字段存在性嗅探**；服务端在只有纯文本时也 MUST 给 `[{kind:"text",…}]` 而非空数组。

### CONV-02 工具调用（P1）

| 字段 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| `name` | string | 是 | 工具原名（`bash`/`read`/`edit`/`task`…），前端按名字选图标与折叠策略 |
| `summary` | string | 是 | 一行人类可读摘要；前端默认只显示这行 |
| `input` | object | 否 | 结构化参数；超阈值或含敏感内容时改给 `arguments_omitted:true` + `input_size` |
| `output` | string | 否 | 结果文本，服务端截断到 16 000 字符 |
| `output_ref` | string | 否 | 完整结果的取回句柄（服务端存储 id 或受控路径），前端按需拉取 |
| `output_size` | number | 否 | 原始字节数，用于显示"已截断" |
| `status` | `"running"\|"ok"\|"failed"` | 是 | 显式状态；只有最后一轮的 `running` 有意义 |
| `images` | `{media_type, ref}[]` | 否 | 工具产出的图片；`ref` 由服务端换成可 GET 的 URL |

为什么比 Ovis 多一个 `status`：Ovis 用 `error` 布尔 + 帧里的 `activity` 推运行态，而 herdr 的 `activity` 不保证覆盖"正在跑的工具"，显式状态才不会把半截输出渲染成完成。`output` 与 `output_ref` 二选一，都缺时就只有 `summary`。

### CONV-03 子代理/对等消息（P1）

Claude 一类 agent 会用 `<teammate-message teammate_id="…">` 信封把对等会话的消息塞进文本流；服务端拆成独立 part，别让浏览器正则文本。

字段（位于 `user` 轮的 `parts[]` 内）：`kind:"teammate"`（必填）· `teammate`（必填，`teammate_id`）· `status`（可选，信封状态如 `idle`）· `summary`（可选，信封 `summary` 属性）· `text`（必填，正文）。

语义：这条消息**不是操作者输入的**（视觉必须与用户气泡区分），也不构成对任何待确认提问的授权；拆分失败时保留原文 `text` part，绝不丢内容。

### CONV-04 任务与清单（P1）

| 字段 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| `parts[].kind:"task_result"` | — | — | 后台任务/子代理**结束时**开一个 assistant 轮，`tasks` 为数组 |
| `tasks[].id` / `title` | string | 是 | 任务 id 与标题 |
| `tasks[].agent` / `model` | string\|null | 是 | 全小写标识；未知为 `null` |
| `tasks[].status` | `"completed"\|"failed"\|"cancelled"` | 是 | 终态 |
| `tasks[].duration_ms` | number\|null | 是 | 服务端测得的耗时；取不到为 `null` |
| `tasks[].turns` / `tool_calls` / `tokens` | number | 是 | 计数，取不到填 0 |
| `tasks[].result` | string | 是 | 结果摘要，截断 16 000 字符；`result_cut` 标截断 |
| `metadata.plan` | `{done,total,current}\|null` | 否 | 任务清单进度；agent 不维护清单时 `null` |

`plan` 放 `metadata` 而非独立通道，因为它属于"当前快照"而不是"某一轮"，前端只在 composer 上方画一行 pill；`current` 是进行中的条目标题。

### CONV-05 历史世代：`history_id` + `incarnation`（P3）

字段：`history_id`（响应顶层，string\|null，同一段会话内**跨追加稳定**；转录被替换或原生上下文清空时**必须变化**，取不到则省略）；`incarnation`（number，**前端本地**，服务端不返回，前端按 `machineId+paneId+historyId` 存 `localStorage`，`historyId` 为 `null` 且会话被替换时自增）。

规则：行身份 = `(paneId, history_id, incarnation, turn.id)`。`history_id` 变化即视为新会话：清空已加载页、丢弃游标、从第一页重取，**不拼接**。这是"历史被替换"唯一可靠的判据——今天没有任何判据，只能靠位置，所以重放/恢复后行身份全部错位。

### CONV-06 更早一页与锚定（P3）

字段：`cursor`（string\|null，本页**第一条** turn 在转录里的位置；会话开头为 `null`，不可分页的来源省略该字段）· 查询参数 `?before`（取该游标之前的一页）· `?from`（增量轮询起点，中间空隙用 `before`+`since` 补齐）· `?since`（配合 `before` 的回翻下界，避免重复取已加载区）。

游标不可识别时返回 **409 `history_changed`**，前端清空重取，不猜测位置。前插必须靠 `turn.id` 锚定：新页插到最前，再把 `scrollTop` 增加"插入高度"，读者视线不动（`TurnList` 现在没有这个能力，只有底部 pinned）。

`cursor` 能否真的给出更早的行，取决于 daemon 能否取到快照缓冲之外的内容——`pane.read` 现在只有 `source=recent`，这是本契约中唯一可能需要 daemon 配合的结构性能力，见 §8 第 2 条。取不到时省略 `cursor`、前端隐藏 `load older`，绝不用"再读 2000 行然后去重"伪造分页。

### CONV-07 逐轮时间与时长（P2）

字段：`ts`（string\|null，该轮开始时间，ISO 8601；**未知就是 `null`**，不填请求时间）· `end_ts`（string\|null，该轮助手最后一次活动时间；**绝不取下一轮 user 的 `ts`**，否则会把等待读者打字的时间算进用时）· `ts_source`（`"transcript"\|"observed"`，真实转录时间还是服务端观察到的快照变化时间）· `duration_ms`（number\|null，`end_ts - ts`，任一为 `null` 时必须为 `null`）· `duration_estimated`（boolean，仅当 `end_ts` 缺失、退化为"下一轮 `ts` − 本轮 `ts`"（Ovis `docs/chat-mode-audit.md` 的口径）时为 `true`，前端把它显示成"≤ 7s"而不是"7s"，因为该口径把等待读者输入的时间也算在内）。

今天前端的时长是"从第一个携带该轮的快照开始计时"（`ChatLens.tsx:56-72`），把**从轮次开始到浏览器第一次看到它之间的时间整段丢掉**，且页面刷新即归零。scrollback 启发式只能给 `ts_source:"observed"`，前端必须把观测值与真实时间区分显示；没有 `ts` 时状态行只显示状态词，不显示钟点。

### CONV-08 交互式提问卡（P4）

新路由：`GET /api/v1/herdr/panes/{paneId}/prompt` 与 `POST /api/v1/herdr/panes/{paneId}/prompt/answer`。

| 字段 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| `prompt` | object\|null | 是 | `null` = 当前没有可答的提问，前端保留现有键条（`KeyBar`） |
| `prompt.id` | string | 是 | 稳定标识（建议 `hash(agent,kind,question,options,序号)`）；答错 id 即 409 |
| `prompt.kind` | `"question"\|"approval"\|"plan"\|"menu"` | 是 | 决定卡片形态 |
| `prompt.title` / `question` / `body` | string | 标题与问题必填 | `body` 可为 `null` |
| `prompt.options[]` | `{label, description\|null}` | 是 | **选项来自服务端解析屏幕**，不是 agent 主动上报 |
| `prompt.multi_select` | boolean | 是 | 多选 |
| `prompt.custom_option_index` | number\|null | 是 | "自行输入"在选项里的下标 |
| `prompt.default_option_index` / `default_custom_text` | number\|null / string | 否 | 预选与预填 |
| `prompt.steps[]` / `answers[]` | 见语义 | 否 | 多步提问的进度（`{label,answered,current}`）与已回答步骤（`{question,answer,note?}`） |
| `prompt.queued` | `"collapsed"\|"open"` | 否 | 排队中的提问 |
| `prompt.fallback` | boolean | 否 | 只能按键回答、无法结构化读出选项时置 `true` |

提交体 `PromptAnswer`：`{prompt_id, option_index?, option_indices?, custom_text?, step_back?, step_index?}`。服务端必须校验 `prompt_id` 与当前屏幕一致，否则 **409 `prompt_changed`**——卡片渲染到提交之间，agent 可能已经问了下一个问题。

因为选项是启发式解析出来的，`fallback:true` 是常态而非异常：此时前端显示"只能按键回答"并落回 `KeyBar`，绝不把可能错误的选项渲染成可点按钮；`409 prompt_changed` 时刷新卡片并提示重答，不自动重投。

### CONV-09 会话历史恢复（P4）

| 路由 | 语义 |
| --- | --- |
| `GET /api/v1/herdr/panes/{paneId}/history?limit=&agent=` | 该 pane 所属工作区/agent 的原生会话列表，最新在前，`limit` ≤ 50 |
| `POST /api/v1/herdr/panes/{paneId}/resume` | 体 `{history_id}`：在新 tab 里恢复该会话，返回 `{ok, tabId, paneId, workspaceId}` |

列表条目 `{id, title, agent, cwd, updated_at, resume:{command:string[], cwd:string}|null}`；`resume.command` 由服务端按 agent 生成（agent 无关性的关键：前端不写 `claude --resume` 这类知识），`null` 表示不可恢复。

恢复本身**不需要新 daemon 能力**：现有 `POST /api/v1/herdr/tabs`（返回 `paneId`）+ `POST /api/v1/herdr/panes/{paneId}/run`（`command: string[]`）已能组合，见 `server/bridge.go` 的 `handleTabCreate` / `handlePaneRun`；真正的新工作是"列出原生会话"——读各 agent 的落盘目录，`待服务端确认`。错误：`404 pane_not_found`、`409 launch_unsupported`（`resume.command` 不可用）、`409 stale_source`（列表已过期）。

### CONV-10 上下文用量（P2）

字段：`metadata.model`（string\|null，取不到为 `null`，**不从推理文本推断**）· `metadata.reasoning_effort`（string\|null，同上）· `metadata.context.used`（number，已用 token）· `metadata.context.window`（number\|null，未知为 `null`）· `metadata.screen`（boolean，`true` = metadata 读自屏幕而非转录，输出变化后需重新读取）。

`metadata` 整体缺席时前端不画用量条（不显示 `0/0`，也不显示"未知"占位）。来源是 agent 自己的转录/统计，scrollback 兜底路径通常给不出，这是允许的降级。

### CONV-11 通知推送（P5）

本仓浏览器侧没有任何流式基础设施（`EventSource`/`text/event-stream`/`http.Flusher`/WebSocket 全仓 0 命中），因此新开一条 SSE 路由 `GET /api/v1/events?panes=id1,id2`（路径名 `待服务端确认`）。帧：`id: 128` + `event: conversation-changed` + `data: {"paneId":"w1:p1","historyId":"h-7f3c1a","revision":17}`。

| 事件名 | data | 前端动作 |
| --- | --- | --- |
| `hello` | `{seq, heartbeatMs}` | 记录起始序号；后续 `seq` 跳号即视为丢失，整体重取 |
| `conversation-changed` | `{paneId, historyId, revision}` | 对 `(paneId,historyId,revision)` 去重后拉一次 conversation |
| `pane-status` | `{paneId, agentStatus, finishId?}` | 更新状态词，不重取会话 |
| `pane-exited` | `{paneId}` | 标灰该 pane |
| `session-changed` | `{}` | 重取侧栏结构 |
| `gap` | `{fromSeq}` | 序号断档且无法补齐：清缓存重取 |

规则：`id:` + `Last-Event-ID` 重连，服务端在小窗口内重放，超出窗口就发 `gap`；心跳用注释帧 `: ping`，15s 一次；`Content-Type: text/event-stream`、`Cache-Control: no-cache`、不设 `Content-Length`。去重键是 `(paneId, historyId, revision)`——比重放事件 id 更可靠，因为重放可能跨越重连。

**传输前提（实现时必读）**：`compressRecorder`（`server/compress.go:189`）把整个响应缓存在内存里且不实现 `Flush`，而 `text/event-stream` 属于 `text/*` 会被判为可压缩，因此 SSE **必须**走与 `/opendesign/` 相同的绕行分支（理由已记在 `server/bridge.go:898-905` 的注释里），或给 recorder 增加透传+Flush。`GuardRequests` 只对写方法查 Origin（`server/guard.go:54`），GET 的 SSE 不受影响；`server/run.go:52-55` 只设了 `ReadHeaderTimeout`、没有 `WriteTimeout`，长连接不会被服务器掐断。

## 3. 端点草案

`GET /api/v1/herdr/panes/{paneId}/conversation?lines=&before=&from=&since=`

| 参数 | 校验 | 默认 | 说明 |
| --- | --- | --- | --- |
| `lines` | 1..2000，整数 | 200 | 仅 scrollback 兜底路径用：从 `pane.read` 取多少行原文再解析。上限沿用 `/read` 的 2000（`server/bridge.go:432`），默认 200 对齐前端 `READ_LINES`（`web/src/lib/herdr.ts:258`） |
| `before` | 合法游标 | — | 取更早一页 |
| `from` | 合法游标 | — | 增量轮询起点 |
| `since` | 合法游标 | — | 回翻下界 |

错误：`before` 与 `from` 同时给 → 400 `invalid_request`；`lines` 非法 → 400 `lines must be between 1 and 2000`（复用现有文案）；非法/过期游标 → 409 `history_changed`；daemon 失败 → 502 `herdr_conversation_failed`（复用 `writeBadGateway`）；解析自身超时 → 504 `conversation_parse_timeout`。

路由接入点：在 `server/bridge.go:857-878` 的 suffix switch 里加 `case strings.HasSuffix(rest, "/conversation")`，放在 `default: writeNotFound(w)` 之前，复用 `strings.Trim(…, "/")` 与 `writeMethodNotAllowed(w, "GET")`。

**最小可粘贴骨架**（字段名以 Ovis `shared/protocol.ts:427-450` 为准；能否产出取决于 daemon 能力，见 §8）：

```json
{
  "source": "scrollback",
  "history_id": "h-7f3c1a",
  "revision": 17,
  "activity": "working",
  "cursor": "c-120",
  "turns": [
    { "id": "t-9", "role": "user", "ts": "2026-10-25T09:41:02.113Z",
      "parts": [{ "kind": "text", "text": "先把服务端的对话端点理出来" }] },
    { "id": "t-10", "role": "assistant", "ts": "2026-10-25T09:41:04.002Z",
      "end_ts": "2026-10-25T09:43:19.884Z", "ts_source": "observed",
      "parts": [
        { "kind": "thinking", "text": "先看 bridge.go 的 dispatch" },
        { "kind": "tool", "name": "read", "summary": "读 server/bridge.go", "status": "ok",
          "input": { "path": "server/bridge.go", "offset": 857 },
          "output": "…截断…", "output_size": 18324 },
        { "kind": "text", "text": "dispatch 在 857 行，可加 suffix 分支。", "phase": "final_answer" }
      ] }
  ],
  "metadata": { "model": "claude-sonnet-4-5", "context": { "used": 41233, "window": 200000 } }
}
```

| 顶层字段 | 类型 | 语义 |
| --- | --- | --- |
| `source` | string | `"scrollback"` 或 `"<agent>-transcript"`。**唯一**的降级开关 |
| `history_id` | string\|null | 见 CONV-05；不可得时 `null` |
| `revision` | number | 见下 |
| `activity` | `"thinking"\|"working"\|"idle"` | 仅显示反馈，不作为投递授权 |
| `cursor` | string\|null | 见 CONV-06；不可分页时省略 |
| `turns` | Turn[] | 必填，可以为空数组 |
| `metadata` | object | 见 CONV-10，可整体缺席 |

**`revision` 语义**：按 `(paneId, history_id)` 单调递增，只在 `turns`/`metadata` 真的变化时加一；同一 `revision` 的响应 MUST 字节稳定。它取代 `pane.read` 那个恒为 0 的 `revision`，也是 ETag 与前端去重的共同基础。

**ETag / 304**：`ETag: W/"<history_id>.<revision>"`，`If-None-Match` 命中则 304 空体。轮询成本从"每次重新解析"降到"一次比对"——这是收益最确定的一项，因为 `usePaneRead` 现在 400ms 一次全文重解。304 空体不会经过 gzip 压缩（`compressMinBytes = 1024`，`server/compress.go`），但 `Vary: Accept-Encoding` 要一并加上。当前全仓没有任何 `ETag`/`If-None-Match` 处理，这是新增而非修改。

**超时与缓存**：daemon 调用沿用 `Client` 的 10s（`server/herdr.go`）；端点自身 `context.WithTimeout` 建议 8s，解析预算 p95 < 80ms（2000 行）。解析结果按 `(paneId, history_id, revision)` 做小容量缓存（如 32 个 pane），否则每次轮询都是全量重解析。

## 4. 兼容与降级

| 场景 | 服务端行为 | 前端行为 |
| --- | --- | --- |
| daemon 无对话 RPC（当前所有版本） | `pane.read` 快照 + 启发式，`source:"scrollback"`，`history_id`/`cursor`/`metadata` 为 `null` 或省略 | 继续 `usePaneRead`+`deriveConversation`；忽略 `parts` 缺失 |
| daemon 有原生转录 | `source:"<agent>-transcript"`，字段齐全 | 直渲 `parts`，停止本地解析 |
| 服务端是旧版（404） | — | 首次 404 后永久降级到轮询，不每次重打（避免 400ms 一次 404） |
| daemon 断开 | 502 | 保留上次快照并显示 `daemon unreachable`（`ChatLens.tsx:178-182` 已实现） |
| 游标过期 | 409 `history_changed` | 清空已加载页重取，不猜测位置 |

**不做的兼容**：不做 `?version=2` 协商、不做特性探测、不改现有 `/read` 的参数与响应；新旧并存只靠 `source` 一个字段。

## 5. 分阶段（每阶段可独立发布）

| 阶段 | 内容 | 验收（curl + 前端降级） | 人日 | 风险 |
| --- | --- | --- | --- | --- |
| P0 | 路由 + scrollback 启发式 + `turn/parts(text,thinking)` + `activity/revision` + ETag | `curl -i '…/conversation?lines=200'` → 200 且 `turns[0].role=="user"`；同 ETag 第二次 304；`lines=abc` → 400 | 0.5–1 | 启发式误切轮次；用"认不出就是 prose"的保守规则兜底 |
| P1 | 工具 part + 子代理消息 + `task_result`/`plan` | 跑一次 `bash` 的 pane 返回 `kind:"tool"`，`status` 由 `running` 变 `ok`；`output_ref` 可取回 | 1.5–2.5 | 工具输出跨轮串话；按 `input` 边界切分并保留原文 |
| P2 | `ts/end_ts/ts_source` + `metadata.model/context/plan` | 连续两次轮询，`revision` 变而 `ts` 稳定；`duration_ms` 不为负 | 1–2 | scrollback 拿不到真实时间；只报观测值，标 `ts_source:"observed"` |
| P3 | `history_id` + `cursor`/`before/from/since` + 409 `history_changed` | 两页拼接无重复无缺行；旧游标 → 409；前插后 `scrollTop` 视线不动 | 1.5–2 | daemon 取不到更早的行；省略 `cursor`、隐藏 `load older` |
| P4 | prompt 端点 + 409 `prompt_changed` + history 列表 + resume | 答旧 id → 409，屏幕未变则 200；resume 开出新 tab 且 `paneId` 不同 | 2–3 | 屏幕选项解析错；`fallback:true` 落回键条；resume 命令按 agent 维护 |
| P5 | `GET /api/v1/events` SSE | `curl -N` 能看到 `hello` 与心跳；杀掉重连带 `Last-Event-ID` 续号或收到 `gap` | 2–3 | 必须绕过 `withGzip`（见 CONV-11）；反向代理可能缓冲事件流 |

合计约 **8.5–13.5 人日**。原子性：P0 之后只返回 `text` part 就能被前端消费；P1 加 part 类型只扩联合、不改已有字段；P3 的 `cursor` 是可选字段，缺席时前端隐藏入口——因此任何阶段停在那里都能发布。

## 6. 为什么 agent 无关、为什么先做启发式

herdr 能驱动十余种 agent（Ovis `shared/protocol.ts:432` 列了 12 个原生转录源 + scrollback）。逐 agent 接原生档案是 O(12) 的持续维护——新 agent、新版本格式、新落盘位置都要跟进；而 herdr 的 pane 内容本来就是 TUI 屏幕，与 agent 是谁无关。因此顺序固定为：

1. **先**把 `web/src/lib/conversation.ts` 的形状规则（背景填满的 run = 用户、斜体小字 = 推理、ASCII 框/字形行 = 工具、其余 = 回答、"认不出就是 prose"）移植到 Go，输入是 `pane.read` 的文本。这一步不需要任何 agent 知识，对所有 agent 一次生效，`source:"scrollback"`。
2. **再**对确实有原生转录的 agent 读档案，`source:"<agent>-transcript"`，此时才可能有真实时间、精确参数、用量。
3. **任何一步失败都退回** `source:"scrollback"` 并原样返回文本分块，不返回错误——降级必须是常态而不是异常路径。

明确不做：不在前端按 `agent` 类型分支渲染；不要求 daemon 提供 agent 专用 RPC；不为某一家的格式改变 `parts` 的形状。

## 7. 附录 A：前端消费清单

| 目标行为 | 需要的字段 | 现在缺什么 | 落在哪里 / 降级 |
| --- | --- | --- | --- |
| 轮次与正文 | `turns[].role/parts` | 服务端结构 | `TurnList.tsx` 改吃 `parts`，新增 `PartList`；`source:"scrollback"` 时保留 `deriveConversation` |
| 工具卡片族 | `kind:"tool"` 全字段 | 参数/状态/结果 | 新 `ToolCard`（名+状态点+折叠参数+结果+图片）；今日只有 `WorkBlock.tsx` 的一行摘要 |
| 工具图片 | `images[]` | 无 | 新 `ToolImages` 网格；点击开既有图片查看器 |
| 子代理消息 | `kind:"teammate"` | 文本被当普通 user 输入 | 新 `TeammateMessageRow`，视觉上区别于用户气泡 |
| 任务结果/清单 | `kind:"task_result"`、`metadata.plan` | 无 | 新 `TaskResultRow` + composer 上方清单 pill |
| 提问卡 | CONV-08 全字段 | 只有 `KeyBar` 盲按 | 新 `PromptCard` + `.prompt-dock`；`fallback:true` 或 `prompt===null` 时保留 `KeyBar` |
| 逐轮时间/时长 | `ts/end_ts/ts_source` | 用快照到达时刻估（`ChatLens.tsx:56-72`） | `TurnList` 时钟、`WorkBlock` 时长；`ts===null` 不画钟点 |
| 更早一页 | `cursor/before/from` | 无游标 | `ChatLens` 顶部 `load older` + 前插保位；无 `cursor` 时隐藏，`TurnList.tsx:118` 的截断提示留作兜底 |
| 行身份/替换 | `history_id` + 本地 `incarnation` | 无 | 行 key 改为 `(history, incarnation, turn.id)`；`history_id` 变即清空 |
| 会话历史恢复 | CONV-09 路由 | 无入口、无列表 | 新 `SessionHistory` sheet；`resume===null` 时禁用恢复按钮 |
| 上下文用量 | `metadata.model/context` | 无 | 新 `UsageStrip`（模型名 + 用量环）；`metadata` 缺席不渲染 |
| 通知与推送 | CONV-11 事件 | 无 SSE 客户端 | 新 `web/src/lib/events.ts`；`usePaneRead` 在事件驱动下退避到 4s 轮询兜底；`pane-status` 复用现有状态点 |

实现约束：新的取数逻辑一律加在 `web/src/lib/herdr.ts`（本仓所有 `fetch` 都在那里），类型加 `HerdrConversation`；不新增 `visual-*.css` 覆盖层；前端不得因字段缺失而抛错——缺字段即降级，是上表每一行的共同前提。

## 8. 待确认与决策记录

**待服务端确认**（仓库内无法确认，本文不编造）：

1. daemon 是否有对话/事件订阅类 RPC，方法名与帧形状（herdr-web 的 `Client` 目前只有请求-响应 `Call`，没有订阅能力）。
2. 能否在 `pane.read` 之外取到"更早的行"（决定 CONV-06 走 daemon 还是服务端自建环形缓冲；后者离开即丢，只能算半成品）。
3. 各 agent 原生转录的落盘路径与格式（至少先确认 Claude Code 与 Codex 两种）。
4. `model`/`reasoning_effort`/上下文用量能否从转录或 daemon 读到（决定 CONV-10 是否可能）。
5. 提问选项能否结构化读出，还是只能解析屏幕文本（决定 CONV-08 是常态卡片还是常态 `fallback`）。
6. SSE 在 Tailscale / 反向代理下的缓冲与心跳要求，以及事件路由名是否用 `/api/v1/events`。

| 决策 | 结论 | 对应 |
| --- | --- | --- |
| DEC-01 端点位置 | `/api/v1/herdr/panes/{paneId}/conversation`，与 `/read` 同级，走 `bridge.go:857` 的 suffix switch | §3 |
| DEC-02 时间真相 | 只报可观测时间，未知即 `null`，`ts_source` 标注来源；禁止从推理文本推断时间或 effort | CONV-07/10 |
| DEC-03 传输 | 浏览器侧用 SSE，不复刻 Ovis 的 WebSocket `/ws`（本仓无 WS，SSE 依赖少一个数量级） | CONV-11 |
| DEC-04 原生转录优先级 | `待定`：是否先只接 Claude Code + Codex 两种 | §6 |
| DEC-05 系统级通知 | `待定`：Service Worker / Web Push 本轮不做，只做页内事件 | CONV-11 |

**验收方式**：Go 侧断言按 `server/bridge_test.go` 现有表风格加（400/404/409/304 各一行，与 `/read` 的 `lines` 边界表并列）；前端 `make web-typecheck`；浏览器手工过一遍"旧 daemon 降级"与"新字段渲染"两条路径。**变更纪律**：本文是提案，落地前不改 `server/*`；每条字段先有 HTTP 断言再写前端；标为 `待服务端确认` 的条目在确认前不得写进代码分支。
