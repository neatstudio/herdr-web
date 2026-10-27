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
| `52125a0` | xterm 6 把原生滚动条换成了自己画的 14px 浮层（`.scrollbar.vertical`），于是 `(pointer: coarse)` 里那两条隐藏原生滚动条的规则悄悄失效，手机上右边缘又出现一条随溢出淡入的栏杆。改成同时隐藏浮层：屏幕宽度、行数（27 行 / 19 行带键盘）、行宽 374px 全都不变，只是栏杆没了；桌面 `(pointer: coarse)/(max-width: 720px)` 都不命中，PC 仍保留栏杆 |
| `ab13de2` | 横屏手机（844×390）弹出键盘后两个 sheet 整块被盖住：`bottom: var(--kb-inset)` 只写在 `(pointer: coarse) and (min-height: 500px)` 里，390 高的机器不满足，sheet 仍是满高。picker 的第一行在 163px、键盘顶在 ~140，一行都看不见；fleet 的 prompt 滚到后面也在键盘下面。放开到所有粗指针高度，并给矮横屏单独压 chrome：picker 藏掉视图切换、标题折掉、关闭钮浮到过滤行右端（清除钮左移 44px 让两个 ✕ 不叠），chrome 163→45，250px 键盘下仍露 2 行且列表可滚；fleet 少一层内边距，头部 63→45；`.sheet--dialog` 不压（表单本来 287px 就放得下，压到 104px 只会多一段滚动） |
| `08d0433` | PC 上这张表把宽度撒错了地方：picker 是满屏 sheet，却在 pane 名旁边只给 agent 4rem，于是 `opencode-gpt-5-coder` 被截成 `opencode…`，而右边 1 300px 的名字列空着。⚠️ 这是本轮唯一一处"桌面也要改"的截断：1440×900 下 `.srow__agent` clientWidth 64、scrollWidth 133。改成 `@media (min-width: 700px)` 里 `.sheet .srow:not(.srow--space)` agent 列 10rem、`.srow__agent` 字号从 micro 抬到 fine（这里是身份不是注脚），160px 装得下 133px，名字列仍有 1254px。手机保持 5.25rem——那条粗指针规则从"所有触摸屏"收紧成 `(pointer: coarse) and (max-width: 699px)`，于是 820 宽的 iPad 也吃到桌面列宽。行高不动（桌面 30、触摸 44）。rail 侧栏**故意不加宽**：它只有 244px，名字比 agent 更缺像素，所以 agent / 名字 / 空间行都补了 `title`，picker 行的 `title` 从"只有备注"改成 `名字 — id (空间) · 备注` |
| `b3eb59a` | 第三方 agent 的长名字把 tile 头撑成两倍高：herdr 原样透传 pane 跑的东西，`opencode-gpt5-coder-xhigh` 这种 slug 进来时 `.tile__agent` 没有截断，1024px 下被挤到 max-content 以下、在自己的盒子里换行，那一格的头 58px、旁边那格 28px——并排的头就不在一条线上了。芯片封顶 14ch + `text-overflow: ellipsis` + `white-space: nowrap`，全名进 `title`。1024/1280/1440/1920、2 与 3 格全量：每个头都是 28px，芯片单行 91px（`scrollWidth` 176），没有子元素越过 tile 边界 |
| `79bf6bf` | iOS 只要聚焦的字段小于 16px 就放大整页且不缩回：草稿框早在 `composer.css` 付过这笔账，其余手机够得到的字段没有——picker 筛选 12px、工作区表单 12.5px、dispatch 表单（手机上唯一能把活发出去的入口）输入 12.5px、textarea 与两个 select 13.3px。`(pointer: coarse)` 里把这五类字段抬到 16px：只长字不长盒，44px 高度不变，320/390 实测 `docW === innerW` 无横向溢出；鼠标与触控板窗口一行未改。⚠️ 这是 4.3 那句话的另一半：16px 不是字号档位，是 iOS 不缩放的地板 |
| `8fd0314` | 禁用态的半透明按钮是个窗口而不是调光器：fleet 的提交钮 `position: sticky` 钉在表单上（4.9 加的），`opacity: .5` 于是让底下滚过的策略提示直接读在橙色上，正好在它解释「为什么不能按」的时候看起来像掉漆。改成同样两种颜色的实色混合（`color-mix(in srgb, var(--accent) 50%, var(--paper))`，字再用纸色 50%）——两种主题下是与原来逐像素相同的禁用色，底下的东西不再透出来；320 实测浅色 #cd967e、深色 #844a28 |
| `1209205` | 截断之后全名去哪看：4.13 把长 slug 截成 `opencode-gpt5…`，全名只进了 `title`——而 `title` 只认悬停，手机上长按什么也没有，偏偏「这个 pane 跑的是什么 agent」就是决定点不点的信息。芯片补长按（`longPressHandlers`）开 pane 菜单，菜单顶部加一行 `agent` 打印全名（`MenuTarget.agent`，行高按 34 计进弹层高度），回归测试钉三件：1024 下两个 `.tile__head` 高度相等、芯片 `scrollWidth > clientWidth`、`touchstart` 之后菜单里读得到 `opencode-gpt5-coder-xhigh`。同一次提交还带上了 §4.15 的横屏键盘修复 |
| `a3cc97b` | 桌面上的 tab 条一溢出，够不着的就不只是最后一个 tab：`white-space: nowrap` 让每个 tab 的自动最小宽度等于整个名字，tab 从不收缩、溢出的是条本身——而桌面条把滚动条藏了（`.strip::-webkit-scrollbar { display: none }`），鼠标滚轮也不滚横向，于是 1024px 下八个 139px 的 tab 在 848px 的条里多出 292px，最后几个落在右边界外、任何指针手势都够不着；`+` 的 sticky 只写在窄屏块里，同一个原因下它也一起越界（1286–1316）。让名字走省略号（`.tab__name` 早就会）之后 tab 可缩到 88px，下限 5.5rem 保住序号/编号/状态点，八个 tab 以 102px 全部上屏（848 == 848）；`+` 的固定从窄屏块提到基础规则（桌面同样需要），仍然溢出的情形（1024 下 12 个 tab：1087 > 848）由 `strip--more` 在固定钮左缘补一道阴影，说明底下还有 |
| `8ca78a4` | herdr 的 zoom 让舞台失去了解释自己的能力：`arrangeTiles` 在 `layout.zoomed` 时只返回一格，`arrangeable` 又同时把排列开关藏掉，而 tile 头的闸门是 `tiles.length > 1`——于是一个装着 4 个 pane 的 tab、屏幕上 1 格、头上没名字、没有关闭入口、也没有一句话说另外 3 格去哪了。闸门改成 `tileHeadVisible(tileCount, tabPaneCount)`（多于一格，或该 tab 的 pane 多于显示的格），`layout.zoomed` 时在头里补一句 `zoom 1/4`（琥珀、无框、`--step-micro`，因为 herdr 没有 unzoom RPC，它只能陈述不是按钮）；显示的格恰好不是输入目标时，空态从 `click to read this pane` 改读 `click to work here — the prompt sends to pD`；顺带触摸平板的头从 28px 长到 37px、× 从悬停才显示改成常显 32×32（手机走透镜不渲染tile，所以只命中 iPad 尺寸的帧） |
| `3b29472` | 一条非 ASCII（或带换行）的草稿只停在 pane 的输入框里，发不出去：这类文字一个键带不动，走的是粘贴路径，而 `pane.send_text` 会把行尾的 `"\n"` 一起写进 pane；在 raw 模式的 TUI 里那个换行是 LF，行编辑器读成「在草稿里换行」（Ctrl+J），于是文字留在 prompt、永远不提交。隔离会话里用一个只打印收到字节的 pane 量到 herdr 0.9.0：带换行的 `pane.send_text` 到达 `61 0a`，`Enter` 键到达 `0d`。改成粘贴不带换行、紧接一次独立的 `Enter` 键；ASCII 的打字路径本来就以那个键收尾，不动 |
| `7ee9b35` | 两条请求的发送只有一个「成/不成」的答案：一个键带不动的文字走「粘贴 + 单独一个 Enter」，是两个 HTTP 请求，中间能断——粘贴到了、键丢了，输入框就把 pane 里已经有的那行留着，下一次发送会打两遍；粘贴根本没到，屏幕上却什么也不说。发送结果改成三态 `sent / unreached / unsubmitted`，卡片那行 note 讲清落在哪一半：没到是 `could not reach w2:p1, message kept`（草稿留着、不进历史），到了但键丢了是 `in w2:p1, Enter did not land`（清空输入框，并给一颗只发 Enter 的 `send ⏎`，绝不重打文字）；`handOff` 的 Tab 丢了同样交出文字改走 raw 模式，下一键就能补完。新增 `web/tests/prompt-send.spec.ts` 三条用例，把两半分别打到失败 |
| `90c8344` | 手指够不到的从来不是「盒子不够高」，而是尺寸改了、命中区没改：masthead 的 daemon/fleet 入口和手机上唯一的 pane 开关都只有 20px 高（pane 开关 43px 宽），之前用伪元素把命中区撑到 44px——但 `.cluster--button` 和 `.stage__pick` 自己带 `overflow: hidden`（前者要截断 daemon 标签，后者要截断长工作区名），伪元素被自己的元素裁回 20px，于是 44px 只是一行注释，手指仍旧只摸到 20px 的玻璃。两个无边框控件改成真实盒子长到 44px（daemon 入口的 border 是透明的、pane 开关在头部是 `border: 0`，视觉零变化；两行都是 46px，长高不挤任何东西），唯一有边框的 theme chip 保留伪元素撑高（它自己不裁）。粗指针实测 390×844 与 320×568：host/fleet/pane 开关命中高度 20/20/18px → **44/44/44px**，masthead 与 stage 头仍 46px，tab 条起点仍在 92px，横纵溢出 0/0；桌面 1440×900 一个像素没动（仍 20px） |
| `83244a6` | 手机横过来再弹键盘，390px 只剩 180px 可画：tab 条占掉 37px（五分之一屏）只为报当前 pane，而草稿卡的 placeholder 本来就在报（`send to w2:p1`），被它挤下去的那行键条却恰是软键盘给不了的（Esc、Tab、方向键）。粗指针且高度 ≤499px、键盘弹起时让 tab 条隐身：844×390 实测 `.lens` 69→106px、xterm 正文 25→62px（一行变四行），kb=160 时正文 75px；竖屏 390×844 配 336px 键盘仍留 37px 身份行（正文 353px），桌面够不着这条查询。新增 `web/tests/landscape-keyboard.spec.ts` 两例，用 `--kb-inset` + `has-keyboard` 模拟键盘，并把规则临时撤销一帧量出「让位前」的高度，钉住增长量恰等于条高、无溢出、竖屏不被动 |
| `4cc6dd6` | `/` 和 `@` 调色板在软键盘上被剪掉上半截：它用 `max-height: min(44vh, 340px)` 算的是整屏，而键盘抬高后真正可用的只有从草稿卡顶部到屏顶那一段——320×568 配 260px 键盘时板子量到 y=-57、高 284（上半截连同筛选项全在键盘后面），844×390 配 210px 时 y=-96、高 195。改成先量后夹：打开时用 `ResizeObserver` 量草稿卡顶边到视口顶的距离，发布成 `--palette-max`，`max-height` 取 `min(44vh, 340px, clamp(top-12))`，粗指针下取 `min(50vh, var(--palette-max))`；关闭或卸载即删掉这个变量。实测 390×844 kb=336 y=161 h=266、320×568 kb=260 y=5 h=222、844×390 kb=210 y=5 h=94，1440×900 无键盘逐项不变；新增 `web/tests/palette-fit.spec.ts` 四例 |
| `05ee728` | 键盘一弹，键菜单把终端挤成一条缝：它是刻意待在流里的（要边按方向键边看 TUI 回答），但在 320×568 配 260px 键盘时，标题行 + 两行 16 键网格 + 常驻键条一起压在一个 `min-height: 0` 的 `.term__host` 上，host 只剩 **2px**，横屏 844×390 配 210px 时是 **0px**——为了看 TUI 才打开菜单，结果菜单把 TUI 藏了。粗指针且高度 <700px、键盘弹起时把菜单折成一行：16 键网格变单行 40px 横向滚动（手机横过来有的是横向空间），`hide` 保 44px 拇指目标，常驻键条只贡献它那颗 `keys` 开关（网格是它的超集，不丢键）；面板保留自己的盒子与 `role="group"`，不用 `display: contents` 拆掉 a11y 盒。顺手修掉一个更隐蔽的：键条基规则是 `justify-content: center`，而网格的 16 条轨道宽 700px 装进 214px 的滚动盒里被居中，内容起点算成 **x=-237**、`scrollLeft` 只能从 0 往右滑，于是 esc/tab/⌫/↵/ctrl 落在滚动原点左边——不是「在屏幕外」，是**滑不到**（`scrollWidth` 也只报 457）。给折叠态的网格补 `justify-content: start`。实测：844×390 kb=210 host 0→55、320×568 kb=260 host 2→146（146px 够 TUI 回一行 `ready`），16 键单行 40px，首键 esc 在 x=6、末键 PgDn 一次滑动可达，`hide`/`keys` 均 44px；390×844 竖屏两行网格与 host 202/408 逐项未动 |
| `5f3221f` | 折叠规则得有人看着：新增 `web/tests/keymenu-space.spec.ts` 三例，沿用 `--kb-inset` + `has-keyboard` 模拟键盘的桥。横屏 844×390 kb=210 打开菜单后 host ≥40px（折叠前是 0）、网格单行 40px 装下全部 16 键不滚动、`hide` 与 `keys` ≥44px、行落在终端与草稿卡之间（host 底沿 = 菜单顶沿，菜单底沿 = 草稿卡顶沿）、关闭后高度回到打开前；320×568 kb=260 host ≥40px（折叠前 2px）、网格 `scrollWidth > clientWidth` 故必须能滑、首键 x ≥ 网格左沿（钉住上面那个居中 bug）且末键一次滑动后完整落在网格盒内、页面 568/320 无溢出；390×844 kb=336 仍是两行网格、host ≥120px——折叠是矮框的补丁，不是高框的新样式 |
| `baec5c2` | 面板一开，键条把自己又铺了一遍：网格是常驻键条的严格超集（16 ⊇ 6），可面板打开时键条仍原样待在下面，于是同一批键买了两份。竖屏 390×844 kb=336 时菜单要吃掉 151+44=195px，host 353→202；而面板本身只要 151，剩下的 44 是重复的那一行。折叠态（844×390 kb=210）更明显：那一行抢走 844px 里的 46px，网格盒 832→786。改成 `html.has-keyboard` 下用兄弟选择器 `.keymenu__panel ~ .keys:not(.keys--grid)` 藏掉键条，面板的 `keys` 开关就是把它叫回来的那颗键；面板关闭时 6 键原样都在（上一版把常驻键条整条降级过一次，键盘一弹就一个键都不剩，这个回归一并删掉）。顺手修折叠态关闭时键条挤在左侧（844px 行里只有 284px 宽、起点 x=6）：补 `flex: 1 1 auto`，现在 `rowBox {x:6,w:832,h:44}` 居中。`hide` 在所有竖屏规则够不着的头里仍是 26×20 的字，可它是面板唯一的出口：给伪元素负 inset 撑到命中 44px 高，网格在重叠处仍赢（不抢 ^C），实测只压到 pane 底沿 ~3px |
| `c4b8254` | 六条回答的菜单是 1169px 芯片挤在 390px 行里，第三颗被屏幕边缘切在字中间，读起来像一个坏掉的盒子而不是「还有」；同一行的目标也不到 44px——`padding: 6px 12px 2px` 把芯片的命中裙摆裁成 40px，手指落在芯片下沿按到的是底下的 esc，而芯片自己 1px 描边让 `inset: -6px` 只够到 42px（实测 346→388.5）、键条又从下面探上来 4px 裙摆吃掉剩下那点。行改成 `padding: 6px 12px`（6+32+6=44）、裙摆 `calc(-6px - var(--rule-w))` 精确贴到行边（346→390）、行 `position: relative; z-index: 1` 赢下边界；边缘按有无内容淡出（右 34px、左 20px，`mask-image`），滚到端点即收；`scroll-padding-inline: 12px` 让吸附不吞掉首颗的 12px 留白，静止时 `scrollLeft 0`、不点左淡出；`ResizeObserver` 同时盯行与每颗芯片（行盒不变而菜单变宽的情形）。代价是轨道多付 4px：390×844 无键盘 515、kb=336 时 309、320×568 kb=260 时 109px，仍够两行事实。新增 `web/tests/pick-row.spec.ts` 四例 |
| `a264c84` | 键盘一弹，头一藏，唯一能换镜头的开关也跟着走了——偏偏拇指最想换镜头的时候就是打字打到一半、正看着一份读不懂的 TUI 的时候。放回头里就是 34px：320×568 加 336px 键盘只剩 197px 轨道的一半左右，所以头不改 DOM 位置、改成脱离文档流浮在 tab 条上：36px 高、透明、`pointer-events: none`，只有 `.stage__lenswrap`收 `auto`，底下的 tab 照样能划；条在尾端留出 96px+内边距给开关，钉住的 `+` 让位（37px 的条里 96+44 再加间隙是 160px，320px 宽只塞得下一个 44px 控件，打字时有用的是开关），关掉键盘 `+` 立刻回来；开关的裙摆长到 34px，正好填满条的内带、碰不到下面的转录和终端镜头的查找钮；点一下换镜头不 blur，键盘和光标原位不动。只在 `(pointer: coarse) and (min-height: 500px)` 里成立：`.stage--lens` 本来就只在 ≤720px 的帧出现，横屏手机（<500px）照旧藏头。新增 `web/tests/lens-typing.spec.ts` 五例 |
| `f6adf48` | 320×568 配 260px 键盘再打一份五行草稿，键条底部 11px 被草稿卡盖住：舞台只剩 ~300px（37 条 + 44 回答行 + 44 键行 + 最高 120px 的草稿卡），唯一能让的是轨道，而轨道的**内边距本身也在地板里**——`.chat__lane` 上下 20/28px 共 48px，48+44+44=136 的硬地板撞上舞台只剩 125px 的行，溢出 11px（实测 `keys.bottom` 173 vs `prompt.top` 162.5），`.lens` 的 `overflow: hidden` 正好把它裁在草稿卡边上。改的是空气不是转录：`html.has-keyboard` 下轨道上下各 8px（地板 16），键盘一收立刻回 20/28；实测 320 变成 37..74 / 74..118 / 118..162 / 162..300 首尾相接，120px 的草稿卡仍 `overflow-y: auto` 能滚到第 6 行，390×844 kb=336 逐项未动。**先修的是量尺**：老用例只手设 `--kb-inset`，`visualViewport.height` 还是整窗，`fitComposer` 的 40% 上限就按 568 算成 227px（8 行），量出来的溢出比真机更狠、也永远量不准真机；改成只谎报 visual viewport 高度并派发 `resize`，让 `PromptBar` 自己发布 inset 与 class。新增第六例钉住夹击（`keys.bottom <= prompt.top`、三行首尾相接、草稿卡 ≤120px 且滚动、轨道 padding 8/8、收键盘回 20），把修复撤掉该例以 11px 溢出失败 |
| `059ba3c` | 横过来打字时，换镜头的开关跟着头一起没了：`(pointer: coarse) and (max-height: 499px)` 把头整行藏掉（4.20），键条用它换来的那 44px 里没有开关的位置——而这块屏**默认就是终端镜头**（宽而粗指针的帧默认 `terminal`），于是「想读成转录」这个动作在打字时彻底不可达。开关改在 `.lens` 里脱离文档流，落在键条居中之后空出来的右翼：844×390 配 210px 键盘实测 `lens` 844×106、`head` 与 `.lens__switch` 都是 0×0，pill `735,69` 99×28（行 `y62 h44`，末键右沿 564，剩下 171px 空档），`document.elementFromPoint(839, 101)` 命中 `button.flip__opt`、往左 1px 命中 `div.keys`，**高度代价 0px**；568×320 配 160px 键盘 pill 落在 `459,49`。门是粗指针 + `max-height: 499` + `min-width: 560` + `has-keyboard` + `:has(.keys)`，桌面/竖屏/没有待选菜单的聊天镜头一概不画。26px 的面上用 `::after` 撑到 38px，`pointerdown` 取消掉，点它不 blur、键盘不掉、光标不动。**回归是测试自己抓到的**：`keymenu-space` 的横屏例点不动 `hide`——`<button class="flip__opt" aria-pressed="true" title="the session's real terminal">term</button> … intercepts pointer events`。键菜单展开时它自己就是那一行，`hide` 正好在同一条右翼上，于是加 `:not(:has(.keymenu__panel))`：面板一开 pill 让位，收起即回。新增 `web/tests/lens-flip.spec.ts` 六例 |
| `aaeb4f6` | 横过来再弹键盘，键条底部那一截还是被草稿卡吃掉：`4.27` 只把轨道的空气从 48px 压到 16px，可草稿卡按设计能拿 40% 的可视高度，一行变三行时它就从 66px 长到 90px——844×390 配 210px 键盘，`.lens` 只剩 **82px**；568×320 配 160px 剩 **86px**。键条下面那一摞是 8（轨道空气）+44（回答行）+44（键行）=**104px**，差的 18–22px 就被 `.lens` 的 `overflow: hidden` 裁在草稿卡边上：半颗键看得见、一颗也按不到。草稿的份额不能让（读不了的草稿比看不见的会话更糟），让的是行：键盘弹起时 `.lens` 变成 size container，容器查询在 **103px**（比需要的 104px 少一像素）以下才触发——轨道空气归 0、回答行 padding 6→4（芯片裙摆跟着收到 `calc(-4px - var(--rule-w))`，40px 的行仍是 40px 的靶）、键行的 1px 规则从 `border-top` 挪进 `inset` 阴影，于是 40px 的键面正好装进 40px 的行，没有一颗键掉到 4.21 的手指地板以下。实测折叠后 844×390 键条底沿与 `.lens` 底沿**同为 82px**（轨道余 2px）、568×320 键行结束在 86px、轨道留 6px（原来是键条被藏 18px）、844×390 空草稿仍是 106px 的镜头不折叠（44/44 原样）、竖屏 390×844 与 320×568 逐项未动，草稿卡自己一像素没缩（三行仍是 90px）。新增 `web/tests/squeeze-rows.spec.ts` 五例 |
| `fc74ed9` | 一条回答的尾巴被贴进了操作者的气泡：devin 的回答是纯散文 + 行内代码片，代码片一长就会折行，于是下一行**从第 0 列起**就是芯片底色。`isBandRow` 当时的要求是「填充从文字前开始并覆盖大半行」，`w6:p7` 上 ` tConsoles() / knownPeerHost / fleetSources 。` 填充 **91%**、` laim / Heartbeat / Release / Cancel  全不验。` **79%**、`  web/src/components/session/Markdown.tsx:71   <a ...` **71%**，三行全部被当成 user band，同一个窗口被切成 4 轮、其中 3 轮的操作者气泡是 agent 自己的话，而真正的操作者消息（`❭ /usage`）在别的窗口。判据改成「填充覆盖整行的每一个字形」：真输入框会把消息铺满 pane 宽度，带底色的行**后面不再跟着任何普通墨色**；而折行的代码片一定会被收句的散文接住（实测 71–91%，从没有 100%）。改完 `w6:p7` 从 4 轮回到 1 轮、三个假气泡全消，`w2N:p5` 的真气泡 `❭ /usage`（bg `42;42;42`、填充 100%）照旧开一轮；omp 三个窗口（`w6:p3`、`w8:p4`、`w2T:p1`）与 agy（`wE:pG`）的轮次、thoughts、work、answer 逐项未变（omp 的盒子行本来就是 100% 填充，仍由 `BOX_EDGE_RE` 先收走）。新增 `conversation.test.ts` 一例钉住折行芯片（撤掉修复该例即失败），`test:unit` 330/330 |
| `c1d1eef` | 手机上那个查找放大镜一直是**压在正文上**的角标：它 44×44 钉在网格右上角，而网格右上角正是 TUI 摆状态行的地方——390×844 实测盖掉了两段话的尾巴，844×390 配 210px 键盘时网格只剩 55px 高（四行），角标就吃掉三行，`v0.6.14 ta[g]` 这种折行处也被切在字中间。改用「它是键条里的一颗键，不是网格上的一个角标」：`TerminalLens` 把它从 `.term__host` 里移出来做兄弟节点（`.term` 补 `position: relative` 当定位上下文），`terminal.css` 只在触屏帧把它停靠进键条——竖屏停右翼、横屏停左翼（右翼已被 4.28 的镜头开关占掉），别的帧仍是原来那个角标。**键条的翼是从自己的内边距里买的**：390px 宽、`padding: 2px 6px` 的键条内容盒 378px，七面 44px + 六道 4px 间隙正好 332px，皮肤上 46px 无处可让，于是 `padding-right: 52px` 把内容盒收到 326px——(326−24)/7 = **43.1px**，实测仍按 44 上报（`keyFirst w=44`、末键 `more` 右沿 338、放大镜 344..388 落在 696..740 的条里，6px 间隙）；**362px 是门**：内容盒 304px 时脸正好 (304−24)/7 = **40px** 地板，再窄就得掉到 34px 的 `ctrl` 之下，所以 320×568 保留角标（实测 270..314 / 143..187）。横屏 844×390 用 `padding-left: 52px`，内容盒 786px 居中出 332px ⇒ 键 279..611，放大镜 `2..46 / 270..310`，同一行「查找 · 键 · 开关」；键盘弹起（vv 180）时 `.term` 只剩 106px、网格 55px，折叠键菜单把 3px 内边距搬到 `.keymenu` 上，放大镜的 `bottom` 跟着补这 3px（`63..103` 落在条 `59..103` 里），**高度代价 0px**，右翼 `flip` 仍 735..834 互不重叠。40px 高而不是 44：旁边是 44px 条里的 40px 脸，44px 会往回扎进 4px 网格。键菜单展开时它不带面板、键条被 `.keymenu__panel ~ .keys` 藏掉，于是 `:has(.keymenu__panel)` 一并收走。新增 `web/tests/term-find-dock.spec.ts` 六例（竖屏/竖屏键盘/320 角标/横屏/横屏键盘/桌面 1280×800 无镜头），同跑 `keymenu-space` + `lens-typing` 16 例全绿，`test:unit` 330/330、`tsc --noEmit` 干净 |
| `a387869` | 桌面上的 AUTO/WRAP/EXACT/FIT 是**浮在正文上**的：6px 贴角、静止 35% 不透明，而转录是追着尾巴滚的——1280×800 实测条在 `142..162`、第一条可见行在 `148`，字从脸里透出来。补滚动内边距修不了：`overflow:auto` 会把内容画进 padding 带，而它永远滚着，实测 30px 内边距下仍有行盒落在 `141`。所以细指针 + >900px 给它一行真栅格：条占第一行 `auto`、阻塞提示第二行、滚动盒第三行，静止不透明；代价是 537px 高 tile 里的 24px（一条折行），换来静止与尾巴处都没有字被压。粗指针/窄帧那条 44px 整宽触屏条一位未动 |
| `49b2aa0` | 手机草稿在卡片里**贴着底**：桌面把 `prompt__field` 对齐到底，好让一行高的按钮压在两行草稿的最后一行上；但手机的 pad 是 2×2（74px），比草稿两行起底（48px）高，于是草稿被顶到底：390×844 实测 field `751..825`、textarea `777..825`，占位文字比它旁边的 attach 按钮低 26px，卡片左上角是一块空洞。窄帧改成 `align-items: start`，草稿首行与 attach/image 齐平（都是 751），空出的那一行读作「可以接着写」；卡片仍是 96px，一行转录都没多花。打字态 pad 折成一行，用**三个类**把它重新居中到草稿上（`.has-keyboard .shell.is-narrow .prompt__field`，66px 卡片）；短横屏的侧折仍居中（70px）；平板 820×1180 与桌面 1280×800 还是 `end` |
| `ec86308` | 手机上的长代码行原来不是**被裁掉**，是**看不出还能滑**：`.chat__code-body` 与 `.chat__pre` 本来就是 `white-space: pre` + 横向滚动，390×844 实测 `clientW 366 / scrollW 823`（另一块 708），滚得到，但面板边缘正好把字切在中间、又没有滚动条，读起来就是「这一行到此为止」。用 `.chat__pick` 的同一条约定：块自己带 `data-edges="more|back|both"`，CSS 用 `mask-image` 淡出还有字的那一侧（右 36px、左 22px，`-webkit-` 双写）。属性而不是 state——一条轨道里可能有十几个块，各滚各的，一个捕获阶段 `scroll` 监听统一重画；`ResizeObserver(lane)` 管旋转与换帧宽。16px 地板挡住「量出来 2–3px 舍入溢出」就去淡字的情况（横屏 820 的帧 `scrollW 823` 因此保持干净）。实测淡出末段字形亮度 688→53、跨最后 25 CSS px，是真淡出不是空转；滚到中段两侧都淡、滚到底只淡左，`webkitMaskImage` 每个状态都跟 `maskImage` 一致（iOS Safari 覆盖）。新增 `web/tests/code-edge-fade.spec.ts` 四例 |
| `8ff5ad8` | 转录把客户端的输入框当成了 Agent 的最后一句话：可见快照止于输入框，末尾几行是客户端的家具，不是文字。Gemini（`agy`）最坏——它把思考过程画成**正体灰**`▸ Thought for 5s, 184 tokens`，既非斜体也无 dim 属性，于是「按样式认思考」的 `isReasoningLine` 把它当回答正文；一个回合的结尾会同时出现三句假话：Agent 在引用自己的计时行、光标裸 `>` 造出一个空 blockquote、`? for shortcuts` 成了回答的最后一句。规则改成「标记 + 词」：`○◌▸◉✻*` 后面必须跟 `thought\|thinking\|reasoning` 才算思考，理由是工作行 `● Ran 7 commands` 也是灰的，只有 `○`/`●` 分不出来；标记本身在进折叠时剥掉（字形是客户端的，`Thought for 5s, 184 tokens` 已经把话说全了）。`CHROME_PATTERNS` 补 `? for shortcuts`、`esc\|ctrl+c to interrupt\|cancel\|stop` 与**裸** `>` 行；`>` 后面有字仍然算正文，因为那是 Agent 真写下的引用，用例里也放了一条不许被吞掉。折叠侧零 CSS 改动：思考本来就渲染成一行可展的 `data-kind="thought"` 行，计时行现在住在里面。`tsc --noEmit` 干净，`test:unit` 333/333（新增三例），新增 `web/tests/transcript-hygiene.spec.ts` 三例（390×844 ×2、700×800 ×1），同跑 `pick-row` 4/4、`squeeze-rows` 5/5、`desktop-display-row` 2/2；真 agy 面板探头：转录止于回答与它的 meta 行 |
| `e89d459` | 回答里的表格不是画，是表格——devin 的三列表头是「问题 / 证据 / 建议」，可 `Markdown` 把凡是画得出来的东西都当图，整块塞进 `<pre>`：真 devin 面板的一份回答量到 `scrollWidth` **1464px** 挤在 390px 手机的 **366px** 轨道里，五分之四的每一行都在侧滑后面，表头一列也看不见，读者只能猜哪一格对应哪一列。新增 `web/src/lib/table.ts` 认两种形状——盒子表（`┌─┬─┐`、`│ cells │`、`├─┼─┤`、`└─┴─┘`）与 markdown 竖线表——把回答切成「散文 / 表格」两段；盒子表只在开框、闭框、每一行的列数**与列宽**都一致时才认，所以 logo 框、目录树、被面板裁掉右框的行仍然逐字进 `.chat__pre`（`table.test.ts` 用「logo 框 + 树」这条夹具钉住字节不变）。渲染侧 `AnswerProse` 出真 `<table>`，每格带 `data-label="列名"`；`TurnList` 改用它。**560px 以下表头折进格子**：每行成一张卡、列名在值上面，一行一个 `border-top`，空格子连标签一起不印（真 devin 面板第一行第一格就被裁成空，印个「问题」再跟个空行只是噪声）。实测同一份真面板快照：390×844 下 `.chat__table` `scrollWidth == clientWidth == 366`、`.chat__pre` 0 个、`documentElement` 不横滚；719×844 下表头正常显示三列 `th`、行高与文本一致。新增 `web/tests/box-table.spec.ts` 两例（390 手机卡布局、719 桌面表格），同跑 `transcript-hygiene` 3/3、`code-edge-fade` 4/4；`tsc --noEmit` 干净，`test:unit` 341/341（含新增 8 例） |
| `42bf53f` | 终端里的一行是**面板的宽度**，不是句子的长度：devin 一份回答到手机上时，每 200 显示列就有一个换行，而 `Markdown` 把换行一律变成空格——于是整段话成一堵墙，词中间坐着空格（`功 能`、`本次只看了一个仓库，避免了破坏既有功 能测试。`），段落之间也没有空行。新增 `web/src/lib/prose.ts` 的 `reflowProse`：按**终端列**量宽（CJK 两列），只把「上一行确实跑到换行列」的两半接回去——上一行宽度超过 `wrap - 10` 才算折行，短行结束一个句子才算段尾（补一个空行）；围栏块、`---` 规则线、画出来的表与图、列表/标题/引用开头一律逐字不动。接缝处**只有两侧都是 CJK 才不加空格**，全角标点两侧也不加（`./...、前端`、`通过：go vet`），被换行切断的 URL/括号路径（`(file:///` + `Users/…`）同样不加；反过来「上一行占满换行列、这一行是短的无标点纯文字」是 devin 那种裸标题，给它单独成段。渲染侧 `AnswerProse` 把散文段先过一遍 `reflowProse` 再交给 `Markdown`（表格段不变）。真 devin 面板 `w2N:p5` 的文本实测：第 0 回合 40 行散文 → **28 行**、9 段 → **12 段**，第 4 回合 113 → 112 行、34 → 35 段，同一份文本过两遍结果不变；390×844 渲染后 5 段 `.chat__prose` 合计 10562px，轨道 `scrollHeight` 11640 / `clientHeight` 603。`tsc --noEmit` 干净，`test:unit` 355/355（新增 `prose.test.ts` 14 例：中文折行不加空格、拉丁词之间补回一个空格、拉丁↔中文保留空格、ASCII 句点不断段、短句 `。` 断段、换行列上的 `。` 不断段、空行不跨、列表/标题/引用/规则线不动、画出来的行不动、围栏块逐字、全角标点不加空格、裸标题成段、URL 不断开、幂等），新增 `web/tests/prose-reflow.spec.ts` 4 例（390×844 手机：中文折行接回、英文折行接回、围栏块三行原样、两条列表项各自成项），同跑 `transcript-hygiene` 3/3、`box-table` 2/2、`code-edge-fade` 4/4 |

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

### 4.10 桌面这张表为什么也窄（`08d0433`）

4.8/4.9 的结论是"手机上的 picker 要拇指化"，桌面一直没量。一量就发现**满屏 sheet 的
宽度全给了名字**：

| 量到的东西（1440×900 鼠标，深色） | 改前 | 改后 |
| --- | --- | --- |
| `.sheet .srow__agent` clientWidth | 64（`4rem`） | 160（`10rem`） |
| 同一个格子 `opencode-gpt-5-coder` 的 scrollWidth | 133 → 截成 `opencode…` | 160，装得下 |
| `claude-code` / `cursor-agent` / `grok` 的 scrollWidth | 77 / 84 / 64（后两个被截） | 全部 ≤160 |
| `.srow__name` 宽度（1440 / 1280） | 1350 / 1190 | 1254 / 1094 |
| `.srow` 行高 | 30 | 30（只动宽度） |

三条要记：

1. **满屏 sheet 不分桌面/手机，宽度预算却按手机给的。** 5.25rem 是 4.8 为 390px
   定的（否则名字列被吃掉），但同一套规则在 1440 上跑时，那 60px 是纯浪费。
   宽屏该按宽屏给，所以桌面规则挂在 `min-width: 700px`，与指针无关——平板也够宽。
2. **粗指针规则要收紧到窄屏，否则会盖掉桌面规则。** 4.8 的
   `.sheet .srow:not(.srow--space)` 在文件末尾、后于新规则，会赢；把它改成
   `(pointer: coarse) and (max-width: 699px)` 之后，820×1180 的 iPad 拿到 160px
   列宽（实测），390 手机仍是 84px。
3. **rail 侧栏不跟着加宽。** 它 244px（1440）里要塞 agent + 名字 + 空间三样，
   名字更缺像素；把 agent 列加 12px 只是把截断从 agent 挪到名字。这里 PC 的补法是
   `title`：`.row__agent`、`.srow__agent`、空间行的 `.srow__name` 都带上了原文，
   picker 行的 `title` 也从"只有 note"换成 `名字 — id (空间) · 备注`。
   `opencode-gpt-5-coder` 在 rail 里仍是 `opencode-gp…`，但悬停可读全。

桌面行高、字体基准、终端区宽度都没动：`.srow` 还是 30px，`build` 与
`test:unit` 324/324 全绿，四端截图（1440 深/浅、390、820）无溢出。

### 4.11 横屏 + 键盘：140px 里怎么放下一张表（`ab13de2`）

4.9 把 sheet 从"满屏"改成"跟 `visualViewport`"，但那条规则外面套了
`(pointer: coarse) and (min-height: 500px)`——因为竖屏 390×844 扣掉键盘还有 544px，
而横屏 844×390 扣掉 250px 只剩 140px，当时判断"140px 放不下 picker 的 163px 自带
chrome，不如整张留着"。实测这个判断错了：整张留着意味着**列表在键盘下面**。

| 量到的东西（844×390 粗指针，深色，250px 键盘） | 改前 | 改后 |
| --- | --- | --- |
| `.sheet` 高度 | 390（满高，被键盘盖住 250） | 140 |
| picker 视图切换 / 头部 / 过滤行 / 列表顶 | 45 / 63 / 55 / 163 | 0 / 45（浮层）/ 45 / 45 |
| picker 可见整行 | 0 | 2（200px 键盘时 3，无键盘时 5） |
| fleet 头部 / 列表顶 / `#dispatch-send` | 63 / 63 / 滚到底也在键盘下 | 45 / 45 / 键盘上方可点到（`sendHit` 自己） |
| new workspace 面板 | 287，`#workspace-create` 在 278–322（键盘顶 140，点不到） | 保持 287 居中，面板本身可滚，滚到底 create 可点 |

三条要记：

1. **"放不下"和"不显示"是两回事。** 140px 确实放不下 163px 的 chrome，但取舍不是
   "整张 sheet 留着"，而是"chrome 让位"。视图切换（agents/spaces）是唯一可以藏的：
   关掉重开就能切到另一张表；头部则从"一行"降级成"一个浮动关闭钮"。
   `padding: 9px 12px` 在矮横屏里是纯损耗，44px 的按钮自己就是行高。
2. **浮动关闭钮必须让出底下的点击位。** 关闭钮浮在过滤行右端后，`input` 的右侧要留
   两个 44px（`padding-right: 88px`），清除钮从 `right: 44px` 排到关闭钮左边——
   否则两个 ✕ 叠在一起，点关闭会清空、点清除会关闭。滤镜行自身的内边距也归零，
   45px 而不是 55px。
3. **对话框不吃这条压缩。** `.sheet--dialog` 是 grid 居中的短表单，287px 本来就
   在键盘上方；跟着 shrink 到 104px 只会把 create 挤进滚动区。所以选择器写成
   `:not(.sheet--fleet):not(.sheet--dialog)`，fleet 单独只减内边距（它的关闭钮在
   头部里，头不能消失）。

竖屏回归：390×844（sheet 544、列表 381）、820×1180（880，头部 63）、桌面 1440×900
（不粗指针，`--kb-inset` 为 0，sheet 仍是 900）全部与改前一致，`build` 与
`test:unit` 324/324 全绿。

### 4.12 升级 xterm 6 后，手机上的滚动条回来了（`52125a0`）

4.7 那批给粗指针加了两条隐藏滚动条的规则，注释写的是"手机上右边缘那根栏杆是噪音"：

```css
@media (pointer: coarse), (max-width: 720px) {
  .term__host .xterm-viewport { scrollbar-width: none; }
  .term__host .xterm-viewport::-webkit-scrollbar { display: none; }
}
```

它们假设滚动条是浏览器画在 `.xterm-viewport` 上的。xterm 6 不再画原生滚动条，改成
自己用 DOM 做一个 14px 宽的浮层：`.xterm-scrollable-element > .scrollbar.vertical`
（横向同理）。于是那两条规则匹配不到任何东西了，而浮层在网格溢出时淡入——手机上
只要键盘弹开、能显示的行变少，网格必然溢出，栏杆就一直在。

| 量到的东西（390×844 粗指针，深色） | 改前 | 改后 |
| --- | --- | --- |
| `.scrollbar.vertical` 盒子 | `[376,137,14,540]`（`opacity 0.125`，`transition: opacity .8s`） | `display: none` |
| `.xterm-screen` | `374 × 540` | `374 × 540`（不变） |
| `.xterm-rows` 宽度 / 可见行数 | 374 / 27（键盘 19） | 374 / 27（键盘 19） |
| 桌面 1440×900 `matchMedia` | 两条都为 false | 两条都为 false（PC 保留栏杆） |

三条要记：

1. **"隐藏滚动条"这一类别，在 xterm 6 里换实现不算换外观。** 浮层是 DOM 盒子，
   不是滚动容器的伪元素，`scrollbar-width` 与 `::-webkit-scrollbar` 都管不到它；
   要写 `.term__host .xterm-scrollable-element > .scrollbar`。改这条之前先看 DOM，
   别相信注释里的"已隐藏"。
2. **浮层不吃文本宽度。** 它 `left: 376`、宽 14，而网格右边界是 374——栏杆站在
   终端自己的 8px 右内边距里。所以这次不是"挡字"而是"多余"：手机靠手指滚文本，
   `.term__jump` 已经负责"有历史且你不在底部"的提示。
3. **只在粗指针/窄屏隐藏。** 媒体查询原样保留，桌面鼠标滚动条照旧；`build` 与
   `test:unit` 324/324 全绿，390 深/浅、1440 截图对比无其他变化。

### 4.13 长 agent 名把并排的头撑歪（`b3eb59a`）

herdr 是 agent-agnostic 的：面板里跑什么就报什么。官方几个名字都短，第三方的是
slug——`opencode-gpt5-coder-xhigh` 这种。`.tile__agent` 是芯片（`padding: 1px 5px 0`
＋描边），从来没人给它设过宽度上限，于是 1024px 四格并排时它被挤到 max-content
以下、在**自己的盒子里换行**：

| 量到的东西（1024×768 鼠标，深色，一格宽 424） | 改前 | 改后 |
| --- | --- | --- |
| 该格 `.tile__head` 高度 | 58（芯片三行） | 28 |
| 邻格 `.tile__head` 高度 | 28 | 28（两格终于齐平） |
| `.tile__agent` 盒 | 宽 92、`scrollWidth` 176、三行 | 宽 92、单行 91，`scrollWidth` 176 截成 `opencode-gpt5…` |
| 子元素越界（`right > tile.right`） | 0（是变高不是溢出） | 0 |

三条要记：

1. **固定高度的条里，任何 chip 都要能截断。** 排气孔不是"名字太长"，是"换行
   把一格撑高"：头是高 28 的条，只有它自己变形时，并排的格子才对不齐——比溢出
   更难发现，因为 `document.scrollWidth` 是干净的。
2. **截断要按字符给上限，不是按像素。** 14ch 跟着字号走，`--step-micro` 变成
   11px 时不用重算；`title` 补回全名，悬停可读，手机长按也能看到。
3. **padding 不动。** 芯片的 1px/5px 是它的视觉呼吸，改宽度前先量 `scrollWidth`
   而不是猜"是不是 padding 太大"；这里 92px 的盒子装 176px 的字，任何 padding
   都救不回来。

### 4.14 手机上的表单：16px 是 iOS 的地板，禁用态不该是窗口（`79bf6bf`、`8fd0314`）

两件都出在"手机上能填的表单"上，一起补。

**第一件：iOS 的聚焦缩放。** iOS ≥10 不看 `user-scalable=no`，只要聚焦的
`input`/`textarea`/`select` 字号小于 16px 就放大整页，并且**不缩回**——随后所有
`visualViewport` 与 `--kb-inset` 的量都不再是 1:1，键盘弹起那套版式全歪。草稿框在
`composer.css` 里早写过 `max(16px, …)` 和注释，其余字段没人管：

| 字段（390×844 与 320×640 粗指针，明暗各一遍） | 改前 | 改后 |
| --- | --- | --- |
| `#herdr-input`（草稿） | 16 / 48 | 16 / 48（本来就对） |
| `#herdr-sheet-filter`（picker 筛选） | 12 / 44 | 16 / 44 |
| `#workspace-label`、`#workspace-cwd` | 12.5 / 44 | 16 / 44 |
| `#dispatch-prompt`（textarea） | 13.33 / 74 | 16 / 86 |
| `#dispatch-cwd`、`#dispatch-branch` | 12.5 / 44 | 16 / 44 |
| `#dispatch-kind`、`#dispatch-weight`（select） | 13.33 / 44 | 16 / 44 |
| `docW - innerW`（横向溢出） | 0 | 0（两个宽度都是） |

只有字长：盒子高度全是既有的 44px 刻度，没有一条 `min-height` 被改写；唯一的位移是
dispatch 的 textarea 从 74 涨到 86（4 行 × 字号差），下面的策略/机器行因此各下移
12px，320×640 上本来就在首屏之外，靠 sticky 的提交钮仍可直接按。规则挂在
`(pointer: coarse)`，鼠标与触控板窗口一像素没动——PC 上 16px 的筛选框只会显得笨。

**第二件：禁用态的 `opacity` 是个窗口。** 4.9 把 fleet 的提交钮钉在表单底部
（`position: sticky; bottom: 0`），而 `.newws__submit:disabled { opacity: .5 }`
是**整只按钮**半透明，包括背景色：表单滚到策略提示那行时，提示文字直接读在橙色
按钮上，像按钮掉了一块漆——恰好是它在说"send to 0 machines"的时候。`opacity` 不能
只调字，但可以把同样的混合结果写成实色：

```css
.newws__submit:disabled {
  opacity: 1;
  background: color-mix(in srgb, var(--accent) 50%, var(--paper));
  color: color-mix(in srgb, var(--paper) 50%, transparent);
  cursor: default;
}
```

半透明橙叠在纸色上，就是"橙 50% + 纸 50%"；半透明的字叠在那块实色上，等于纸色
50% 的 alpha。所以两种主题下颜色与原来逐像素相同（320 实测浅色 `#cd967e`、深色
`#844a28`），只是不再透出后面的行。桌面提交钮不 sticky，但同一个禁用色也跟着变；
空表单的 create 钮同理。

### 4.15 横屏键盘上，fleet 的输入框长在提交钮底下（`1209205`）

844×390 的横屏手机弹出 250px 键盘后，fleet 表单只剩 140px：头 45、体 95。这些盒子
原来装 12.5px / 13.3px 的字；`79bf6bf` 按 iOS 的地板把它们抬到 16px 以后，四行 prompt
单独就有 86px——再加 30px 的 label、44px 钉住的提交钮，一共 160px 要塞进 95px：输入框
从 75 长到 161，提交钮钉在 72–140，于是正在打的那一行正好压在「你要按的那个按钮」底下，
滚到底也只能看见按钮顶上一条橙边。

两件不能动的：sheet 是 `fixed; inset: 0` 加 `bottom: var(--kb-inset)`，不能再长；键盘态
里提交钮更不能消失（4.9 的规矩）。只能从表单自己身上让出 65px：

1. 体的上内边距 12→6、下内边距 24→0。**提交钮 sticky 贴的是 padding box**，那 24px 正是
   把它从 140 抬到 116、盖住输入框的直接原因；
2. prompt 的 label 折掉——占位符 `what should the agents do?` 一字不差地重复了它；
3. textarea 封到 `2.4em` ≈ 38px（16px 下两行），内部滚动跟光标。

实测（844×390，深/浅一致）：

| 量到的东西 | 改前 | 改后 |
| --- | --- | --- |
| prompt 盒 | 75–161（高 86） | 51–89（高 38） |
| 提交钮盒 | 72–140（盖住 prompt） | 96–140 |
| 两者间距 | 叠 68px | 空 7px |
| prompt 底部的 `elementFromPoint` | 落在 `.newws__submit` 上 | 落在 `#dispatch-prompt` 上 |

打进三行以上时 textarea 的 `scrollTop` 跟着光标走（第 3 行 24、第 4 行 42），最后两行
始终留在盒里；竖屏 390×844、无键盘的横屏（prompt 仍 86px、label 仍在、提交钮回到表单
末尾 322–366）与全部桌面尺寸逐项未变。

三条要记：

1. **`padding-bottom` 不是呼吸，是位移。** 给滚容器加下内边距，等于把钉住的条往上抬，
   抬多高就盖住多少内容；算 sticky 的位置要从 padding box 起，不是从 content box。
2. **`:has()` 在这里替代了组件改动。** DispatchSheet 是另一条线上的文件，用
   `.newws__field:has(#dispatch-prompt)` 就只针对这一个字段；不支持 `:has()` 的浏览器
   只是回退成旧布局（label 仍在、输入框四行），不会坏。
3. **矮横屏的键盘态是全站最紧的盒子（140px）。** 任何「给字段加高度」的规则都要在这里
   复算；这也是它挂在 `max-height: 499px` + `.has-keyboard` 上、而不是无条件手机规则的
   原因——竖屏与无键盘横屏都还是完整的四行表单。

### 4.16 桌面上的 tab 条：能缩就缩，缩不动才滚（`a3cc97b`）

桌面这张条从来没被当成会溢出过。`.strip` 是 `overflow-x: auto`，滚动条被
`.strip::-webkit-scrollbar { display: none }` 藏掉，鼠标滚轮只滚纵向——于是只要
tab 内容宽过容器，右边那几个既不换行也不可达：没有任何指针手势能把它们拉出来
（触控板的横滑和 shift+滚轮是有的，但不能指望）。`+` 也只在小屏块里 sticky，
同一个条上它一起越界，等于「加 tab」这个按钮在溢出时消失。

原本以为能缩。实际不缩的原因不在 `.tab`，在 `.tab__name` 旁边的 `white-space`：
`nowrap` 的按钮自动最小宽度就是 min-content，也就是整个名字的宽度，没有显式
`min-width` 就没有收缩余地，`text-overflow: ellipsis` 于是永远不出现。补一条
`min-width: 5.5rem` 才解开。

实测（`/tmp/probe-tabs3.mjs`，8 个 tab 各自独立 tab id）：

| 视口 | 改前 | 改后 |
| --- | --- | --- |
| 1440×900，3 个 | `scrollW 1195 == clientW 1195`，tab 139px，`+` 661–691 | 逐位不变（`+` 661–692，多 1px 左描边） |
| 1024×768，8 个 | `scrollW 1140 / clientW 848`，tab 139px，`+` 1286–1316（屏外） | 848 == 848，8×102px，`+` 993–1024 |
| 1024×768，12 个 | 同样溢出，`+` 屏外 | `scrollW 1087` 仍溢出，12×88px，`+` 固定 993–1024 |
| 844×390 横屏，9 个 | 溢出 73px | 844 == 844，9×89px，`+` 800–844 |
| 390×844，8 个 | 溢出 358px | 8×88px，`+` 固定 346–390 |

五种尺寸、明暗两色，页面横向溢出始终 `0/0`（`bodyW == innerW`）。

三条要记：

1. **自动最小宽度就是 min-content。** 不写 `min-width` 的 flex 子项，省略号是
   装饰不是能力——先量 `scrollWidth`，再决定是不是「样式没生效」。
2. **溢出不是手机特征。** 判据是内容宽于容器，不是视口窄于某个数。`+` 的
   sticky 用宽度当闸门是错的，因为 844px 的横屏手机比 900px 还窄、却和桌面一样
   溢出，所以这条规则搬进基础规则。
3. **藏起来的滚动条 + 没有手指 = 不可达。** 能缩就缩，缩到下限还溢出才滚，滚的
   时候要说出右边还有东西：`strip--more` 给固定钮加左缘阴影（不能给条本身加右侧
   mask，那会把固定钮一起淡掉），左侧照旧由 `strip--scrolled` 的 mask 说明。

### 4.17 一格为什么只显示一格（`8ca78a4`）

herdr 能把一个 tab 缩放到单格（zoom）。桌面舞台在 `layout.zoomed` 时由
`arrangeTiles` 收敛成一格——这一步是对的，别的 pane 确实不在屏幕上。但同一时刻
`arrangeable` 变成 false，排列开关也藏了，而 tile 的头只在 `tiles.length > 1`
时画。三件事叠在一起：tab 条说这里有 4 格，舞台只画 1 格，没有头、没有关闭入口、
没有一句话；输入框还写着 `send to wE:pC`，而屏幕上那格可能是 `wE:pD`——herdr
的 focus 决定谁在屏幕上，我们的选择决定消息发去哪，两者本来就可以不同。

判据不该是「舞台上有几格」，而是「这一格需不需要被介绍」。新加的
`tileHeadVisible(tileCount, tabPaneCount)` 在「多于 1 格」或「该 tab 的 pane
多于显示的格」时为真；只有一格 pane 的 tab 照旧不画头，因为 `.stage__head` 已经
写着工作区、cwd 和状态，再画一条就是重复。

实测（`/tmp/probe-zoom.mjs` 桌面、`/tmp/probe-zoom-phone.mjs` 触摸平板，明暗各一遍）：

| 场景 | 改前 | 改后 |
| --- | --- | --- |
| 1280×800 暗，zoom 4 格 | 1 格，无头、无关闭入口 | 1 格 1062×537，头 28px：`omp pC zoom 1/4 … working`，chip 56×15，溢出 `0/0` |
| 1280×800 亮，zoom 但输入目标是另一格 | 空态读 `click to read this pane`，像一格活的舞台 | 空态读 `click to work here — the prompt sends to pD` |
| 1440×900 暗，focus 模式（非 zoom） | — | 1 格 1195×637，头 28px，无 chip，开关 `grid=false / one=true` |
| 1440×900 亮，单 pane 的 tab | — | 无头、无开关，溢出 `0/0` |
| 1024×768 亮，zoom | 头无 | 848 宽舞台，头 28px，chip 起于 x 233 |
| 1024×768 触摸，4 格 | 头 28px，`×` 16×14 且 `opacity: 0` | 头 37px，`×` 32×32 常显 |
| 820×1180 触摸，4 格 | 头 28px | 头 37px，`×` 32×32，溢出 `0/0` |

三条要记：

1. **收敛本身不是 bug，沉默才是。** 舞台少画几格是 herdr 的决定，客户端只是如实
   转述；问题在于转述到一半就停了。凡是屏幕上的东西少于数据里的东西，就得有个地方
   把差额说出来，否则用户读到的不是「缩放」而是「丢 pane」。
2. **描述状态的字不能长得像控件。** 第一版把 `zoom 1/4` 画成带虚线框的 chip，
   和 agent、pane id 并排时读作第三个名字，也像第三个能点的按钮；改成无框的琥珀
   `--step-micro` 注脚之后，它才明确是「关于这一格的注解」。
3. **触屏上没有 hover，所以「藏起来」等于「看不见但能点」。** 关掉一个 pane 的
   `×` 在桌面是 hover 才浮出来，平板上它就是一块看不见的命中区，而它执行的是不可逆
   操作。给 32×32 的常显盒子，头从 28px 长到 37px，代价是每格 9px；手机走透镜
   根本不渲染 tile，所以这条只落在 iPad 尺寸的帧上。

配套：`npm --prefix web run typecheck` 干净，`test:unit` 325/325（`layout.test.ts`
新增 `tileHeadVisible` 五组断言：`(1,1)=false`、`(2,2)=true`、`(1,4)=true`、
`(3,3)=true`、`(0,0)=false`），`npm --prefix web run build` 通过。

## 5. 给服务端的一页需求（若要继续逼近 Ovis）

最小可用集，按依赖排序：

1. `pane.conversation` 至少返回 **turn 边界 + 每个动作的开始/结束时间**。
   有它才有时长摘要与稳定行身份；不需要解析所有 agent，`source: "scrollback"` 作为兜底即可。
2. `pane.read` 增加 **`before` 游标**，让聊天能往前翻而不是只有 200 行。
3. 会话历史的 `history_id`/世代号，避免历史被替换时整段重排。
4. （可选）选择菜单的结构化读出：`{options[], default_index}`。没有也能用键条，有则能做卡片。

### 4.18 发出去的消息为什么停在输入框（`3b29472`）

现场是：手机上打了一句中文，点发送，我们的草稿框清空了、placeholder 回到
`send to w2:p1`，而 pane 里那句话**还在它自己的输入框里**，光标停在末尾，一个字节都没提
交。这条不是渲染问题，是发送语义问题——中间隔了一次「文字被当成粘贴」。

草稿的两条出口本来就分岔（4.1 之前的打字/粘贴之分）：

- **一个键带得动的 ASCII** → `typePaneText`：逐字符发 `keys`，最后补一次 `Enter` 键。
- **一个键带不动的** → `sendPaneText(paneId, line)`，默认 `newline = true`，于是
  `web/src/lib/herdr.ts` 在行尾补一个 `"\n"` 写进 `/input`。

病根在第二条。`pane.send_text` 是「把字节原样写进 pty」：它不做 bracketed paste、也不
做行尾转换，`"\n"` 就是 LF。而现代 TUI 的行编辑器处在 raw 模式，读到的 **LF 是
「换行」这个动作本身**（等同 Ctrl+J），**CR 才是 Enter**。所以旧路径等于「把文字打进去，
再在草稿里敲一次换行」——文字进去了、草稿变两行、什么也没发。用户看到的那句「消息在输入框里，
发出不去」逐字对应这个字节。

量到的东西（隔离的 `herdr --session probe` 会话，pane 里跑一个 `tty.setraw` 的
Python 读字节程序，只回显十六进制）：

| 发的调用 | pane 收到的字节 | 含义 |
| --- | --- | --- |
| `pane send-text w1:p1 $'abc\n'` | `616263 0a` | 文字 + LF（= Ctrl+J，草稿内换行） |
| `pane send-keys w1:p1 enter` | `0d` | CR（= 真 Enter，提交） |
| `pane run w1:p1 "xyz"` | `1b5b3230307e 78797a 1b5b3230317e 0a` | bracketed paste 包一层，末尾仍是 LF |

顺带否掉了先前的猜测：不是 bracketed paste 的锅。`pane.send_text` 根本不加
`ESC[200~…ESC[201~`，加了那一层的是 `pane run`（CLI 的 `pane run` 帮人「打字+回车」）。

再往下做了一次端到端复现（同一个隔离会话，pane 里换成一个仿真 TUI：raw 模式，收到 `0a`
打印 `NEWLINE`、收到 `0d` 打印 `SUBMIT:<草稿>`）：

- 旧路径 `send-text $'abc\n'` → 屏幕上 `abcNEWLINE`，没有 `SUBMIT`。
- 新路径 `send-text "检查一下"` + `send-keys enter` → `SUBMIT:检查一下`。

修法就是让「粘贴」和「提交」变成两次独立调用，而不是一个带尾巴的字符串：
`pasteThenSubmit(paneId, line)` = `sendPaneText(paneId, line, false)`（不带换行）→
`sendPaneKeys(paneId, ["Enter"])`；粘贴失败就直接返回 false，不再补一次键。ASCII 的
`typePaneText` 路径本来就以 `Enter` 键收尾，所以它一直是好的——这也解释了为什么
「英文发得出去、中文发不出去」这种一半好一半坏的现场。

`handOff`（Tab 补全、`/` 菜单）照旧不补 Enter：那两条路径要的就是「把字放进 pane，
让菜单开着」。

验证：`npm --prefix web run typecheck` 干净；`test:unit` 326/326；
`npm --prefix web run build` 通过；浏览器用例
`text a key cannot carry is sent as text` 改为断言先 `POST …/input {"text":"检查一下这个目录"}`
（**不再带 `\n`**）、再 `POST …/keys {"keys":["Enter"]}`，三条 prompt 用例全过
（`enter types the line key by key and keeps history` 与
`tab hands the line to the pane so completion continues there` 未受影响）。

### 4.19 两条请求的发送，断了怎么讲（`7ee9b35`）

`3b29472` 把「粘贴 + Enter」从一个带换行的字符串拆成了两次调用，这件事通了，但
它把两次调用的结果又压回一个 `boolean`：`delivered = await pasteThenSubmit(...)`。
两次请求就意味着一对发送可以在中间断掉，而一个布尔值说不出断在哪。两种断法，两种
完全不同的补救：

- **粘贴没到**：pane 里什么都没有。这时文字必须留在输入框里，而且不能进历史——它
  还没发出去。旧代码 `return` 了，框里文字在，但屏幕上没有任何解释：第二次按回车
  看起来也是「没反应」。
- **粘贴到了，Enter 丢了**：文字已经在 pane 的行编辑器里。旧代码同样 `return`，框里
  于是还留着同一段文字——再按一次回车就会把这段字打第二遍（TUI 的行编辑器不清空）。
  这是比第一种更坏的失败：它不报错，还会写坏输入。

所以发送结果改成三态，`web/src/lib/composer.ts` 新增纯函数：

```ts
export type SendOutcome = "sent" | "unreached" | "unsubmitted";
export function sendTrouble(outcome: SendOutcome, target: string): SendTrouble | null
```

- `sent` → `null`，什么都不说。
- `unreached` → `{ keepsDraft: true, note: "could not reach w2:p1, message kept", action: "retry" }`。
- `unsubmitted` → `{ keepsDraft: false, note: "in w2:p1, Enter did not land", action: "enter" }`。

`keepsDraft` 是这张表唯一真正的分岔：它决定 `send()` 在什么情况下提前返回、让框里的
字留着。`PromptBar` 只多一个 `trouble` 状态，note 的拼装顺序仍是「被拒的附件 → 上传
失败的附件 → 发送中断」，一次只讲一件最该讲的事；换 pane 时清掉（那是上一个 pane 的
事）。`action: "enter"` 时 note 旁边多一颗 `send ⏎`，`resubmit()` 只调
`sendPaneKeys(paneId, ["Enter"])`，**不重发文字**——这正是上面第二种断法唯一安全的
补法。

`handOff`（Tab 补全 / `/` 菜单）反着来：文字已经进 pane 就一定要交出输入框、切进 raw
模式，哪怕末尾那个键没送到。留着副本才是危险的那个选择；键丢了下一键就能补，而重复
打字不可逆。

验证：`npx tsc --noEmit -p web` 干净；`test:unit` 329/329（`composer.test.ts` 新增
三例钉住三态与两句话）；`npm --prefix web run build` 通过；新增浏览器用例
`web/tests/prompt-send.spec.ts` 3/3——粘贴到、键丢：断言 `POST …/input` 只发一次、
框被清空、`send ⏎` 点下去 `POST …/keys {"keys":["Enter"]}` 恰好补一次且文字没有
第二次 `POST`；粘贴没到：`could not reach`、草稿还在、`/keys` 一次没发、再按回车
就成功；ASCII 打字路径的 `/keys` 失败同样保住草稿。
`web/tests/app.spec.ts` 80 过、8 条失败（`#herdr-feed-text` 相关）——在干净 `HEAD`
的临时 worktree 上逐条复现，同样是 8 条失败：那是手机帧把 Scope 换成 `SessionStage`
的既有遗留，与本次改动无关。

### 4.20 横屏手机上，先让 tab 条走（`83244a6`）

一台手机横过来是 390px 高，iOS 的软键盘要吃掉约 210px，剩下 180px 同时要装
转录、键条和草稿卡。这三样里只有一样是软的键盘替不了的：Esc、Tab 和方向键——
打字时最常按的恰好是它们。可此前先被挤掉的是转录：844×390 实测键盘态（kb=210）
`.lens` 只有 69px、xterm 的正文 **25px**，一行多一点；而它上面还压着 37px 的 tab
条，一整个第五屏，用来告诉你在哪个 pane——这句话草稿卡的 placeholder 已经说了：
`send to w2:p1`。

所以规则按「这一行此刻值不值这些像素」来写，而不是按宽度：

```css
@media (pointer: coarse) and (max-height: 499px) {
  .has-keyboard .shell.is-narrow .stage--lens > .strip { display: none; }
}
```

- **只认短屏**：`max-height: 499px` 是横放手机的上限（横放手机最高 440px，iPad
  mini 短边 744px），500 落在中间，和 `lib/frame.ts` 的 `TOUCH_SIDE` 同一条线。
  竖屏的键盘也高，但屏幕更高，390×844 配 336px 键盘后正文还有 353px——那 37px
  的身份行赚得回来，所以竖屏不动。
- **只认键盘在场**：`has-keyboard` 由 `PromptBar` 从 `visualViewport` 报告，
  键盘收起时 tab 条立刻回来。代价是键盘弹出的那一下有一次布局跳动——和
  masthead 在同一个状态下先让位是同一个决定，跳一次比长期少四行划算。
- **只让 tab 条走**：键条留下。它 44px，正好是软键盘没有的那几个键；谁都能被
  替，它不能。
- **`.stage--lens > .strip` 而不是 `.strip`**：桌面舞台和 tile 视图里条的含义不同，
  这条只该管透镜。

844×390 实测（`--kb-inset` + `has-keyboard` 模拟）：kb=210 时 `.strip` 隐身、
`.lens` 69→**106**px、xterm 正文 25→**62**px（16px 行高约四行），`.term__host`
底边和键条严丝合缝，页面溢出仍 0/0；kb=160 时正文 75px，kb=260 时 12px（此时已
没有可让的东西，只剩 h 一行的诚实数字）。竖屏 390×844 配 kb=336：条高 37px 原样
留着，正文 353px。1440×900 桌面不匹配查询，一个像素没动。

`web/tests/landscape-keyboard.spec.ts` 钉住三件事：键盘态下增长量**恰好等于条高**
（把规则临时用内联 `display:flex` 撤销一帧，量出「没有这条规则」的高度再比，
差 0.5px 以内才算过）、`.lens` 底边与草稿卡顶边齐平且页面不溢出、收起键盘后条
回到原高原位；第二条用例守竖屏：同一套键盘模拟下条必须还在、正文 >300px。


### 4.21 44px 的注释：伪元素撑出的命中区被自己的 overflow 裁掉了（`90c8344`）

手机上一根手指约 9mm，masthead 的 daemon 入口、fleet 入口和面板头部唯一的工作区
开关都按文字盒子画：20px 高，开关宽 43px。之前给它们加过一道伪元素「裙边」
（`::before { inset: -12px 0 }`），量出来却什么也没变——`#herdr-host-open`
真实可达高度仍是 22px，`#herdr-picker-open` 是 18px。

原因是这三个控件自己就是裁切盒：`.cluster` 基规则带 `overflow: hidden`（daemon
标签要靠它走省略号），`.stage__pick` 的基础规则也带一份（长工作区名同理）。伪元素
是元素自己的子盒，`overflow: hidden` 连它一起裁——量到 `::before` 的盒子确实是
102×42，可达区域却只有那 20px。**伪元素能穿透的是祖先的 `overflow`，
穿不过自己的**，这条是这次量出来的，不是看规范推的：`elementFromPoint` 从控件
中心往上下逐像素探，22px 外就落到别的元素上。

修法分两类，按「画不画边框」分：

- **无边框的**（daemon 入口、fleet 入口、pane 开关）让真实盒子长到 44px。
  `.cluster--button` 的边框是 `transparent`，`.stage__pick` 在头部是
  `border: 0`，所以 44px 盒子不画任何新东西；masthead 和 `.stage__head` 都是
  46px 的行，44px 控件在里面居中，行高、间距、tab 条起点全都不动。
- **有边框的 theme chip** 保持伪元素裙边（`.switch--cycle::before { inset: -12px 0 }`）：
  它自己 `overflow: visible`，裙边本来就生效（实测 45px），而把 22px 的边框盒
  写到 44px 会变成另一个设计。

量到的数（`elementFromPoint` 逐像素探上下边界，粗指针模拟）：

| 视口 | 控件 | 改前盒 / 可达 | 改后盒 / 可达 |
| --- | --- | --- | --- |
| 390×844 | `#herdr-host-open` | 105×20 / 22px | 105×**44** / **44px** |
| 390×844 | `#herdr-fleet-open` | 54×20 / 22px | 54×**44** / **44px** |
| 390×844 | `#herdr-picker-open` | 43×18 / 18px | 58×**44** / **44px** |
| 390×844 | `#herdr-theme-cycle` | 49×22 / 45px | 49×22 / 45px（不动） |
| 320×568 | 同上 | 同上 | 同上 |
| 1440×900 鼠标 | host / fleet | 135×20、54×20 | 135×20、54×20（一行未改） |

挡住 44px 的另一个可能不是「父亲裁切」而是「伸得太远偷了下一行的点击」，所以也量了：
masthead 46px、`.stage__head` 46px、`.stage--lens > .strip` 起点 92px 均不变，
条顶往下 4px 的 `elementFromPoint` 仍落在条上；页面溢出保持 0/0。

`web/tests/touch-targets.spec.ts` 两例：粗指针下三件控件可达高度 ≥44 且盒子本身
≥44（防止再退回「裙边被裁」的假修复）、theme chip 盒子仍 <30 但可达 ≥44、两行
都还是 46px、条顶 92px、条顶 4px 归条不属于控件、无溢出；鼠标视口下 host/fleet
仍 <30px、pane 开关保持隐藏——粗指针规则不许跟到鼠标上。

### 4.22 先把可用空间量出来，再决定板子多高（`4cc6dd6`）

`/` 调色板和 `@` 补全都用 `max-height: min(44vh, 340px)` 收高度。`44vh` 的前提是
「视口就是可用屏幕」，而软键盘把这个前提打掉了：`visualViewport` 缩了，`layout
viewport` 没缩，`100vh` 仍是整屏，于是板子按整屏算出 44% 之后又被草稿卡顶上去，
上半截直接跑到屏幕外。

键盘下的正确高度是一个测量值，不是比例：拍板的那一刻，草稿卡顶边到视口顶还剩多少。
所以打开时量一次（`ResizeObserver` 盯草稿卡与最近的 `.shell`，外加 window /
`visualViewport` 的 resize），把它发布成 `--palette-max`，`max-height` 变成
`min(44vh, 340px, clamp(top - 12px))`（粗指针下 `min(50vh, ...)`，手指按原因另算），
关闭或卸载就把变量删掉——它描述的是「这一次开口的可用空间」，留着只会过期。

| 视口 / 键盘 | 改前盒 | 改后盒 |
| --- | --- | --- |
| 390×844 / 336px | 顶部出屏 | y=161 h=266 |
| 320×568 / 260px | y=-57 h=284 | y=**5** h=222 |
| 844×390 / 210px | y=-96 h=195 | y=5 h=94 |
| 1440×900 / 无 | 原样 | 逐项不变 |

`web/tests/palette-fit.spec.ts` 四例把这四种姿态钉住，包括「先开板子再弹键盘」
（测量必须跟着变化重算，不能只在打开那一帧算一次）。

### 4.23 键盘一弹，菜单把终端挤没了：折成一行（`05ee728` / `5f3221f`）

键菜单是**刻意在流里**的：打开菜单去按 `↑`/`↓`，目的就是看 TUI 怎么回答，浮层盖住
终端等于把要看的东看藏起来。这个取舍只有在「还剩下一个终端」时成立，而键盘弹起时
不成立——一个 `min-height: 0` 的 `.term__host` 面对两行 16 键网格加标题行加常驻键条，
320×568 配 260px 键盘时是 2px，844×390 配 210px 时是 0px。

矮框（粗指针、高度 <700px、`html.has-keyboard`）里菜单折成一行：

- 16 键网格变 `grid-template-rows: 40px` 的单行，横向滚动。（网格本来就是常驻键条的
  超集，所以折叠时把键条里的键藏掉不丢任何一键，只留那颗 `keys` 开关。）
- 面板保持自己的盒子（`role="group"` 还在），标题收起，`hide` 保持 44px 拇指目标。
- 面板的 `order` 把网格排到前、`hide` 排到后，于是「看键」优先于「关闭」。

顺带挖出一个更隐蔽的 bug：键条基规则为了居中是 `justify-content: center`，而网格的
16 条轨道在 320px 上宽 700px、装进 214px 的滚动盒后被居中，内容起点算成 **x=-237**。
`scrollLeft` 只能从 0 往右滑，于是 esc/tab/⌫/↵/ctrl 停在滚动原点左边——它们不是「在
屏幕外」，是**滑不到**（`scrollWidth` 都只报 457，因为只量得到原点右边的部分）。
折叠态的网格改 `justify-content: start`。

| 姿态 | 改前 host | 改后 host | 网格 |
| --- | --- | --- | --- |
| 320×568 / kb=260 | 2px | **146px** | 单行 40px，`sw 700 / cw 214` |
| 844×390 / kb=210 | 0px | **55px** | 单行 40px，`sw=cw=738` 不滚动 |
| 390×844 / kb=336 | — | 202px | 两行 84px（不动） |
| 390×844 / kb=0 | — | 408px | 两行 84px（不动） |

`web/tests/keymenu-space.spec.ts` 三例钉住：host 不低于 40px、单行 16 键、首键在滚动
原点、末键一次滑动可达、`hide`/`keys` ≥44px、菜单夹在终端与草稿卡之间、页面无溢出，
以及「高框不许被折」——折叠是矮框的补丁，不是所有手机的新样式。

### 4.24 同一批键不收两次钱（`baec5c2`）

折叠规则（4.23）解决了「菜单把终端挤没」，但没问「菜单里有没有重复的东西」。网格 16 键
是常驻键条的**严格超集**，可面板打开时键条照样铺在下面——于是 esc/tab/ctrl/^C/↑/↵ 这
六键在同一个面板里出现了两次，第二份还算在终端头上：

| 姿态 / 状态 | 面板 + 键条 | 只有面板 | host |
| --- | --- | --- | --- |
| 390×844 / kb=336 | 151 + 44 = 195px | 151px | 353 → 202 改成 353 → **246** |
| 844×390 / kb=210（折叠） | 面板行 + 44px 键条 | 面板行 | 网格盒 786 → **832** 宽 |

`html.has-keyboard` 下用兄弟选择器 `.keymenu__panel ~ .keys:not(.keys--grid)` 藏掉键条，
面板自带的 `keys` 开关就是把它叫回来的那颗键（面板不存在 → 选择器不匹配 → 键条回来）。
不改 TSX，`role="group"` 的盒子保留。

两个坑：

- **上一版的「降级」是错的**：`05ee728` 曾把键条里的**每一个键**在键盘弹起时藏掉，只留
  `keys` 开关。折叠状态确实只剩一行，但键盘一弹、面板还没开时，手机上连 esc 都没有——
  「网格是超集」的前提只在面板打开时成立。这条整块删掉，键条六键全程都在。
- **关闭后键条挤在左边**：折叠态行盒 844px 宽，键条只占 284px 并靠左（起点 x=6），像被
  裁掉一半。补 `flex: 1 1 auto` 后 `rowBox {x:6, w:832, h:44}`，键组居中。

`hide` 是 26×20 的字，在所有竖屏规则（`min-height:500px`）够不着的头里都是这么小，而它是
面板唯一的出口。伪元素负 inset 把命中区撑到 44px 高（实测 `document.elementFromPoint`
逐像素扫：face 20px，target 44px），网格在重叠像素处仍然赢——`^C` 上沿 2px 点到的仍是
`keys__key`，只压到 pane 底沿约 3px。

`keymenu-space.spec.ts` 四例（新增横屏无键盘的 `hide` 命中扫描）：关闭态六键 `esc tab
ctrl ^C ↑ ↵` 齐全且面高 ≥40、行高 ≥44；打开态键条 `display: none` 且 `hide` ≥44；竖屏
高框 host 减幅 ≤110px（钉住「只付面板那一份」）；横屏无键盘 face 20px 但命中 44px、
`^C` 上沿不被抢。

### 4.25 回答行的目标与边缘（`c4b8254`）

行里放的是菜单答案，见过的最长是六条：**1169px 的芯片，390px 的行**。两件事同时错，而且
都不是「再挪几个像素」能解决的。

**边缘**。溢出时第三颗芯片被屏幕边缘切在字中间，看起来像盒子坏了，不像「右边还有」。行
自己最清楚哪一侧还有东西，于是按边淡出，只在那一侧有内容时淡：

| 姿态 | 芯片总宽 / 行宽 | 轨道 | 淡出 |
| --- | --- | --- | --- |
| 390×844 / kb=0 | 1169 / 390 | 515px | 右 |
| 390×844 / kb=336 | 1169 / 390 | 309px | 右 |
| 320×568 / kb=260 | 1087 / 320 | 109px | 右 |
| 390×844 滚到端点 | — | — | 左 |

右 34px、左 20px，两侧都有时是一条有两个停点的渐变；`mask-image` 只影响绘制、不影响命中，
所以裙摆照旧整条可点。滚到端点即收——「还有」不该在没有了的时候还挂着。

**目标**。芯片 32px 的面是给眼睛的，44px 是给手指的，差的那 12px 由行的 padding 出。上一版
行高只给了 `6px 12px 2px`，2px 的下沿把裙摆裁回去，实测命中只有 40px；更隐蔽的是芯片自己
的 1px 描边：`::after` 的包含块是 padding box（30px），`inset: -6px` 只能撑到 42px，裙摆
实测 346→388.5，388.5 之后落到行本身、389 之后落到下面键条的裙摆上。修法是让裙摆精确贴到
行边：`inset: calc(-6px - var(--rule-w)) -2px` → 346→390 整 44px；
行补 `position: relative; z-index: 1`，把边界（388.5–390，键条自己的裙摆从下往上探的
那一点）判给答案而不是 esc——esc 的 44px 从 390 起，一分没少。

`elementFromPoint` 逐像素复核（390×844 / kb=336）：`row 346→390 h44`、`chip 352→384 h32`，
347 与 389 都命中 `.chat__pickopt`，390 起才是 `keys`。

三个坑：

- **吸附会吞掉留白**：只写 `scroll-snap-align: start` 时静止态 `scrollLeft = 12`，首颗芯片贴
  着行边、左淡出常亮——看起来像一进来就已经滑过。补 `scroll-padding-inline: 12px` 后静止
  `scrollLeft 0`、首颗 `left 12`、左淡出消失。「按 12px 留白对齐」和「按 0 对齐再补留白」
  是两件事。
- **行盒不变、内容变宽**：同一个 pane 换了菜单时行的宽度不动，只 observe 行会漏掉。行和每
  颗芯片都 `observe`，一次观察一次测量。
- **这 4px 是借的**：轨道 40→44 让 320×568 / kb=260 的轨道从 113 掉到 109px。接受，因为
  109px 仍够两行事实；但这是回答行第二次向转录借空间，再借就得先删内容。

`web/tests/pick-row.spec.ts` 四例：44px 带两端与面心都命中芯片、静止与滚到底的 class 与
mask 互斥且末颗离边 ≥8px、裙摆下沿的 tap 打到的是那一号键（`/keys` 收 `["1"]`，桥被
stub）、320×568 kb=260 的轨道 ≥100px。同批 `keymenu-space` / `touch-targets` /
`prompt-send` / `landscape-keyboard` / `palette-fit` 15 例仍全绿。

### 4.26 键盘弹起时，镜头开关不能跟着头一起走（`a264c84`）

4.20 为了给轨道腾地方，让整个 stage 头在键盘弹起时 `display: none`。头里有 cwd、agent 状
态、pane 开关——这些确实都是「屏幕上已经有第二份」的东西——但同一行里还坐着**唯一能换镜头
的开关**。于是最尴尬的一刻发生了：拇指打字打到一半，正看着一份读不懂的 TUI（或反过来，
正在文档里读一段不知道怎么输入的命令），想换镜头，而开关不在。

把头放回文档流是最直接的修法，代价也算得出来：320×568 加 260px 键盘只剩 109px 轨道
（4.25 量的），46px 的头占掉 42%。

**所以头不改 DOM 位置，改成脱离文档流，浮在 tab 条上。** 条本来就只有 37px、只报当前 pane
的名字，而「把控件浮在一条滚动行上面」是这个外壳已经用熟的手法——钉住的 `+` 就是
`position: sticky`。

| 姿态 | 头 | 开关 | 条 | 轨道 |
| --- | --- | --- | --- | --- |
| 390×844 / kb=336 | `x274 y0 116×36`，`absolute` | `x284 y5 96×26` | `0→37`，`padding-right 116` | 起点 37 |
| 320×568 / kb=260 | `x204 116×36` | 右缘 310（屏宽 −10） | 同上 | 起点 37 |
| 390×844 / kb=0 | 回到行里 `h46` | 行内 | `92→137`，`+` 在 | 起点 137 |
| 844×390 / kb=210 | `display: none` | — | `display: none` | 命中落到转录 |

四条对应关系：

- **谁吃点击**：头的盒子整块 `pointer-events: none`，只有 `.stage__lenswrap` 收 `auto`。
  少了这一句，右上手势（划 tab、滚转录）会被一层看不见的满宽 div 吞掉。
- **`+` 让位**：37px 的条里 96px 的开关 + 44px 的钮 + 间隙是 160px，320px 宽只塞得下一个
  44px 控件，打字时有用的是开关（它弹的工作区面板本身就会把键盘顶掉）。关掉键盘 `+` 立刻
  回来，实测 `display` 在 `flex` 与 `none` 之间切换。
- **条给开关留位**：`padding-right` 与 `scroll-padding-right` 都吃到 `--lens-head: 116px`，
  最后一个 tab 不会停在浮层底下拽不出来。
- **裙摆 34px**：26px 的开关面放进 36px 的行，44px 是够不到的——再往外就压到转录的第一行和
  终端镜头右上角的查找钮上。`::after` 的 `inset: -5px -2px` 让命中填满条的内带
  （1→35，34px），条的 0 与 36 两条边线仍然归条。

`/tmp/probe-lenshead.mjs` 逐点复核（390×844 / kb=336）：命中 `(284,18)` 面心是
`button.lens__opt`，`(284,1)` 与 `(284,34)` 是同一颗，`(254,18)` 已经是 `div.strip`——头确实
是透明的；320×568 / kb=260 同构，开关右缘 310 没越过屏幕边。

**换镜头不 blur。** 开关的 `pointerdown` 被 `preventDefault()`（和草稿框自己的按钮同一个手
法：它并不取消随后那次 click），于是 tap 之后 `document.activeElement` 仍是 `.prompt__input`、
`<html>` 仍带 `has-keyboard`，紧接着敲的字仍进草稿——这条是测试里真的敲了 `!` 验的，不是
推断。

媒体查询一开始写的是 `(max-width: 900px) and (min-height: 500px)`，太宽：`.stage--lens`
本来就只在 ≤720px 的帧出现，900 这个上界只会让细指针的桌面窗口也进这条规则。收成
`(pointer: coarse) and (min-height: 500px)` 后六个姿态逐字节重测，无变化；横屏手机
（<500px）停在原来的 `display: none` 里，不会有一块浮层盖在终端查找钮上。

`web/tests/lens-typing.spec.ts` 五例：浮层不吃轨道高度（头 `absolute`、条从 0 起、轨道起点
等于条下沿）、其它头元素与 `+` 都不在、条留位 ≥ 开关宽 + 8、开关的四边与面心都命中它自己
而条上空白的点落回 `.strip`、敲了字再 tap `term` 之后镜头变了而焦点/键盘/草稿都还在、关掉
键盘后头回到行里且 `padding-right` 归零、320×568 / kb=260 开关仍不越界。同批
`pick-row` / `keymenu-space` / `touch-targets` / `landscape-keyboard` / `palette-fit` /
`prompt-send` 24 例全绿，`tsc --noEmit` 干净。

### 4.27 键盘弹起时，先让步的是内饰不是正文（`f6adf48`）

4.26 把开关找回来了，代价是键盘弹起时舞台格局固定成四段：37px 的条、44px 的回答行、
44px 的键条、然后是草稿卡。前三段都不该动——条报身份、回答行是菜单的读法、键条是软键盘
给不了的 Esc/方向键。真正会长的只有草稿卡：`fitComposer` 的上限是可视高度的 40%，320×568
配 260px 键盘时可视高 308px，上限 123px，取整到五行 120px。

把量到的段高加起来：条 37 + 回答行 44 + 键条 44 + 草稿卡 138（120 的输入框 + 上下边）= 263，
舞台可用约 300px，正好余 37px 给轨道。看起来够，实际装不下。

关键在于**内边距也算地板**。`.chat__lane` 写了 `min-height: 0`，可以缩到 0，但它自己的
`padding: 20px 0 28px` 缩不掉：48px 的内饰是它不可让的部分，而它能拿到的只有 37px——少
11px。这 11px 没有凭空消失，它把下面的三行整体往下推：`keys.bottom = 173` 压进
`prompt.top = 162.5`，而 `.lens` 是 `overflow: hidden`，被裁的正好是键条下沿那一排字母。

**修法是让内饰先让。** 键盘弹起时轨道上下各收 8px（地板 16），键盘一放立刻回 `20/28`：

```css
.has-keyboard .chat__lane {
  padding-top: 8px;
  padding-bottom: 8px;
}
```

改完之后的五段地板，只有轨道那条是软的：

| 行 | 盒子 | 地板从哪来 |
| --- | --- | --- |
| 条 | `0 → 37` | 36px 的行 + 1px 线，固定 |
| 轨道 | `37 → 74`（37px，刚好一行） | `min-height: 0`，但 `padding: 20px 0 28px` 缩不掉 |
| 回答行 | `74 → 118` | `6 + 32 + 6`，芯片自己的 32px |
| 键条 | `118 → 162` | `min-height: 44px` |
| 草稿卡 | `162 → 300` | 5 行 × 24 + 边距，`fitComposer` 算出来的 |

改完的 320×568 / kb=260 是首尾相接的四段：轨道 `37..74`、回答行 `74..118`、键条
`118..162`、草稿卡 `162..300`，`keys.bottom === prompt.top`，无重叠也无空隙；草稿卡仍是
120px、`overflow-y: auto`，第 6 行靠滚动可达。390×844 / kb=336 的轨道本来就富余，逐项不变。
代价说清楚：五行草稿时转录只剩 37px（一行 + 8px 空气）。这个交换是刻意选的——人正在打字，
草稿和键条比历史重要；草稿一收，转录立刻回满。

**这一条真正的教训在量尺上。** 之前所有键盘用例（含 4.23、4.26 那批）模拟键盘的方式是
直接给 `<html>` 设 `--kb-inset` 再加 `has-keyboard`，但 `visualViewport.height` 仍是整窗。
`PromptBar` 里有两个消费者：一个按 `innerHeight - view.height` 发布 inset，另一个
`fitComposer` 用 `view.height` 算 40% 上限。只改 CSS 变量等于骗过第一个、骗不过第二个：
上限按 568 × 0.4 = 227px 算，草稿卡长到 8 行 192px，量出的溢出比真机狠得多，而且无论怎么
调参数都量不到真机的那个 11px。所以先把辅助函数改成**只谎报可视高度**：

```js
Object.defineProperty(window.visualViewport, "height", {
  configurable: true,
  get: () => window.innerHeight - px,
});
window.visualViewport.dispatchEvent(new Event("resize"));
```

一条谎话，剩下的全走产品代码：inset 是 `keyboardInset()` 钳出来的、`has-keyboard` 是
`PromptBar` 自己加的、网格重排和草稿重算都是真的。收键盘就是把这条 defineProperty 删掉
再派发一次 `resize`。改完前五例仍全绿（它们断言的是头的浮层几何，不受这条影响），
第六例才第一次能看见真机的夹击。

`web/tests/lens-typing.spec.ts` 第六例：320×568 / kb=260 打六行草稿后，`overflow-y` 必须是
`auto`、草稿卡 ≤120px、轨道底沿 = 回答行顶沿、回答行底沿 = 键条顶沿、
`keys.bottom <= prompt.top`、草稿卡底沿不越过可视高度、`.shell` 底沿贴可视高度、轨道实际
只留 20px 以上且 `padding` 读出来是 8/8，最后收键盘断言 padding 回到 20。把 chat.css 那条
规则临时撤掉重跑，该例以 `Expected: <= 162.5, Received: 173` 失败——失败信息就是那 11px。
六例全绿用时 9.2s，`tsc --noEmit` 干净。

### 4.28 横过来打字，开关得自己在键条的空档里（`059ba3c`）

4.26 把竖屏的开关找回来了（浮在 tab 条上），4.20 又把横屏的头整行让给了键条。两件事凑在
一起留下一个洞：`(pointer: coarse) and (max-height: 499px)` 的帧里，`.lens__switch` 与
`.strip` 一起 `display: none`，而这块屏恰恰是**宽而矮的粗指针**——按 4.19 定的规则，
宽帧默认镜头是 `terminal`。也就是说：手机横过来、点开草稿开始打字，想读成转录的人
在整段打字过程中没有任何入口。

不能放回头里，那 36px 是从键条手里抢回来的；不能塞进键条，7 颗键在 844px 上居中的两侧
本来就是空档。实测 844×390 配 210px 键盘：

| 盒子 | 量到 |
| --- | --- |
| `.lens` | `0,0` 844×106 |
| `.strip` / `.lens__switch` | `0×0`（`display: none` 的祖先） |
| `.keys` | `y 62..106`，高 44 |
| 末键 `.keys__key` | 右沿 **564** |
| `.flip` | `735,69` 99×28 |

右翼从 564 到 844 有 280px 空着，pill 占 99px，还剩 171px。所以它是 `.lens` 的绝对子元素，
`right: 10px; bottom: 9px`，26px 高的面居中在 44px 行的中线上（`69 + 28/2 = 83`，
行中线 `62 + 22 = 84`，差 1px 是 1px 的描边）：**垂直方向不花一分钱**，转录、回答行、
键条、草稿卡四段全不动。

命中测出来是干净的：`elementFromPoint(839, 101)`（pill 的右下角内）→
`button.flip__opt`；往左 1px `838` 仍是 pill，`731` 则是 `div.keys`，说明它没有盖住键条
可点的区域，也没被键条的裙摆吃掉。`pointerdown` 上 `preventDefault()`，所以点它
聚焦不会离开 `#herdr-input`、`has-keyboard` 不消失、光标原位——否则点一下换镜头
等于自己把键盘收了、把 pill 收了。

文案故意用 `chat` / `term` 两个词，不用图标：9.5px 的字在真实终端背景上必须靠反色块才读得
出「当前是哪个」，`aria-pressed` 决定谁反色（`--ink` 底、`--paper` 字，是两套主题唯一都定义
过的对比对）。

**边界是三条，每条都是「不要画」比「画了但没用」更对：**

- 桌面（1280/1440，细指针）整块 `.lens` 都不存在，`.flip` 自然不画；
- 竖屏 390×844：头的浮层在（4.26），`.lens__switch` 可见，pill 不画；
- 聊天镜头没有待选菜单（`:has(.keys)` 不成立）时键条不存在，pill 也不画。

**第三条边界被测试自己推翻了一次。** `keymenu-space` 的横屏例在回归里挂掉：

```
<button type="button" class="flip__opt" aria-pressed="true"
        title="the session's real terminal">term</button>
from <div class="flip" role="group" aria-label="session view">…</div>
subtree intercepts pointer events
```

键菜单展开时（4.23、4.24 改的那个折叠态）它自己就是那一行，`hide` 正好落在同一个右翼。
pill 的 `z-index: 3` 压住了它——用户打开的菜单关不掉，而菜单里唯一的出口就是那颗 `hide`。
门补一个 `:not(:has(.keymenu__panel))`：面板收起时 `hide` 不在 DOM，pill 立刻回来；面板
展开时让位，两边都是唯一入口，谁在干活谁拿那块地方。

```css
.has-keyboard .lens:has(.keys):not(:has(.keymenu__panel)) > .flip { … }
```

`web/tests/lens-flip.spec.ts` 六例（844×390 横屏四例、390×844 竖屏一例、1280 桌面一例）：
几何（pill 底沿 = 键条底沿、pill 完整落在键条这条带子里、中心差 ≤4px、与末键夹角 >8px、
页面 `scrollHeight` 仍是 390）、点 `term` 换镜头且 `data-lens` 与 `aria-pressed` 同步、
`#herdr-input` 仍聚焦、`has-keyboard` 仍在、再点回 `chat`、键菜单展开时 pill 隐藏且
`hide` 可点、菜单收起 pill 回来，以及三条不画的边界。键盘的模拟沿用 4.27 的量尺——
只谎报 `visualViewport.height`，让 `PromptBar` 自己发 `--kb-inset` 与 `has-keyboard`；
横屏帧的默认镜头是 `terminal`，所以用例在 `addInitScript` 里钉住 `herdr:lens:w2:p1`
才量得到聊天镜头。六例与 `keymenu-space` 四例同跑 10 例 9.9s 全绿，回归子集 31 例全绿，
`tsc --noEmit` 干净。

### 4.29 键条与回答行在镜头不够高时自己折叠（`aaeb4f6`）

4.27 把轨道的空气压到 16px，是为了让 320×568 上的键条不被草稿卡盖住。可草稿卡的高度不是常数：
按 `fitComposer` 的设计它最多拿可视高度的 40%，一行变三行时它自己会从 66px 长到 90px。
于是同一台机器上换一份草稿，溢出又回来了：

| 帧 | 键盘 | 草稿 | `.lens` | 轨道 | 回答行 | 键行 | 合计 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 844×390 | 210px | 空 | 106px | 18px | 44px | 44px | 106px ✓ |
| 844×390 | 210px | 三行 | **82px** | 8px | 44px | 44px | 96px ✗ 18px 在草稿卡下面 |
| 568×320 | 160px | 三行 | **86px** | 6px | 44px | 44px | 94px ✗ 18px |
| 320×568 | 260px | 五行 | 125px | 8px | 44px | 44px | 96px ✓（4.27 已修） |

差别在于竖屏有一整块舞台，横屏没有：横屏的 `.lens` 是「舞台减去草稿卡」，而草稿卡能长到
40% 的可视高度，所以镜头的高度是被别人决定的，且随时会变窄。

**谁让路**。三条都试过：

1. **让草稿卡缩回两行**——它已经在 40% 那个上限里了，除非改 `COMPOSER_VIEWPORT_SHARE`，
   而那个数字是「你打的字必须读得全」的承诺，为 18px 的键条去砍它不划算。
2. **让键行消失**——`esc` 是软键盘给不了的键，正是 4.19 把键条搬到移动端的理由。
3. **把回答行折进键行**——两块命中区叠在一条 40px 的带子里，手指分不出按到哪个。

**让行自己折叠**，但只在镜头真的不够高时。判据不能是媒体查询：同样的 844×390，空草稿的
镜头有 106px（够），三行草稿只有 82px（不够），媒体查询看不见草稿。能看见的是一个容器查询——
`.lens` 的高度是 flex 给的（舞台减草稿卡），**与它自己的内容无关**，所以给它加尺寸 containment
不会造成循环布局：

```css
@media (pointer: coarse) and (max-height: 499px) {
  html.has-keyboard .lens { container-name: lens; container-type: size; }

  @container lens (max-height: 103px) {
    html.has-keyboard .chat__lane { padding-top: 0; padding-bottom: 0; }
    html.has-keyboard .chat__pick { padding-top: 4px; padding-bottom: 4px; }
    html.has-keyboard .lens .keys { min-height: 40px; border-top: 0; box-shadow: inset 0 var(--rule-w) 0 …; }
  }
}
```

阈值 103px 是 104px 少一像素：栈需要 104px 时一条也不折，矮于它才折，折叠后又一定装得下
（折叠后只要 80px），所以不会在两个状态之间抖动。

**40px 的行，40px 的键面**。折叠态最容易犯的错是「把行压到 40px 然后键面还是 44px」——
那会把键面自己的边框挤出盒子，肉眼看不出来，手指落在键面上沿按到的是上一行。做法是：
键面的高度不动（仍是 40px，横屏粗指针那条规则本来就给的是 40），把本该在盒子外面的 1px
规则换成 `box-shadow: inset`，于是盒子 40px = 键面 40px。回答行同理：padding 6→4 之后
32px 的芯片面两侧各剩 4px，裙摆 `inset: calc(-4px - var(--rule-w)) -2px` 多出的一像素被行的
`overflow` 裁掉，靶子正好铺满 40px 的整行。

**不折的三条边界**（都是用例钉住的）：

- 草稿短的时候就别折。844×390 空草稿的镜头 106px，44px 的行原样留着——折叠是补丁，不是新样式。
- 竖屏不折。查询挂在 `(pointer: coarse) and (max-height: 499px)` 上，390×844 配 336px 键盘
  仍是 44/44。
- 草稿卡不折。三行草稿仍是 90px（40% × 180px 的可视高度），折叠只动它下面的行。

`web/tests/squeeze-rows.spec.ts` 五例：844×390 三行草稿（镜头 82px、键条底沿 = 镜头底沿、
回答行 40、键行 40、键面 40、芯片面 32、规则 `border-top` 为 0 且 `box-shadow` 含 `inset`、
键与芯片中心的 `elementFromPoint` 分别命中 `keys__key` 与 `chat__pickopt`、草稿卡仍是 90px、
页面 `scrollHeight` 仍是 390）、844×390 空草稿（镜头 106px、44/44、`containerType` 为 `size`）、
568×320 三行草稿（镜头 86px、键条底沿 = 镜头底沿、轨道 ≥0 且 <8px、两块都点得到）、
568×320 终端镜头（折叠同样生效、终端盒底沿不超过镜头底沿）、390×844 竖屏（44/44，查询不越界）。
键盘模拟沿用 4.27 的量尺：只谎报 `visualViewport.height`，让 `PromptBar` 自己发
`--kb-inset` 与 `has-keyboard`。

同跑：`squeeze-rows` 五例 3.6s 全绿，回归子集（`lens-flip`、`keymenu-space`、`pick-row`、
`touch-targets`、`landscape-keyboard`、`palette-fit`、`lens-typing`）28 例 16.8s 全绿，
`tsc --noEmit` 干净。探针 `/tmp/probe-568c.mjs` 用**真实样式表**（不再注入候选 CSS）复测
八个尺寸，数值与注入版逐项相同：折叠态 568 轨道 6px / 键行 40@46..86、844 轨道 2px /
键行 40@42..82、844 空草稿 44/44、两档竖屏逐项未动。

### 4.30 折行的代码片不许替操作者说话（`fc74ed9`）

前面几版都在修手机上的高度，这一条修的是**读错内容**：`devin` 的回答是纯散文，但每处
`path`、`command`、`fleetPeers[id]` 都带一块行内代码底色（`48;2;0;43;54`）。底色一长就会折行，
折出来的那一行**从第 0 列就踩着底色开始**，于是它看起来和一个真的输入框带子一模一样。

`isBandRow` 原判据是「填充从文字前开始，且覆盖大半行」——`w6:p7` 的实测：

| 行 | 文本 | 填充 | 判定 |
| --- | --- | --- | --- |
| 1 | ` What this is： fleet.go 的 handleFleetHello …` | 60% | 散文 ✓ |
| 4 | ` Problem：a) peer 名单投毒 …` | 13% | 散文 ✓ |
| 8 | ` tConsoles() / knownPeerHost / fleetSources 。` | **91%** | **假 user band** ✗ |
| 12 | ` 6. 共享账本的 claim/release/cancel 不验证节点身份 …` | 48% | 散文 ✓ |
| 15 | ` laim / Heartbeat / Release / Cancel  全不验。` | **79%** | **假 user band** ✗ |
| 17 | ` Problem：任何能发帖的人（默认无认证）可： …` | 45% | 散文 ✓ |
| 20 | ` Fix：claim/heartbeat/release/cancel 与 attest 一样要求签名 …` | 36% | 散文 ✓ |

后果不是画错一个颜色：这三行把同一个窗口切成 4 轮，其中 3 轮的**操作者气泡里是 agent 自己的话**，
而真正的操作者消息（同一批 pane 里的 `❭ /usage`）被留在后面当 chrome。用
`/tmp/band.mjs`（按行重算 span/底色、打印 `band=`、`fill=`、`lead=`、`bgs=`）逐行复算才定位到
「91% 也算大半行」这个洞。

**判据收紧成「填充覆盖整行的每一个字形」**：真的输入框会把消息铺满 pane 宽度，带底色那一行
**后面不再跟着任何普通墨色**；折行的代码片一定会被收句的散文接住——实测 71%、79%、91%，
从没有 100%。所以 `filled * 2 >= total` 换成 `filled === total`，一行注释就地说明为什么
「大半行」不够。这条规则仍然不比颜色（`BOX_EDGE_RE` 那段说过：omp/pi 的盒子正文和输入带
共用同一个 `48;2;15;18;22`），也没有任何 `agent === "devin"` 分支。

**拿真 pane 复算**（`/tmp/dump-conv.mjs` 直接喂 `herdr pane read --format ansi` 的尾巴）：

| pane | agent | 改前 | 改后 |
| --- | --- | --- | --- |
| `w6:p7` | devin | 4 轮，3 个假气泡 | **1 轮**（`user: null`）✓ |
| `w2N:p5` | devin | 2 轮（`❭ /usage` 真的） | 2 轮，`❭ /usage` 照旧 ✓ |
| `w6:p3` `w8:p4` `w2T:p1` | omp | 1 轮 + thoughts/work | 逐项未变 ✓ |
| `wE:pG` | agy | 1 轮 | 未变 ✓ |

omp 的盒子行本来就是 100% 填充（`| …`、`+--- …`），仍然先被 `BOX_EDGE_RE` 收走，不受影响。

**用例**。`conversation.test.ts` 加一例：一段回答里出现折行代码片（`chip("tConsoles() / knownPeerHost / fleetSources")` 后面接 ` 。`），
断言只有 1 轮、`user` 是那句故意打的中文、`answer` 同时含折行前后的散文。撤掉修复该例失败
（`ℹ pass 24 / fail 1`），装回去 330/330。同跑 `pick-row` + `squeeze-rows` 9 例 6.9s 全绿、
`tsc --noEmit` 干净。

这一条属于目标里那句「还要额外支持一些其他 agent」：官方那几个 agent 的输出形状我们早就吃住了，
真正会让转录读错的是**没见过的渲染习惯**——devin 的行内芯片、agy 的纯文本流。判据只能建在
「输入框是一个矩形」这种与 agent 无关的形状上，不能建在具体配色或具体 agent 名上。

### 4.31 查找放大镜去当键条里的一颗键（`c1d1eef`）

查找钮从 4.24 起就是个角标：44×44，绝对定位在网格的右上角。桌面没问题——那里有 ⌘F，角标只是个入口。手机上它就成了身上的一块膏药：

| 帧 | 网格高 | 角标占掉 | 后果 |
| --- | --- | --- | --- |
| 390×844 | 559px | 44×44 @ `340,143` | 盖住两段话的尾巴 |
| 844×390 kb-up（vv 180） | **55px** | 44×44 @ `794,6` | 四行里三行被盖，`v0.6.14 ta[g]` 切在字中间 |

「把它缩小」不能解决问题：手指地板是 40px（4.21），而 40px 以下就不是拇指目标了。「把它挪到网格外面」才是：键条那 44px 本来就是手机的，它两侧的空白像素是横屏帧上仅有的空地。

**先改结构再改样式**。角标原来是 `.term__host` 的子节点，而 `.term__host` 是 `overflow: hidden` 的定位上下文——CSS 再怎么算也挪不出网格盒子。现在它是 `.term__host` 的**兄弟**、`<KeyMenu/>` 之前（`TerminalLens.tsx`），`.term` 补一行 `position: relative` 当它的定位上下文；`.term` 没有内边距，所以它的底沿就是键条的底沿。`onPointerDown` 从 `stopPropagation` 改成 `preventDefault`：要的是草稿框别 blur（键盘别掉），而不是别的事件也别冒泡。

**键条的翼是从自己的皮肤里买的**。竖屏 390px 的键条 `padding: 2px 6px`，内容盒 378px；七面 44px + 六道 4px 间隙 = 332px，看上去还剩 46px，但那 46px 里塞不进 44px 的圆盘——只要再来一道间隙。所以 `.keys` 拿 `padding-right: 52px`，内容盒收到 326px：

- 390px：(326 − 24) / 7 = **43.1px** ⇒ 实测按 44 上报，末面（`keys`）右沿 338，圆盘 `344..388`，中间 6px 缝；
- 362px：(304 − 24) / 7 = **40px** ⇒ 正好踩在手指地板上，所以 **362px 是这条规则的门**；
- 320px：再窄脸就要掉到 39px 以下，`ctrl` 这种最常用的键先受害——320 的手机保留角标（实测圆盘仍在 `270..314 / 143..187`）。

横屏 844×390 的键条是居中的，两侧都有空地，本该两边随便停；但右翼在**打字时**是 4.28 那个镜头开关的（`flip` 735..834），而四行的网格上那开关比查找更值钱，于是横屏停左翼：`padding-left: 52px`，内容盒 786px 居中出 332px ⇒ 键 `279..611`、圆盘 `2..46 / 270..310`，一行读作「查找 · 键 · 开关」。

**一个像素级的账**：圆盘 40px 高而不是 44px。它身边是 44px 条里的 40px 脸（`terminal.css` 的 `(pointer: coarse)` 块），做 44px 就会比脸高出 4px、往回扎进它存在的意义就是别盖的那块网格。`bottom` 直接沿用键条自己的表达式 `2px + max(0px, env(safe-area-inset-bottom) - 8px)`，圆盘与脸一起躲开 home indicator。

**两次回归**都来自「键条的框不是 `.term` 的框」：

1. **键盘弹起、键菜单折叠时**（`@media (pointer: coarse) and (max-height: 700px)` 里的 `html.has-keyboard .keymenu`），键条把 `padding-top/bottom` 交给 `.keymenu`，于是 `.term` 的底沿比键条的底沿低 3px，圆盘挂在 `bottom: 0` 上就比最后一颗按键探出 3px（横屏实测 103 vs 106）。修法不是给键条补内边距，而是让圆盘认这个框：同一查询里 `html.has-keyboard .term__find-open { bottom: calc(3px + …) }`。
2. **键菜单展开时**键条被 `.keymenu__panel ~ .keys:not(.keys--grid)` 藏掉（4.24），面板是八列铺满宽度的——没有翼，圆盘就跟着那行一起消失，`:has(.keymenu__panel)` 收走它，面板关掉就回来。

**用例**。`web/tests/term-find-dock.spec.ts` 六例，`installBridge` 里钉住 `terminal` 镜头，键用「只谎报 `visualViewport.height` 再派发 `resize`」的桥（4.27 那套），断言的是几何关系而不是具体数字：圆盘整个落在键条盒子里、与最后一颗键**同一水平线**（垂直中心容差 3px）、面积 44×40、竖屏圆盘在键右侧、横屏在左侧、320 的角标不被停靠逻辑动到、桌面 1280×800 干脆没有 `.term`（4.29 的紧凑帧门）。同跑 `keymenu-space` + `lens-typing` 16 例全绿，`test:unit` 330/330，`tsc --noEmit` 干净。

这一条对应目标里「更多的要考虑移动端的交互……可显示的空间以及一些快捷 btn 的提供」：手机上每一个**盖在正文上**的浮动控件都在偷空间，而偷来的那 44px 本可以通过「键条是一行，行有两翼」白拿——前提是先把它从被 `overflow: hidden` 关起来的盒子里搬出来。

### 4.32 桌面上那四个词不该浮在字上（`a387869`）

AUTO / WRAP / EXACT / FIT 从 4.4 起就是「贴角的小字」：`position: absolute`、右上 6px、静止 `opacity: .35`，悬停或聚焦才升到 1。手机帧后来被 4.4 改成整宽 44px 的一行（"那四个词要装进 186px"），**桌面帧没动**——因为桌面有鼠标，悬停就能读。

问题出在转录是**追着尾巴滚的**。它一进来就滚到底，第一条可见行永远贴着视口顶；而浮动条就钉在那上面：

| 帧 | 条的位置 | 第一条可见行 | 结果 |
| --- | --- | --- | --- |
| 1280×800 单 pane | `142..162`（24px 高） | `148` | 字从 35% 的条里透出来 |
| 1280×800 双 pane | `164..188`（每 tile 一个） | 同上偏移 | 两个 tile 各糊一块 |
| 1024×768 | 同上 | 同上 | 同上 |

「加内边距」是最先想到的，也是错的。`.scope__scroll` 是 `overflow: auto`，**滚动容器只会把内容裁到它的 padding box，不会把内容排到 padding 之外**：padding-top 只是把第一屏内容往下推，一旦滚起来，内容照样画进那条带子里。实测给 30px 的 `padding-top`，`scrollTop` 拉到 2135 时仍有行盒落在 `top: 139..143`，而条在 `142..162`——差 3px，就是它盖住的那半行。

所以改成**一行真栅格**，和窄帧 4.4 早已在做的同一件事（"the transcript starts below it rather than under it"）：

```
.scope:has(> .scope__scroll) { grid-template-rows: auto auto minmax(0, 1fr); }
```

条进第一行（`position: static`、`justify-content: flex-end`、`padding: 2px var(--pad)`、`opacity: 1`），阻塞提示 `.scope__notice` 进第二行，滚动盒进第三行。`:has(> .scope__scroll)` 是必须的：`.scope--idle` 的占位 tile（`4.17`）没有滚动盒，不能被多出来的空行撑开。

**代价量清了**：1280×800 的 tile 537px 高，滚动盒从 537 落到 512——一条折行，换「静止时和滚到底时都没有字压在控件下面」。`(pointer: fine) and (min-width: 901px)` 是这道门的上沿；900px 以下的细指针窗口仍走粗指针那套整宽浮层（那里本来就是浮的，见 4.4 的取舍：触屏条可以浮，因为它是拇指够得到的整宽一行）。

**用例**。`web/tests/desktop-display-row.spec.ts` 两帧，合成转录 80 行：

- 1280×800 细指针：条可见且 `height < 28`、滚动盒顶沿在条底沿之下、`opacity === "1"`、在顶部和 `scrollTop = scrollHeight` 两处 `.scope__line` 可见矩形都不与条相交（每个行盒先裁到滚动端口再比，否则追尾滚动的行会带着大负值 y 误报）、点 `EXACT` 后 `data-display` 与 `aria-pressed` 成对翻转、`FIT` 可 Tab 聚焦；
- 820×1180 粗指针：条仍是整宽浮层（`width ≥ 800`、`height ≥ 44`、四个面 ≥44×96）、滚动盒顶沿与条顶沿齐平（都是 `137`）、`padding-top ≥ 条高`、页面无横向溢出——这条是**保护**，不许把桌面的行挪给触屏。

同跑 `app.spec` 里六条显示相关用例，其中五条在 390 宽的手机上全部超时失败，但**与本条无关**：紧凑帧早已把 `Scope` 换成 `SessionStage`，手机上根本没有 `#herdr-feed-text` 和 `#herdr-display-*`（`git stash` 掉本条样式后同样失败）。`tsc --noEmit` 干净，`test:unit` 330/330。

这一条对应目标里「UI 你看看……既要考虑 PC 上能够显示得完全」：PC 的问题不是缺功能，而是**控件和正文共用同一块像素**。

### 4.33 手机草稿的首行不该沉到卡片底（`49b2aa0`）

草稿卡有三个状态：静止、打字（软键盘弹起）、短横屏。静止时右边是 2×2 的 36px pad（`4.24`），打字时 pad 折成一行（键盘吃掉高度），短横屏再把 pad 侧折进同一行（卡片 96 → 70px）。三种状态共用一条桌面规则：

```
.prompt__field { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; }
```

桌面上这条是对的：pad 只有一行 34px，草稿两行 44px，底对齐把按钮压在草稿**最后一行**上，卡片上沿留给第一行。手机上它错了——pad 是 74px 的两行，比草稿的 48px 起底还高，底对齐就等于把草稿推到卡片地板上：

| 帧 | field | textarea | attach | 症状 |
| --- | --- | --- | --- | --- |
| 390×844 静止 | `751..825` | `777..825` | `751..787` | 占位文字比按钮低 26px，左上角空洞 |
| 320×568 静止 | `475..549` | `501..549` | `475..511` | 同上，26px |

试过三种候选，只量 `textarea.y`：`end`（现状）777、`center` 764、`start` 751。`start` 胜出的理由不是数字好看，是**它让空出来的那一行有含义**：草稿首行与 attach/image 齐平，下面那行是留给第二行字的书写空间；`center` 则是上下各半块空洞，读起来像排歪了。卡片高度三种候选都是 96px——pad 仍是卡片里最高的东西，所以这个修复不向转录收任何费用。

打字态要反过来：pad 折成一行 36px 后，48px 的草稿又成了最高的东西，居中才让那一行按钮骑在草稿中线上。这需要一条**三个类**的规则，因为 `composer.css:369` 早有一条 `.has-keyboard .prompt__field { align-items: center }`，两个类的窄帧规则写在它后面会赢过它：

```
.shell.is-narrow .prompt__field { align-items: start; }                      /* 静止 */
.has-keyboard .shell.is-narrow .prompt__field { align-items: center; }       /* 打字，三票 */
```

短横屏不用另写：`@media (pointer: coarse) and (max-height: 500px)` 那块的 `.shell.is-narrow .prompt__field { align-items: center }` 在文件末尾，两个类、同特异性、后到，自然压住静止那条。平板（820×1180 粗指针）和桌面（1280×800 细指针）都不是 `is-narrow`，一条都没碰到，仍是 `end`。

**用例**。`web/tests/composer-draft-top.spec.ts` 五例，键盘走真实检测（只改 `visualViewport.height` 再派发 `resize`，由 `PromptBar` 自己挂 `has-keyboard`）：

- 390×844 静止：`alignItems === "start"`、`|textarea.y − attach.y| ≤ 1`、卡片 96、field 74、pad 74 且 `pad.bottom === field.bottom`、草稿 48 且右沿不越过 pad 左沿、field 在卡片里上下等距；
- 390×844 填两行：卡片仍是 96、`textarea.y === attach.y`（长高了不往下沉）；
- 390×844 + 300px 键盘：`center`、pad 折成一行 36、卡片 66、attach 落在草稿的上下沿之间；
- 844×390 静止：`center`、卡片 70、pad 36；
- 1280×800 细指针：仍是 `end`、attach 底沿在草稿底沿之内——这条是**保护**，桌面那条规则不许被手机改动带走。

同跑 `squeeze-rows` / `touch-targets` / `landscape-keyboard` / `desktop-display-row`，共 16 例全过——这三个状态（96 / 66 / 70）都在其中被量过。`tsc --noEmit` 干净，`test:unit` 330/330。

这一条对应目标里「更多的要考虑移动端的交互……只有这一块做好了，移动端才算是真正可用」：软键盘和拇指都到位了，剩下的是**光标该从哪儿开始写**。

### 4.34 长代码行要让人看见「还能滑」（`ec86308`）

上一轮说要修的是「390px 下长代码行被硬裁」，**这个判断是错的**，先纠正：`Markdown.tsx` 里围栏块和逐字块都渲染成 `white-space: pre` + `overflow-x: auto`，一直在滚。用 390×844 量一块 938px 的 TS 行：

| 指标 | 值 |
| --- | --- |
| 块宽 / 可见宽 | 366px（`clientWidth`） |
| 内容宽 | 823px（`scrollWidth`，另一块 708） |
| 可滚距离 | 457px |
| 静止时 `scrollLeft` | 0 |
| 有没有滚动条 | 没有（44px 高的块上一条横条反而碍事） |
| 页面横向溢出 | 无（`documentElement.scrollWidth === innerWidth`） |

所以字一个都没丢，丢的是**信号**：面板边缘把最后一个字切在笔画中间，读起来就是「这一行到此为止」。真机上想读全得先猜到它能划。

**做法**照抄同屏已经成立的那条约定。回答芯片行（`.chat__pick`）早就在用「有内容的那一侧淡出」，它自己又是从 tab 条借来的；一块代码跟一行芯片是同一类东西——超出盒子的横向内容，没有滚动条，唯一的提示是边缘的渐隐。于是：

- `ChatLens` 在 `read.text` 变化后扫一遍 `.chat__code-body, .chat__pre`，按每个块自己的 `scrollLeft / clientWidth / scrollWidth` 算出 `more`（右有字）、`back`（左有字），写进 `box.dataset.edges`；没有就删掉属性。**是属性不是 React state**：一条轨道里可能同时有十几块，每块偏移都不同，而滚动是浏览器自己处理的，一个捕获阶段的 `scroll` 监听（`scroll` 不冒泡，所以只能捕获）就能统一重画，包括下一次渲染才加进来的块。
- `ResizeObserver(lane)` 管旋转和换帧宽——块的宽度随轨道变，轨道的盒子又会随每一个块变，所以盯轨道这一只盒子就够了。
- CSS 侧三对规则（`more` / `back` / `both`），`-webkit-mask-image` 与 `mask-image` 双写。遮罩加在块**自己**身上而不是盖一层渐变：`--ui-panel` 背景归 `.chat__code` 管，遮罩只让字形变淡，块的形状一点不动。

宽度取的是字形量级而不是随手给：块自带 `padding: 10px 12px`，所以右边 36px = 12px 内边距 + 24px 字形（约三个半字符），左边 22px = 12px + 10px（约一个半字符）；一个被切掉一半的字符看起来是「淡出」而不是「坏了」。另外加了 16px 地板：`scrollWidth` 把块自己的 24px 内边距也算进去再取整，一行刚好放得下时也会报 2–3px 溢出（横屏 820 的帧 `clientW 820 / scrollW 823` 就是这样），没有地板就会为了藏 3px 去淡掉本来能读的字。

**实测**（Chromium，`--force-device-scale-factor=2`，取最后 ~50 物理 px 的字形峰值亮度）：

| 状态 | `data-edges` | mask | 末段亮度 |
| --- | --- | --- | --- |
| 390×844 静止 | `more` | `linear-gradient(to right, #000 calc(100% - 36px), transparent 100%)` | 688 → 614 → 500 → 376 → 272 → 53 |
| 390×844 滚到中段 | `both` | 四段：`transparent 0, #000 22px, #000 calc(100% - 36px), transparent 100%` | 两侧都淡 |
| 390×844 滚到底 | `back` | `transparent 0, #000 22px` | 只淡左 |
| 390×844 短块（`npm test`） | 无 | `none` | 不动 |
| 700×800 静止 | `more` | 同上（`clientW 676 / scrollW 823`） | 一样 |
| 844×390 横屏 3px 溢出 | 无 | `none` | 16px 地板生效 |

每个状态下 `webkitMaskImage` 都与 `maskImage` 相同，iOS Safari 走的是同一份规则。滚动时不改块的宽高和右沿（旋转、滚动都没让块跳一格）。

**用例**：`web/tests/code-edge-fade.spec.ts` 四例，桩和别的移动端用例同一套（`herdr:lens:w2:p1=chat`，只读接口全打桩）。

- 390×844 长行：`data-edges === "more"`、mask 含 `calc(100% - 36px)` 且不含左段、`scrollWidth - clientWidth > 200`（先钉住「它在滚」这个前提）、页面无横向溢出、块右沿不越过视口；
- 390×844 短行：`scrollWidth === clientWidth`、无属性、`mask === "none"`；
- 390×844 滚到 `(scrollWidth - clientWidth) / 2` 变 `both`（四段都在），滚到底变 `back`（有 `22px` 没有右段），几何不变，滚回 0 用 `expect.poll` 等回 `more`；
- 700×800 细指针帧：同样淡出（`scrollWidth - clientWidth > 100`）——窄桌面也是这个盒子，不该只在手机上成立。

`tsc --noEmit` 干净，`test:unit` 330/330，新用例 4/4，同跑 `pick-row` 4/4（芯片的 20 / 34px 淡出没被这次改动碰掉）。这一条补的是「长行读不全」这一类：内容一直在，缺的从来只是让人知道它还在。

### 4.35 客户端的输入框不能变成 Agent 的最后一句话（`8ff5ad8`）

`format=ansi` 的可见快照是有边界的：它截到光标所在的那一行，也就是输入框。所以最后几行永远不是 Agent 写的，而是客户端画的。以前这些行大多能靠样式认出来——真 `dim`、真反显、或者 `────` 花边——但换一个客户端就漏：

- **Gemini / `agy`** 把思考过程画成正体灰：`▸ Thought for 5s, 184 tokens`、`○ Thought for 32.3s (working out the rules)`。没有斜体、没有 dim 属性，`isReasoningLine` 的两条判据（`italicShare > 0.15`、`hasDefaultInk`）都不成立，于是它被当成回答正文，折叠里什么都没有，回答尾巴上多了一句「思考了 5 秒」。
- 底部键提示 `? for shortcuts` 和 `esc to interrupt` 同样没有样式标记，读起来完全是 Console 的语气。
- 空输入框本身是**一行裸 `>`**。空行会被 `isPadding` 吃掉，`>` 不会；它进来之后被当成引用块的开头，渲染出一个空的 `blockquote`。

三种「家具」叠在同一个回合：Agent 引用自己的计时、一个空引用块、以及 `? for shortcuts` 作为回答的最后一句。

**为什么不能「灰就是思考」**：`● Ran 7 commands (2.1s)` 也是灰的正体。`○`/`●` 单独出现时既可能是列表圆点，也可能是客户端的工作行，靠颜色永远分不开。唯一的稳定信号是**标记加词**：

```ts
const THOUGHT_MARK_RE = /^\s*[○◌▸▹⟡◇◈●✻✶✳*]\s+(?:thought|thinking|reasoning)\b/i;
const THOUGHT_GLYPH_RE = /^\s*[○◌▸▹⟡◇◈●✻✶✳*]\s+/;
```

两条分开是刻意的：认行用带词的那条，剥标记用只含字形的第二条。第一版把它们合成了一条，`stripThoughtMark` 连 `Thought` 一起吃掉，折叠里剩 `for 5s, 184 tokens`——单测第一次跑就红了（`'for 5s, 184 tokens\n for 32.3s …'` vs 期望的 `'Thought for …'`）。字形该剥，因为它是客户端画的符号；词该留，因为那一行唯一的信息就是「思考了多久、多少 token」。

`CHROME_PATTERNS` 补三条，都带「为什么」的注释：`? for shortcuts`（键提示）、`esc|ctrl+c to interrupt|cancel|stop`（中断提示）、以及**裸** `>` 行。裸很关键：

```ts
function isBareCaret(text: string): boolean {
  return /^>\s*$/.test(text);
}
```

`>` 后面有字是 Agent 真写下的引用——比如 `> 安装 https://github.com/…`，那是它引用用户的指令——必须原样留住。所以只吃掉空的那个。用例里两条都放：一条 `> cannot find symbol: class Pane` 断言仍然匹配 `/^> …$/m`，一条裸 `>` 断言回答不以 `>` 结尾。

**折叠侧零改动**。`WorkBlock` 本来就把 `thoughts` 渲染成一行可展开的 `data-kind="thought"` 行，`total` 也把思考算进计数（`totalWork(counts) + (thoughts.length > 0 ? 1 : 0)`），所以计时行现在住进折叠里，摘要行从「1 file read · 1 action」开始算，不用碰 CSS。

**实测**（`/tmp/probe-agy.mjs`，390×844，真 `agy` 面板，只读）：轨道 innerHTML 现在止于 `<div class="chat__meta" …>`，最后一段正文是 `<p>已成功安装 DietrichGebert/ponytail。</p>`；`.chat__prose` 里没有 `? for shortcuts`、没有 `Thought for`、没有空 `<blockquote>`；折叠摘要 `1 file read · 1 action`。截图 `/tmp/ui/agy-phone.png` 复查：转录干净地停在 meta 行 `● idle 00:07 markdown text`。

**用例**：`web/tests/transcript-hygiene.spec.ts` 三例，桩与 `code-edge-fade` 同一套（`herdr:lens:w2:p1=chat`，只读接口全打桩，夹具是**合成**的——形状抄客户端，文字为本用例所写，因为真面板的原文不该进仓库）：

- 390×844：`prose` 含 `已成功安装 ponytail。`，不含 `for shortcuts`、`Gemini 3.8 Flash · high`、`/Thought for \d/`；`.markdown__quote` 恰好 1 个且含 `安装 ponytail`（裸 `>` 没造出第二个、且是空的）；
- 390×844：`.work__head` 恰好 1 个；打开后（`work__head` → `.work__row[data-kind="thought"] > button`，思考在第二层）`.work__detail-body` 同时含 `Thought for 32.3s` 与 `Thought for 5s, 184 tokens`——**没有被静默丢掉**，只是折起来了，这一点比「不出现」更重要；
- 700×800 细指针窄帧：同样规则，`prose` 含回答、不含键提示。

`tsc --noEmit` 干净，`test:unit` 333/333（含新增三例：灰思考行折进折叠而 `● Ran` 仍算工作行；键提示与中断行被丢掉；裸光标是家具、有字的引用是正文）。同跑 `pick-row` 4/4、`squeeze-rows` 5/5、`desktop-display-row` 2/2。这一条补的是「转录末尾那几行不是人写的」这一类：判据必须落在**词**上，不能落在**样式**上。

### 4.36 回答里的表格该排成表格（`e89d459`）

`Markdown` 的默认判断是「画得出来的就当图」：box 字符、`|` 开头、行内三段以上空白的对齐列，全部逐字进 `<pre>`，且 `white-space: pre`。对目录树、logo、菜单这是对的——终端里唯一的排版就是坐标。对表格是错的：表格有列，列有名字，名字才是那格的意思。

真 devin 面板 `w2N:p5` 的一份回答就是三列表（`问题 / 证据 / 建议`），量出来 `scrollWidth` **1464px**、容器 **366px**：横向滑四分之三才看到第三列，而表头早滑出去了，读者看见的是「建议每个版本留一天只修 Bug」却不知道它在哪一列。这不是「样式不好看」，是**信息在手机上没有入口**。

**判据必须落在结构上，不能落在「像不像表格」**。纯 `|` 也算不出表格：diff 的 `+`/`-`、`||` 并集、markdown 里的竖线都能长成一行。所以 `web/src/lib/table.ts` 只认两种封闭形状：

- **盒子表**：`┌─┬─┐` 开框、`├─┼─┤` 分隔、`└─┴─┘` 闭框、`│ … │` 行；开框、闭框、每一行的列数必须相同，且**各列宽度在框线里必须一致**（左边框、每根 `┬`、右边框的 x 坐标逐行对齐）。这条宽度判据就是 logo 框与目录树的防火墙——它们也是 box 字符，但右边界不在同一列。
- **竖线表**：表头 + `|---|` 分隔 + 数据行，列数一致；`\|` 是转义、不切列，所以 `README 支持 GitLab\|Gitea` 仍是一格。

不成立就**原样退回**：切分器只把散文按字节留给 `Markdown`，一处不符就整段不动，`table.test.ts` 用「logo 框 + 树」钉住这条分支的字节不变（这正是 4.34 修过的那些块的邻居，不能为了新功能回退）。被面板裁掉右框的行同理——宁可当图，也不要把半行当列。

**渲染**：`web/src/components/session/AnswerProse.tsx` 里 `AnswerProse` 拿 `splitTables` 的段落，表格段出真 `<table>`（`thead` + `th scope="col"` + `td data-label="列名"`），散文段仍交给 `Markdown`；`TurnList` 的回答体换成它，复制按钮仍复制 `turn.answer` 原文（复制的是 Agent 说的话，不是渲染结果）。宽轨道是正常表格：无外框、行间 1px `--ui-border`、表头用 `--ui-label` + `--step-label` 字号，读起来是图注而不是加粗正文；第一列不给 `padding-left`，与上面的段落左缘对齐。

**560px 以下是卡片**：`@media (max-width: 560px)` 里 `table/thead/tbody/td` 全 `display: block`、`thead` 藏起来、`tr` 变 flex 列并带 `gap: 5px` 与行间 `border-top`；`td::before` 用 `content: attr(data-label)` 印出列名（CSS 看不见已藏掉的 `th`，所以列名必须随格子进 DOM）。空格子 `td:empty` 整格不显示——真面板第一行第一格被裁成空，只印「问题」再跟个空行是噪声。`td[data-label=""]` 也不印标签，兼容没有表头的表。

同一套淡出规则扩到表格：`ChatLens` 的 `data-edges` 扫描选择器加 `.chat__table`，三组 `mask-image` 各加一个选择器——宽轨道上列多到要滑的时候，和代码块一样在右缘淡出 36px（左 22px），滑到端点即收。

**用例**：`web/tests/box-table.spec.ts` 两例，夹具是**合成**的（形状抄真面板，文字本用例自己写，因为被裁的单元格原文不进仓库）：

- 390×844（`hasTouch`/`isMobile`）：`.chat__table` 恰好 1 个、`thead` 不可见、`tbody tr` 2 行、`td[data-label="证据"]` 首行含 `server.go 2222 行`（原框里那格是折成两行的）、表格含 `留一天修 Bug` 与 `大文件`、`.chat__pre` 0 个、`documentElement` 不横滚、前言两句都还在；
- 719×844：`thead` 可见、`th` 3 个且第二个是 `证据`、2 行数据、卡片布局未触发、无 `.chat__pre`、页面不横滚。

`tsc --noEmit` 干净，`test:unit` 341/341（新增 `table.test.ts` 8 例：盒子表含折行格、竖线表、`\|` 转义、logo 框 + 树逐字不变、右框被裁、只有表头的盒、无分隔行的竖线、纯散文原样）。同跑 `transcript-hygiene` 3/3、`code-edge-fade` 4/4。真 devin 面板复查：390×844 与 719×844 都只剩 1 个 `.chat__table`、`scrollWidth == clientWidth`（366 / 695），页面 390/390 与 719/719 不横滚。

### 4.37 折行是终端的，句子是 Agent 的

面板宽度决定一行在哪断，Agent 决定一句话在哪断——两者混在一起，手机上的回答就读不成段。证据是 devin 面板 `w2N:p5` 的原始行：一段话的每一行都正好量到 196–200 列，而真正结束段落的行只有 60–90 列；这两类行在文本里长得一样，都是「一行字后面跟一个换行」。

**判据落在宽度上，不落在标点上**。只看句号会把 `server.go:1780-1794 (file:///…)` 这种正好在换行列上的引用当成句尾——实测第 0 回合里 198 列的行有 9 行以 `…)` 结尾，它们全是一个折行的前半。所以 `reflowProse` 先量出这份回答的换行列 `wrap`（所有行里最宽的显示列数，地板 72 列，因为窄回答不该被拼回），"上一行宽度 > `wrap - 10`" 才算折行；只有「上一行短 + 以 `。！？…：` 结尾」才算段尾，补一个空行。10 列的宽容度是给「刚好差几个字就换行」的行留的，同时也是防止把短句连成一段的闸门。

**接缝处的空格是语言问题**，不是格式问题：两侧都是 CJK 字形时不加（`功能测试`），否则加一个（`the measured width of the lane.`、`调用 API`），全角标点任何一侧都不加（`、`、`：`），被切断的 token（`/`、`(`、`-`、`_`、`@` 结尾）不加。

**devin 的裸标题**：它把 `###` 标题印成一行纯文字、上下不一定有空行，于是「占满换行列的一段话」接上「项目深度评审结论」会被拼成一句。补一条：短（≤ 28 列、且不超过半个换行列）、无句末标点、无 ASCII 字母数字标点（排除路径、代码、`Pro · 46% remaining (resets in 15h 47m)` 这类用量行）的行，单独成段。真面板复查：`项目深度评审结论` 现在是独立一段，`(file:///Users/gouki/server/ide/…)` 完整不断开。

**用例**：`web/tests/prose-reflow.spec.ts` 四例，夹具是**合成**的（形状抄真面板，文字本用例自己写，因为被裁的单元格原文不进仓库）：390×844 手机帧下断言「功 能」的被切断处被接回、英文折行接回、围栏代码块三行原样、两条列表项各自成项。`prose.test.ts` 14 例覆盖规则本身，含幂等。

`tsc --noEmit` 干净，`test:unit` 355/355（`prose.test.ts` 新增 14 例），`prose-reflow` 4/4，同跑 `transcript-hygiene` 3/3、`box-table` 2/2、`code-edge-fade` 4/4。真 devin 面板复查：390×844 下 5 段 `.chat__prose` 合计 10562px（轨道 `scrollHeight` 11640 / `clientHeight` 603），段首不再粘在一起，`项目深度评审结论` 独立成段，`file:///Users/gouki/…` 不再断成两半。
