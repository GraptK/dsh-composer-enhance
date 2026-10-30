# dsh-composer-enhance

DSH（DeepSeek Harness）插件：在输入框发送键前加一个「增强提示词」按钮。点一下，把当前草稿交给**一次**模型调用改写成更清晰、更具体的提示词并写回输入框；过程中可取消，写回后可一键回退到原文。

按钮只做一件事——**改写，不回答**。它不替用户执行任务，也不改变用户的原意，只把草稿补成一段可以直接发送的完整请求。

- 宿主半：注册一个 session 命令，取当前默认模型（或 `Config` 覆盖的模型）→ 读本会话最近对话作语境 → `llm.stream()` → 保真闸/长度闸 → 清洗 → 返回文本
- 浏览器半：`conversation.input.right` 槽里的一个按钮，读/写草稿、取消、回退、按修饰键决定带不带历史；`conversation.composer.dock` 槽里是可选的预览卡
- 无构建步骤：仓库里的 `.js` 就是发布产物
- 中英双语界面文案，随 DSH 语言自动切换
- 宿主侧带 60s 调用超时（另有 65s 客户端兜底），失败文案按界面语言本地化
- 按钮不抢输入焦点（不打断中文输入法组词）；失败原因同时写进 `title` 与 `aria-label`
- 每次调用有一个 `req=` 关联 ID，宿主日志与浏览器 console 能用同一个值对上
- **保真闸**：草稿里的反引号片段 / URL / 路径 / 版本号必须逐字保留，否则拒绝写回；**长度闸**：输出不能扩写成 2.5 倍以上
- **引用 chip 保护**：草稿里有 `@文件`/引用时禁用按钮，避免把 chip 抹成纯文本

> 包名从 `dsh-composer-enhance` 改为 `dsh-composer-enhance`（v0.4.0）：原名在 npm 已被占用（`github.com/adcx222/dsh-composer-enhance`）。

## 安装

宿主要求：DSH `>=0.2.0-rc.2 <1.0.0`（声明在 `package.json` 的 `engines.dsh`，插件市场据此显示兼容性结论；用区间而不是 `^0.2.0-rc.2`，因为 semver 的预发布语义会让 `^0.2.0-rc.2` **不包含** 0.3.x）、Node ≥ 20。

在 DSH 的插件市场里搜索 `dsh-composer-enhance` 一键安装；或让 Agent 执行：

```text
plugin_manager  action=install_bundle  target=dsh-composer-enhance
```

安装后刷新页面，发送键左侧即出现魔法棒按钮。

从源码安装（GitHub 仓库 / 本地目录）也可以：把仓库放到任意目录，然后在 profile 的 `package.json` 里用 `link:` 指过去，并把包名加进 `dsh.profile.bundles`：

```json
"dependencies": { "dsh-composer-enhance": "link:E:/path/to/dsh-composer-enhance" }
```

`link:` 形态会带上整棵源码树（`files` 白名单只约束 npm 包），所以仓库根目录必须保留 `LICENSE`。改完源码刷新页面即生效，无需构建。

## 用法

1. 输入框写一句草稿（中文、英文、中英混排都行）。
2. 点魔法棒 → 按钮转圈，草稿被改写成可直接发送的提示词。
3. 转圈时再点一次 = 取消。
4. 写回后按钮变成回退箭头，点一下回到原文；手动改过结果后回退箭头自动消失。
5. 只想改一句时，选中那一段再 `Ctrl+点击`（macOS 为 `Cmd+点击`）——只把选中文字发出去，结果只替换这一段；没选中就还是整段增强。
6. 想先看效果再决定：`Alt+Shift+点击`（v0.4.0）只拿结果、不写回，输入框下方出现预览卡（标题 + 字符差 + 正文 + 「采用/放弃」）；采用后仍可用回退箭头回到原文。
7. 草稿里有 `@文件`/引用 chip 时按钮会被禁用（悬停说明原因）——整段改写会把 chip 抹成纯文本，所以宁可拒绝（v0.4.0）。

整体行为：普通点击=整段增强，再点=回退，增强中=取消，`Ctrl/⌘`=局部，`Alt`=本次不带历史，`Shift`=本次带全部，`Alt+Shift`=本次只预览。`Alt`/`Shift` 与 `Ctrl` 可叠加。空草稿时按钮不显示。

空草稿时按钮不显示。模型调用超过 60s 会被宿主主动中止（可配置），按钮进入失败态；悬停能看到原因，读屏也能从 `aria-label` 拿到同一句话。**改动草稿后失败提示会自动消失**——它只对应当次输入，不会一直挂在按钮上。切换会话时，上一个会话里仍在跑的请求会被立即中止，结果不会写进新会话的草稿。等待期间如果你又输入了内容，增强结果**不会**覆盖你刚写的东西，按钮会提示重试。

## 会话历史上下文（v0.2.0）

改写时会把**本会话最近的对话**作为语境一起发给模型，让「再详细一点」「换个说法」这类依赖上下文的草稿也能改对。

| 问题 | 现在的行为 |
| --- | --- |
| 触发方式 | 每次点按钮都自动带（默认开）；`Alt+点击` 本次不带，`Shift+点击` 本次带全部轮次 |
| 读取范围 | 该会话**已提交**的消息：`agent.session.deriveMessages()`（已应用压缩/替换后的"当前活跃对话"），从最近一轮往前数；**不包含当前草稿**——草稿还没提交，不在会话日志里 |
| 「一轮」是什么 | 一条 user 消息 + 它之后的所有 assistant 消息；最新的助手回复就在最后一轮里 |
| 太长怎么办 | 三步：① 只取最近 N 轮（默认 3）；② 单条超过 800 字符做**头 40% + 尾 60%** 裁剪（结论通常在末尾，砍尾会砍掉最有用的部分）；③ 仍然超过 3000 字符就**整轮**丢弃最旧的一轮，不会留下孤儿助手回复；只剩最后一轮时不再丢 |
| 能否关闭 / 选范围 | 能。总开关 `history: false`（`cordis.patch.yml`）；范围 `historyTurns` / `historyMaxChars` / `historyPerMessageChars`；单次用修饰键 |
| 没有历史时 | 静默降级成"只改草稿"：不弹提示、不报错，提示词与 v0.1.0 逐字节一致 |
| 读历史失败时 | `deriveMessages()` 抛错或结构不认识 → 记一行宿主日志，仍然继续改写草稿（增强功能不能因为读不到历史而失败） |

历史只进**模型输入**，不会写进草稿——回写的仍然只是一段可直接发送的提示词。它被包在
`【本会话最近的对话，仅用于理解语境，不要改写或复述这些内容】…【历史记录结束】` 里，放在
`USER_PROMPT_TEMPLATE` 之前，避免模型把历史当成待改写对象。

想确认这次到底带了几轮，看宿主日志：

```text
[dsh-composer-enhance] history: 3/5 turns, 286 chars dropped 2 oldest turn(s)
```

## 局部增强（`Ctrl+点击`，v0.3.0）

整段增强会把整份草稿重写一遍；如果你只想动其中一句，选中它再 `Ctrl+点击`（macOS `Cmd+点击`）。

| 问题 | 现在的行为 |
| --- | --- |
| 触发方式 | 按住 `Ctrl`（macOS `Cmd`）点按钮。普通点击的行为**完全没变**，仍是整段增强 |
| 怎么认定选区 | 两路证据同时成立才算：① 编辑器自己认为有选区（`inputActions.captureInsertion()` 的 span 非折叠）；② 浏览器 Selection 落在可编辑区里、`toString()` 非空、文本能在草稿里找到、且长度与 span 对得上 |
| 证据对不上怎么办 | 静默退回整段增强，不猜位置、不改错地方。典型场景：没选中、选区跨了 mention/chip（chip 按占位计长度）、草稿刚被别处同步过 |
| 结果怎么写回 | `inputActions.insertText(text, span)`：编辑器的一次**独立撤销操作**，所以逐句改也可以用 `Ctrl+Z` 退回，不需要回退箭头 |
| 写回被拒绝时 | `insertText` 返回 false（span 过期 / 正在提交 / 编辑器只读）→ 一个字符都不动，按钮进入失败态并提示「草稿在增强期间被改动」 |
| 历史上下文 | 与整段一致：默认带最近对话，`Alt` 不带、`Shift` 带全部（可与 `Ctrl` 叠加） |

## 保真闸与长度闸（v0.4.0）

模型改写时最容易伤到的是**硬事实**：路径、版本号、URL、反引号里的代码片段。改错一个字符，用户拿去执行就报错。

| 问题 | 现在的行为 |
| --- | --- |
| 提取什么 | 四条规则：反引号片段、`https?://` URL、带扩展名的路径/文件名、语义化版本号（`v1.2.3` / `1.2.3-rc.1`）。去重后最多 40 条，长度 ≥2 才算 |
| 怎么判 | 结果里必须**逐字**包含每一条硬事实；缺一条就整次失败 |
| 失败后 | 结果**不写回草稿**，按钮进失败态并列出缺失项（最多 5 条）；日志 `reason=fidelity fidelity=missing:N` |
| 关掉它 | `fidelity: false`（`cordis.patch.yml` / Config） |
| 长度闸 | 草稿 ≥80 字符时，结果超过 `maxExpansionRatio`（默认 2.5，可配 1–6）即拒绝，日志 `reason=too-verbose expand=<实际>><上限>`；短草稿不受比例约束（否则一句「写个周报」很容易被误判） |

闸门是**硬失败**而不是"提示一下"：宁可让用户再点一次，也不默默把半截事实写回输入框。想保留被拒的结果，用 `Alt+Shift` 预览模式自己判断。

## 可选预览（`Alt+Shift+点击`，v0.4.0）

| 问题 | 现在的行为 |
| --- | --- |
| 触发方式 | `Alt+Shift+点击`（普通点击仍是直接写回，未改） |
| 显示在哪 | 输入框卡片下方（`conversation.composer.dock` 槽）的一张卡：标题、字符差 `±N chars`、结果正文、「采用 / 放弃」 |
| 采用后 | `inputActions.setDraft(结果)`，之后按钮的回退箭头仍可退回原文（预览阶段不留回退点） |
| 放弃后 | 草稿一个字符都不动，卡片消失 |
| 会话切换 | 预览卡只属于产生它的会话；切走后不再显示 |
| 为什么不做成默认 | 多一次确认点击会削弱"一键更快"的差异；保真闸已经把"悄悄改坏"的风险挡住了 |

## 配置项一览（v0.4.0）

`cordis.patch.yml` 里给默认值，`Config` schema 让插件管理器/Config Inspect 能渲染表单。

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；关掉后点按钮直接返回「已被插件配置禁用」，不调模型 |
| `temperature` | `0.3` | 采样温度（0–2） |
| `maxTokens` | `2048` | 输出预算；思考 token 也计入 |
| `timeoutMs` | `60000` | 宿主侧单次调用超时 |
| `history` | `true` | 是否带最近对话作语境 |
| `historyTurns` | `3` | 取最近几轮（1–12） |
| `historyMaxChars` | `3000` | 历史总字符预算 |
| `historyPerMessageChars` | `800` | 单条历史裁剪长度（头 40% + 尾 60%） |
| `fidelity` | `true` | 硬事实保真闸 |
| `maxExpansionRatio` | `2.5` | 长度闸倍数（1–6） |
| `provider` / `model` | `''` | 只给本插件覆盖模型；**两个都填**才生效（日志 `modelSource=config`），只填一个忽略 |

类型写错（例如 `maxTokens: "2048"`）会让插件激活失败——这是导出原生 schema 的代价，已写进已知限制。

## 它是怎么跑起来的

```
┌─ 浏览器 ───────────────────────────────────────────────┐
│ conversation.input.right 槽（发送键前、模型选择器之前）  │
│   <EnhanceButton>                                      │
│     useInput(s => s.draft)           读草稿（+ chip 数） │
│     inputActions.setDraft(text)      整段写回（可回退）  │
│     inputActions.insertText(text,sp) 局部写回（Ctrl/⌘）  │
│ conversation.composer.dock 槽                          │
│   <PreviewDock>  Alt+Shift 预览卡：采用 / 放弃          │
└───────────────┬────────────────────────────────────────┘
                │ ctx.remote.commands.execute(sessionId, '/enhance-prompt <base64url>', [], signal)
                │ ← 已生成的稳定 Remote（首参 SessionId 由网关适配成 Agent，第 4 参是取消信号）
┌───────────────▼────────────────────────────────────────┐
│ Host 半 index.js                                       │
│   ctx.commands.register({ name:'enhance-prompt',       │
│                            recordInput:false, … })      │
│   → enabled:false 直接拒绝（reason=disabled）            │
│   → decodeRequest() 取回草稿 + 本次历史开关 + 关联 ID     │
│   → agent.session.deriveMessages()（已提交的消息）       │
│       → selectHistory() 选轮/裁剪/预算 → 历史上下文      │
│   → 取模型：Config 覆盖 ⇄ 会话默认（日志 modelSource=）   │
│   → 取消信号 + 宿主超时才合并成一个 signal               │
│   → ctx.llm.stream({ system, messages, temperature })   │
│   → clampEnhancedText() 清洗                            │
│   → 保真闸 / 长度闸（失败=不写回，reason=fidelity|too-verbose）│
│   → console.info(req=… reason=… fidelity=… expand=…)     │
│   → { kind:'success', text }  →  CommandExecution       │
└────────────────────────────────────────────────────────┘
```

两个关键设计决定：

1. **Client→Host 走「session 命令」而不是自定义 Remote。**
   `ctx.remote.<命名空间>` 是 typert/tsdown 在 DSH **构建期**生成的产物，第三方手写包无法凭空获得；而 `commands/execute` 是**已经生成好**的稳定 Remote，浏览器半只需拼一行命令字符串就能调到宿主逻辑。
   代价：每次增强会在聊天流里留下一个命令节点（`command/run` + `command/done`）。命令生命周期是 log-only，**不进模型历史、不加 token**；`recordInput:false` 保证草稿原文不写进 `command/run.args`。
2. **system 提示词走 `GenerateOptions.system`，不塞消息。**
   请求态消息类型 `RequestUserInput` 只允许 `role:'user'`，塞 system 消息会被拒。

## 提示词策略

增强行为完全由 `prompts.js` 的两个常量决定。它们分工不同，**必须成对修改**——任何一条语言规则都只应存在于两份提示词中，不应只改一处。

### `SYSTEM_PROMPT`：改写的规则书

| 段落 | 作用 |
| --- | --- |
| 角色与输出契约 | 说明结果会逐字覆盖草稿，因此只能是一段可直接发送的提示词 |
| `TASK` | 把目标钉死在「改写」而非「回答」 |
| `ANALYSIS PROCESS` | 三步：评估草稿（目标、歧义与缺口、指令清晰度、缺失的上下文）→ 套用提示词工程原则（明确指令、补齐上下文、显式参数与约束、定义输出格式、匹配语气与复杂度、去冗余）→ 成文并守住原目标 |
| `Do NOT` 段 | 不索要教程、不索要代码片段、不建议草稿未提及的技术栈/库/文件名、不解释 HOW、不回答问题 |
| `IMPORTANT CONSTRAINTS` | ①语言匹配最高优先级 ②约 800 字符且不超原文约 3 倍 ③只输出提示词本身 |
| 两个范例 | 覆盖「极短草稿」与「自带改写指令的草稿」两种典型输入 |

### `USER_PROMPT_TEMPLATE`：每次请求实际发出的用户消息

内嵌 `{input}` 占位符，由 `buildUserPrompt(input)` 填入草稿。

| 段落 | 作用 |
| --- | --- |
| `CRITICAL PRIORITY - LANGUAGE CONSISTENCY` | 六条语言规则，与 system 提示词第 1 条约束同源，形成双重锁定 |
| `ENHANCEMENT REQUIREMENTS` | 八条产出要求：只输出正文、禁止元注释、保留原意、必须实质增强、已清晰则轻润色、不得烂尾、不加无关要求、自成完整提示词 |
| `EXAMPLES` | 中文 / 英文 / 中英混排 / 模糊任务 四类正例 |
| `BAD` / `GOOD` 输出对比 | 直接对照「写出语言分析」与「输出纯提示词」，压制最常见的失败模式 |

### 三条不可动摇的规则

1. **语言匹配是最高优先级**，且语言判断只能影响行为、**绝不能出现在输出里**——`BAD OUTPUT EXAMPLE` 专门压制这一点，system 与 user 两份提示词各自重申一遍。
2. **结果原样替换草稿**，因此必须自成一段可直接发送的提示词：没有前言、没有 markdown 围栏、没有引号、没有 label。
3. **不做实质增强视为失败**；已经写清楚的草稿只做轻润色，不改变意图。

改提示词时只需要动这两个常量。`buildUserPrompt()` / `cleanupEnhancedText()` / `clampEnhancedText()` 是纯函数，不承载策略；但它们是规则 2 的最后一道防线——`cleanupEnhancedText()` 会去掉首尾引号、模型偶尔自作主张加的 `Enhanced prompt:` 之类自述 label，以及**恰好包住全文**的 code fence（只在围栏内再没有围栏时才脱，避免破坏草稿里本就存在的代码块）。

## 错误与边界

宿主失败一律是稳定的英文 `Enhance prompt: …` 家族，浏览器半用前缀匹配翻译成本地化文案；认不出来的文案原样透出，把真实报错交给用户，而不是吞成一句"增强失败"。

| Host 返回 | 触发条件 | 界面显示（中文） |
| --- | --- | --- |
| `Enhance prompt: empty input.` | 草稿为空，或载荷解码失败 | 请先输入内容 |
| `Enhance prompt: input too long (N > 8000 characters).` | 草稿超过 8000 字符（浏览器侧也会先拦一次） | 内容过长，无法增强 |
| `Enhance prompt: no default model selected.` | 没有可用的默认模型 | 请先在模型选择器里选中一个模型 |
| `Enhance prompt: timed out after 60s.` | 超过 `timeoutMs` | 增强超时，请重试 |
| `Enhance prompt: cancelled.` | 用户取消 | 不显示（调用方按 aborted 直接返回） |
| `Enhance prompt: empty result.` | 模型没吐回任何可用文本（且不是被 `max-tokens` 截断） | 模型没有返回可用内容 |
| `Enhance prompt: fidelity check failed (missing: a, b).` | 保真闸：结果丢掉了草稿里的硬事实（最多列 5 条） | 改写丢了原文的关键信息（如路径/版本/链接），已放弃本次结果 |
| `Enhance prompt: result too long (N chars vs M input chars, limit 2.5x).` | 长度闸：结果超过 `maxExpansionRatio` | 改写结果明显比原文长太多，已放弃本次结果 |
| `Enhance prompt: disabled by plugin config.` | 总开关 `enabled: false` | 增强提示词已被插件配置禁用 |
| `Enhance prompt: model ran out of output budget (max-tokens, maxTokens=N).` | 思考过程把 `maxTokens` 用完了，正文为空 | 模型的输出额度被思考过程用完了，请重试或提高 maxTokens |
| `Enhance prompt failed: model stream ended with error.` / `… with aborted.` | 适配器用终止性 `finish` 块报错（不抛异常） | 增强失败 — `model stream ended with error.` |
| `Enhance prompt failed: <detail>` | 模型调用抛错 | 增强失败 — `<detail>` |

### 结果为空时怎么查

宿主日志里有三种证据，按顺序看：

| 日志 | 含义 | 处理 |
| --- | --- | --- |
| `history: off` / `no-session` / `derive-failed` / `empty` / `ok` | 本次到底有没有把对话带进去，卡在哪一层（`no-session` = 命令没拿到会话，`derive-failed` = 读会话抛错） | 预期要带历史却没带，看这一行就够了 |
| `model hit the output token budget before producing text finish=max-tokens text=0 chars inputTokens=… outputTokens=… reasoningTokens=…` | 思考把预算吃光 | 提高 `maxTokens`，或换一个思考量更小的模型 |
| `model returned no usable text finish=stop text=0 chars …` | 模型正常结束但没给正文 | 换模型重试；再复现就把这条日志贴出来 |

表里都是宿主返回的文案；另有一类是浏览器半自己的提示：`action.draftChanged`（请求期间你改动了草稿，结果不覆盖新输入，请重试）。

三条长度/时间上限分属两个运行时，**改动必须同步**（浏览器半是独立脚本，无法共享宿主常量）：

| 位置 | 常量 | 值 | 作用 |
| --- | --- | --- | --- |
| `prompts.js` | `MAX_OUTPUT_CHARS` | `1600` | 结果硬上限的**下限**；宿主实际按 `min(8000, max(1600, 原文长度))` 放宽，长草稿不会被砍短 |
| `index.js` | `MAX_INPUT_CHARS` | `8000` | 宿主侧草稿上限 |
| `client.js` | `MAX_TEXT_LENGTH` | `8000` | 浏览器侧草稿上限，发送前先拦 |
| `index.js` | `DEFAULT_TIMEOUT_MS` | `60000` | 模型调用超时 |

关于载荷：草稿是任意多行文本，走命令**行**必须先编码，这里用 UTF-8 → base64url，字节数约膨胀 4/3。8000 个 ASCII 字符 ≈ 10.7K 字符命令行；8000 个汉字（UTF-8 3 字节）≈ 32K 字符命令行。命令节点是 log-only，不进模型历史。

## 日志与排障（v0.3.1）

每次点击会在两端各留一行日志，用同一个 `req=` 关联：

```text
# 浏览器 console（client.js）
[dsh-composer-enhance] req=ab12cd start whole chars=42 history=auto
[dsh-composer-enhance] req=ab12cd ok ms=1830 text=57 mode=whole

# 宿主 console（index.js）
[dsh-composer-enhance] req=ab12cd ok reason=ok ms=1830 provider=deepseek model=chat finish=stop in=1900 out=90 reasoning=0 text=57 history=ok/2of2 historyChars=310 historyMessages=4 maxTokens=2048 modelSource=session fidelity=ok expand=57<=105
[dsh-composer-enhance] req=7c1d2e fail reason=fidelity fidelity=missing:2
```

字段含义：

| 字段 | 含义 |
|---|---|
| `req=` | 本次点击的关联 ID（6 位 base36）。v2 载荷新增可选字段 `id`；旧载荷没有时宿主补一个 |
| `ok` / `fail` | 成/败；失败了看 `reason=` |
| `reason=` | `ok`、`empty-input`、`too-long`、`no-model`、`cancelled`、`timeout`、`client-timeout`、`stream-error`、`stream-aborted`、`max-tokens`、`empty-result`、`fidelity`、`too-verbose`、`disabled`、`draft-changed`、`insert-rejected` |
| `ms=` | 端到端耗时 |
| `finish=` | 模型流终止原因：`stop` / `max-tokens` / `error` / `aborted` |
| `in=` / `out=` / `reasoning=` | 输入 / 输出 / 思考 token；`?` 表示模型没报 usage |
| `history=` | `<reason>/<带入轮数>of<总轮数>`，例如 `ok/2of2`、`off/0of0`、`no-session/0of0`、`empty/0of0`、`derive-failed/0of0` |
| `historyChars=` / `historyMessages=` | 历史占用字符数 / 参与挑选的纯文本消息条数 |
| `modelSource=` | `session`（用会话模型）或 `config`（用 `Config` 里的 `provider`+`model` 覆盖） |
| `fidelity=` | `ok` 或 `missing:N`（保真闸缺了几条硬事实） |
| `expand=` | `<结果长度><=<上限>`（通过）或 `<结果长度>><上限>`（被长度闸拒绝） |

排障顺序：① 用 `req=` 在两端 grep 到同一行，确认是同一次点击；② 看 `reason=` 落在哪一层；③ `fail` 且 `finish=max-tokens` → 提高 `config.maxTokens`；④ `history=*/0of0` → 对照历史开关与修饰键。

## 目录结构

| 文件 | 职责 |
| --- | --- |
| `package.json` | 声明 `dsh.bundle.patch`（Host 行）与 `dsh.client`（浏览器半）；`exports['./client']` 指向手写 `client.js`；`engines.dsh` 给出宿主版本区间 |
| `cordis.patch.yml` | 把本包插进 profile 的 Loader 图，并带上可调参数：`- insert: [{ id, name, config: { temperature, maxTokens, timeoutMs } }]` |
| `index.js` | **Host 半**：`export const inject` + `export function apply(ctx, config)`，注册命令、实现 `enhanceText()` |
| `prompts.js` | 提示词资产与结果清洗（`buildUserPrompt` / `cleanupEnhancedText` / `clampEnhancedText` / `MAX_OUTPUT_CHARS`） |
| `client.js` | **浏览器半**：`window.__ModuleLoader__.load({ id, factory })`，注册 locale、`conversation.input.right`（按钮）与 `conversation.composer.dock`（预览卡）两个槽，并把宿主错误文案本地化 |
| `locale/{zh,en}.json` | 插件管理器展示元数据（`meta.title` / `meta.description`）。**不是** Client 字典——字典内联在 `client.js` 里，两处用途不同、不重复注册 |
| `icon.svg` | 插件图标（≤256KiB、相对路径、单色 currentColor） |
| `README.en.md` / `README.md` | 英文 / 中文说明。npm 只自动带 `README.md`，英文版靠 `files` 白名单显式带上 |
| `LICENSE` | MIT 许可。仓库根目录必须有；npm 包的 `files` 里也显式包含 |
| `test/` | 离线验证脚本，零依赖、不联网、不进 npm 包：`verify-host.mjs`（宿主半）、`verify-client.mjs`（浏览器半）、`verify-manifest-yaml.mjs`（引导期 YAML）、`live.mjs`（opt-in 真模型回归，无 Key 时跳过） |
| `.github/workflows/ci.yml` | CI：Node 20/22 矩阵跑 `npm run check` + `npm test` |
| `CHANGELOG.md` | 版本变更记录 |
| `.gitignore` | 忽略 `node_modules/`、`*.tgz` 等本地产物 |

## 三个必须遵守的契约

1. **bundle 契约**：`package.json` → `dsh.bundle.patch` → YAML `- insert:` 一行；Host 半导出 `apply(ctx, config)` 与可选 `inject`（本包为 `['commands','llm','agentDefaultModel']`）。所有注册都写在 `ctx.effect(() => …)` 里，返回清理函数。
2. **browser 契约**：`dsh.client = { platform:'web', immediately:true, inject:[…] }` + 导出 `./client`；`client.js` 必须是**纯 JS**（无 JSX/TS/import），`__ModuleLoader__.load` 的 `id` **必须等于包名**，只能 `require('react')`，**不得** require 任何 `@deepseek-ai/dsh-client-*` 包；样式只能用 Theme 的 `--dsw-alias-*` token；可见文案走 `ctx.locale.register`。
3. **槽契约**：`ctx.slots.inject(SLOT, () => ctx.slots.register({ name, id, order, locale, inject }, Component))`。`conversation.input.right` 是 list 槽、`replaceRisk: none`；组件自动获得 `sessionId` / `useInput` / `inputActions` / `t` 等标准 props。

## 安装与验证

```text
# 1) 安装
plugin_manager  action=install_bundle  target=dsh-composer-enhance

# 2) 确认行已生效（看 application / warnings，不看"没报错"）
plugin_manager  action=list_plugins

# 3) 免审批地确认槽里出现了占用者（occupants 里应出现 id=dsh-composer-enhance）
cordis_inspect_query platform=client provider=Slots method=listSubTree
                     input={"root":"conversation.input.right"}
```

然后：刷新页面 → 发送键左侧出现魔法棒按钮 → 输入一句中文草稿 → 点按钮 → 按钮转为转圈（再点即取消）→ 草稿被替换且语言保持一致 → 按钮变为回退箭头 → 点击回到原文；手动改过增强结果后，回退箭头自动消失。

回归输入（同时验证语言一致性与"只改写不回答"）：

| 输入 | 期望 |
| --- | --- |
| `做个登录页面` | 中文，补全校验/错误态/移动端等具体要求，不实现代码 |
| `explain what this code does` | 全英文，不解释 HOW、不编造技术栈 |
| `这段代码有 bug，can you help me fix it?` | 保持中英混排，不塌成单一语言 |
| `修复它` | 中文，只补上下文/范围，不擅自指定框架 |
| 已经写得很完整的长草稿 | 轻润色，不改变意图，长度不超原文约 3 倍 |
| 空草稿 | 按钮不显示 |
| 临时断网/把模型选成不可用的 provider | 按钮进入失败态并给出可读原因，不改变草稿 |

## 开发与验证

```text
node test/verify-host.mjs            # 57 项：manifest / 文件清单、prompts.js 纯函数、index.js 宿主半（历史、超时、取消、错误、配置收敛、Config schema、关联 ID 与日志、载荷自识别、保真闸与长度闸、总开关、模型覆盖）
node test/verify-client.mjs          # 31 项：模块与两个槽注册、locale、宿主文案本地化、点击成功/失败/超长、焦点与失败态清理、会话切换、局部增强、重入锁与关联 ID、chip 保护、预览
node test/verify-manifest-yaml.mjs   # cordis.patch.yml 用真实 yaml 解析器过一遍（本机没有 yaml 依赖时自动 SKIP）
node test/live.mjs                   # opt-in 真模型回归；没有 DEEPSEEK_API_KEY 时打印跳过、退出码 0
npm test                             # 前三个一起跑（不联网）
npm run check                        # 三个 JS 产物的 node --check
```

三个离线脚本只用 Node 标准库、不联网、不需要 `npm install`。改动源码或提示词后先跑它们再发版；`prepublishOnly` 还会在 `npm publish` 前对三个 JS 产物做一次语法检查。`test/live.mjs` 需要 `DEEPSEEK_API_KEY`（可选 `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL`），它验的是提示词资产在真模型上的行为，不碰 DSH 插件链路。

## 常见调整点

- **换提示词**：只改 `prompts.js` 的两个常量，其余不动；两份提示词里的语言规则必须保持同步。
- **换模型/温度/超时**：改 `cordis.patch.yml` 该行的 `config.temperature` / `config.maxTokens` / `config.timeoutMs`；`index.js` 的 `readOptions()` 会把越界或非数字的值回落到 `DEFAULT_*`。这些键现在也通过 `Config` schema 暴露出来了，插件管理器 / Config Inspect 里能直接看到它们的类型与默认值。
- **调历史上下文**：同一行的 `config.history`（总开关）、`config.historyTurns`（1–12）、`config.historyMaxChars`（200–12000）、`config.historyPerMessageChars`（100–4000）；取舍算法在 `index.js` 的 `selectHistory()`，纯函数、被 `test/verify-host.mjs` 直接覆盖。
- **`Config` schema**：`index.js` 用 `@deepseek-ai/schemastery` 声明 12 个可调项的类型与默认值（温度/预算/超时、四个历史键、`enabled`/`fidelity`/`maxExpansionRatio`、`provider`/`model`）。这是 `dependencies` 里唯一一个运行时依赖；解析不到时自动退化成"不导出 `Config`"，插件照常加载。
- **保真闸与长度闸**：规则在 `index.js` 的 `FIDELITY_PATTERNS` / `missingFidelityFacts()` / `expansionVerdict()`，都是纯函数，被 `test/verify-host.mjs` 直接覆盖。想放宽就调 `config.maxExpansionRatio`（1–6）；不想要就直接 `config.fidelity: false`。
- **预览卡**：`client.js` 的 `PreviewDock` + 模块级 `previewStore`（发布/订阅），挂在 `conversation.composer.dock` 槽、`order: 20`。想改样式只动 `client.js` 顶部的 CSS 字符串。
- **总开关与模型覆盖**：`config.enabled: false` 让按钮直接返回"已被配置禁用"；`config.provider` + `config.model` 同时给才会覆盖会话模型（日志 `modelSource=config`）。
- **思考档位**：`agentDefaultModel.currentSelection()` 返回 `{ provider, model, reasoningEffort? }`，代码已把它透传进 `ctx.llm.stream`。
- **载荷与超时上限**：`client.js` 的 `MAX_PAYLOAD_CHARS`（65536，v2 载荷 base64url 后的长度）与 `CLIENT_TIMEOUT_MS`（65000）；`index.js` 的 `MAX_INPUT_CHARS`（8000）必须与 `client.js` 的 `MAX_TEXT_LENGTH` 一致——两个运行时分属浏览器与 Node，无法共享常量。
- **同时暴露给 Agent**：解开 `index.js` 末尾注释的 `ctx.tools.register`，与按钮共用同一个 `enhanceText(ctx, request, signal, options, agent)`（官方规范要求 UI 动作与 Agent 工具不得各写一套逻辑；`enhanceText()` 直接收 `{ text, history? }`，工具入口不需要任何命令行编码）。
- **想改为「紧贴发送键」的展开态交互**：把槽换成 `conversation.input.activity`（single 槽，`replaceRisk: shadows-shipped-ui`），并实现 `onActiveChange` 的展开/释放。

## 已知限制

- **思考型模型吃预算**：DSH 默认开启思考，思考 token 也计入 `maxTokens`（默认 2048）。如果日志出现 `finish=max-tokens` 且正文为空，说明预算被思考用完，提高 `config.maxTokens`（上限 8192）或换思考量更小的模型。
- **客户端兜底超时是固定 65s**：`client.js` 的 `CLIENT_TIMEOUT_MS` 必须比宿主 `config.timeoutMs`（默认 60000）长，否则客户端会抢在宿主超时文案之前报"增强超时"。把宿主超时调到 65s 以上时，请一并改这个常量（两个运行时不共享常量）。
- **连点不会发起第二次调用**：增强中再点按钮仍是"取消"（原有语义）；渲染还没刷新时的重复 click 由 `controllerRef` 重入锁挡掉。
- 聊天流会出现一个命令节点；这是复用 `commands/execute` 的必然后果。
- 历史上下文取的是 `deriveMessages()` 的**已提交**消息，当前草稿不在其中；也就是说"这次输入的草稿"本身不会被当成历史的一部分（避免把同一段文字算两遍）。
- 历史只带 user/assistant 的纯文本块：工具调用、工具结果、图片块都被丢弃——它们对"改写草稿"没有帮助，还会吃掉预算。
- **保真闸是硬失败，不是提示**：结果丢了硬事实就整次丢弃、不写回；想保留被拒结果只能用 `Alt+Shift` 预览模式自己判断（`fidelity: false` 可关，但不建议）。
- **长度闸只对 ≥80 字符的草稿生效**：太短的草稿没有稳定的"合理倍数"，容易被误判，所以短草稿只受输出硬上限约束。
- **预览不会自动采用**：`Alt+Shift` 之后必须点卡片上的「采用」，切走会话或刷新页面后待确认结果会丢失（它只在内存里）。
- **引用 chip 会被保护但不会被处理**：草稿里有 `@文件`/引用时按钮直接禁用，不会替你展开引用内容再用上（竞争对手 `@huanhuan123/dsh-prompt-optimizer` 会读引用内容，这是有意不跟进的：读文件涉及权限边界与额外延迟）。
- **配置会被 schema 校验类型**：导出 `Config` 后，`cordis.patch.yml` 里写错类型（例如 `maxTokens: "2048"` 字符串）会让插件激活失败，而不是像以前那样静默回落。取值范围仍由 `readOptions()` 钳制，所以只有"类型写错"才会报错，改回数字即可恢复。
- **局部增强依赖真实选区**：`Ctrl+点击` 只在"编辑器认的 span"和"浏览器 Selection"两路证据都对得上时才生效；选区跨 mention/chip、草稿刚被别处同步、输入法还在组词时都会静默退回整段增强。它是可选加速路径，不是默认路径。
- **局部增强没有回退箭头**：局部写回是编辑器的一次独立撤销操作，回退用编辑器本身的 `Ctrl+Z`；`insertText` 被拒绝（span 过期 / 正在提交 / 只读）时一个字符都不动，只报错。
- 增强结果写回**整段**时仍是 `setDraft(text)` 替换草稿；局部模式才会走 `captureInsertion()` + `insertText(text, span)`。
- 两个 8000 与 1600 分属两个运行时，无法共享常量，改动需按上表同步。宿主侧的结果上限会随原文长度放宽（`min(8000, max(1600, 原文长度))`），所以很长的草稿不会被砍到 1600。
- `useInput((state) => state.draft)` 会随每次按键重渲染按钮。组件本身需要草稿文本来发起请求和判断空态，无法用更窄的选择器规避；按钮很小，实测影响可忽略，故未做特殊处理。
- 界面文案内联在 `client.js`，`locale/*.json` 只服务插件管理器元数据；两者不是"同一份文案的两个副本"。
- 仓库根目录已经放了 `LICENSE`（`files` 白名单只约束 npm 包，git / `link:` 安装会带上整棵树）；版权行目前是 `dsh-composer-enhance contributors`，正式对外发布前建议改成你自己的名字或组织名。

## License

MIT
