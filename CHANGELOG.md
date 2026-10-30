# Changelog

本文件记录对外可见的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.4.0] - 2026-10-30

### 功能

- **保真闸（S1）**：改写前从草稿里提取硬事实——反引号片段、URL、文件路径/带扩展名的文件名、语义化版本号（最多 40 条）——改写结果里必须逐字保留，否则整次调用按失败处理、结果不写回草稿，错误文案列出缺失项（最多 5 条），日志 `reason=fidelity fidelity=missing:N`。可用 `fidelity: false` 关闭。
- **长度闸（S1）**：草稿 ≥80 字符时，结果超过 `maxExpansionRatio`（默认 2.5x）即拒绝，避免模型把一句话扩成两千字模板；日志 `reason=too-verbose expand=<实际>><上限>`。上限可在 `1–6` 之间配置。
- **引用 chip 保护（S2）**：`InputState.occurrences` 非空说明草稿里有 `@文件`/引用 chip，整段改写会把 chip 抹成纯文本——此时按钮禁用并说明原因，点击不发请求。
- **可选预览（S3）**：`Alt+Shift+点击` 只取结果、不写回草稿，改在输入框下方（`conversation.composer.dock` 槽）显示预览卡（标题 + 字符差 + 正文 + 「采用/放弃」）。默认关闭，普通点击行为完全不变；预览期间不留回退点，采用后用既有的回退箭头仍可回到原文。
- **模型覆盖 + 总开关（S5）**：`Config` 新增 `enabled`、`provider`、`model` 三个键。`enabled: false` 让按钮直接返回「已被插件配置禁用」；`provider` 与 `model` **同时**填写时本次调用改用该模型（日志 `modelSource=config`），只填一个则忽略以免半覆盖导致 404。
- **真模型回归（S4）**：新增 `test/live.mjs`（`npm run test:live`），未设置 `DEEPSEEK_API_KEY` 时打印跳过并退出 0，配置后跑三条用例：中文进中文出且不过度扩写、硬事实逐字保留、已清晰的草稿只做轻度润色。

### 变更

- **包名 `dsh-enhance-prompt` → `dsh-composer-enhance`**：`dsh-enhance-prompt` 在 npm 已被占用（`github.com/adcx222/dsh-enhance-prompt`，2026-10-20 收录于 awesome-dsh-plugin 目录），改名以避免市场与 npm 撞名。
- `engines.dsh` 由 `^0.2.0-rc.2` 改为 `>=0.2.0-rc.2 <1.0.0`：semver 的 `^0.2.0-rc.2` 因预发布语义**不包含** 0.3.x（实测 `satisfies('0.3.0','^0.2.0-rc.2')` 为假），区间写法能同时容纳 0.2.x 与 0.3.x。
- `Config` 由 7 键扩到 12 键（新增 `enabled` / `fidelity` / `maxExpansionRatio` / `provider` / `model`），全部只声明类型与默认值，范围钳制仍在 `readOptions()`。
- 一次点击的对外语义不变（普通点击=整段、再点=回退、增强中=取消、Ctrl/⌘=局部、Alt=本次不带历史、Shift=本次带全部）；新增的 `Alt+Shift` 是唯一的组合键变化，且只影响预览。

### 工程

- 宿主半检查 49 → 57 项（保真闸命中/放行/可关、长度闸拒绝/短输入豁免、总开关、模型覆盖与半覆盖、Config 12 键），浏览器半 27 → 31 项（chip 禁用与不发请求、预览不写回、预览卡采用后清空、三条新错误文案本地化）。
- 新增 `test/live.mjs`、`README.en.md`、`.github/workflows/ci.yml`（Node 20/22 矩阵：`npm run check` + `npm test`）、`npm run check` 脚本。
- 无新增运行时依赖（仍是 `@deepseek-ai/schemastery` 一个）。

## [0.3.1] - 2026-10-29

### 功能

- **一次点击 = 一根 `req=` 串起两端日志**：浏览器半生成 6 位 base36 关联 ID，随 v2 载荷的新增可选字段 `id` 传给宿主；两端都用同一个值打日志。定位问题时只需在浏览器 console 与宿主 console 各 grep 一次 `req=xxxxxx`。旧载荷没有 `id` 时宿主自己补一个。
- **成功路径也有结构化日志**：每次调用固定一行 `req=<id> ok|fail reason=<code> ms=<n> provider=… model=… finish=… in=/out=/reasoning=… text=<长度> history=<reason>/<kept>of<total> historyChars=… historyMessages=… maxTokens=…`。以前成功路径一行日志都没有，只有失败/异常才留痕。
- **历史诊断字段补全**：`historyContextFor()` 的返回值新增 `messages`（参与挑选的纯文本消息条数）与 `requested`（本次是 `off` / `auto` / `all` 哪一种），并在日志里以 `historyMessages=` 与 `history=` 的形式暴露——"为什么没带历史"现在能区分关掉、无会话、读失败、为空四种状态并看到条数。

### 修复

- **载荷自识别，避免把明文解成乱码**：`decodeRequest()` 改为先按 base64url 前缀 `eyJ2Ijoy`（`{"v":2`）判定 v2，再对 v1 兼容路径做"解出来再编码回去逐字节一致"的校验。像 `abc-123` 这种**全由 base64url 字符组成但解码不是合法 UTF-8** 的输入，以前会被当成 base64 解出乱码并当草稿送改写，现在按非法载荷处理、走既有的空输入文案。
- **连点/双击不再发起第二次模型调用**：`start()` 与 `startPartial()` 入口加了 `controllerRef` 重入闸门。`onClick` 读的是渲染期闭包里的 `enhancing`，渲染还没刷新时连点会各起一次请求、由后写覆盖前写；现在第二次 click 直接忽略（增强中点击仍是"取消"，语义未变）。
- **客户端兜底超时**：`withClientTimeout()` 用 `AbortSignal.timeout(65000)` + `AbortSignal.any` 给每次调用包一层比宿主 `timeoutMs`（默认 60s）略长的定时信号。桥接/RPC 永不结算时按钮不会再一直转圈，文案复用既有的「增强超时，请重试」，日志 `reason=client-timeout`。`AbortSignal.timeout/any` 缺失时退化为只透传取消信号，不引入新失败路径。
- **载荷上限护栏**：`client.js` 新增 `MAX_PAYLOAD_CHARS = 65536`，命令行超过上限时在发起 RPC 之前就报「内容过长」（复用既有 `action.tooLong` 文案），不再把超长命令丢给桥接层。

### 变更

- 不改对外行为、不改 Alt/Shift/Ctrl 语义、不改 `conversation.input.right` 槽位与 `order`、不改既有错误文案措辞、不改 v2 载荷既有字段语义（`id` 是新增可选字段）。日志一律走 `console.info`，宿主侧仍不引入 logger 服务。

### 工程

- 宿主半检查 43 → 49 项（id → `req=` 对齐、无 id 自动补、成功路径字段完整性、失败路径 `reason=`、v1 兼容与"合法 base64 字符的明文"、历史诊断字段三态），浏览器半 24 → 27 项（连点只发一次、载荷带 6 位 id 且 console `req=` 与载荷一致、局部增强同样带 id 与重入锁）。
- 新增测试用的 `tick()`/`makeProps` 复用，无新增依赖。

## [0.3.0] - 2026-10-29

### 功能

- **局部增强（`Ctrl+点击`／macOS `Cmd+点击`）**：只把选中的片段发给模型，结果用 `inputActions.insertText(text, span)` 写回选区——它是编辑器的一次独立撤销操作，回退交给 `Ctrl+Z`。认定选区要两路证据同时成立：① 编辑器自认有选区（`captureInsertion()` 的 span 非折叠）；② 浏览器 Selection 落在可编辑区、`toString()` 非空、文本能在草稿里找到、长度与 span 对得上。任一不成立就**静默退回整段增强**；`insertText` 返回 false（span 过期／正在提交／只读）时一个字符都不动，只报「草稿在增强期间被改动」。普通点击与既有的 Alt／Shift 历史语义完全不变。
- **导出 `Config` schema**：用 `@deepseek-ai/schemastery` 声明 7 个可调项（`temperature` / `maxTokens` / `timeoutMs` / `history` / `historyTurns` / `historyMaxChars` / `historyPerMessageChars`）的类型与默认值。插件管理器与 Config Inspect 现在能把这些配置投影成表单（`isNativeConfigSchema` 要求的 `Symbol.for('schemastery')` 品牌、`type` 字符串、`meta` 对象三项都满足）。

### 变更

- `dependencies` 新增 `@deepseek-ai/schemastery: ^3.18.5`（`dependencies` 里唯一的运行时依赖；`peerDependencies` 的 7 个 dsh 包与 react 保持不变）。它是**可选的**：解析不到时 `Config` 为 `undefined`，cordis 视作 absent，插件照常加载，行为回落到 0.2.x。
- schema 只声明**类型 + 默认值**，不做范围钳制：越界值仍由 `readOptions()` 收敛，所以"值越界"照旧静默回落；只有"类型写错"（例如 `maxTokens: "2048"`）才会让插件激活失败——这是导出 schema 的必然代价，已写进 README 已知限制。
- `cordis.patch.yml` 的 config 内容未变；按钮 tooltip 增加一行「`Ctrl+点击` 只增强选中文字」，`aria-label` 仍只报状态（读屏不念长说明）。

### 工程

- 宿主半检查 40 → 43 项（`Config` 原生 schema 判定 / 默认值与 `readOptions()` 一致 / schema 不做范围钳制 / `dependencies` 断言），浏览器半 20 → 24 项（局部成功、`insertText` 被拒、无选区退回整段、选区不在草稿里退回整段）。
- 测试仍只用 Node 标准库；`test/verify-manifest-yaml.mjs` 的 yaml 解析器现在会从插件自己的 `node_modules` 解析（装了依赖之后才存在），没有依赖时仍自动 SKIP。

## [0.2.1] - 2026-10-29

### 修复

- **`Enhance prompt: empty result.` 的根因可判**：流式循环新增采集 `finish.reason` 与 `usage`，空结果日志现在写明结束原因与输入/输出/思考 token 数。
- **思考型模型吃光输出预算**：`DEFAULT_MAX_TOKENS` 1024 → 2048（思考 token 也计入 `maxTokens`，1024 时常见"思考用完、正文为空"）。`cordis.patch.yml` 与默认值同步。
- `finish.reason === 'max-tokens'` 且无正文时，不再笼统报 `empty result`，改为 `Enhance prompt: model ran out of output budget (max-tokens, maxTokens=N).`，界面显示「模型的输出额度被思考过程用完了，请重试或提高 maxTokens」。
- 适配器用**终止性 `finish` 块**（`error` / `aborted`）报错时不抛异常的情况现在被识别为 `Enhance prompt failed: model stream ended with <reason>.`，不再误报成"模型没有返回可用内容"。
- 有正文但 `finish=max-tokens`（被截断）时仍然成功返回，同时留一行"结果可能被截断"的宿主日志。

### 变更

- 每次点击都打一行 `history: <reason>` 日志（`off` / `no-session` / `derive-failed` / `empty` / `ok`）。以前只在成功带到历史时打日志，无法区分"关掉了"和"读不到"。

### 工程

- 宿主半检查 36 → 40 项（max-tokens 文案、finish=error、截断警告、history reason 日志），浏览器半 19 → 20 项（预算错误本地化）。

## [0.2.0] - 2026-10-27

### 功能

- 改写时把**本会话最近的对话**作为语境一起发给模型，依赖上下文的草稿（「再详细一点」「换个说法」）能改对。
- 历史取值：`agent.session.deriveMessages()` 的已提交消息（已应用压缩/替换的当前活跃对话），不含当前草稿。
- 截取策略：默认最近 3 轮 → 单条超 800 字符做头 40% + 尾 60% 裁剪 → 仍超 3000 字符则整轮丢弃最旧的一轮（不留孤儿助手回复）。
- 触发与开关：默认每次点击都带；`Alt+点击` 本次不带、`Shift+点击` 本次带全部轮次；`cordis.patch.yml` 新增 `history` / `historyTurns` / `historyMaxChars` / `historyPerMessageChars`。
- 无历史、读不到历史（`deriveMessages()` 抛错）都静默降级成"只改草稿"，增强本身不会失败；带了历史时宿主日志会打一行 `history: N/M turns, X chars dropped …`。

### 变更

- Client→Host 载荷升级为 v2 JSON `{ v:2, text, history? }`；宿主仍兼容 v1 的"纯草稿明文"载荷（`decodePayload` → `decodeRequest`）。
- `prompts.buildUserPrompt(input, historyContext)` 多了一个可选参数，不传时输出与 0.1.0 逐字节一致。

### 工程

- 宿主半检查 27 → 36 项（新增历史选取、预算丢弃、裁剪、非文本块过滤、失败降级、config 收敛），浏览器半 17 → 19 项（v2 载荷、修饰键），`cordis.patch.yml` 结构与 `readOptions()` 逐键一致。

## [0.1.0] - 2026-10-12

首个版本。

### 功能

- 在输入框发送键左侧新增「增强提示词」按钮：一次模型调用把当前草稿改写成更清晰、更具体的提示词并写回。
- 运行中可再次点击取消；写回后可一键回退到原文；手动修改过结果后回退按钮自动消失。
- 中英双语界面文案，随 DSH 语言自动切换；宿主失败文案按界面语言本地化。
- 宿主侧模型调用超时（默认 60s，可在 `cordis.patch.yml` 调整），温度、最大 token、超时都做了越界回落。

### 实用性与健壮性

- 结果清洗会去掉模型自作主张加的 `Enhanced prompt:` 之类 label，以及恰好包住全文的 markdown 围栏（正文里本就存在的代码块不受影响）。
- 结果长度上限随原文放宽：`min(8000, max(1600, 原文长度))`，长草稿不再被截断到 1600 字符。
- 按钮在 `mousedown` 时阻止默认行为，不再抢走输入框焦点，中文输入法组词不会被中断。
- 失败原因同时写进 `title` 与 `aria-label`；改动草稿后失败提示自动清除。
- 会话切换时立即中止上一个会话仍在进行的请求，结果不会写进新会话草稿。
- 请求期间用户继续输入时，增强结果不再覆盖新内容，改为提示重试。
- 用户取消不写日志；模型报错、超时、空结果会写一条带统一前缀 `[dsh-enhance-prompt]` 的宿主日志。
- 草稿只有空白字符时按空输入处理；桥接异常、未知命令都有明确且本地化的提示。

### 工程

- `engines.dsh` 声明宿主版本区间（插件市场据此显示兼容性）。
- `test/` 下三个零依赖离线验证脚本（宿主半 27 项、浏览器半 16 项、引导期 YAML 1 项），`npm test` 一次跑完。
- `prepublishOnly` 在发布前对三个 JS 产物做语法检查。

[0.1.0]: https://github.com/OWNER/REPO/releases/tag/v0.1.0
