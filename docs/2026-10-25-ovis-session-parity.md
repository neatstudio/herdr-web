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
| 代码块语言 / 复制 / 折叠 | `CodeBlock`（`lucide-react` 图标） | `components/session/Markdown.tsx` `CodeBlock`：语言标签、`copy` 文字链、超 30 行折到 20 行（提交 `5ee48b6`）；粗指针下 `copy` 与 `show all` 各占 44px（提交 `f7118af`） |
| markdown 正文 | `HighlightedCode`、表格、列表 | `components/session/Markdown.tsx`（`lib/markdown.ts` 解析） |
| 输入框随内容长高 | `Composer.tsx` `sizeTextarea()`（`useLayoutEffect` + 隐藏测量副本） | `components/PromptBar.tsx` + `lib/composer.ts` `fitComposer()`（提交 `4278e69`） |
| 按 pane 存草稿 | `ovis:composer-draft:<paneStorageId>` | `herdr:draft:<paneId>`（`lib/composer.ts:95`） |
| `@` 提及 / `/` 命令 | `lib/mentions.ts` + `usePaneCommands` | `lib/composer.ts` `mentionQuery`/`slashQuery` + `PromptBar.tsx`（提及 pane/workspace/路径，非 agent 专有） |
| 附件上传 / 粘贴 / 拖入 | `uploadImages` + `.composer-attachments` | `lib/attachments.ts` + `PromptBar.tsx`（`uploadFile`）；粗指针下四枚 36px 控件各长出 `-4px` 裙边，实际接住 44×44（提交 `fb7cc02`） |
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

1. **终端内查找**（已做，`c2af03e`）：Ovis 的 `FindBar` 是服务端搜索（它 `scrollback: 0`）；
   herdr 有本地 2000 行，用 `@xterm/addon-search` 即可，不依赖 RPC。
2. **把答案复制为 markdown / 纯文本**（已做，`f421b9c`）：`lib/answerText.ts` 一份
   `turnCopyText()`，markdown 原样、纯文本去标记；按钮从「只在最后一轮、只给纯文本、手机上
   还要 hover 才现形」改成每一轮都写两个格式。
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
| `c2af03e` | 会话透镜里能搜回滚：桌面宽屏根本没有 xterm（`Scope` 把转录画成 DOM 文本），浏览器自带的查找本来就好用，所以只在透镜里补——xterm 画在 canvas 上，Chromium 的查找对看得见的行也报 0 结果。加一条浮在 `.term__host` 里的 bar 跑 `@xterm/addon-search` 搜本地 2000 行：`⌘F` 开、`Ctrl+F` 仍然下行给 readline/TUI，Esc 关、Enter 下一个、Shift+Enter 上一个，计数直接来 `onDidChangeResults`；浮层不改变栅格、不触发 `refit()`（`refit` 会 `reset()` 重画，闪一下）；高亮色只能是 `#RRGGBB`（装饰不认 `var()`），`lib/find.ts` 的 `findInk()` 按主题给色、翻主题时用新色重跑。手机端 bar 高 48px 且贴顶，软键盘遮不到 |
| `1f61e56` | agent 名字不再念两遍：herdr 给没改过名的 agent pane 的 `terminal_title` 就是程序名，于是 `paneListName()` 和旁边的 agent 芯片同时打出同一个词——侧栏与选择面板读作 `codex codex herdr-web`，tile 头读作 `omp omp pF`，pane id 反倒被挤掉。新增 `paneNameRepeatsAgent()`（两边 trim 后忽略大小写完全相同才算重复）与 `paneRowName()`：侧栏/面板留着染色芯片、名字列改印短 id（`codex pG herdr-web`），tile 头留着名字、省掉芯片（`omp pF`，id 仍是 `tile__id`）；改过名的 `codex — working`、目录恰好同字的 `app`、没有 agent 的 shell 行照旧 |
| `63cdfa4` | 不认识的 agent 状态不再被念成 idle：herdr 把 `agent_status` 原样透传，官方之外的 agent 会报 `error`、`paused` 这类词，而 `toneOf()` 让它们全落进 idle——分组和配色这样没错，写成字就是撒谎，一个刚出错的 pane 在标题栏里读作 IDLE。改成「tone 是桶、状态字才是真相」：`statusLabel()` 对四种已知状态印规范词、其余印原词（按词边界截到 24 字），`statusChip()` 在 tile 头里截到 12 字；`data-tone` 照旧吃 `toneOf`，所以侧栏的颜色与排序一字未动，不认识的词挂在行的 tooltip 上。同一个 clip 也顺手把整句状态收进 `.stage__status-word` 30ch 与 `.tile__status` 12ch 的天花板，长词不会把标题挤走 |
| `503991e` | 手机上的 chrome 与打字盘给手指让路：masthead 三个入口、主题循环、以及手机上唯一的 pane 切换器都是 20–22px 高（切换器只有 28px 宽）——不到半个指尖，点工作区名经常点空。盒子不能直接加高：主题块是带边框的、切换器扛着 head 的左对齐，44px 的框套 10px 的字是另一个设计。于是盒子照旧画，只把「接住那一指」的伪元素撑开（`.lens__opt` 早就在用这招）：masthead 里 `inset: -12px 0` ⇒ 44px 高、仍在 46px 的行内；切换器 `inset: -13px -10px` ⇒ 48×44，文字的 x 位置不动；没有粗指针的桌面一行未改。打字模式四个控件从 32px 回到 36px：草稿自己两行撑起 66px 的卡，这一行不会因 36px 变高，那 4px 是白让的 |
| `d2842eb` | 标签条也给手指让路：它是手机上唯一的导航，而 tab 只有 35px 高，横屏里钉住的 `+` 更是只剩 30px 宽。这里借不到 head 那招伪元素——标签条夹在 head 与转录之间，向外撑出来的那几像素要么落在上面 24px 的透镜切换器上（它的接住区正好也在那儿），要么落在下面的转录上，从第一行起手的一次滚动会变成切 tab。所以条子本身长到 44px：转录让出 8px，竖屏会话的 1.3%；`+` 两向都到 44，正好对上条子早就给它留的 `scroll-padding-right: 44px`。打字模式把这 8px 还回来（键盘弹起时条子只需说明「你在哪个 tab」），仍是 36px |
| `690f11a` | 横屏里那个钉住的 `+` 其实点不到：9 个 tab 时整条 844px 装满，`+` 本该 `position: sticky; right: 0` 永远露在右沿，可这两条规矩写在 `max-width: 700px` 里，844×390 恰好落在 700–900 之间——`+` 退回普通 flex 项，被挤出右边界 43px（条子要多滚 73px 才看得见它）。挪进 900px 那一块（和 `.tab{min-width: 5.5rem; max-width: 66vw}`、`scroll-padding-right: 44px` 一起）：900px 正是「标签条是手机唯一 tab 列表」的分界。改后 390/700/768/844 四种视口 `+` 都贴在右沿内侧（844 是 `[800,844]`），700–900px 的桌面窗口也让 tab 收窄而不是把条子撑出屏幕 |
| `e7be773` | 分屏里没被选中的 tile 只写一句 `click to read this pane`，白空掉一整块——那里该回答的是「这是哪个 pane、在哪个目录跑」。它不能读：只有 active tile 读 pane，否则每次轮询都会把每一格的转录拉一遍。正文因此只用 fleet 快照已有的东西：完整 pane id（头部只印短 id，且只在 pane 自己有名字时才印）、目录末两段（`tailPath(cwd, 2)`——末两段才分得清同一个 repo 的两份 checkout，完整路径留在 tooltip）、以及 `statusNote()`：只有 herdr 报了个本 console 不认识的词才印，因为那种词在头部芯片里会被截到 12 字；已知状态头部已经说过，不重复。四行都是 `--step-label` 10.5px，`.scope__idle` 仍是原来那个 flex/full-height 容器，`App.tsx` 里「no pane selected」那条带 `<strong>` 的空态一字未动 |
| `8974530` | 手机上的聊天 lens 原来只给「herdr 认得出的 agent」开：`hasAgent` 为假时 `drawnLens` 被硬改成 `terminal`、切换器也不画。可 herdr 只认识它认识的 agent——套在 wrapper 脚本里、被 `npm run` 拉起、或刚出的新二进制都报成 shell（`agent: ""`），这种 pane 在手机上就被钉死在 46 列的 xterm 里，恰好是这一宽度唯一读不了的东西。agent 名于是退回只决定**默认**：切换器对每个 pane 都画，每 pane 存过的选择由 `resolveLens()` 优先（`resolveLens("chat", false) === "chat"`），刷新后仍开聊天；prompt 上的 shell 默认照旧是终端，它的文档视图就是回滚读成 prose，空态照旧给 `Open terminal` |
| `aa88ff0` | 手机上手边的菜单按不到：键条原来只认 herdr 报的 `blocked`，而 herdr 只对它认识的 agent 报 blocked——第三方 agent 画完菜单仍是 `working`，方向键、`↵`、`esc` 就全都没有。改成内容自己出第二意见：`showsPicker(text)` 去 ANSI、逐行去掉竖线/箭头前缀，取末 12 行数选项标记（`[1]`、`(2)`、`3.`）≥2 个、且末 6 行里有一句确认/取消提示，两条都中才出键条；宁可漏判，因为误判会把方向键从正在打字的输入框里抢走。`ChatLens` 的重钉滚动、键盘捕获、键条渲染三处共用这一个判断 |
| `4afa186` | 菜单的答案原来只能用方向键走过去：键条只有 `esc ↑ ↓ ← → ↵` 六个键，手机上一份三选一的菜单要按三次才选中、四次才确认，而答案本身就是 agent 在等的那个数字。改成把快照里拼出来的答案做成 chips（`parsePickerOptions()` 复用 `showsPicker` 的同一道闸，所以绝不会出现「有键条没 chip」或反之）：`[1] keep [2] skip [3] edit` 一行内联菜单变成三枚 chip，点一下发出 `{"keys":["2"]}`。标签止于内联菜单对齐用的两格以上空档（`1. run step 2. then` 因此是一个答案不是一个），超长标签**中间**截断而不是结尾——答案常是共享前缀的路径，能区分它们的是尾巴（`/Users/gouk…kspace-name-w0`）。键条保留：`esc` 在它手上，且「herdr 报 blocked、快照却没写答案」那种菜单只有键条过得去 |
| `f421b9c` | 答案带不走：唯一的复制在最后一条上，且只给一行拍平的纯文本；手机更糟——`.chat__meta` 只在 hover/`focus-within` 时 `opacity:1`，拇指既没有 hover 也点不到还没显形的东西，等于这一功能只对桌面有用。改成每一轮都写两个格式：`markdown` 是 agent 原文（标题、围栏、行内代码原封不动），`text` 去标记但**围栏内的内容一个字节不动**（`sh` 块里的 `#` 是注释不是标题，`npm test --watch=false` 原样），操作者自己说的话在两种格式里都原样保留（他打的 `#` 就是他要的）。判断全在 `lib/answerText.ts` 的 `turnCopyText()`：按行扫围栏状态机丢围栏行、只对围栏外的行剥 `#`/`>` 与行内语法，链接 label 与 target 相同只印一次；`TurnList` 拆出 `TurnFooter`，`copied` 记成 `{id, format}`，只把刚点的那一个按钮写成 `copied`（1.5s 后复原），另一格式的标签不被顺手改掉 |
| `f7118af` | 代码块的两个按钮是整条聊天里最后两处点不准的地方：`copy` 只有 26×20，`show all 34 lines` 有 44px 宽却只有 30px 高——而正好是手机上最需要折的那段构建日志。粗指针下让表头行本身长到 44px（语言标签继续吃省略号），`copy` 撑成 44×44、`show all` 补到 44px 高；细指针一律不动，仍是 30px 的表头与 20px 高的文字链，鼠标不需要那块空白。手机上每处代码块因此多 14px 的表头高度，换来的是不用瞄准的手指尺寸 |
| `fb7cc02` | 输入区的四枚按钮正好落在拇指落点上，却只有 36×36：`+`（附件）、图片、`/`（命令）、发送两两相隔 2px，组成 2×2 的 74px 方块。面不能长大——36px 正是「静止 96px / 弹键盘 66px」两张卡高的来源，每多 1px 面就从转录里拿走 1px——所以手指的余量加在面**外面**，和本文件里 `.prompt__untile` 用同一个办法：透明的 `::before` 裙边 `inset:-4px`，四个控件各得 44×44，一个元素都不动。裙边只在 2px 缝里互相重叠，后画的兄弟盖住先画的，最后一个正是发送——这一下绝不会落到邻居身上 |
| `57aad70` | 横屏里的发送键原来真的会掉到键盘底下：`--kb-inset` 等于「键盘挡住的高度」，但代码用 `innerHeight * 0.6` 给抬升封顶，防的是「浏览器报一个塌掉的 visualViewport 把控制台折没」。这个上限在竖屏从来不会咬到（844 高，键盘 300–420，上限 506），可是 844×390 横屏配 250px 键盘时，上限只有 234：外壳留下 156px，草稿卡底边 148 正好压在 140px 的可视区下面 8px——按不到的正是发送。改成「地板」而不是「比例」：抽到 `lib/composer.ts` 的 `keyboardInset(innerHeight, viewportHeight)`，返回 `min(被挡高度, innerHeight − 140)`，140px 是静止草稿卡 66 + 卡片外 8 + 键条 37 + 一点转录；浏览器乱报时仍然折不到控制台以下。实测 844×390：inset 234→250px、卡底 148→132（可视区 140）、`underKeyboard` true→false、页面溢出仍 0,0、转录仍贴底；390×844 与 320×568 两个姿态的数字与改前逐位相同（420/844、300/844、260/568 都远在 140px 地板之上）。单测 `keyboardInset` 四例（竖屏全给、横屏给满 250 而不是 234、无键盘与回缩地址栏不动、塌掉的视口停在地板上、NaN/Infinity 不动） |
| `cbe3f5c` | 大屏手机横过来也是手机：竖着是 `max-width` 管得住的，横过来 932×430 / 915×412 却比 900px 的粗指针闸门宽，于是拿到桌面舞台——八格 178px 的 tile、176px 的工作区侧栏、89px 的草稿卡。判据改成「宽度，或者粗指针且窄或矮」：`lib/frame.ts` 的 `compactFrame(w, h, coarse)`，720 以内一律手机；粗指针再看 900px 宽或 500px 高（横放的手机最高 440，iPad mini 竖着 768，500 落在中间）。样式表里两处 `max-width: 900px` 的手机折叠（侧栏并成单列、键盘弹起时让出 masthead 与 46px 头）补上同一条高度线，否则透镜会画在 176px 侧栏旁边 |
| `2312f04` | 横屏手机的闲时盘也折成一行：一张 844×390 的卡只有 390px 高，草稿卡占掉 96px，而撑起这 96px 的不是两行草稿是 74px 的 2×2 盘——键盘弹起时早就这么折过，只是这回键盘没弹。竖屏没有宽度在草稿旁边放一排四个控件，横屏有 828px，所以这是高度规则不是宽度规则：粗指针且高度 ≤500px 时 `.shell.is-narrow .prompt__pad` 改用一行 flex、字段垂直居中，卡 96→70px，转录拿回 26px。926×428 / 932×430 / 844×390 实测转录 233/235/195→259/261/221、卡底 420/422/382 仍在视口内、四枚 36px 控件排成 150px 一行、溢出 0/0；竖屏 390×844 与 320×568 照旧 2×2 与 96px，926×428 鼠标与 1024×768 触屏本照旧桌面卡，键盘态卡仍是 66px |

| `7cb89b9` | 平板竖着也不该掉进手机框：`compactFrame` 原来只看宽度，于是 iPad 竖放（744×1133、820×1180、768×1024）落进透镜、横放却拿到桌面舞台——转一下屏整个控制台重建。宽度本来就说不清这件事：手机之所以是手机看的是短边，而短边不随摆放改变。判据改成「宽度 ≤720」，否则「粗指针且短边 ≤500」；500 落在横放手机（≤480）与 iPad mini 短边（744）之间，`TOUCH_WIDTH`（900）整条删掉。900px 的 CSS 折叠不动：平板现在留着舞台，折掉它的侧栏在这个宽度上本来就对。测试钉住手机/平板分界，并断言六种摆放里 `f(w,h) === f(h,w)`。实测 820×1180 / 744×1133 触摸：8 格 205px/186px 的 tile、草稿 70px、页脚 26px、溢出 0/0；390×844、320×568、844×390、932×430 与 1280×800、1024×768 逐位不变 |
| `4bfd5f1` | 触屏 tile 上的 AUTO/WRAP/EXACT/FIT 被切成半截：它是四列等分的 grid，可 grid 项不会缩到自身 min-content 以下，格子于是被四个词撑成 223px，而 8 格 tab 在 744px 平板上给每格 186px——最后一个词 `FI` 被 tile 的 `overflow: hidden` 剪掉，820px 平板剪掉 18px、1024px 剪掉 11px。它还在读 `--step-fine`，这个 token 样式表从头到尾没定义过，字号于是继承祖先（约 15px）。格子改 `minmax(44px, 1fr)`（每格仍是一指宽，四格均分 tile），字改 `--step-label`、内边距 4px+`min-width: 0`，最宽的词 EXACT（41px）正好装进最窄的格（46px）。实测 744/820/1024 的末格右沿刚好落在 tile 右沿、溢出 0、格宽 47–53px；鼠标桌面的浮层条仍是 [183,20]、格宽 46/45/53/38 一点没动 |
| `b013330` | 细字一直在假装自己存在：`--step-fine` 被 20 处声明引用（面板、弹窗、任务板、peek 预览），却在两个仓库里都没有定义过（`git log -S` 查空），声明全部落到 computed-value 阶段失效、字号继承正文 12.5px——面板因此只剩颜色一层层级。在 `:root` 定成 11px（标签 10.5 < 细字 11 < 正文 12.5）。连带两件：`.newws__submit` 高度是 padding + 行盒，细字一缩手机上 44→42px，coarse 下钉 `min-height: 44px`（桌面仍 30px，副产品是弹窗里的 create 在粗指针下 32→44px）；任务板条目的那行 prompt 是唯一识别信息，留在正文 12.5px，其余元信息才用细字。390×844/844×390/1440×900 明暗实测 20 处全 11px/17.6，旧 tmux、peek、dispatch 条目、commits、collect 这批原本量不到的补 fixture 后也一致 |
| `dcd8738` | 细字一缩小，面板和表里的控件就全部掉到拇指下面：`--step-fine` 只有 11px，而这些盒子没有 `min-height`，高度全靠自己的行盒加 padding——字段 34、策略切换 23、机器行 19（复选框 13）、两处折叠行 18、stop 19、面板头按钮 22/18、关闭按钮 20×24。桌面无所谓，手上大面积按空。先试了 masthead 那套伪元素扩展，用 `elementFromPoint` 逐点扫发现 button 把生成内容裁进自己的盒子，`::before` 的 inset 只在原盒范围命中，于是改成真实长高：字段（含 fleet 表单的 select）、策略键、机器行（复选框 13→18，行内详情在粗指针下允许换行，手机上一行只剩省略号，而“这台机器装了哪个 agent”正是决定点不点的信息）、`.dispatch__line` 居中与 stop、两处 `summary`、`.hostpanel__act`、面板与表的头部按钮/关闭按钮。整块必须写在样式表末尾：`.sheet--dialog .newws__field input` 的 34px 在 500 行之上、同特异度，写在旁边是静默失效。390×844 粗指针实测 host 9 个控件9 个小 → 0，fleet 25 → 0，844×390 同；1440×900 鼠标 host 仍 9 小、fleet 仍 19 小，逐个高度与改前一致（22/18/19/23/30/34） |
| `9eaf60c` | 终端镜头里的键条、键盘菜单和查找条仍是鼠标尺寸：44px 的键条里浮着 32px 的键面（上下各 6px 空），菜单的 `hide` 是 26×20 的文本链接、两行网格每行只有 32px，查找条的三枚按钮是 36×36、旁边那颗启动按钮 40×40。键面加到 40px 时整条会从 44 涨到 45（1px 规则 + 2+2 padding），等于白拿终端一行，所以让 padding 从 2 退到 1 把那 1px 还回去，`min-height` 继续钉住 44px——竖屏、横屏、键盘起落四种姿态下终端高度与改前逐项相同（559/429/177/0）。菜单是在流里的，它长多高终端就少多高，于是给小屏横放留了 `min-height: 500px` 的闸：竖着两行网格升到 40px、标题行 44px（`hide` 变成真 34×44），480px 高的横屏手机维持 32px 不变。查找条按钮升到 44px，390 宽仍有 182px 输入框、320 宽 112px，无溢出 |
| `1dc18b4` | 手机上换 pane 全靠 picker 表，可这张表每一件都还是桌面尺寸：行高 30px、agent 名用 9.5px 的 micro 字号、还塞在 4rem（64px）的列里，于是 `opencode-gpt-5-coder`、`claude-code` 被截成 `opencode-…`/`claude-co…`——一行里唯一能区分两个 pane 的词没了，名字那侧却空着；Agents/Spaces 切换条 34px，筛选框 27px 高、旁边那个 14px 的 `×` 只有 16×14。粗指针下：行 44px，agent 列放宽到 5.25rem 并把字号提到 `--step-fine` 11px（identity 不是 caption），切换条 44px、字号同样升到 11px；筛选框 44px，清除键撑成 44×54 顶满整行、字段用 `padding-right: 46px` 把文字让开它（`top/right/bottom: 0` 让它吃满 filter 行，而不是只吃 input 的 44px）。全部挂在 `(pointer: coarse)` 且以 `.sheet` 前缀收窄，桌面仍是 30px 行 / 34px 切换条 / 27px 筛选框 / 16×14 的 `×`（1440×900 与 1280×800 逐项复测）。390×844、320×780、768×1024 明暗实测：表内每个可点元素都 ≥44×44，列表可滚、无溢出 |
| `b473db7` | 打字钻进 picker 时那张表把下半屏藏了：`visualViewport` 缩了但 layout viewport 没缩，`.sheet` 是 `position: fixed; inset: 0`，于是 390×844 上配 300px 键盘时 sheet 仍量到 844、第 1–8 行全在键盘后面，而且列表内容 528px 正好塞进 528px 的盒子——没有溢出可滚，第 12 行永远摸不到。修法只用已有的 `html.has-keyboard` 与 `--kb-inset`：粗指针且 `min-height: 500px` 时 `.has-keyboard .sheet { bottom: var(--kb-inset, 0px) }`，sheet 844→544，`.sheet__body` 拿到 381px 的可视区与 528px 的内容，最后一行滚得到也点得中。肖像限定是因为 390px 高的横屏手机 sheet 自带 chrome 就 163px（头 63 + 切换条 45 + 筛选 55），让 250px 给键盘就一行都不剩——那里保留整屏 5 行更好。同一条规则顺带把 new-workspace 弹窗从 y=278 抬到 y=128，仍在键盘以上居中 |
配套验证：`npm --prefix web run typecheck` 干净；`test:unit` 285/285（此数后被各条改动抬到 310，含 `fitComposer` 两行起底、
`imeEnter` 各一例、`findLabel` 的 1/4、0/0 与越界夹取，以及 `lens.test.ts` 里
`resolveLens` 的三例）；
`/tmp/probe-enter.mjs`：回车发 `/keys`、`⇧⏎` 只换行、合成 IME 回车不发、发送后焦点仍在草稿；
`/tmp/probe-card-attach.mjs`：`#herdr-attach` 与 `#herdr-image` 两个选择器都能加附件、卡片长到 231px；
`/tmp/probe-pc.mjs`：1440×900 草稿 `896×89`、圆角 14、34px 控件、页脚可见，1280×800 与 1024×768 无溢出；
`probe-card.mjs`：390×844 与 320×700 明暗两色卡高 96、草稿两行、控件簇 2×2 36px；
线上 5001 复查同尺寸（`live-1440x900-{dark,light}.png`、`live-390x844-dark.png`）。
`/tmp/probe-code-tap.mjs`：390×844 手机（明暗两色、34 行代码块）改前 `copy` 26×20、
`show all` 30px 高，改后 `copy` 44×44、`show all` 44px 高、表头 44px，点 `copy` 得到 `copied`
且不滚走；720×900 细指针（narrow 桌面）尺寸一位不变（表头 30 / `copy` 26×20 / `show all` 30），
两侧页面溢出均为 0/0。
`/tmp/probe-composer-tap.mjs`：390×844 手机（明暗两色 × 静止/弹键盘）四枚控件都报 44×44 有效、
卡高仍是静止 96px 与键盘 66px（`html.has-keyboard` 下单行 `+ image ↵ send`）、页面溢出 0/0；
`elementFromPoint` 从面外 3px 落点仍归该控件，往外 14px（进草稿）就归 `textarea`；
发送右下方无人抢，邻居的裙边只在 2px 缝里交换。1280px 桌面一位不变：34px 面、没有裙边。
截图 `thumb-{dark,light}-{resting,typing}.png`。
`/tmp/probe-copy.mjs`：390×844 手机（明暗两色）两轮各有 `markdown`/`text` 两个按钮，粗指针下
`min-height` 就是 44px、`.chat__meta` 不再靠 hover（两轮 opacity 均 1），点 `markdown` 拿到
`## 改好了` 与 ```` ```sh ```` 行、点 `text` 拿到去掉 `#`/反引号的同一段但围栏里的
`npm test --watch=false` 一字不差，被点的那颗 1.5s 后从 `copied` 复原；720×900 细指针（narrow
桌面）未 hover 时 `opacity:0`、hover 后第一轮变 1，按钮 24px 高、伪元素向外各撑 10/6px；
弹键盘后聊天区 603→397px、草稿卡仍是 66px、每一轮两个按钮都还在、页面溢出 0/0。
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

`/tmp/probe-find.mjs`（390×844 与 700×800 粗指针，明暗两色）：收起时右上角放大镜 `[344,134,40,40]`、
终端 `[0,128,390,568]`；点开后 bar `[6,134,378,48]`、输入框拿到焦点、计数 `0/0`，终端矩形一字未变
（开 bar 不挪栅格）；输入 `error` 后 `1/4`、`.xterm-decoration` 4 个，Enter `2/4`、Shift+Enter `1/4`、
Esc 后 bar 消失、放大镜回来、装饰清零；`700x800` 细指针（`TOUCH=0`）拿到基准尺寸 36px 触发球 / 44px bar；
1440×900 桌面 `findOpen:false`、无 `.term__*`、转录里能读到那行错误、页面无溢出——桌面按设计不改。
`/tmp/probe-find-kb.mjs`（390×844 + 336px 软键盘）：iOS 只缩 `visualViewport` 时 `--kb-inset:336px`、
`.shell` 508px、终端 36–390（354px）、bar 落在 `y 42–90`、键盘线 508，未遮；Android 两条 viewport 都缩
时不重复缩短；关掉键盘 bar 回到 `y 134–182`、终端仍 568px，无跳动。截图 `find-390x844-*-{dark,light}.png`、
`find-kb-ios-dark.png`。

去重这条的验证：`npm --prefix web run typecheck` 干净；`test:unit` 287/287（新增 `paneNameRepeatsAgent` 与 `paneRowName` 各一例）；`/tmp/probe-dup.mjs`（两 pane，`terminalTitle` 故意等于 agent，1440×900 细指针 + 390×844 粗指针，明暗两色）：改前 tile 头 `omp omp pF` / `codex codex pG`、侧栏 `codex codex herdr-web`，改后 tile 头 `omp pF` / `codex pG`、侧栏与选择面板 `codex pG herdr-web` / `omp pF herdr-web`，无一处重复；`probe-fill.mjs` 与 `probe-pc-rich2.mjs` 的几何一字未动；`app.spec.ts` 79 passed / 8 个既有失败（与改前同一批）。

触控目标这条的验证：`npm --prefix web run typecheck` 干净；`test:unit` 289/289；`npm run build` 通过；
`/tmp/probe-hit.mjs`（390×844 粗指针）用 `elementFromPoint` 打**标签外 10px** 的上下左右四点：
四个入口全部命中自己，盒子仍是原来的 `135×20` / `54×20` / `49×22` / `28×18`（可见的画一字未动，
撑开的只有接住手指的那块）；左右两侧被邻居接住的点落在邻居自己的字上，两枚 chip 间隔 10px，
本来就没有死区。`/tmp/probe-tap.mjs` 明暗两色 × 竖横两向：`scrollHeight - clientHeight` 全 0，
竖屏打字卡 `[8,434,374,66]`、横屏 `[8,82,828,66]` 与改前相同，行内四个控件 36×36（原 32px）；
1440×900 与 1920×1080 的 1/2/4/6 pane 几何与改前逐项相同（`/tmp/fill4.json` vs `/tmp/fill2.json`
0 处差异）。截图 `tap-rest.png`、`tap-phone-{dark,light}.png`、`tap-landscape-{dark,light}.png`。

标签条这条的验证：`npm --prefix web run typecheck` 干净；`test:unit` 289/289；`npm run build` 通过；
`/tmp/probe-tap.mjs` 四腿（明色亦然）`scrollHeight - clientHeight` 仍全 0：竖屏收起时 tab `96×44`、
`#herdr-new-tab` `44×44`、条子 `[0,92,390,45]`，横屏收起时条子 `[0,46,844,45]`（head 0–46），
打字两腿 tab `96×36`、`+` `44×36`、打字卡仍是 `[8,434,374,66]` / `[8,82,828,66]`；
`/tmp/probe-fill.mjs` 1440×900 与 1920×1080 的 1/2/4/6 pane 几何 0 处差异（细指针的条子还是 35px）。
截图 `strip-phone-{dark,light}.png`、`strip-landscape-{dark,light}.png`，顶部裁切
`strip-top-phone-dark.png`、`strip-top-landscape-light.png`。

钉住 `+` 这条的验证：`npm --prefix web run typecheck` 干净；`/tmp/probe-sticky4.mjs`（10 pane 撑满条子，
390×844 / 700×900 / 768×400 / 844×390 四种视口读计算样式）：`plusPos:"sticky"`、`plusRight:"0px"`、
`plusOrder:"0"`，`+` 分别是 `[346,390]`、`[656,700]`、`[724,768]`、`[800,844]`，`scrollWidth` 都等于条宽。
`/tmp/probe-strip-fit.mjs`（1/2/3/4/9 pane × 竖横 × 明暗，`deviceScaleFactor:2`）：九 pane 横屏
`tab` 宽 `[89]×9`、`scrollWidth 844 = 条宽`、`+ [800,844]`，九 pane 竖屏 `[346,390]` 且条子可滚 446px；
`activeUnderPlus:false`、`docOverflow:0` 处处成立。`/tmp/probe-strip-desktop.mjs`（细指针 640–900px）：
760/800/900px 下 `+` 仍贴右沿、九 pane 的 `tab` 收窄到 88px，与粗指针一致。

空 tile 这条的验证：`npm --prefix web run typecheck` 干净；`test:unit` 290/290（新增 `idleTileFacts`
一例：目录取末两段、无 cwd 不出空行、已知状态不重复、未知词原样给出）；`npm run build` 通过；
`/tmp/probe-idle.mjs`（四 pane 分屏，1440×900 与 1100×760 × 明暗）：`wE:pB` 读到 `wE:pB` /
`tmux/api`（tooltip 是全路径）/ 斜体 `waiting for the…`（tooltip 是整句）/ `click to read this pane`，
`wE:pC` 只有 id 与 `/`，`wE:pD` 只有 id 与提示，`idClipped` 全 false，`scrollWidth - innerWidth` 0，
正文在格子里垂直居中（`wE:pB` 正文 146px 落在 164–454 的 tile 里）；
`/tmp/probe-idle-click.mjs`：点正文（不是按钮）仍会激活它——`herdr:pane` 变成 `wE:pB`、
`#herdr-feed-text` 读到 `read from B`、`.scope--idle` 从 2 格剩 1 格。
截图 `idle-dark-1440.png`、`idle-light-1100.png`、`idle-activated.png`。

无 agent 的 pane 那条的验证：`npm --prefix web run typecheck` 干净；`test:unit` 293/293
（`lens.test.ts` 三例：存过 `chat` 的 shell 仍开聊天、显式选择在两个方向都压过 agent 判断、
没有存过时 agent 判断说了算）；`npm run build` 通过；
`/tmp/probe-shell-lens.mjs`（`agent: ""` 的 `wE:pA`，390×844 / 320×700 / 844×390 × 明暗）：
切换器 96×26 画在头右侧（320 时 x=210..306，仍留 14px 边距）、默认 `term` 压亮，
点 `chat` 后 `.chat` 挂载且 `.term__host` 卸载、`localStorage["herdr:lens:wE:pA"]` 记成 `chat`，
刷新后仍开聊天（`resolveLens` 生效），再点 `term` 复原；head 与页面的
`scrollWidth - clientWidth` 全 0；1440×900 桌面照旧没有切换器、没有 `.chat`、没有 xterm
（桌面本来就没有 lens）。截图 `shell-phone-dark-term.png`、`shell-phone-dark-chat.png`、
`shell-small-dark-chat.png`。

键条这条的验证：`npm --prefix web run typecheck` 干净；`test:unit` 296/296（`pickerKeys.test.ts`
三例：claude/codex/内联菜单/带 ANSI 方框都认得出，正文里的编号列表与只有提示的段落不算，
菜单后面跟着九行工具日志时算历史消息而不是问题）；`npm run build` 通过；
`/tmp/probe-picker-bar.mjs`（390×844 × 明暗，每个用例独立 context，pane 靠 `herdr:pane` 预设
而不是靠切 tab）：`wE:pI`（opencode 报 `running`、转录末尾是菜单）键条 390×44，聊天道
603→559（键条真的让出 44px，不是压在上面），点 `esc` 发出 `{"keys":["esc"]}`；`wE:pF`
（正文有编号列表、没有提示）没有键条；`wE:pG`（herdr 报 blocked）照旧有键条。软键盘弹起
（`--kb-inset: 336px`、`html.has-keyboard`）：masthead 0、标签条 37、聊天道 397、键条仍 44 高、
草稿卡 66、页面溢出 0,0。截图 `picker-dark-picker.png`、`picker-dark-picker-kb.png`、
`picker-light-picker.png`。全量 e2e：78 通过 / 9 失败，8 条是既有失败，第 9 条 `1241`
单跑通过（全量跑里的摇摆用例）。


选项条这条的验证：`npm --prefix web run typecheck` 干净；`test:unit` 300/300（`pickerKeys.test.ts`
新增四例：三选一内联菜单解析成 `1/keep、2/skip、3/edit`；正文无菜单时返回 null；超长标签中段截断成
`11 + … + 14` 字且两条共享前缀的路径仍可区分；`1. run step 2. then` 与单空格分隔的 `[1] keep [2] skip`
都不算「多个答案」——宁可退回键条，也不猜一个会打错数字的 chip）；`npm run build` 通过；
`/tmp/probe-pick-chips.mjs`（390×844 × 明暗，每用例独立 context，六种 pane）：`wE:pI`（opencode
报 `running`、末尾是内联菜单）chip 行 390×40、键条 390×44，聊天道 603→519（两行都真的让出空间），
三枚 chip `1 keep / 2 skip / 3 edit`，点第二枚发出 `{"keys":["2"]}`，chip 本体 67×32、伪元素接住区
`−6px` 竖向外扩 ⇒ 44px；`wE:pF`（正文有编号列表、无提示）与 `wE:pG`（blocked + 正文）都只有键条没有
chip；`wE:pJ`（claude 报 `running`、八条长路径菜单）八枚 chip 在行内横向滚动，页面溢出仍是 0,0。
软键盘弹起（`--kb-inset: 336px`）：聊天道 397→313、键条 44、chip 40、草稿卡 66、溢出 0,0。
截图 `picker-dark-picker.png`、`picker-dark-picker-kb.png`、`picker-light-picker.png`、
`picker-dark-many.png`。


### 4.1 桌面舞台：一屏一 pane（`0b24a1f`）

会话区里「一屏只读一个 pane」这件事，两边原本只说了一半：Ovis 天生一屏一个会话，手机上我们
也早就只剩一个 pane（`stack`）；但桌面双屏/四屏 tab 一放开就是八格。1440×900 的八 pane 布局
每格 299×318——这正是分屏的意义，也正好是一屏读不完八段转录的原因。这一条把两半接上，
**只改画法，不动 herdr**：herdr 的 `zoomed`（它自己的放大）照旧，切换器也只在非 `zoomed`
时出现。

- `lib/layout.ts`：`ArrangeMode` 加 `focus`，`arrangeTiles()` 第三参 `focusPaneId`。选中顺序是
  请求的那个 pane → herdr 自己的 `focusedPaneId` → 快照里的 `focused` → 第一个 pane。第一条
  必须在最前：点 tile 只是把「发到哪」切过去，不移动 herdr 的光标，若以 herdr 为准，切换器
  会放大另一个窗格。`splitsOf()` 在 `focus` 下返回空——整屏一格，没有相邻边可拖。
- `App.tsx`：`stageMode = narrow ? "stack" : stageFocus ? "focus" : "side"`；`arrangeable` 只在
  「桌面 + 拿到 layout + 未 zoomed + 多于一个 pane」时画切换器。手机和单 pane tab 都不画：
  手机已经只剩一个 pane，单 pane 再用一个 ONE 说一遍是噪音。
- `ArrangeSwitch.tsx`：两个字 `grid` / `one`，`role="group" aria-label="pane arrangement"`，
  沿用透镜切换器（`.lens__switch` / `.lens__opt`）的视觉与接住区，放在 `.stage__head` 的
  spacer 之后——和右上角 LIGHT/DARK 同一套语言，46px 的头不增高。
- `index.css`：`focus` 的 tile 与 `side` 一样绝对定位（一格里没有第二格可分）。

实测（`/tmp/probe-focus.mjs`，8 pane、`layout.area` 160×60 按 4×2 切、默认 dark）：

| 视口 | grid 时每格 | 切 one 后整屏 tile | 页面溢 |
| --- | --- | --- | --- |
| 1440×900 | 299×318 ×8 | 1195×637 | 0,0 |
| 1280×800（light） | 266×268 ×8 | 1062×537 | 0,0 |
| 1920×1080 | 412×408 ×8 | 1648×817 | 0,0 |

三档 `tilesOverflow` 都是 `[0,0]`，`.prompt`（896×89）与标签条位置不变，切回 `grid` 八格
逐位复原；`aria-pressed` 跟着翻，`data-arrange` 由 `side` 变 `focus`、`data-count` 由 8 变 1。
390×844 手机与 1440×900 单 pane tab 上切换器根本不进 DOM（`arrange: null`）。截图
`focus-1440x900-dark.png`、`focus-1280x800-light.png`、`focus-1920x1080-dark.png`。
`test:unit` 318/318（`layout.test.ts` 加三例：整屏一格、回退顺序、没有拖拽边），typecheck 与
build 干净。

注意 `focus` 只是画，不写 `localStorage`：刷新回到 `grid`，和 PC「默认是真实终端分屏」的
默认一致。

### 4.2 横过来的大屏手机，也是手机（`cbe3f5c`）

上一节 `458b51f` 把横屏手机带进了透镜，闸门是 `(max-width: 720px), (pointer: coarse) and
(max-width: 900px)`。这条线在 844×390 上够用，可 iPhone 14/15 Pro Max 横着是 932×430、
Galaxy S23 Ultra 是 915×412——都比 900 宽，于是重新掉回桌面舞台：八格约 178px 的 tile、
左边 176px 的工作区栏、AUTO/WRAP/EXACT/FIT 渲染条，加一张 89px 的桌面草稿卡。**宽度不是
手机的判据，高度才是**：一台手机横放时高度不超过 440px，而任何桌面窗口都不会这么矮。

- `lib/frame.ts`（新）：`compactFrame(width, height, coarse)`。`width <= 720` 一律手机；
  否则要求粗指针，且 `width <= 900 || height <= 500`。500 落在横放手机（≤440）与 iPad mini
  竖放（768）之间，1024×768 的触屏本仍走桌面。
- `App.tsx`：`narrow` 不再自己拼媒体查询，改用 `compactFrame()`，监听 `resize` 与指针种类
  的 `change`（拔掉鼠标、转平板会换答案）。`narrow` 是 `SessionStage` 与 `TabStage` 的唯一
  开关，所以一处判据把视图和版式一起改了。
- `index.css`：`max-width: 900px` 那块手机折叠——`.body` 并成单列、`.sidebar` 收起、46px 的
  `.stage__head`、标签条收窄——补上 `(pointer: coarse) and (max-height: 500px)`；键盘弹起时
  让出 masthead 与头的那块同样补。只改闸门不改规则：不补的话，透镜会在 176px 侧栏旁边
  开一张 750px 的转录。

实测（`/tmp/probe-phoneland.mjs` 与 `/tmp/probe-kb-phoneland.mjs`，13 pane mock fleet）：

| 视口 | 改前 | 改后 |
| --- | --- | --- |
| 926×428 触摸（明） | 桌面：8 tile、头 x=176、草稿 89px | 透镜：`narrow` 真、tile 0、头 [0,0,926,46]、转录 [0,91,926,233]、草稿 [8,324,910,96]、2×2 盘 74 |
| 932×430 触摸（暗） | 同上 | 透镜：转录 [0,91,932,235]、草稿 [8,326,916,96]、卡底 422 |
| 844×390 触摸（暗） | 透镜 | 逐位相同（转录 195、草稿 [8,286,828,96]、卡底 382） |
| 390×844 / 320×568 触摸 | 透镜 | 逐位相同 |
| 926×428 鼠标 | 桌面 | 桌面（细指针不进矮的臂），8 tile、草稿 89px |
| 1024×768 触摸 | 桌面 | 桌面（768 高于 500），8 tile、草稿 70px |
| 1280×800 鼠标 | 桌面 | 桌面，几何不变 |

键盘态（假键盘缩 `visualViewport`）：926×428 配 250px 键盘，草稿卡 [104,66]、卡底 170 在
178 的可视区内；932×430 配 260px，卡底 162 在 170 内；两者转录 67 / 59px、页面溢出 0/0、
无横向滚动。截图 `phland-926x428-light-touch.png`、`phland-932x430-dark-touch.png`、
`kbphland-926x428-light.png`。`test:unit` 322/322（`frame.test.ts` 四例：竖放手机、桌面、
粗指针平板、横放手机的边界 ±1），typecheck 与 build 干净。

### 4.3 平板两种摆法都是平板（`7cb89b9`）

`4.2` 的闸门是「宽度 ≤720，或者粗指针且（宽 ≤900 或高 ≤500）」，把大屏手机横放救
回来了，却也把平板判错了：iPad 竖放 820×1180 宽 820 ≤ 900，落进手机臂，拿到透镜；
同一台横过来 1180×820，宽 1180 超过 900、高 820 也超过 500，两条臂都不认，拿到桌面
舞台。于是**转一下屏，整个控制台重建**（`narrow` 是 `SessionStage` 与 `TabStage` 的
唯一开关）。768×1024 的 iPad 更彻底：竖放被 720px 那条臂直接判成手机。

判据改成两条臂：

```ts
if (width <= COMPACT_WIDTH) return true;          // 720：手机竖放
return coarse && Math.min(width, height) <= TOUCH_SIDE;  // 短边 ≤ 500
```

短边不随摆放改变，所以「手机 vs 平板」在转屏时是稳定的。500 这个数的来源：横放手机的
短边最大 480（932×430 实际是 430，480 是留的余量），iPad mini 短边 744，中间空着
264px 可以放。桌面窗口不满足 `coarse`，永远不进这条臂。

代价讲清楚：平板上再也开不出透镜（聊天视图），两种摆法都是真实终端的舞台。这和
PC 一致（桌面打开就是 xterm 分屏），也符合「默认就应该是真实终端」；气泡式的会话视图
留给真正只有拇指宽的屏幕。

`index.css` 一处未改：JS 的窄等价于「宽 ≤720，或粗指针且短边 ≤500」，而 CSS 的折叠是
`(max-width: 900px), (pointer: coarse) and (max-height: 500px)`——窄成立时折叠一定成立；
反过来 900px 那臂还会折掉平板的侧栏（820 宽触屏本侧栏 176px 收起），那正是想要的：
舞台在，侧栏让给 tile。

| 视口 | 改前 | 改后 |
| --- | --- | --- |
| 820×1180 触摸（明/暗） | 透镜：会话头 + CHAT/TERM，无舞台 | 舞台：侧栏折起、masthead 46、头 [0,46,820,46]、标签条 45、8 格 tile [0,137,820,467]、草稿 [14,1072,792,70]、页脚 26、溢出 0/0 |
| 744×1133 触摸（明） | 透镜 | 舞台：8 格 186px、草稿 [14,1025,716,70]、溢出 0/0 |
| 1024×1366 触摸（暗） | 舞台 | 不变：侧栏 [0,46,176,1294]、头 54、草稿 [190,1258,820,70] |
| 1180×820 / 1024×768 触摸 | 舞台 | 不变 |
| 390×844、320×568 触摸 | 透镜 | 逐位相同（草稿 96px） |
| 844×390、932×430 触摸 | 透镜 | 逐位相同（masthead 0、草稿 70px） |
| 1280×800、1024×768 鼠标 | 桌面 | 逐位相同（草稿 89 / 70px） |

键盘态（假键盘缩 `visualViewport`）：820×1180 配 420px 键盘，`.shell` 从 1180 缩到 760，
页面不滚（`documentScroll 0`）——头 [0,46]、8 格 tile 205×265、草稿 [14,660,792,66]、
盘 [643,675,150,36]、发送 [757,675,36,36] 全在 760 以内，溢出 0/0；744×1133 配 380px
同样成立（shell 753、草稿 [14,653,716,66]）。截图 `tablet-ipad820-coarse.png`、
`tablet-ipad820-coarse-light.png`、`tablet-ipadmini744-coarse.png`、
`kbtablet-ipad820-kb.png`、`kbtablet-ipad820-kb-light.png`。`test:unit` 21 套件 155 例全过
（`frame.test.ts` 六例：竖放手机、桌面、平板两种摆法、六种摆放的旋转不变、短边边界
±1），typecheck 与 build 干净。

### 4.4 那四个词要装进 186px（`4bfd5f1`）

平板拿到舞台之后，一张 8 格 tab 在 744px 上给每格 186px——而每格头上的
AUTO/WRAP/EXACT/FIT 是个四列等分的分段控件，在粗指针下高 45px、铺满整格宽。视觉上
最后一个词只剩 `FI`。

量出来的原因有两层：

1. `grid-auto-columns: 1fr` 的 `1fr` 以 `auto` 为最小值，而 grid 项不会缩到自身
   min-content 以下：四个词的文字宽 55+56+66+46 = 223px，格子就按 223px 分，186px 的
   tile 于是有 37px 落在外面，被 `.tile { overflow: hidden }` 剪掉。
2. `font-size: var(--step-fine)`——这个 token 在 `web/` 里从未定义，声明在 computed-value
   阶段无效，字号于是继承祖先（约 15px），把四个词撑得比设计想的大。

改法：格子 `minmax(44px, 1fr)`（每格仍是一指宽 44px，四格均分 tile），按钮
`min-width: 0` + `padding: 0 4px` + `font-size: var(--step-label)`（10.5px，真实存在的
刻度）+ `white-space: nowrap`。最宽的词 EXACT 在 10.5px 下是 41px，最窄的格是 46px
（186/4），装得下。`min-height: 44px` 与 `touch-action` 不动，点击面没缩小。

| 视口 | 改前（末格越界） | 改后 |
| --- | --- | --- |
| 744×1133 触摸，tile 186 | 词宽 55/56/66/46，剪掉 37px | 格 47×4，末格右沿 186，越界 0 |
| 820×1180 触摸，tile 205 | 剪掉 18px | 格 51×4，越界 0 |
| 1024×768 触摸，tile 212 | 剪掉 11px | 格 53×4，越界 0 |
| 1024×768 / 1280×800 鼠标 | 浮层条 [183,20]，装得下 | 逐位不变（46/45/53/38，富余 14px） |

`/tmp/probe-renderbar.mjs` 打印每格的 `w/scroll/right` 与「末格 right − tile right」；
改后三档粗指针全是 0，两档鼠标仍是 −14。

### 4.5 一个不存在的 token 撑了很多年（`b013330`）

`--step-fine` 在 `web/src/` 里被 20 处声明引用：`/` 菜单的快捷键、弹窗字段说明、
task board 的 id 与元信息、collect 命令、peek 预览的 `<pre>`。它没有定义。CSS 自定义
属性在 computed-value 阶段才替换，未定义就整条 `font-size` 失效，字号于是一路继承到
正文的 12.5px——这些“小字”和正文一样大，面板里的层级只剩颜色和字重。

这不是某一处的笔误：`--step-micro: 9.5px`、`--step-label: 10.5px`、
`--step-body: 12.5px` 都在，中间这个位置空着，`git log -S"--step-fine:"` 在 herdr-web
与隔壁 tmux 仓库都是空结果——它从来没有过值，所以也没有“原来的值”可恢复。

定成 11px 而不是别的数：它要落在 label 之上、body 之下（10.5 / 11 / 12.5），
panel 才从“两档”变“三档”；而 `.hostpanel__body button` 已经在用 `--step-micro`，
不该被这轮改动带歪。

| 站点 | 改前 | 改后 |
| --- | --- | --- |
| `.newws__field` 字段说明 | 12.5px | 11px，盒高 92 不变 |
| `.hostpanel__fleet-head` / fleet 行 | 12.5px | 11px，行高 20 → 18 |
| `.dispatch__targets label` | 12.5px | 11px，19px |
| `.hostpanel__legacy` / peek `<pre>` | 12.5px | 11px（补 tmux fixture 后才量到） |
| `.dispatch__entry header` / `li` / `pre` / commits / collect | 12.5px | 11px（补 dispatch fixture 后才量到） |
| `.newws__submit` | 12.5px，手机 44px | 11px，手机被压到 42 → 钉回 44 |

`--step-fine` 变小会让靠行盒撑高的按钮缩水：`.newws__submit` 是
`padding: 6px` + 11px 行盒 ⇒ 42px，低于拇指下限。修法不是把 padding 加胖
（那会让桌面也变厚），而是在 `(pointer: coarse)` 下钉 `min-height: 44px`，
桌面仍是 30px。弹窗里的 create 按钮顺带从 32 变 44（它原本就只在触屏上有这个机会）。

只有一处故意不跟：任务板条目的 `.dispatch__prompt`。它是“这条任务是什么”的唯一
一行，11px 会把任务板读成一片元信息，所以它留在 `--step-body` 12.5px——板子因此
读作“一行活 + 一块事实 + 一个状态”。

探针补了两种 fixture 才覆盖到最后 6 处：`GET /api/v1/herdr/tmux`（会话列表，使其
渲染 legacy 折叠）+ `/tmux/output`（`{output}` 字段，点 `[data-peek]` 才画出 `<pre>`）；
以及 `GET /api/v1/fleet/jobs` 里带一条 `dispatches`（含 `commits`/`changed`/`output`/
`checkoutPath`/`diffReady` 与一个 stopped job），并把 `<details>` 全部展开后截图。
截图 `fine-{phone390,land844,desk1440,desk1440l}-{host,fleet,newws}.png`，另加
`-board` / `-legacy` 两张滚到底的尾部；`test:unit` 324 例全过。

### 4.6 拇指尺度：面板和表里的控件（`dcd8738`）

4.5 把细字定成 11px 之后，面板和弹窗里有一批控件的高度就只剩自己的行盒与
padding。它们的尺寸不是算出来的，是「小字恰好撑到多高」碰出来的：

| 控件 | 改前（390×844 粗指针） | 改后 |
| --- | --- | --- |
| `.newws__field` 的 input/textarea/select（含 fleet 表单） | 34 | 44 |
| `.dispatch__strategy button` | 23 | 44 |
| `.dispatch__targets label` | 19，复选框 13×13 | 44，复选框 18×18，一行放不下换行 |
| `.dispatch__line .dispatch__stop` | 19×46 | 44×62 |
| `.dispatch__entry summary` / `.hostpanel__legacy summary` | 18 | 44 |
| `.hostpanel__act`（OPEN / TAKE OVER / peek） | 22 | 44 |
| `#herdr-host-refresh` / `#herdr-host-close` / `#dispatch-close` | 22×81 / 18×23 / 20×24 | 44×81 / 44×44 / 44×44 |

两条经验，写在这里省下下次的两次构建：

1. **伪元素那套在 `<button>` 上不能用。** masthead 的
   `position: relative` + `::before { inset: -12px 0 }` 看着通用，但按钮会把生成
   内容裁到自己的盒子，`inset` 只在原盒范围命中。用 `elementFromPoint` 从按钮
   中心往外逐点扫（3/6/9/12/15/19/21px）就能看见：盒内命中、出盒即穿。头部因此
   改成真实 44×44（`inline-flex` 居中）。
2. **写在旁边的粗指针覆写会静默失效。** `.sheet--dialog .newws__field input` 在
   500 行之上声明 `min-height: 34px`，同特异度、后写者赢，粗指针块若放在它前面
   就是一笔白改（第一次复测正是在这里翻车，两个 select 仍是 34）。所以整块钉在
   样式表末尾，并把原因写在注释里。

机器行里唯一的“内容”改动：`.dispatch__targets .newws__dim` 在粗指针下允许换行。
桌面那条「一行一台机器、详情省略、全文进 title」的规则不变，但手机上 44px 的行里
只留一个 `claude omp cursor g…` 的省略号，把选择机器最要紧的信息藏了。

桌面一个像素都没动：1440×900 鼠标下 host 仍是 9 个小控件、fleet 仍是 19 个，高度
与改前逐项相同（22/18/19/23/30/34）——这一批只存在于 `@media (pointer: coarse)`。
截图 `taps-{phone390,land844,desk1440,desk1440l}-{host,fleet-top,fleet-bottom}.png`。

### 4.7 终端镜头的键条、菜单和查找条（`9eaf60c`）

4.6 扫的是面板和表，终端镜头这边还剩三处鼠标尺寸。它们都在
`terminal.css` 的 `@media (pointer: coarse), (max-width: 720px)` 里，所以
改之前先把「这个盒子到底归谁撑高」弄清楚：

| 控件 | 改前（390×844 粗指针） | 改后 |
| --- | --- | --- |
| `.keys__key` / `.keys__more`（键条） | 44×32 | 44×40 |
| `.keys--grid .keys__key`（菜单两行网格） | 43×32 | 43×40（仅 `min-height: 500px`） |
| `.keymenu__head` / `.keymenu__hide` | 20 / 26×20 | 44 / 34×44（仅 `min-height: 500px`） |
| `.term__find-open` | 40×40 | 44×44 |
| `.term__find-step` / `.term__find-close` | 36×36 | 44×44 |

三件值得记下来的事：

1. **键面长高会顺手把整条撑高。** 键条是 `padding: 2px 6px` + 顶部 1px 规则 +
   `min-height: 44px`：40px 的键面算下来是 1+2+40+2 = 45，比 44 多一像素，而
   这一像素正好从终端里拿。所以 `padding-top: 1px`、
   `padding-bottom: calc(1px + max(0px, env(safe-area-inset-bottom) - 8px))`，
   `min-height` 继续钉 44。实测 390×844 竖屏闲时终端 559px、键盘起（260px）429px，
   844×390 横屏 177px 与 0px，全部与改前一致——只是键面从 32 长到 40。
2. **同一个 `.keys` 还有一个变体。** 菜单里的网格是 `<div class="keys keys--grid">`，
   它的 `padding: 0` / `min-height: 0` 写在 300 行附近、同特异度，于是在末尾补
   `padding-top` 的粗指针块会把菜单面板 111 撑到 113、终端从 66 掉到 64。选择器
   必须写成 `.keys:not(.keys--grid)`（0,2,0）。**给基类加粗指针覆写，先把变体类
   排掉。**
3. **菜单在流里，像素是从终端里借的。** 竖屏键盘起时 shell 只剩 584px，菜单
   151px（标题 44 + 两行 40×2 + 间隙）会把终端压到 278px；480px 高的横屏手机
   shell 只有 140px，没有可借的，所以这批尺寸挂在
   `(pointer: coarse) and (min-height: 500px)` 上，横放继续 111px / 32px。
   横屏里的退出口不是 `hide`，而是行内那颗已经 40×44 的 `keys`。

桌面一个像素都没动：1440×900 / 1280×800 / 1024×768 / 900×900 四个视口下，
`.shell`、`.masthead`、`.tab`、`.prompt`、`.term`、`.keys`、`.keymenu` 的盒与
计算样式逐项 diff 为空（`/tmp/probe-desktop-geo.mjs`，改动前后各采集一次）。
截图 `keys-{phone390,land844}-kb{0,1}-{menu,find}.png` 与 `keyslight-*`（浅色）。

### 4.8 手机换 pane 的那张表（`1dc18b4`）

picker 是手机上唯一能换 pane 的入口，而它每一件都还停在桌面尺度。4.6/4.7 扫过
面板与终端镜头，漏掉的正是这张表——因为它在 `index.css` 里，且量的时候要先
`#herdr-picker-open` 打开弹窗才会渲染。

| 控件 | 改前（390×844 粗指针） | 改后 |
| --- | --- | --- |
| `.sheet .srow`（每个 pane 一行） | 30 | 44 |
| `.sheet .srow__agent` | 9.5px，列宽 4rem，长名截成 `opencode-…` | 11px，列宽 5.25rem |
| `.sheet__view`（AGENTS / SPACES） | 34 | 44，字号 9.5→11 |
| `#herdr-sheet-filter` / `.col__clear` | 27 / 16×14 | 44 / 44×54 |

两处选择器上的坑：

1. **`.srow` 有个单列变体。** 空间列表用 `.srow--space`，它自己把 grid 改成单列
   （`index.css:527`），所以放宽 agent 列必须写 `.srow:not(.srow--space)`，否则
   空间行也会被两列模板挤掉名字。
2. **清除键要长在行上，不在 input 上。** `.col__clear` 是
   `position: absolute; right: 13px` 的一颗小字，只把 input 抬到 44px 它还是
   16×14。改成 `top/right/bottom: 0` + `min-width: 44px` + `inline-flex` 居中，
   它就吃满 44px 的 filter 行（实际 44×54），同时 input 用
   `padding-right: 46px` 把文字让开，输入的字不会被 `×` 盖住。

这些规则一律带 `.sheet` 前缀：`.col__input` / `.col__clear` 桌面侧栏
（`Sidebar.tsx`）也在用，不带前缀会把桌面 rail 的筛选框一起抬到 44px。实测桌面
picker 一行 30px、切换条 34px、筛选框 27px、`×` 16×14，与改前逐位相同。

### 4.9 软键盘弹起时的 picker 表（`b473db7`）

4.8 把这张表的每一行抬到 44px 之后，手机上剩最后一个坑：**打字时表的下半屏在键盘
后面**。这不是「表变高了」，而是 sheet 与键盘各说各话：

| 量到的东西（390×844 粗指针，假键盘 300px） | 改前 | 改后 |
| --- | --- | --- |
| `html` 上的 `--kb-inset` / `has-keyboard` | `300px` / 有 | 同（本来就有，只是没人用） |
| `.sheet` 盒 | `[0,0,390,844]` | `[0,0,390,544]` |
| `.sheet__body` client / scroll | `681 / 681`（无溢出，滚不动） | `381 / 528`，可滚 147px |
| 最后一行 `p13` | `[0,647,…]`，在键盘后且滚不到 | 滚到底后 `[0,500,…]`，`elementFromPoint` 命中行内 |
| `docOverflow` | `[0,0]` | `[0,0]` |

320×780 同姿态：sheet `780 → 480`、body `317 / 528`、滚 211px、最后一行
`[0,436,…]` 命中 `row__id`。844×390 横屏故意不动（`min-height: 500px` 之外），
sheet 仍是 390、body `227 / 528` 可滚、5 行可见。

三件事值得记：

1. **可滚的不是 `.col__list`。** 看 DOM 是 `.sheet__body > .col__list`，而
   `.sheet__body` 是 `display: block; flex: 1 1 auto; overflow-y: auto`——`.col__list`
   的 `flex: 1` 在没有 flex 上下文的父盒里不生效。第一次探针把 `scrollTop` 设在
   `.col__list` 上，`scrollHeight == clientHeight`，结论是「不可滚」；真实滚的是
   `.sheet__body`。
2. **「正好塞满」比「溢出」更坏。** 满高时 528 的内容进 681 的盒子，没有滚动条、
   也没有行为异常——问题只在键盘上来后才出现，而且在没有真机键盘的鼠标探针里
   永远看不见。缩 sheet 是让溢出重新出现的唯一办法：视图矮了，滚动才有意义。
3. **横屏不许让。** sheet 的 chrome（头 + 切换条 + 筛选）是 163px 固定成本，390px
   高的横屏手机让出 250px 后 body 只剩负值。所以这条规则挂在
   `(pointer: coarse) and (min-height: 500px)`，与 4.7 的菜单同一道闸。

顺带确认没有连坐：规则选择器是 `.has-keyboard .sheet`，会一起命中
`.sheet--dialog`（new workspace）与 `.sheet--fleet`（dispatch）——实测 new-workspace
面板从 `[18,278,354,287]` 移到 `[18,128,354,287]`，仍在 544px 的可视区里居中，
底部的按钮跟着上来了。桌面没有 `has-keyboard`（没有软键盘），1440×900 鼠标下
picker 仍是满高、行 30px。`build` 与 `test:unit` 324/324 全绿。

## 5. 给服务端的一页需求（若要继续逼近 Ovis）

最小可用集，按依赖排序：

1. `pane.conversation` 至少返回 **turn 边界 + 每个动作的开始/结束时间**。
   有它才有时长摘要与稳定行身份；不需要解析所有 agent，`source: "scrollback"` 作为兜底即可。
2. `pane.read` 增加 **`before` 游标**，让聊天能往前翻而不是只有 200 行。
3. 会话历史的 `history_id`/世代号，避免历史被替换时整段重排。
4. （可选）选择菜单的结构化读出：`{options[], default_index}`。没有也能用键条，有则能做卡片。
