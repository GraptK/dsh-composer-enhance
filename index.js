/**
 * Host 半：把「增强提示词」实现成一个 **session 命令**。
 *
 * 为什么是命令而不是自定义 Remote：
 *   `ctx.remote.<新命名空间>` 是 typert/tsdown 在 DSH 构建期生成的产物，
 *   第三方手写包无法凭空获得（见 dsh-api-remotes/README.md）。
 *   而 `ctx.remote.commands.execute(sessionId, line, attachments, signal)` 是**已生成**的稳定 Remote，
 *   浏览器半因此可以只靠一行命令字符串调用到宿主逻辑。
 *
 * 命令契约（dsh-commands/lib/index.js、dsh-commands/README.md）：
 *   - `parseCommand` 用 /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u 取名字，rawInput 含分隔空格、不做 trim。
 *   - handler 前 append `command/run`、结算 append `command/done`，两条都是 log-only（**不进模型历史、不加 token**）。
 *   - 名字未知或语法非法时 `execute` 返回 undefined 且什么都不记。
 *   - `recordInput:false` 让草稿原文不进 `command/run.args`（结果文本仍会出现在 `command/done`）。
 *
 * 错误文案契约（**改动措辞前请先看这里**）：
 *   client.js 用前缀匹配把这些错误翻译成本地化文案，所以下面所有失败分支都必须是
 *   稳定的英文、且以 `Enhance prompt` 开头。只有 `Enhance prompt failed: <detail>`
 *   允许携带一段原样透出的诊断信息。
 */

import { Buffer } from 'node:buffer';
import { SYSTEM_PROMPT, buildUserPrompt, clampEnhancedText, MAX_OUTPUT_CHARS } from './prompts.js';

export const name = 'dsh-composer-enhance';

/** Host 服务名取自 Service 目录：commands / llm / agentDefaultModel。 */
export const inject = ['commands', 'llm', 'agentDefaultModel'];

const COMMAND_NAME = 'enhance-prompt';
const DEFAULT_TEMPERATURE = 0.3;
// 2048 而不是 1024：思考型模型（DSH 默认开启思考）的思考 token 也计入 maxTokens，
// 1024 时常见"思考吃光预算、正文为空"，表现为 'empty result'。2048 给正文留出余量。
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TIMEOUT_MS = 60_000;
// config 的合法区间：越界或非数字一律回落到默认值，避免把 NaN 之类传进 llm。
const MAX_TEMPERATURE = 2;
const MAX_MAX_TOKENS = 8192;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;
/** 与 client.js 的 MAX_TEXT_LENGTH 必须一致（浏览器半是独立脚本，无法共享这份常量）。 */
const MAX_INPUT_CHARS = 8000;
const LOG_PREFIX = '[dsh-composer-enhance]';
/** v2 载荷的可选关联 ID：浏览器半生成，两端日志共用，便于把同一次点击的两端记录对上。 */
const REQUEST_ID_PATTERN = /^[a-z0-9]{6}$/;
/** base64url('{"v":2') —— v2 载荷必以此开头；用它区分"编码载荷"与"明文"，避免把明文当 base64 解。 */
const V2_PREFIX = 'eyJ2Ijoy';

// ---- 会话历史上下文 -------------------------------------------------------
// 默认口径：自动带最近 3 轮对话（一轮 = 用户一条 + 助手若干条），总预算 3000 字符，
// 单条超过 800 字符做头尾裁剪。全部可在 cordis.patch.yml 的 config 里改。
const DEFAULT_HISTORY_TURNS = 3;
const DEFAULT_HISTORY_MAX_CHARS = 3000;
const DEFAULT_HISTORY_PER_MESSAGE_CHARS = 800;
const MIN_HISTORY_TURNS = 1;
const MAX_HISTORY_TURNS = 12;
const MIN_HISTORY_MAX_CHARS = 200;
const MAX_HISTORY_MAX_CHARS = 12_000;
const MIN_HISTORY_PER_MESSAGE_CHARS = 100;
const MAX_HISTORY_PER_MESSAGE_CHARS = 4_000;
const HISTORY_HEADER = '【本会话最近的对话，仅用于理解语境，不要改写或复述这些内容】';
const HISTORY_FOOTER = '【历史记录结束】';

// ---- 保真闸 / 长度闸（v0.4.0）----------------------------------------------
// 借鉴 dsh-improve-prompt 的「保真闸」：改写结果必须逐字保留原文里的硬事实
// （反引号片段、URL、路径/文件名、版本号），否则不写回草稿；再用"结果/原文"的长度比
// 挡掉把一句话扩写成上千字的结果。两者都是纯本地字符串运算，不增加模型调用、不增加依赖。
const DEFAULT_FIDELITY = true;
const DEFAULT_MAX_EXPANSION_RATIO = 2.5;
const MIN_EXPANSION_RATIO = 1;
const MAX_EXPANSION_RATIO = 6;
// 太短的草稿按倍数算会误伤（"fix bug" 扩到 20 字就超 2.5 倍），所以只在够长时启用比例闸。
const MIN_INPUT_CHARS_FOR_RATIO = 80;
const MAX_FIDELITY_FACTS = 40;
const MAX_FIDELITY_MISSING_SHOWN = 5;
const FIDELITY_PATTERNS = [
  // 反引号里的代码 / 标识符 / 命令
  /`([^`\n]{2,200})`/g,
  // URL
  /https?:\/\/[^\s"'`<>，。；：、）】」』]+/g,
  // 带目录的路径，或带已知扩展名的文件名
  /(?:[A-Za-z]:\\[^\s"'`<>]+|\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+|[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|py|go|rs|java|kt|yml|yaml|toml|ini|cfg|conf|css|scss|html|sh|ps1|sql)\b)/g,
  // 语义化版本（v1.2 / 1.2.3 / 1.2.3-rc.1）
  /\b(?:v\d+\.\d+(?:\.\d+)*|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/g,
];

// ---- 可调项 schema --------------------------------------------------------
// 作用：把 cordis.patch.yml 里的 config 变成插件管理器 / Config Inspect 里可读的表单
// （`isNativeConfigSchema` 要求 value 带 Symbol.for('schemastery') 品牌、type 是字符串、
// meta 是对象 —— 普通对象或函数会被判 unsupported）。
//
// 两条硬约束：
//   1. schema 只声明**类型 + 默认值**，不在这里做范围钳制；越界/非法值仍由 readOptions() 收敛，
//      保证"配置怎么写都不会把 NaN 传进 llm"这条既有语义不变。
//   2. 依赖是可选的：解析不到 @deepseek-ai/schemastery（例如只拷了目录、没装 node_modules）时
//      退化成"不导出 Config"—— cordis 视作 absent，插件照常加载，行为与 0.2.x 一致。
let Schema = null;
try {
  ({ default: Schema } = await import('@deepseek-ai/schemastery'));
} catch {
  Schema = null;
}

export const Config =
  Schema === null
    ? undefined
    : Schema.object({
        temperature: Schema.number().default(DEFAULT_TEMPERATURE),
        maxTokens: Schema.number().default(DEFAULT_MAX_TOKENS),
        timeoutMs: Schema.number().default(DEFAULT_TIMEOUT_MS),
        history: Schema.boolean().default(true),
        historyTurns: Schema.number().default(DEFAULT_HISTORY_TURNS),
        historyMaxChars: Schema.number().default(DEFAULT_HISTORY_MAX_CHARS),
        historyPerMessageChars: Schema.number().default(DEFAULT_HISTORY_PER_MESSAGE_CHARS),
        enabled: Schema.boolean().default(true),
        fidelity: Schema.boolean().default(DEFAULT_FIDELITY),
        maxExpansionRatio: Schema.number().default(DEFAULT_MAX_EXPANSION_RATIO),
        provider: Schema.string().default(''),
        model: Schema.string().default(''),
      });

/** base64url 载荷 → 原文。用编码是为了让任意多行草稿都能安全地塞进"命令行"而不破坏命令语法。 */
function decodePayload(rawInput) {
  const value = String(rawInput ?? '').trim();
  if (value === '') return null;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  try {
    const text = Buffer.from(padded, 'base64').toString('utf8');
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/** base64url 编码（与 client.js 同算法）；只用于判断"解出来再编码回去是否一致"。 */
function encodeBase64Url(text) {
  return Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 6 位 base36 关联 ID：短到能贴在一行日志里，又足够避免同屏碰撞。 */
function newRequestId() {
  return Math.random().toString(36).slice(2, 8).padEnd(6, '0');
}

/**
 * 命令行载荷 → `{ text, history }`。
 *
 * v2 载荷是 JSON：`{ v: 2, text, history?: 'off' | 'all' }`（浏览器半按用户按下的修饰键决定）。
 * 兼容 v1：载荷本身只是草稿明文（旧版 client.js），此时 history 交给 config 默认。
 */
function decodeRequest(rawInput) {
  const value = String(rawInput ?? '').trim();
  if (value === '') return { text: '', history: undefined, id: newRequestId() };

  // v2 载荷：base64url(JSON)，以 base64url('{"v":2') 开头。用前缀判定而不是"先解再看"，
  // 这样 abc-123 这类纯 ASCII 明文不会被当成 base64 解出乱码。
  if (value.startsWith(V2_PREFIX)) {
    const decoded = decodePayload(value);
    if (decoded !== null) {
      try {
        const parsed = JSON.parse(decoded);
        if (parsed !== null && typeof parsed === 'object' && parsed.v === 2) {
          return {
            text: typeof parsed.text === 'string' ? parsed.text : '',
            history: parsed.history === 'off' || parsed.history === 'all' ? parsed.history : undefined,
            id: typeof parsed.id === 'string' && REQUEST_ID_PATTERN.test(parsed.id) ? parsed.id : newRequestId(),
          };
        }
      } catch {
        /* 前缀对但内容不是 JSON：落到下面按非法载荷处理 */
      }
    }
  }

  // 兼容 v1：旧版 client.js 发的是 base64url(草稿明文)。
  // 只有"解出来再编码回去逐字节一致"才认，非法 UTF-8 解出的乱码不会被当成草稿。
  const decoded = decodePayload(value);
  if (decoded !== null && encodeBase64Url(decoded) === value) {
    return { text: decoded, history: undefined, id: newRequestId() };
  }
  // 既不是合法 v2 也不是合法 v1：返回空文本，让上层走既有的 empty input 文案。
  return { text: '', history: undefined, id: newRequestId() };
}

function toMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  return String(error ?? 'unknown error');
}

/**
 * 只给"意外"失败留一行宿主日志：用户主动取消、以及可预期的校验失败都不刷日志。
 * Host 侧没有 logger 服务（Service 目录里没有该项），所以走 console。
 */
function logFailure(reason, detail) {
  try {
    console.warn(LOG_PREFIX, reason, detail);
  } catch {
    /* 日志失败绝不能影响命令结果 */
  }
}

/**
 * 把一次流式调用的结局压成一行诊断：结束原因 + 正文字数 + token 用量。
 * 空结果时这一行就是根因证据（max-tokens 多半是思考把预算吃光）。
 */
function describeStreamOutcome(finishReason, usage, accumulated) {
  const parts = [`finish=${finishReason === null ? 'none' : finishReason}`, `text=${accumulated.length} chars`];
  if (usage !== null && typeof usage === 'object') {
    for (const key of ['inputTokens', 'outputTokens', 'reasoningTokens', 'totalTokens']) {
      if (typeof usage[key] === 'number') parts.push(`${key}=${usage[key]}`);
    }
  }
  return parts.join(' ');
}

/** 把任意数字收敛到 [min, max] 的整数；非数字回落到 fallback。 */
function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

/** 浮点收敛（长度比这类参数不能取整）。 */
function clampFloat(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/**
 * 从原文里抽出"必须逐字保留"的硬事实。
 * 只认四类可机械判定的东西：反引号片段、URL、路径/文件名、版本号。
 * 刻意不抽自然语言词汇与普通标识符 —— 那些改写时本就该变，抽进来只会制造误报。
 */
function collectFidelityFacts(input) {
  const facts = [];
  const seen = new Set();
  const push = (value) => {
    const fact = typeof value === 'string' ? value.trim() : '';
    if (fact.length < 2 || seen.has(fact)) return;
    seen.add(fact);
    facts.push(fact);
  };
  for (const pattern of FIDELITY_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of input.matchAll(pattern)) {
      push(match[1] ?? match[0]);
    }
  }
  // 同一个 URL 会被"URL"与"路径"两条正则各命中一次（`/example.com/docs/api` 是 URL 的子串），
  // 子串事实只会让缺失清单出现重复项，这里只保留更长的那个。
  const kept = facts.filter((fact) => !facts.some((other) => other !== fact && other.includes(fact)));
  return kept.slice(0, MAX_FIDELITY_FACTS);
}

/** 返回原文里有、改写结果里没逐字出现的硬事实（保真闸的判定核心）。 */
function missingFidelityFacts(input, output) {
  const facts = collectFidelityFacts(input);
  if (facts.length === 0) return [];
  const haystack = typeof output === 'string' ? output : '';
  const missing = [];
  for (const fact of facts) {
    if (!haystack.includes(fact)) missing.push(fact);
  }
  return missing;
}

/**
 * 长度闸：结果比原文长太多就拒绝写回。
 * 短草稿（< MIN_INPUT_CHARS_FOR_RATIO）不启用，避免"fix bug"这类正常扩写被误判。
 */
function expansionVerdict(input, output, ratio) {
  const configured = clampFloat(ratio, MIN_EXPANSION_RATIO, MAX_EXPANSION_RATIO, DEFAULT_MAX_EXPANSION_RATIO);
  if (input.length < MIN_INPUT_CHARS_FOR_RATIO) return { over: false };
  const limit = Math.floor(input.length * configured);
  if (output.length <= limit) return { over: false };
  return { over: true, limit, ratio: configured };
}

/** 把插件 config 收敛到安全范围；非法值回落到默认值，绝不抛错。 */
function readOptions(config) {
  const temperature = Number(config?.temperature);
  const maxTokens = Number(config?.maxTokens);
  const timeoutMs = Number(config?.timeoutMs);
  return {
    temperature:
      Number.isFinite(temperature) && temperature >= 0 && temperature <= MAX_TEMPERATURE
        ? temperature
        : DEFAULT_TEMPERATURE,
    maxTokens:
      Number.isInteger(maxTokens) && maxTokens > 0 && maxTokens <= MAX_MAX_TOKENS ? maxTokens : DEFAULT_MAX_TOKENS,
    timeoutMs:
      Number.isFinite(timeoutMs) && timeoutMs >= MIN_TIMEOUT_MS && timeoutMs <= MAX_TIMEOUT_MS
        ? timeoutMs
        : DEFAULT_TIMEOUT_MS,
    // 历史上下文：history:false 为总开关；其余三项是范围与预算。
    history: config?.history !== false,
    historyTurns: clampInt(config?.historyTurns, MIN_HISTORY_TURNS, MAX_HISTORY_TURNS, DEFAULT_HISTORY_TURNS),
    historyMaxChars: clampInt(
      config?.historyMaxChars,
      MIN_HISTORY_MAX_CHARS,
      MAX_HISTORY_MAX_CHARS,
      DEFAULT_HISTORY_MAX_CHARS,
    ),
    historyPerMessageChars: clampInt(
      config?.historyPerMessageChars,
      MIN_HISTORY_PER_MESSAGE_CHARS,
      MAX_HISTORY_PER_MESSAGE_CHARS,
      DEFAULT_HISTORY_PER_MESSAGE_CHARS,
    ),
    // 总开关与保真/长度闸：默认全开；显式写 false 才关。
    enabled: config?.enabled !== false,
    fidelity: config?.fidelity !== false,
    maxExpansionRatio: clampFloat(
      config?.maxExpansionRatio,
      MIN_EXPANSION_RATIO,
      MAX_EXPANSION_RATIO,
      DEFAULT_MAX_EXPANSION_RATIO,
    ),
    // 模型来源覆盖：两个都要写才算数（只写一个会静默回落到会话默认模型）。
    provider: typeof config?.provider === 'string' && config.provider.trim() !== '' ? config.provider.trim() : undefined,
    model: typeof config?.model === 'string' && config.model.trim() !== '' ? config.model.trim() : undefined,
  };
}

/**
 * 给模型调用叠加一个宿主侧超时：用户取消与超时任一触发都会中止流。
 * AbortSignal.timeout / AbortSignal.any 需要 Node 20+；缺失时退化为只透传调用方 signal，
 * 也就是"没有超时但取消仍然有效"，不会把用户的取消能力弄丢。
 */
function withTimeout(signal, timeoutMs) {
  if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') {
    return { signal, timeoutSignal: null };
  }
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (signal) {
    return typeof AbortSignal.any === 'function'
      ? { signal: AbortSignal.any([signal, timeoutSignal]), timeoutSignal }
      : { signal, timeoutSignal };
  }
  return { signal: timeoutSignal, timeoutSignal };
}

/**
 * 会话消息 → 纯文本。只认 `type:'text'` 的内容块：
 * 工具调用 / 工具结果 / 图片块都不该进"语境"（它们对改写草稿没有帮助，还会吃掉预算）。
 */
function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}

/** 模型可见消息 → `[{ role:'user'|'assistant', text }]`，丢掉 system/developer/tool 与空文本。 */
function conversationOf(messages) {
  const out = [];
  if (!Array.isArray(messages)) return out;
  for (const message of messages) {
    const role = message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = messageText(message);
    if (text === '') continue;
    out.push({ role, text });
  }
  return out;
}

/**
 * 单条裁剪：保留头 40% + 尾 60%。
 * 尾重是因为长回答的结论、以及长提问里真正的诉求通常在末尾，砍尾会砍掉最有用的部分。
 */
function clipMiddle(text, limit) {
  if (text.length <= limit) return { text, clipped: false };
  const head = Math.max(1, Math.floor(limit * 0.4));
  const tail = Math.max(1, limit - head - 1);
  return { text: `${text.slice(0, head)}…${text.slice(text.length - tail)}`, clipped: true };
}

/** 切成"轮"：每遇到 user 消息开新的一轮，其后的 assistant 消息归入该轮。 */
function splitTurns(items) {
  const turns = [];
  for (const item of items) {
    if (item.role === 'user') turns.push([item]);
    else if (turns.length > 0) turns[turns.length - 1].push(item);
  }
  return turns;
}

/**
 * 选出要带给模型的历史。
 *
 * 取舍顺序（先便宜后昂贵）：
 *   1. 只取最近 N 轮（turns === 'all' 时不限轮数；
 *   2. 逐条做头尾裁剪；
 *   3. 还超预算就**整轮**丢弃最旧的一轮（不会留下孤儿 assistant 回复）；
 *   4. 只剩最后一轮时不再丢——宁可超预算也不能把语境丢空。
 *
 * @returns {{ lines: string[], chars: number, turns: number, totalTurns: number, dropped: number, clipped: number }}
 */
function selectHistory(items, options) {
  const all = splitTurns(items);
  const wanted = options.turns === 'all' ? all.length : Math.min(options.turns, all.length);
  let kept = all.slice(all.length - wanted);
  let dropped = all.length - kept.length;
  let clipped = 0;

  const render = () => {
    const lines = [];
    let chars = 0;
    let clipCount = 0;
    for (const turn of kept) {
      for (const item of turn) {
        const result = clipMiddle(item.text, options.perMessageChars);
        if (result.clipped) clipCount += 1;
        const line = `${item.role === 'user' ? '用户' : '助手'}：${result.text}`;
        lines.push(line);
        chars += line.length;
      }
    }
    return { lines, chars, clipCount };
  };

  let rendered = render();
  while (rendered.chars > options.maxChars && kept.length > 1) {
    kept = kept.slice(1);
    dropped += 1;
    rendered = render();
  }
  clipped = rendered.clipCount;
  return {
    lines: rendered.lines,
    chars: rendered.chars,
    turns: kept.length,
    totalTurns: all.length,
    dropped,
    clipped,
  };
}

/**
 * 读会话历史并拼成一段上下文。任何一步失败（没有 session、deriveMessages 抛错、
 * 消息结构不认识）都返回空文本——增强功能本身不能因为"读不到历史"而失败。
 */
function historyContextFor(agent, mode, options) {
  const empty = {
    text: '',
    turns: 0,
    totalTurns: 0,
    chars: 0,
    dropped: 0,
    clipped: 0,
    messages: 0,
    requested: mode,
    reason: 'off',
  };
  if (mode === 'off') return empty;
  const session = agent?.session;
  if (!session || typeof session.deriveMessages !== 'function') return { ...empty, reason: 'no-session' };
  let messages;
  try {
    messages = session.deriveMessages();
  } catch (error) {
    logFailure('session.deriveMessages failed:', toMessage(error));
    return { ...empty, reason: 'derive-failed' };
  }
  const items = conversationOf(messages);
  if (items.length === 0) return { ...empty, reason: 'empty' };

  const selected = selectHistory(items, {
    turns: mode === 'all' ? 'all' : options.historyTurns,
    maxChars: options.historyMaxChars,
    perMessageChars: options.historyPerMessageChars,
  });
  if (selected.lines.length === 0) return { ...empty, reason: 'empty' };
  return {
    ...selected,
    messages: items.length,
    requested: mode,
    reason: 'ok',
    text: [HISTORY_HEADER, ...selected.lines, HISTORY_FOOTER].join('\n'),
  };
}

/**
 * 核心实现：一次模型调用，返回可直接替换草稿的文本。
 * 入参是**明文草稿 + 可选的历史开关**（不关心它来自命令行的 base64url 还是 Agent 工具的参数字段），
 * 这样 UI 动作与将来的工具入口天然共用同一份逻辑。
 * @param {object} ctx Host 插件上下文
 * @param {{ text: string, history?: 'off' | 'all' }} request 用户草稿与本次的历史开关
 * @param {AbortSignal | undefined} signal 调用方取消信号
 * @param {{ temperature: number, maxTokens: number, timeoutMs: number }} options 已收敛的可调参数
 * @param {object | undefined} agent 命令调用方传入的 Agent（读会话历史用）
 * @returns {Promise<{kind:'success', text?: string} | {kind:'error', text: string}>}
 */
function usageSummary(usage) {
  if (usage === null || typeof usage !== 'object') return 'tokens=?';
  const pick = (value) => (Number.isFinite(value) ? value : '?');
  return `in=${pick(usage.inputTokens)} out=${pick(usage.outputTokens)} reasoning=${pick(usage.reasoningTokens)}`;
}

/**
 * 一次调用 = 一行日志。`req=` 由浏览器半生成、随 v2 载荷一起过来（旧载荷没有 id 时在这里补一个），
 * 两端用同一个值，定位时只需 grep 一次。
 * 只写 console.info：不改变任何对外行为、错误文案或返回值。
 */
function logOutcome(req, result, report, ms) {
  try {
    const history = report.history;
    const parts = [
      `req=${req}`,
      result.kind === 'success' ? 'ok' : 'fail',
      `reason=${report.reason ?? 'ok'}`,
      `ms=${ms}`,
      `provider=${report.provider ?? '-'}`,
      `model=${report.model ?? '-'}`,
      `modelSource=${report.modelSource ?? '-'}`,
      `finish=${report.finish ?? '-'}`,
      usageSummary(report.usage),
      `text=${result.kind === 'success' && typeof result.text === 'string' ? result.text.length : 0}`,
      `history=${history === undefined ? '-' : `${history.reason}/${history.turns}of${history.totalTurns}`}`,
      `historyChars=${history === undefined ? 0 : history.chars}`,
      `historyMessages=${history === undefined ? 0 : history.messages}`,
      `maxTokens=${report.maxTokens ?? '-'}`,
      `fidelity=${report.fidelity ?? '-'}`,
      `expand=${report.expand ?? '-'}`,
    ];
    console.info(LOG_PREFIX, parts.join(' '));
  } catch {
    /* 日志失败不影响结果 */
  }
}

async function enhanceText(ctx, request, signal, options, agent) {
  const startedAt = Date.now();
  const report = { maxTokens: options.maxTokens };
  const result = await runEnhance(ctx, request, signal, options, agent, report);
  logOutcome(request?.id ?? '-', result, report, Date.now() - startedAt);
  return result;
}

async function runEnhance(ctx, request, signal, options, agent, report) {
  const text = request?.text;
  const input = typeof text === 'string' ? text : '';
  if (!options.enabled) {
    report.reason = 'disabled';
    return { kind: 'error', text: 'Enhance prompt: disabled by plugin config.' };
  }
  if (input.trim() === '') {
    report.reason = 'empty-input';
    return { kind: 'error', text: 'Enhance prompt: empty input.' };
  }
  if (input.length > MAX_INPUT_CHARS) {
    report.reason = 'too-long';
    return { kind: 'error', text: `Enhance prompt: input too long (${input.length} > ${MAX_INPUT_CHARS} characters).` };
  }

  // 模型来源：config 里显式写了 provider+model 就覆盖，否则跟随会话默认模型。
  const selection = ctx.agentDefaultModel.currentSelection();
  const overridden = options.provider !== undefined && options.model !== undefined;
  const provider = overridden ? options.provider : selection?.provider;
  const model = overridden ? options.model : selection?.model;
  if (!provider || !model) {
    report.reason = 'no-model';
    return { kind: 'error', text: 'Enhance prompt: no default model selected.' };
  }
  report.provider = provider;
  report.model = model;
  report.modelSource = overridden ? 'config' : 'session';

  // 历史开关优先级：本次点击的修饰键 > config 总开关。
  const requested = request?.history;
  const mode = requested === 'off' || requested === 'all' ? requested : options.history ? 'auto' : 'off';
  const history = historyContextFor(agent, mode, options);
  report.history = history;
  // 每次点击都打一行：reason 决定"没带上下文"到底卡在哪一层
  // （off=总开关关 / no-session=命令没拿到会话 / derive-failed=读会话抛错 / empty=会话里没有可用文本 / ok=正常）。
  try {
    const detail = [`history: ${history.reason}`];
    if (history.turns > 0) detail.push(`${history.turns}/${history.totalTurns} turns`, `${history.chars} chars`);
    if (history.dropped > 0) detail.push(`dropped ${history.dropped} oldest turn(s)`);
    if (history.clipped > 0) detail.push(`clipped ${history.clipped} message(s)`);
    console.info(LOG_PREFIX, detail.join(' '));
  } catch {
    /* 日志失败不影响结果 */
  }

  const timeout = withTimeout(signal, options.timeoutMs);
  const timedOut = () => timeout.timeoutSignal !== null && timeout.timeoutSignal.aborted;
  const timeoutMessage = `Enhance prompt: timed out after ${Math.round(options.timeoutMs / 1000)}s.`;

  let accumulated = '';
  // 流式结局：finish 块的 reason 与 usage 块是判"为什么没正文"的唯一证据。
  let finishReason = null;
  let usage = null;
  try {
    const stream = ctx.llm.stream({
      provider,
      model,
      // ModelSelection 的可选思考档位（字段名已证实：dsh-agent-default-model/lib/index.js:38-44）。
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
      // 注意：GenerateOptions.system 是 RequestMessage 之外唯一的 system 通道
      // （RequestUserInput 只允许 role:'user'），所以这里必须用 system 而不是消息。
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: buildUserPrompt(input, history.text) }] }],
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      signal: timeout.signal,
    });

    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') accumulated += chunk.text;
      else if (chunk.type === 'finish') finishReason = chunk.reason;
      else if (chunk.type === 'usage') usage = chunk.usage;
    }
    report.finish = finishReason;
    report.usage = usage;
  } catch (error) {
    if (signal?.aborted) {
      report.reason = 'cancelled';
      return { kind: 'error', text: 'Enhance prompt: cancelled.' };
    }
    if (timedOut()) {
      report.reason = 'timeout';
      logFailure(timeoutMessage, toMessage(error));
      return { kind: 'error', text: timeoutMessage };
    }
    report.reason = 'stream-error';
    logFailure('model call failed:', toMessage(error));
    return { kind: 'error', text: `Enhance prompt failed: ${toMessage(error)}` };
  }

  if (signal?.aborted) {
    report.reason = 'cancelled';
    return { kind: 'error', text: 'Enhance prompt: cancelled.' };
  }
  if (timedOut()) {
    report.reason = 'timeout';
    logFailure(timeoutMessage, describeStreamOutcome(finishReason, usage, accumulated));
    return { kind: 'error', text: timeoutMessage };
  }

  // 适配器把调用失败表现为终止性的 error / aborted finish 块，而不是抛异常（llm 服务契约原文：
  // "Adapter selection, dispatch, and iteration failures become terminal error or aborted finish chunks"）。
  if (finishReason === 'error' || finishReason === 'aborted') {
    report.reason = `stream-${finishReason}`;
    logFailure('model stream ended with a failure', describeStreamOutcome(finishReason, usage, accumulated));
    return { kind: 'error', text: `Enhance prompt failed: model stream ended with ${finishReason}.` };
  }

  // 截断只用来挡"模型失控"，不能反过来吃掉用户原文：
  // 长草稿（超过 1600 字符）改写后理应允许同样长，否则用户会静默丢内容。
  // 上限仍是 MAX_INPUT_CHARS，与入口的长度限制保持一致。
  const outputLimit = Math.min(MAX_INPUT_CHARS, Math.max(MAX_OUTPUT_CHARS, input.length));
  const enhanced = clampEnhancedText(accumulated, outputLimit);
  if (enhanced === '') {
    const diagnostics = describeStreamOutcome(finishReason, usage, accumulated);
    if (finishReason === 'max-tokens') {
      report.reason = 'max-tokens';
      // 思考型模型的思考 token 也计入 maxTokens：预算耗尽时正文可能一个字都没有。
      logFailure('model hit the output token budget before producing text', diagnostics);
      return {
        kind: 'error',
        text: `Enhance prompt: model ran out of output budget (max-tokens, maxTokens=${options.maxTokens}).`,
      };
    }
    report.reason = 'empty-result';
    logFailure('model returned no usable text', diagnostics);
    return { kind: 'error', text: 'Enhance prompt: empty result.' };
  }
  // 保真闸 + 长度闸：都在"模型已返回、还没写回草稿"这一刻判断，不额外调用模型、不新增依赖。
  if (options.fidelity) {
    const missing = missingFidelityFacts(input, enhanced);
    if (missing.length > 0) {
      report.reason = 'fidelity';
      report.fidelity = `missing:${missing.length}`;
      logFailure('fidelity check failed', missing.join(', '));
      return {
        kind: 'error',
        text: `Enhance prompt: fidelity check failed (missing: ${missing
          .slice(0, MAX_FIDELITY_MISSING_SHOWN)
          .join(', ')}).`,
      };
    }
    const expansion = expansionVerdict(input, enhanced, options.maxExpansionRatio);
    if (expansion.over) {
      report.reason = 'too-verbose';
      report.fidelity = 'ok';
      report.expand = `${enhanced.length}>${expansion.limit}`;
      logFailure('result too long for the input', `${enhanced.length} chars > limit ${expansion.limit}`);
      return {
        kind: 'error',
        text: `Enhance prompt: result too long (${enhanced.length} chars vs ${input.length} input chars, limit ${expansion.ratio}x).`,
      };
    }
    report.fidelity = 'ok';
  }

  if (finishReason === 'max-tokens') {
    // 有正文但被截断：结果仍可用，留一行证据便于判断要不要提高 maxTokens。
    logFailure(
      'model hit the output token budget; result may be truncated',
      describeStreamOutcome(finishReason, usage, accumulated),
    );
  }
  report.reason = 'ok';
  return { kind: 'success', text: enhanced };
}

export function apply(ctx, config) {
  const options = readOptions(config);

  // 所有注册都是"属于某个 context 的 effect"，必须挂 ctx.effect 以便卸载时回收。
  ctx.effect(
    () =>
      ctx.commands.register({
        name: COMMAND_NAME,
        description: 'Rewrite a prompt with one model call and return the enhanced text (used by the composer button).',
        recordInput: false,
        handler: (invocation) =>
          enhanceText(ctx, decodeRequest(invocation.rawInput), invocation.signal, options, invocation.agent),
      }),
    'dsh-composer-enhance: command',
  );

  // ---------------------------------------------------------------------------
  // 可选的第二条入口：把同一份实现暴露成 Agent 工具。
  // 官方规范（cordis-plugin-development/references/user-actions.md）要求
  // 「UI 动作与 Agent 工具共享同一份实现，不得各写一套逻辑」，此处共用 enhanceText()。
  // 注意 enhanceText() 收的是 { text, history? }，不需要任何命令行编码。
  // 取消注释前请先确认 ToolDefinition 的 output.schema / render 形状。
  //
  // ctx.effect(() => ctx.tools.register({
  //   name: 'enhance_prompt',
  //   description: 'Rewrite a draft prompt into a clearer, more specific prompt.',
  //   parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  //   output: {
  //     schema: { type: 'string' },
  //     render: (_args, value) => [{ type: 'text', text: String(value) }],
  //   },
  //   execute: async (args, exec) => {
  //     const result = await enhanceText(ctx, { text: args.text }, exec.signal, options, exec.agent);
  //     if (result.kind !== 'success') throw new Error(result.text);
  //     return result.text;
  //   },
  // }), 'dsh-composer-enhance: tool');
  // ---------------------------------------------------------------------------
}
