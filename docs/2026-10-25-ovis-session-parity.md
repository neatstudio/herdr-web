# 会话区对照：herdr-web 与 Ovis

对象：`/tmp/ovis`（`ovis@0.4.13`，HEAD `7e0861f`，MIT）与 `web/src/components/session/`、
`web/src/lib/conversation.ts`、`web/src/components/PromptBar.tsx`。
目的：回答"我们的会话区在 UI 与功能上和 Ovis 差在哪"，并说明哪些差距值得补、哪些不该补。

## 0. 一句话结论

Ovis 的会话区建立在**服务端解析原生转录**之上（`GET /api/pane/conversation`，
`shared/protocol.ts:427-439`，返回 `source/turns/metadata/cursor/activity/history_id`）；
herdr-web 建立在**客户端重解 ANSI 快照**之上（`readPane(paneId, 200)` → `deriveConversation()`）。
这条根差异决定了两边的上限：

- Ovis 拥有结构化 turn（工具名/参数/结果/时间戳/history 世代/翻页游标），因此能做工具卡片、
  用时摘要、翻页锚定、交互式提问卡、用量与模型行。
- herdr-web 只有"最近 200 行渲染后的文本"，于是把每条动作压成 `WorkRow{kind,title,detail}`，
  用 `Edit/Read/Ran/Other` 四个动词 + 展开细节表达同一件事。

在这个前提下，手机端"默认聊天、需要全屏 TUI 才切 xterm"的主路径已经对齐；缺的东西里
**大部分不是 UI 不做，而是 herdr 客户端 API 没有对应 RPC**（`web/src/lib/herdr.ts` 只有
`readPane/sendPaneText/sendPaneKeys/uploadFile/pokeTranscript`，无 find、无 scroll、无转录、无历史）。

## 1. 已对齐（同样的事，两边都做了）

| 能力 | Ovis | herdr-web |
| --- | --- | --- |
| 双 lens + 粘性选择 | `lib/usePaneLens.ts`、`lib/paneLens.ts`、`localStorage["ovis:view:*"]` | `components/session/LensSwitch.tsx`、`lib/lens.ts`、`localStorage["herdr:lens:*"]` |
| 保持贴底的滚动 + 回底按钮 | `ChatView.tsx` `following` + `button.btn.chat-new-messages` | `components/session/ChatLens.tsx:84-154` sticky ref + `.chat__jump`（`latest ↓`） |
| 只手写时也不跳走 | `onItemSizeChanged` 重贴底 | `ResizeObserver` on lane（`ChatLens.tsx:119-131`） |
| 动作折叠成一行摘要 | `lib/workBlocks.ts` `Worked for 7s · 1 edit` | `components/session/WorkBlock.tsx:99-118` 同一句式，`lib/chatFormat.ts` |
| 折叠里失败不省略 | `.work-block-failed` | `summariseWork` 的 failed 计数进摘要 |
| 改动文件按 diff 着色 | `EditDiff`（`ChatView.tsx:306`） | `WorkBlock.tsx` `DiffBody` + `lib/diffLines.ts`（提交 `5511450`） |
| 代码块语言 / 复制 / 折叠 | `CodeBlock`（`lucide-react` 图标） | `components/session/Markdown.tsx` `CodeBlock`：语言标签、`copy` 文字链、超 30 行折到 20 行（提交 `5ee48b6`） |
| markdown 正文 | `HighlightedCode`、表格、列表 | `components/session/Markdown.tsx`（`lib/markdown.ts` 解析） |
| 输入框随内容长高 | `Composer.tsx` `sizeTextarea()`（`useLayoutEffect` + 隐藏测量副本） | `components/PromptBar.tsx` + `lib/composer.ts` `fitComposer()`（提交 `4278e69`） |
| 按 pane 存草稿 | `ovis:composer-draft:<paneStorageId>` | `herdr:draft:<paneId>`（`lib/composer.ts:95`） |
| `@` 提及 / `/` 命令 | `lib/mentions.ts` + `usePaneCommands` | `lib/composer.ts` `mentionQuery`/`slashQuery` + `PromptBar.tsx`（提及 pane/workspace/路径，非 agent 专有） |
| 附件上传 / 粘贴 / 拖入 | `uploadImages` + `.composer-attachments` | `lib/attachments.ts` + `PromptBar.tsx`（`uploadFile`） |
| 真实 xterm，不做假终端 | `useTerminalMount.ts`（`scrollback: 0`，翻页走 RPC） | `components/session/TerminalLens.tsx`（本地 `scrollback: 2000`，滚轮天然可用） |
| 控制键条 | `KeyBar.tsx`（默认 12 键、粘滞修饰、长按连发、安全区、mask 渐隐） | `components/session/KeyBar.tsx` + `lib/keybar.ts`（同一套：粘滞修饰、长按连发、`is-at-screen-bottom`；键分三层，且按软键盘高度收细，见 §4 `057348e`、`86169ad`） |
| 终端里回答选择菜单 | `PromptCard` + 键位协议 | `PICKER_BAR_KEYS` + 窗口捕获方向键（`ChatLens.tsx:92-115`），聊天里直接回 Esc/↑↓/Enter（提交 `ce2abcd`） |
| 状态色 / 主题 | `--status-*` + light/dark | `--working/--blocked/--idle/--done` + `lib/theme.ts`（auto/light/dark） |
| 空态与断链态 | `chat-empty`、`Waiting for the PC…` | `.chat__empty`（`No transcript yet.` / `Waiting for the pane to paint.` + 开终端）、`daemon unreachable — showing the last snapshot` |

herdr 独有、Ovis 没有的一处：**聊天 lens 里出现键条**（只在终端选择菜单时出现），
它不回答"选项卡片"，而是把真实的按键发给那个 TUI——对 omp/opencode/zerostack 这类
不提供结构化提问协议的 agent，这是唯一能用的做法。

## 2. 有，但形状不同（不是缺，是取舍）

| 项 | Ovis | herdr-web | 为什么 |
| --- | --- | --- | --- |
| 窄屏阈值 | 768px（`styles.css` 断点） | 720px（lens 仅在 ≤720 出现） | herdr 桌面保留 `TabStage`/`Scope` 的多 tab 分屏，窄于 720 才让位给聊天 |
| 发送按钮 | 一律圆形图标，且兼作停止键 | 桌面 34px、≤900px/粗指针 36px 的圆图标键（手绘箭头 SVG），同一位置在 agent 干活时原地换成琥珀实心方块作停止键 | 一处形状两种宽度，只改尺寸；原来的 `SEND` 文字键在菜单与自绘图标之间风格不一 |
| 附件/图片/命令的位置 | 输入框下面两组：左侧 `+` 附件、麦克风、新标签，右侧停止/发送（`Composer.tsx` `.composer-controls-left/right`） | 输入框独占左侧两行，右侧 2×2 控件簇：`+` 按路径附加、图片、`/` 命令、发送（`PromptBar.tsx` `.prompt__pad`） | 竖屏横向空间最贵：2×2 只占 74px 宽，草稿拿满其余宽度；控件簇与草稿底边对齐，卡片高度仍只有两行 |
| 折叠摘要时长 | 服务端时间戳差（下一 turn 减本 turn） | 从转录里读 TUI 自己打印的用时，并补"上次轮询到现在"的活动计时（`ChatLens.tsx:60-72`） | 快照无时间戳 |
| 状态行（模型/推理等级/上下文环/用量） | `.composer-strip`，数据来自 `ConversationResponse.metadata` | 无 | 客户端 API 无 metadata，硬猜模型违反"认不出就不画"的原则 |
| 快捷键全集 | 12 条可覆盖 + `Mod+Shift+Space` 听写 | 无全局快捷键层（herdr 的交互在 panel/palette 里） | 不是会话区的事务，属控制台骨架 |
| 翻页历史 | 游标 `{before,from,since}` + 槽位锚定 | 只读最近 200 行；更早的在终端 lens 里滚（本地 2000 行） | `readPane` 的 `lines` 是上限参数，无游标 |
| 空态文案 | `No conversation yet — say something below` | `No transcript yet.` + `Open terminal` | herdr 的空态多数是"agent 还没画"，动作应该是看终端 |

## 3. 缺失（按"能不能在客户端补"分类）

### 3.1 需要服务端（`server/*`，不在本次 UI 范围内）

| 能力 | Ovis 实现 | herdr 缺什么 |
| --- | --- | --- |
| 结构化 turn / 工具参数 / 工具结果 | `server/conversation.ts`、`server/codex.ts`、`shared/protocol.ts:190-195`（12 种原生转录 + `scrollback`） | 没有转录 RPC，只能从 ANSI 文本反推 |
| 历史被替换的语义 | `history_id` + `incarnation`（`lib/chatRows.ts:5-11`） | 无 id，行身份只能靠位置 |
| 更早一页 | `cursor` + `LOAD_OLDER_PX` | 无游标 |
| 工具卡片族（`ToolFile`/`ToolImages`/`TaskResultRow`/`TeammateMessageRow`/`GoalActivity`/`SkillActivityList`） | 由结构化块驱动 | 全部塌缩进 `WorkRow`；图片、子代理消息没有独立行 |
| 交互式提问卡（选项、默认项、自定义答案、409 `prompt_changed`） | `PromptCard` + `.prompt-dock` | herdr 用键条回真实按键（见 §1 末），卡片需要协议 |
| 会话历史恢复 | `GET /api/sessions/history` + `SessionHistory.tsx` | 无接口 |
| 上下文用量/成本面板 | `ContextRing`、`UsageMeters.tsx` | 无数据来源 |
| 通知与推送 | `public/sw.js` + `pane-status` | 无 service worker，也无推送通道 |

### 3.2 纯前端可补（值得排期，按收益/成本排序）

1. **终端内查找**：Ovis 的 `FindBar` 是服务端搜索（它 `scrollback: 0`）；herdr 有本地
   2000 行，用 `@xterm/addon-search` 即可，不依赖 RPC。约 1 个组件 + 键条入口。
2. **把答案复制为 markdown / 纯文本**：`TurnList.tsx` 已有逐轮复制，扩一个 `plainText()`
   （标题、列表、代码围栏、链接）即可，成本一个函数。
3. **键条自定义**：herdr 目前固定 `KEY_BAR_KEYS`/`PICKER_BAR_KEYS` 两组；Ovis 有 `KeyBarSettings.tsx`
   从 `KEY_BAR_KEYS` 池里选键并排序。要加设置面板 + 持久化，属中等。
4. **会话内查找**：两边都没有；聊天是 DOM，`window.find` 不可控，自建高亮成本高，暂不排。

### 3.3 刻意不做

- **小地图**：Ovis `@media (max-width:768px)` 就隐藏，而 herdr 的聊天 lens 只在 ≤720 出现，
  等于永远在手机上——做了看不见。桌面没有聊天 lens。
- **动画式打字机 / 流式光标**：只会增加噪声，herdr 的贴底 + 状态点已经够表达"正在写"。
- **在聊天里渲染附件图片**：需要服务端给出代码块的图片引用；当前上传只是把文件交给 TUI。
- **↑ 召回上一条已发消息**：Ovis 自己也没有（`↑/↓` 全部用于菜单高亮），不算差距。

## 4. 这一轮已经补掉的（会话区）

| 提交 | 内容 |
| --- | --- |
| `5511450` | 改动文件在折叠里画成彩色 diff（`+n/−n` 统计、`lib/diffLines.ts`） |
| `5ee48b6` | 代码块语言标签 + 复制 + 超长折叠；围栏内缩进保真（`conversation.ts` 只对围栏行不 trim） |
| `4278e69` | 输入框随内容长高、到上限才内部滚动（原来自带滚动条） |
| `ce2abcd` | 聊天 lens 里直接回答终端 picker（键条 + 键盘） |
| `f35db01` | 输入框半行裁切修掉：`padding` 归零、内边距挪到外框、高度按整行算 |
| `057348e` | 键条改成两层：6 键常驻并按屏宽拉伸，其余（含手机键盘没有的 Backspace/Home/End/PgUp/PgDn）收进 `keys` 菜单的 4×4 网格；顺带藏掉 xterm 自带滚动条、抹掉亮色主题下那条黑带 |
| `f6af9f5` | 输入框排版归正：手机草稿改用 `--font-prose`（唯一一处比例字体）、`line-height: 1.44` 让光标正好一行高、发送/停止/附件换成手绘 SVG 并 flex 居中（原来 `↑`/`■`/`＋` 字符自带边距，调到哪儿都偏） |
| `0262c71` | 草稿卡重排：左侧两行草稿、右侧 2×2 控件簇（`+` 路径附加 / 图片 / `/` 命令 / 发送），发送与停止共用一个圆按钮；卡片本身（边框、聚焦光晕、页脚提示）挪进 `index.css` 由所有宽度共用，`composer.css` 只管菜单、附件与触屏 |
| `e1b8994` | 回车即发送被证实没问题，问题在 IME 与失焦：`imeEnter()`（`isComposing` 或 keyCode 229）挡住输入法提交那一下，`test:unit` 加断言；发送中不再 `disabled` 文本框（原来每发一条软键盘就掉），页脚写明 `⏎ 发送 / ⇧⏎ 换行`，`enterKeyHint="send"` |
| `86169ad` | 软键盘适配 + 键条收细：`PromptBar` 实测 `visualViewport` 落差写入 `--kb-inset`，`.shell` 按它缩短（iOS 软键盘不缩 layout viewport 的老问题，Android 实测为 0 自然不重复缩）；键条 44px 条高 + 32px 键、7 个控件均分 34–44px，菜单改 8 列 2 行（111px） |
| `553c823` | 打字模式把软键盘占掉的那半屏要回来：键盘弹起时 `.masthead` 与 `.stage__head` 让位（只留标签条这一行身份：哪个 tab、哪个 agent、什么状态），`.shell` 从三行栅格切成两行（否则被 `display:none` 的 masthead 会把 `.body` 顶进 `auto` 行，会话区塌到 233px）；同时 2×2 控件簇折成一行 32px，卡片 96→66px。390×844 + 336px 键盘实测：聊天正文 276→398px、终端 232→354px、页面溢出 0。键盘弹起时第四格把 `/` 换成换行键——手机回车就是发送（没有 Shift 可按），没有换行键就写不了段落，而 `/` 只是打一个键盘上已有的斜杠；按钮平时 `display:none`，桌面与键盘收起仍是四个，`#herdr-command-button` 元素与 `aria-expanded` 保留 |
| `458b51f` | 横向手机落进透镜视图：lens 闸门原来只认 `max-width: 720px`，而样式表早在 900px 就折叠侧栏、放大触屏控件，844×390 于是两边都不管——没有侧栏也没有 lens，却留着桌面 tab 条、AUTO/WRAP/EXACT/FIT 渲染条和约 130px 的终端。闸门改为 `(max-width: 720px), (pointer: coarse) and (max-width: 900px)`，粗指针到 900px 一律走 lens；短边姿态（≤480px）再学打字模式把 46px masthead 与 22px 状态行让出来、`.shell` 栅格并成一行，聊天正文 132→204px，会话头留工作区与 CHAT/TERM，标签条留 tab/agent/状态 |
| `0b7ac3b` | 触屏版式只跟画面走：`@media (pointer: coarse)` 里原来连整张卡的框（贴边 8px、20px 圆角、抬起底色、2×2 控件簇）都给了触屏，结果 1440px 触屏本上草稿被拉成 1179×96 的整条底栏。改动把触屏拆成两层——字号/点击面（16px 草稿、36px 控件，`pointer: coarse` 霣持，iOS 才不会聚焦放大）和手机框（`.shell.is-narrow` 才算），顺便把 721–900px 的鼠标窗口从 119px 的手机卡还原回 89px 的桌面卡；打字模式的一行折叠改用 `.has-keyboard .shell.is-narrow`（`has-keyboard` 在 `html` 上，是 shell 的祖先不是后代）重整特异性后仍赢过 2×2 |

配套验证：`npm --prefix web run typecheck` 干净；`test:unit` 281/281（含 `fitComposer` 两行起底与
`imeEnter` 各一例）；
`/tmp/probe-enter.mjs`：回车发 `/keys`、`⇧⏎` 只换行、合成 IME 回车不发、发送后焦点仍在草稿；
`/tmp/probe-card-attach.mjs`：`#herdr-attach` 与 `#herdr-image` 两个选择器都能加附件、卡片长到 231px；
`/tmp/probe-pc.mjs`：1440×900 草稿 `896×89`、圆角 14、34px 控件、页脚可见，1280×800 与 1024×768 无溢出；
`probe-card.mjs`：390×844 与 320×700 明暗两色卡高 96、草稿两行、控件簇 2×2 36px；
线上 5001 复查同尺寸（`live-1440x900-{dark,light}.png`、`live-390x844-dark.png`）。
`/tmp/probe-code.mjs` 34/34（390×844 手机、700×900 窄桌面）；`probe-diff.mjs` 24/24；
`probe-composer-fit.mjs` 16/16、`probe-composer-refit.mjs` 8/8；
`/tmp/probe-keys.mjs`（390×844 与 320×700，明暗两色）：键条 `scrollWidth == clientWidth`，
菜单 8 列 2 行、页面无横向溢出、xterm 视口无滚动条，Esc/外点都能收起；
`/tmp/probe-kb.mjs`（390×844，模拟 336px 键盘）：iOS 路径 `--kb-inset: 336px`、`.shell` 508px，
键条与输入框整体落在键盘上方、页面无溢出，菜单展开后仍不遮输入框；Android 路径
（直接缩 viewport）inset 为 0、布局与 iOS 收缩后一致，不重复缩短。
`/tmp/probe-mobile.mjs`（390×844，KB=336，明暗两色 × 两个 lens）：键盘收起时 masthead 0–46、
head 46–92、聊天 128–740（612px）、卡片 96px；弹起后标签条 0–36、聊天 36–434（398px）、卡片
434–500（66px，控件簇一行 32px、草稿两行居中），终端 36–390（354px）+ 键条 390–434（44px），
`scrollHeight - clientHeight` 均为 0；关掉键盘回到收起状态、无跳动。
`/tmp/probe-newline.mjs`：键盘弹起时 `#herdr-newline-button` 显示、`#herdr-command-button` 隐藏，
点一次在光标处插入换行（草稿 2→3 行、卡片 66→90px）、焦点与 `has-keyboard` 都还在、不发
`/input` 请求；连点两次插入两行。
`/tmp/probe-closed.mjs`：390×844 / 834×1112 / 1280×800 收起态控件仍是四个（新行按钮 `display:none`），
卡片 96 / 96 / 89px 与改前一致。
`/tmp/probe-band.mjs`（`hasTouch` 模拟粗指针）：横向 844×390 改前是 `.shell`（无 lens、无聊天区、45px
渲染条、终端只剩中间 130px），改后 `.shell is-narrow`、masthead 0px、会话头 0–46、标签条 46–82、
聊天 82–286（204px）、草稿卡 96px；667×375 同构（聊天 189px）；竖屏 390×844 与 834×1112 只多了
lens（聊天 612 / 854px，masthead 与状态行照旧）；细指针 1440/1280/1024 一字未动（无 lens、渲染条在、
草稿 896×89）；全部尺寸 `scrollWidth/clientWidth`、`scrollHeight/clientHeight` 之差为 0，
`after2-term-844x390-{dark,light}.png` 里 TERM 一侧的 xterm 160px + 键条 44px 也落在卡片上方。

`/tmp/probe-band.mjs`（`TOUCH=1` 表粗指针）：1440×900 与 1024×768 的草稿回到
`896×70` / `820×70`（居中、圆角 14、控件仍是一行 36px，触屏只是没有 15px 页脚提示），改前是
`1179×96` 的整幅底栏；900×700 粗指针是平板，仍 `.shell is-narrow`（聊天 442px、卡 96px）；
`TOUCH=0` 细指针 900×700 / 800×600 窗口回到桌面卡（`872×93` / `772×93`、圆角 14、四控件一行），
1440/1280/1024 与改前逐像素相同（`896×89`）；390×844 与 834×1112 收起态卡片仍 96px、2×2 36px，
`probe-kb.mjs` 键盘弹起仍是 66px（一行折叠），关掉键盘回 96px 不跳动，明暗两色 `pp2-900x700-dark.png`、
`pc-touch-1440x900-dark.png`。

## 5. 给服务端的一页需求（若要继续逼近 Ovis）

最小可用集，按依赖排序：

1. `pane.conversation` 至少返回 **turn 边界 + 每个动作的开始/结束时间**。
   有它才有时长摘要与稳定行身份；不需要解析所有 agent，`source: "scrollback"` 作为兜底即可。
2. `pane.read` 增加 **`before` 游标**，让聊天能往前翻而不是只有 200 行。
3. 会话历史的 `history_id`/世代号，避免历史被替换时整段重排。
4. （可选）选择菜单的结构化读出：`{options[], default_index}`。没有也能用键条，有则能做卡片。
