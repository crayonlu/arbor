# Arbor TUI 设计文档（M6.5）

> 状态：**已实现**。本文档与 `packages/tui/src/` 实际代码对齐（非早期设想）。
> 视觉预览：`packages/tui/storybook.html`（HTML mock，配色与布局参照，非运行时）。
> 约定：**TUI 内所有提示文案、代码、注释均为英文；少写注释。** 文档本身用中文以便 review。

## 1. 目标与定位

- pi 级别的紧凑信息密度，但在 diff、thinking、subagent 展示上更强。
- 单进程、library-first；CLI/TUI 跑 **Bun**（OpenTUI 原生 FFI 需 `Bun.dlopen`，Node 无 `node:ffi`）；core 仍 `node:test`。
- 渲染底层用 `@opentui/core` 命令式 API（`BoxRenderable`/`TextRenderable`/`MarkdownRenderable`/`DiffRenderable`/`InputRenderable`/`ScrollBoxRenderable`/`SelectRenderable` + `createCliRenderer`），**不手写终端底层**，不用 ink/JSX。
- 全键盘操作，**无鼠标/点击交互**。

## 2. 包结构 `packages/tui/src/`

| 文件 | 职责 |
|---|---|
| `index.ts` | barrel：`runTui`、`createTuiApp`、`SessionModel`、`darkTheme`、`createTuiExtensionUi` 等 |
| `app.ts` | `createTuiApp` + `runTui`：装配布局、订阅 `session.subscribe`、reconcile 渲染、按键路由、视图切换、slash 派发 |
| `event-bridge.ts` | `AgentEvent` → `SessionModel`（流式文本/thinking、tool 块、subagent thread、usage、job 通知） |
| `theme.ts` | `ArborTheme` 接口 + `darkTheme` + `buildSyntaxStyle()`（tree-sitter 配色） |
| `icons.ts` | 图标常量（Unicode 几何，非 emoji） |
| `ui-context.ts` | `TuiExtensionUi`：`ExtensionUi`（notify/confirm/input/select/ask）映射到终端浮层 |
| `components/thinking.ts` | 流式 tail（maxHeight，老内容顶出顶部，常驻截断） |
| `components/todo-panel.ts` | 持久 todo 面板（单列，常驻，live，逐行 fg） |
| `components/tool-block.ts` | 工具块（header + body；bash 背景色成败；edit→diff 由 app 注入） |
| `components/subagent.ts` | 内联 subagent 块（带边框）+ 只读 thread 视图 |
| `components/command-palette.ts` | `/` 触发，分类 + subsequence fuzzy，键盘选择 |
| `components/status.ts` | 状态栏：model · mode · view · running · tokens · cost · jobs · queued |

> 注：早期设想的 `terminal.ts`/`layout.ts`/`view.ts`/`components/message.ts`/`markdown.ts`/`diff.ts`/`input-bar.ts` 未单独成文——renderer 生命周期、布局、视图切换都在 `app.ts` 内，消息/markdown/diff 用 OpenTUI 内置 renderable 直接组合，避免无谓拆分。

## 3. 布局

自上而下，**左右 padding 统一为 1 cell**（`ScrollBox` paddingLeft/Right:1），**无 header**（状态栏承载 model/mode/view/usage/jobs）：

```
┌ scrollback（左对齐，无 icon rail）
│   user input（底色，无标签）
│   assistant markdown（流式）
│   thinking tail（边框 dim，常驻截断）
│   tool 行（name + args + 状态；bash 背景色；Ctrl+O 展开）
│   edit → DiffRenderable（split/unified）
│   subagent 块（边框，Ctrl+T 切入其会话）
│   sys 行 / job notice
├ todo（持久面板，单列，常驻 live）  ← subagent 视图下隐藏
├ input bar（淡背景；运行中 queued 提示）  ← subagent 视图下隐藏（只读）
└ status bar（model · mode · view · running · jobs · usage）
```

- **无 user/assistant 文字标签**：用户输入用半透明底色区分；assistant 用 markdown 纯文字。
- **边框极简**：只有 **diff**、**thinking tail**、**subagent** 保留 single 边框；其余靠底色/间距分隔。
- **无 chevron（▸▾）**：tool 行用紧凑一行（name + args + 状态），展开/折叠走 `Ctrl+O`。

## 4. 主题（dark，pi 系色板，变量化）

偏暖中性、**非蓝主调**（参考 pi：teal accent、橄榄 success、金 warn、哑红 error）。底色不透明，面板/输入/状态为低 alpha 叠层。颜色集中于 `theme.ts` 的 `ArborTheme` 接口 + `darkTheme` 对象（非 CSS 变量——那是 HTML storybook 的产物；运行时是 TS 对象，后续 light/高对比主题只需新增同接口的对象）。`#rrggbbaa` 8-hex 带 alpha（OpenTUI 不接受 `rgba()` 串）。

```
bg       #141418        底（不透明，暖中性）
bgPanel  #b4bcc8@.05    面板叠层
bgInput  #b4bcc8@.07    输入框
bgUser   #b4bcc8@.06    用户消息底
bgRun    #f0c674@.06    运行态
bgQueue  #f0c674@.05    队列提示
border   #b4bcc8@.14    borderDim @.08
text #d4d4d4  muted #808080  dim #666666
accent  #8abeb7   teal（主强调，非蓝）
success #b5bd68   olive
warn    #f0c674   gold
error   #cc6666   muted red
info    #81a2be   muted blue-gray（仅 paths/links）
think   #9575cd   purple
addFg #b5bd68 / addBg #b5bd68@.10   delFg #cc6666 / delBg #cc6666@.10
codeBg #000000@.25
syntax: kw #569CD6 · str #CE9178 · fn #DCDCAA · com #6A9955 · num #B5CEA8 · typ #4EC9B0
```

## 5. 图标系统（极简，看 pi）

**icon 不是越多越好**。仅保留必要图标，Unicode 几何/dingbat，非 emoji。v1 为**静态**图标（无脉冲动画——加载态用静态 `●` + 文字 `running`；动画留 future）。

| 图标 | 字形 | 用途 |
|---|---|---|
| load | `●` | 运行中（状态栏/输入） |
| done | `✓` | todo 已完成 |
| pending | `○` | todo 待办 / 选择项 |
| prompt | `❯` | 输入提示符 / 队列提示 |
| bullet | `●` | todo 头计数 / 通知 |

tool 名用 `text` 色；**命令成败不用图标，用工具块背景色**（见 §8）。thinking / subagent / 模型切换用文字标签，不配图标。

## 6. 字体

- 文本：等宽字体即可（OpenTUI 用终端字体渲染）。推荐 JetBrains Mono / Nerd Font，但**不依赖**——图标用 Unicode 几何。README 注明推荐字体。

## 7. 输入交互（状态机）

Enter / Esc 语义随当前状态变化。**全键盘**，无点击。

| 状态 | Enter | Esc |
|---|---|---|
| 空闲（未运行） | 发送，启动 agent | — |
| 运行中 · 无队列 · 有输入 | 入队 steering（下个 turn 注入） | 清空输入 |
| 运行中 · 无队列 · 空输入 | 打断 abort | — |
| 运行中 · 已入队 | 打断（abort + 丢弃队列，`clearSteering`） | 撤回入队消息 |
| 刚发送 · 模型未产出 | （运行中） | **rewind**：abort + 空闲后 rewind + **输入框自动填回该消息**（可编辑重发） |
| 任意 | | `Ctrl+C` abort + quit |

- rewind 判定窗口：本 turn 首次出现 assistant `message_start` 之前（用 `message_start` role=assistant 关闭窗口）。一旦产出，Esc 不再 rewind，退化为清空输入。
- rewind **静默执行**（移除消息 + 回填输入框，无可见提示行）。
- 其余快捷键：`Ctrl+O` 展开/折叠 bash 截断输出（全局 toggle）；`Ctrl+T` 循环切换 main ↔ 各 subagent 视图；`/` 打开命令面板；`↑↓` 选择；`Enter` 派发。

## 8. diff / 代码高亮 / 工具状态

### 代码高亮
- 用 **OpenTUI 内置 tree-sitter**：`MarkdownRenderable`（代码块）、`DiffRenderable` 都自带语法高亮（`SyntaxStyle.fromTheme` + tree-sitter）。`runTui` 里 `getTreeSitterClient()` + `initialize()`；headless 测试渲染器跑不了 worker，故测试不传 client（真实 TUI 才 init）。

### diff（屏宽自适应）
- 宽 ≥100 列：**split**（左右 old/new 对照）。
- 宽 <100 列：**unified**。
- 按终端列数自动切换（`renderer.width >= 100`）。`/display diff split|unified` 可手动覆盖。
- edit 工具结果默认渲染为 `DiffRenderable`（非纯文本）。
- **bash 大输出 clamp**：超出 8 行干净截断为尾部，顶部一行 `… (+N lines, Ctrl+O expand)`；`Ctrl+O` 全局 toggle 展开全部。bash 输出始终显示（clamp），不隐藏。diff 不 clamp。
- 增删低饱和着色 + 行号 + hunk 头暗色。

### 工具状态（背景色，不用图标，参考 pi）
**仅 bash 命令**用工具块 header 背景色表示成败；read/write/edit **不着色**（edit 的 diff 增删色是信号，不叠状态底色）：
- bash 成功：olive tint `addBg`
- bash 失败：red tint `delBg`
- bash 运行中：gold tint `bgRun`

状态文字（`done` / `exit 1` / `running`）随背景，**不用 ✓/✗ 图标**。

## 9. thinking（流式 tail，常驻截断）

- 带细边框、淡色（标签紫 `think`，正文 dim）。
- **流式 tail**：限高 6 行，新内容从底部进入，**老内容被顶出顶部不可见**；截断时标签显示 `thinking  ↑ older scrolled off`。
- **无展开**（Ctrl+O 留给工具输出）；thinking 始终截断尾部。
- thinking 取自 assistant message 的 `thinking` content block（`message_update` 累积）。

## 10. todo（持久，单列）

- 钉在 scrollback 与 input 之间，**常驻可见、live 更新**（参照 Claude Code）。
- **单列**展示，逐行独立 fg。带 `● todos  2/4` 计数头。
- 数据源：`session.todos.get()`（core `TodoStore`），每次 render 读取。
- done `✓`（success）/ in_progress `●`（accent）/ pending `○`（dim）。
- 空列表时面板折叠为空（不占行）。

## 11. subagent（内联 + 可切换会话，支持并行）

- 对话区内联块（**无侧边栏**），带边框，title = `<agent>  <status>  <N> tools  ❯Ctrl+T`，body 显示最新一条 assistant 文本或 tool 摘要。
- **并行 subagent**：一个 turn 内多个 `task` tool call 并发执行（core `executeToolCalls` 并发），各自一个内联块。
- **可切换会话视图**：`Ctrl+T` 在 main 与各活跃 subagent 之间循环；切入 subagent 后，**会话区换成该 subagent 的 transcript**（其 text/tool 行，按 thread 顺序），**只读**——input/todo/queue 隐藏，底部一行 `❯Ctrl+T back to main   <label>`。切回 main 恢复输入。
- **thread 数据**：core `task` 工具经 `onUpdate` 上报有序 `SubagentThreadItem[]`（text + tool）+ `streamingText`；event-bridge 落到 tool item 的 `thread` 字段；`SessionModel.subagentThreads()` 列出可切换的 thread。
- **无 progress bar**（步数未知，不造假 %）；仅状态文字。
- 状态栏 `view: main` / `view: agent:<name>` 标识当前视图。

## 12. 命令面板（`/`）

- 输入框首字符为 `/` 时打开浮层（`SelectRenderable` + 自管 query 行）。
- **subsequence fuzzy** 过滤 `category name description`，按 category rank 排序。
- 选中 `Enter` 派发 `/<category> <name>`；`display diff/expand/theme` 由 TUI 本地处理（切 diff 视图/全局展开），其余经 cli 的 `executeSlashCommandTui`（双 handler）执行。
- 命令清单由 cli `listCommands(session)` 提供（builtin + extension），经 `runTui({commands, runCommand})` 注入。

## 13. ExtensionUi 浮层

- `createTuiExtensionUi()` 实现 `ExtensionUi`：`confirm`（Yes/No）、`input`（InputRenderable）、`select`/`ask`（SelectRenderable，ask 支持 multiSelect + Space 勾选）、`notify`（toast）。
- 单个绝对定位浮层（高 zIndex）承载当前提示；app 按键先交给 `extensionUi.handleKey`，消费则不下行。
- cli `runInteractive` 创建该 ui，既作 `buildSession({ui})` 注入 AgentSession（启用 ask 工具），又作 `runTui({extensionUi})` 挂载到 renderer；并作为 `TuiCommandHook` 传给 slash 派发。

## 14. 工程约定

- TS strict + `erasableSyntaxOnly` + `exactOptionalPropertyTypes` + `verbatimModuleSyntax`；biome tab/110 列。
- **TUI 内所有可见文案英文**；代码与注释英文；**少写注释**（只写非显然的 why）。
- 运行于 Bun；`@opentui/core` 精确版本。
- tui 包仅在 interactive 模式被 cli 动态 import；headless 模式不加载原生插件。
- 测试：`bun:test`；用 `createTestRenderer` + `captureCharFrame` 做渲染快照（app/subagent/todo/thinking/palette），纯逻辑用普通断言（event-bridge）。
- 不做：鼠标/点击、侧边栏、permission/sandbox、client/server、图片/kitty/latex、图标脉冲动画、窄屏 compact diff 三档（v1 仅 split/unified 两档）。

## 15. 验收

- `arbor`（interactive）跑通：流式 markdown、tool 块、edit→diff（split/unified 自适应）、thinking tail、持久 todo、subagent 内联 + Ctrl+T 多 agent 切换（并行）、输入状态机（queue/interrupt/rewind 回填）、Ctrl+O 展开、`/` 命令面板、ExtensionUi 浮层。
- `npm run check`（tsc 三包 + biome）干净；`npm test`（core/cli node:test + tui bun:test）全过。
