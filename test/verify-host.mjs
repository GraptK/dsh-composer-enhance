/**
 * 宿主半（index.js / prompts.js）的离线验证脚本：只用 Node 标准库，不联网、无第三方依赖。
 * 覆盖三件事：静态检查、prompts.js 纯函数行为、index.js 宿主半的端到端行为（含超时/取消/错误）。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 用法：node test/verify-host.mjs [目标目录]；默认校验本脚本上一级目录（仓库根）。
const DIR = (process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url))).replace(/\\/g, '/').replace(/\/$/, '');
const url = (name) => pathToFileURL(`${DIR}/${name}`).href;
const abs = (name) => `${DIR}/${name}`;

let checks = 0;
function ok(label, fn) {
  fn();
  checks += 1;
  console.log(`  ok  ${label}`);
}
async function okAsync(label, fn) {
  await fn();
  checks += 1;
  console.log(`  ok  ${label}`);
}

console.log('\n[1] manifest 与文件清单');
const pkg = JSON.parse(readFileSync(abs('package.json'), 'utf8'));
ok('name / version / license / type', () => {
  assert.equal(pkg.name, 'dsh-composer-enhance');
  assert.equal(pkg.version, '0.4.0');
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.private, undefined, 'private 必须不存在');
});
ok('engines.node 与 engines.dsh（插件市场据此判定宿主兼容性）', () => {
  assert.equal(pkg.engines.node, '>=20');
  // dshmarket/lib/discovery-compatibility.js:36-58 manifestFacts() 读 engines.dsh（顶层优先）。
  // 用「>= 下界 < 上界」而不是 ^0.2.0-rc.2：semver 的 ^0.2.0-rc.2 不包含 0.3.x（预发布语义），
  // 而 DSH 的判定带 includePrerelease，写成区间才能同时容纳 0.2.x 与 0.3.x。
  assert.equal(pkg.engines.dsh, '>=0.2.0-rc.2 <1.0.0');
});
ok('每个 @deepseek-ai/dsh-* peer 区间一致，且都被 engines.dsh 覆盖', () => {
  const dshPeers = Object.entries(pkg.peerDependencies).filter(([k]) => k.startsWith('@deepseek-ai/dsh-'));
  assert.equal(dshPeers.length, 7);
  const ranges = new Set(dshPeers.map(([, v]) => v));
  assert.equal(ranges.size, 1, `peer 区间不一致: ${[...ranges].join(' | ')}`);
  // peer 是最小可用区间（^0.2.0-rc.2），engines 是宿主侧范围（放行 0.3.x）。
  assert.equal([...ranges][0], '^0.2.0-rc.2');
  assert.ok(pkg.engines.dsh.includes('<1.0.0'));
});
ok('dependencies 带 schemastery（Config 才是原生 schema）；它不是 peer，避免宿主再验一遍', () => {
  assert.equal(pkg.dependencies['@deepseek-ai/schemastery'], '^3.18.5');
  assert.equal(pkg.peerDependencies['@deepseek-ai/schemastery'], undefined);
});
ok('exports 每个目标都真实存在', () => {
  const targets = Object.values(pkg.exports).filter((v) => typeof v === 'string');
  for (const target of targets) {
    if (target.includes('*')) continue;
    assert.ok(existsSync(abs(target.replace(/^\.\//, ''))), `exports 指向不存在的文件: ${target}`);
  }
  assert.ok(existsSync(abs('index.js')));
});
ok('files 里的每一项都真实存在', () => {
  for (const entry of pkg.files) {
    if (entry.includes('*')) {
      for (const concrete of ['locale/zh.json', 'locale/en.json']) assert.ok(existsSync(abs(concrete)), concrete);
      continue;
    }
    assert.ok(existsSync(abs(entry)), `files 列了不存在的路径: ${entry}`);
  }
});
ok('scripts.prepublishOnly 覆盖三个 JS 产物', () => {
  assert.equal(pkg.scripts.prepublishOnly, 'node --check index.js && node --check prompts.js && node --check client.js');
});
ok('dsh 段完整（manifestVersion / bundle.patch / client）', () => {
  assert.equal(pkg.dsh.manifestVersion, 1);
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.deepEqual(pkg.dsh.client.inject, [
    '@deepseek-ai/dsh-api-remotes',
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-slots',
  ]);
});
ok('client.js 的 id / NS / 槽 id 与包名一致，且 CSS 前缀同步', () => {
  const client = readFileSync(abs('client.js'), 'utf8');
  assert.ok(client.includes("id: 'dsh-composer-enhance'"));
  assert.ok(client.includes("const NS = 'dsh-composer-enhance'"));
  assert.ok(client.includes("id: 'dsh-composer-enhance',\n            order: 10"));
  assert.ok(!/wb-enhance-prompt/.test(client), 'client.js 仍有旧包名');
  assert.ok(!/\.wb-/.test(client));
});
ok('client.js / index.js / prompts.js 没有残留旧包名或旧叙事', () => {
  for (const f of ['client.js', 'index.js', 'prompts.js', 'package.json', 'cordis.patch.yml', 'README.md']) {
    const text = readFileSync(abs(f), 'utf8');
    assert.ok(!/wb-enhance-prompt|WorkBuddy|workbuddy|逆向/.test(text), `${f} 仍有残留`);
  }
});

console.log('\n[2] prompts.js 纯函数');
const prompts = await import(url('prompts.js'));
ok('buildUserPrompt 只替换一次占位符', () => {
  const built = prompts.buildUserPrompt('hello');
  assert.ok(built.includes('hello'));
  assert.equal(built.match(/\{input\}/g), null);
  assert.equal(prompts.USER_PROMPT_TEMPLATE.match(/\{input\}/g).length, 1);
});
ok('两份提示词仍带全部语言规则（回归护栏）', () => {
  assert.ok(prompts.SYSTEM_PROMPT.includes('Language matching is the highest priority'));
  assert.equal((prompts.USER_PROMPT_TEMPLATE.match(/CRITICAL PRIORITY - LANGUAGE CONSISTENCY/g) || []).length, 1);
  for (const n of ['1.', '2.', '3.', '4.', '5.', '6.']) assert.ok(prompts.USER_PROMPT_TEMPLATE.includes(`\n${n} `));
  assert.equal((prompts.USER_PROMPT_TEMPLATE.match(/^\d\. /gm) || []).length, 14, '六条语言 + 八条产出要求');
});
ok('cleanupEnhancedText: trim / 引号 / label / 整段围栏', () => {
  assert.equal(prompts.cleanupEnhancedText('  hi  '), 'hi');
  assert.equal(prompts.cleanupEnhancedText('"hi"'), 'hi');
  assert.equal(prompts.cleanupEnhancedText('“中文”'), '中文');
  assert.equal(prompts.cleanupEnhancedText('Enhanced prompt: hi'), 'hi');
  assert.equal(prompts.cleanupEnhancedText('增强后的提示词：hi'), 'hi');
  assert.equal(prompts.cleanupEnhancedText('```\nhi\n```'), 'hi');
  assert.equal(prompts.cleanupEnhancedText('```markdown\nhi\n```'), 'hi');
  assert.equal(prompts.cleanupEnhancedText('Enhanced prompt:\n```\nhi\n```'), 'hi');
  assert.equal(prompts.cleanupEnhancedText('```\nEnhanced prompt: hi\n```'), 'hi');
});
ok('cleanupEnhancedText: 不破坏正文里本就存在的代码块', () => {
  const body = 'Write a function.\n```js\nconst a = 1;\n```';
  assert.equal(prompts.cleanupEnhancedText(body), body);
  const two = '```\nfirst\n```\n```\nsecond\n```';
  assert.equal(prompts.cleanupEnhancedText(two), two);
  assert.equal(prompts.cleanupEnhancedText('```\nunterminated'), '```\nunterminated');
});
ok('clampEnhancedText: 默认上限 1600，且先清洗再截断', () => {
  assert.equal(prompts.MAX_OUTPUT_CHARS, 1600);
  assert.equal(prompts.clampEnhancedText('x'.repeat(2000)).length, 1600);
  assert.equal(prompts.clampEnhancedText('"' + 'y'.repeat(10) + '"'), 'y'.repeat(10));
  assert.equal(prompts.clampEnhancedText('short', 3), 'sho');
});

console.log('\n[3] index.js 宿主半');
const host = await import(url('index.js'));
ok('导出契约', () => {
  assert.equal(host.name, 'dsh-composer-enhance');
  assert.deepEqual(host.inject, ['commands', 'llm', 'agentDefaultModel']);
  assert.equal(typeof host.apply, 'function');
  assert.equal(host.default, undefined, '不应有 default 导出');
});

ok('Config 是原生 schemastery schema（Config Inspect / 插件管理器据此投影出表单）', () => {
  const Config = host.Config;
  assert.notEqual(Config, undefined, 'Config 未导出：确认 dependencies 里的 @deepseek-ai/schemastery 已安装');
  // 判定条件逐字对应 dsh-tool-cordis/lib/types/config.js 的 isNativeConfigSchema()：
  // 带 Symbol.for('schemastery') 品牌、type 是字符串、meta 是对象。
  assert.equal(Reflect.get(Config, Symbol.for('schemastery')), true);
  assert.equal(typeof Reflect.get(Config, 'type'), 'string');
  const meta = Reflect.get(Config, 'meta');
  assert.ok(meta !== null && typeof meta === 'object', 'meta 必须是对象');
});

ok('Config 默认值 = readOptions 的默认值，且 schema 不做范围钳制', () => {
  const defaults = host.Config({});
  assert.deepEqual({ ...defaults }, {
    temperature: 0.3,
    maxTokens: 2048,
    timeoutMs: 60_000,
    history: true,
    historyTurns: 3,
    historyMaxChars: 3000,
    historyPerMessageChars: 800,
    enabled: true,
    fidelity: true,
    maxExpansionRatio: 2.5,
    provider: '',
    model: '',
  });
  // 越界值原样通过 schema：钳制仍由 readOptions 负责，
  // 这样"配置写错"依然是静默回落，而不是让插件激活失败。
  assert.equal(host.Config({ temperature: 9 }).temperature, 9);
});

const warnings = [];
const infos = [];
const realWarn = console.warn;
const realInfo = console.info;
console.warn = (...args) => warnings.push(args.join(' '));
console.info = (...args) => infos.push(args.join(' '));

function mount(config, behaviour = {}) {
  let definition = null;
  let streamOptions = null;
  const ctx = {
    effect: (fn) => {
      fn();
    },
    commands: {
      register: (def) => {
        definition = def;
        return () => {};
      },
    },
    agentDefaultModel: {
      currentSelection: () => (behaviour.noModel ? undefined : { provider: 'deepseek', model: 'chat', reasoningEffort: 'high' }),
    },
    llm: {
      stream: (options) => {
        streamOptions = options;
        return behaviour.stream ? behaviour.stream(options) : (async function* () {})();
      },
    },
  };
  host.apply(ctx, config);
  return {
    definition,
    get options() {
      return streamOptions;
    },
  };
}

const encode = (text) => Buffer.from(text, 'utf8').toString('base64url');
/** v2 载荷：浏览器半现在发 JSON；v1 的"纯草稿明文"仍要兼容。 */
const payload = (text, history) => encode(JSON.stringify(history === undefined ? { v: 2, text } : { v: 2, text, history }));
const call = (definition, rawInput, signal, agent) =>
  definition.handler({ rawInput, signal, agent: agent ?? { id: 's' }, commandId: 'c' });

await okAsync('命令注册与 recordInput:false', async () => {
  const m = mount(undefined);
  assert.equal(m.definition.name, 'enhance-prompt');
  assert.equal(m.definition.recordInput, false);
  assert.equal(typeof m.definition.handler, 'function');
});

await okAsync('空载荷 / 纯空白草稿 → empty input', async () => {
  const m = mount(undefined);
  assert.deepEqual(await call(m.definition, ''), { kind: 'error', text: 'Enhance prompt: empty input.' });
  assert.deepEqual(await call(m.definition, '   '), { kind: 'error', text: 'Enhance prompt: empty input.' });
  assert.deepEqual(await call(m.definition, '!!!not-base64!!!'), { kind: 'error', text: 'Enhance prompt: empty input.' });
  assert.deepEqual(await call(m.definition, encode('   \n  ')), { kind: 'error', text: 'Enhance prompt: empty input.' });
});

await okAsync('超长草稿 → input too long（8000 通过、8001 拒绝）', async () => {
  const m = mount(undefined, { stream: async function* () { yield { type: 'text-delta', text: 'ok' }; } });
  const tooLong = await call(m.definition, encode('x'.repeat(8001)));
  assert.match(tooLong.text, /^Enhance prompt: input too long \(8001 > 8000 characters\)\.$/);
  const justOk = await call(m.definition, encode('x'.repeat(8000)));
  assert.equal(justOk.kind, 'success');
});

await okAsync('没有默认模型 → no default model selected', async () => {
  const m = mount(undefined, { noModel: true });
  assert.deepEqual(await call(m.definition, encode('hi')), { kind: 'error', text: 'Enhance prompt: no default model selected.' });
});

await okAsync('成功路径：拼接 delta → 清洗 → success，并透传模型与思考档位', async () => {
  const m = mount(undefined, {
    stream: async function* () {
      yield { type: 'text-delta', text: '```\nEnhanced prompt: ' };
      yield { type: 'text-delta', text: '写一份周报\n```' };
      yield { type: 'tool-call', text: 'ignored' };
    },
  });
  const result = await call(m.definition, encode('周报'), undefined);
  assert.deepEqual(result, { kind: 'success', text: '写一份周报' });
  assert.equal(m.options.provider, 'deepseek');
  assert.equal(m.options.model, 'chat');
  assert.equal(m.options.reasoningEffort, 'high');
  assert.equal(m.options.temperature, 0.3);
  assert.equal(m.options.maxTokens, 2048);
  assert.equal(m.options.system, prompts.SYSTEM_PROMPT);
  assert.ok(m.options.messages[0].content[0].text.includes('周报'));
});

await okAsync('长草稿：结果上限按原文放宽，短草稿仍按 1600 兜底', async () => {
  // 3000 字符草稿改写成的 2500 字符结果必须完整保留（旧行为会静默截到 1600 = 丢内容）。
  const m = mount(undefined, { stream: async function* () { yield { type: 'text-delta', text: 'b'.repeat(2500) }; } });
  const preserved = await call(m.definition, encode('a'.repeat(3000)), undefined);
  assert.equal(preserved.kind, 'success');
  assert.equal(preserved.text.length, 2500, '长草稿的改写结果被截断了');

  // 短草稿不受影响：仍然只保留 MAX_OUTPUT_CHARS。
  const m2 = mount(undefined, { stream: async function* () { yield { type: 'text-delta', text: 'c'.repeat(4000) }; } });
  const clamped = await call(m2.definition, encode('hi'), undefined);
  assert.equal(clamped.text.length, 1600);

  // 放宽也有上限：最长草稿最多拿到 MAX_INPUT_CHARS。
  const m3 = mount(undefined, { stream: async function* () { yield { type: 'text-delta', text: 'd'.repeat(9000) }; } });
  const capped = await call(m3.definition, encode('e'.repeat(8000)), undefined);
  assert.equal(capped.text.length, 8000);
});

await okAsync('模型抛错 → failed: <detail>，且写了宿主日志', async () => {
  warnings.length = 0;
  const m = mount(undefined, {
    stream: () => (async function* () { throw new Error('boom'); })(),
  });
  const result = await call(m.definition, encode('hi'), undefined);
  assert.deepEqual(result, { kind: 'error', text: 'Enhance prompt failed: boom' });
  assert.equal(warnings.length, 1, '意外失败应留下一行宿主日志');
});

await okAsync('模型返回空文本 → empty result，且写了宿主日志', async () => {
  warnings.length = 0;
  const m = mount(undefined, {
    stream: async function* () { yield { type: 'text-delta', text: '   ' }; },
  });
  assert.deepEqual(await call(m.definition, encode('hi'), undefined), { kind: 'error', text: 'Enhance prompt: empty result.' });
  assert.equal(warnings.length, 1);
});

await okAsync('finish=max-tokens 且无正文 → 预算文案（不再笼统报 empty result），日志带 finish/usage', async () => {
  warnings.length = 0;
  const m = mount(undefined, {
    stream: async function* () {
      yield { type: 'usage', usage: { inputTokens: 900, outputTokens: 2048, reasoningTokens: 2048 } };
      yield { type: 'finish', reason: 'max-tokens' };
    },
  });
  assert.deepEqual(await call(m.definition, encode('hi'), undefined), {
    kind: 'error',
    text: 'Enhance prompt: model ran out of output budget (max-tokens, maxTokens=2048).',
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /max-tokens/, '日志必须写明结束原因');
  assert.match(warnings[0], /reasoningTokens=2048/, '日志必须带思考用量，才能看出预算被思考吃光');
});

await okAsync('finish=error → 显式失败（适配器用终止块报错，不抛异常）', async () => {
  warnings.length = 0;
  const m = mount(undefined, {
    stream: async function* () { yield { type: 'finish', reason: 'error' }; },
  });
  assert.deepEqual(await call(m.definition, encode('hi'), undefined), {
    kind: 'error',
    text: 'Enhance prompt failed: model stream ended with error.',
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /finish=error/);
});

await okAsync('finish=max-tokens 但有正文 → 仍然成功，另记一行"可能被截断"证据', async () => {
  warnings.length = 0;
  const m = mount(undefined, {
    stream: async function* () {
      yield { type: 'text-delta', text: '写好的提示词' };
      yield { type: 'finish', reason: 'max-tokens' };
    },
  });
  assert.deepEqual(await call(m.definition, encode('周报'), undefined), { kind: 'success', text: '写好的提示词' });
  assert.equal(warnings.length, 1, '截断仍要留证据');
  assert.match(warnings[0], /truncated/);
});

await okAsync('用户取消 → cancelled，且不写日志', async () => {
  warnings.length = 0;
  const controller = new AbortController();
  const m = mount(undefined, {
    stream: async function* (options) {
      for (let i = 0; i < 50; i += 1) {
        if (options.signal?.aborted) {
          const error = new Error('aborted');
          error.name = 'AbortError';
          throw error;
        }
        await new Promise((r) => setTimeout(r, 20));
        yield { type: 'text-delta', text: 'x' };
      }
    },
  });
  setTimeout(() => controller.abort(), 60);
  assert.deepEqual(await call(m.definition, encode('hi'), controller.signal), { kind: 'error', text: 'Enhance prompt: cancelled.' });
  assert.equal(warnings.length, 0, '用户取消不刷日志');
});

await okAsync('宿主超时 → timed out（config.timeoutMs 生效），且写了宿主日志', async () => {
  warnings.length = 0;
  const m = mount({ timeoutMs: 1000 }, {
    stream: async function* (options) {
      for (let i = 0; i < 100; i += 1) {
        if (options.signal?.aborted) {
          const error = new Error('aborted');
          error.name = 'TimeoutError';
          throw error;
        }
        await new Promise((r) => setTimeout(r, 50));
        yield { type: 'text-delta', text: 'x' };
      }
    },
  });
  const result = await call(m.definition, encode('hi'), undefined);
  assert.deepEqual(result, { kind: 'error', text: 'Enhance prompt: timed out after 1s.' });
  assert.equal(warnings.length, 1);
});

await okAsync('config 收敛：非法值回落默认，合法值生效', async () => {
  const bad = mount({ temperature: 99, maxTokens: 0, timeoutMs: 'soon' }, { stream: async function* () {} });
  await call(bad.definition, encode('hi'), undefined);
  assert.equal(bad.options.temperature, 0.3);
  assert.equal(bad.options.maxTokens, 2048);

  const good = mount({ temperature: 0.9, maxTokens: 4096, timeoutMs: 5000 }, { stream: async function* () {} });
  await call(good.definition, encode('hi'), undefined);
  assert.equal(good.options.temperature, 0.9);
  assert.equal(good.options.maxTokens, 4096);

  const nan = mount({ temperature: Number.NaN, maxTokens: 1.5 }, { stream: async function* () {} });
  await call(nan.definition, encode('hi'), undefined);
  assert.equal(nan.options.temperature, 0.3);
  assert.equal(nan.options.maxTokens, 2048);
});

await okAsync('取消信号被合并进 llm.stream（不是原样透传 null）', async () => {
  const controller = new AbortController();
  const m = mount(undefined, { stream: async function* () {} });
  await call(m.definition, encode('hi'), controller.signal);
  assert.ok(m.options.signal instanceof AbortSignal);
  controller.abort();
  assert.equal(m.options.signal.aborted, true, '调用方取消必须能传到流里');
});

console.log('\n[3] 会话历史上下文');

const textMsg = (role, text) => ({ role, content: [{ type: 'text', text }] });
const sessionOf = (messages) => ({
  deriveMessages: () => messages,
});
const agentWith = (messages) => ({ id: 's', session: sessionOf(messages) });
/** 造 n 轮：每轮 user + assistant。 */
const turnsOf = (n) => {
  const out = [];
  for (let i = 1; i <= n; i += 1) {
    out.push(textMsg('user', `问题${i}`), textMsg('assistant', `回答${i}`));
  }
  return out;
};
const promptTextOf = (m) => m.options.messages[0].content[0].text;

await okAsync('没有 session 时提示词与旧版逐字节一致（不含历史头）', async () => {
  const m = mount(undefined, { stream: async function* () { yield { type: 'text-delta', text: 'ok' }; } });
  await call(m.definition, payload('周报'));
  assert.equal(promptTextOf(m), prompts.buildUserPrompt('周报'));
});

await okAsync('有历史时：模型看到「历史头 + 用户/助手行 + 草稿」，而回写结果只有改写后的草稿', async () => {
  const m = mount(undefined, { stream: async function* () { yield { type: 'text-delta', text: '改写结果' }; } });
  const result = await call(m.definition, payload('周报'), undefined, agentWith(turnsOf(2)));
  assert.deepEqual(result, { kind: 'success', text: '改写结果' });
  const prompt = promptTextOf(m);
  assert.ok(prompt.startsWith('【本会话最近的对话'), prompt.slice(0, 40));
  assert.ok(prompt.includes('【历史记录结束】'));
  assert.ok(prompt.includes('用户：问题1') && prompt.includes('助手：回答2'));
  assert.ok(prompt.includes('周报'), '草稿仍要出现在提示词里');
  assert.equal(result.text, '改写结果', '历史不得混进回写草稿');
});

await okAsync('默认只带最近 3 轮（更早的轮次不进提示词）', async () => {
  const m = mount(undefined, { stream: async function* () { yield { type: 'text-delta', text: 'ok' }; } });
  await call(m.definition, payload('草稿'), undefined, agentWith(turnsOf(5)));
  const prompt = promptTextOf(m);
  for (const n of [3, 4, 5]) assert.ok(prompt.includes(`问题${n}`), `缺少第 ${n} 轮`);
  for (const n of [1, 2]) assert.ok(!prompt.includes(`问题${n}`), `不该带第 ${n} 轮`);
});

await okAsync('history:"off" 本次不带历史；history:"all" 带全部轮次', async () => {
  const off = mount(undefined, { stream: async function* () { yield { type: 'text-delta', text: 'ok' }; } });
  await call(off.definition, payload('草稿', 'off'), undefined, agentWith(turnsOf(5)));
  assert.equal(promptTextOf(off), prompts.buildUserPrompt('草稿'));

  const all = mount(undefined, { stream: async function* () { yield { type: 'text-delta', text: 'ok' }; } });
  await call(all.definition, payload('草稿', 'all'), undefined, agentWith(turnsOf(5)));
  for (const n of [1, 2, 5]) assert.ok(promptTextOf(all).includes(`问题${n}`), `all 模式缺少第 ${n} 轮`);
});

await okAsync('历史预算：超预算整轮丢弃最旧的一轮（不会留孤儿助手回复）', async () => {
  const longTurns = [];
  for (let i = 1; i <= 6; i += 1) {
    longTurns.push(textMsg('user', `问题${i}${'x'.repeat(28)}`), textMsg('assistant', `回答${i}${'y'.repeat(28)}`));
  }
  // historyMaxChars 下限是 200（更小的值会被收敛），所以这里用足够长的消息把总字数推过去。
  const m = mount({ historyTurns: 6, historyMaxChars: 200 }, { stream: async function* () { yield { type: 'text-delta', text: 'ok' }; } });
  await call(m.definition, payload('草稿'), undefined, agentWith(longTurns));
  const prompt = promptTextOf(m);
  assert.ok(prompt.includes('问题6'), '最新一轮必须保留');
  assert.ok(!prompt.includes('问题4'), '超预算时最旧的一轮应被丢弃');
  assert.ok(!prompt.includes('回答4'), '丢弃必须整轮：不能留孤儿 assistant 行');
});

await okAsync('单条超长消息做头尾裁剪（保留头 40% + 尾 60%，中间用 …）', async () => {
  const long = `HEAD-${'隔'.repeat(500)}-TAIL`;
  const m = mount({ historyPerMessageChars: 120, historyMaxChars: 3000 }, { stream: async function* () { yield { type: 'text-delta', text: 'ok' }; } });
  await call(m.definition, payload('草稿'), undefined, agentWith([textMsg('user', '问'), textMsg('assistant', long)]));
  const prompt = promptTextOf(m);
  assert.ok(prompt.includes('HEAD-'), '应保留开头');
  assert.ok(prompt.includes('-TAIL'), '应保留结尾');
  assert.ok(prompt.includes('…'), '裁剪处应有省略号');
  assert.ok(!prompt.includes('隔'.repeat(200)), '中间大段必须被裁掉');
});

await okAsync('只认 text 块：工具调用/工具结果不进历史，空文本消息被跳过', async () => {
  const messages = [
    textMsg('user', '问题'),
    { role: 'assistant', content: [{ type: 'tool-call', id: 't1', name: 'read', arguments: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', text: '不该出现' }] },
    textMsg('assistant', '结论'),
    textMsg('system', '系统提示不该进历史'),
  ];
  const m = mount(undefined, { stream: async function* () { yield { type: 'text-delta', text: 'ok' }; } });
  await call(m.definition, payload('草稿'), undefined, agentWith(messages));
  const prompt = promptTextOf(m);
  assert.ok(prompt.includes('结论'));
  assert.ok(!prompt.includes('不该出现'), 'tool 结果不能进历史');
  assert.ok(!prompt.includes('系统提示不该进历史'));
});

await okAsync('deriveMessages 抛错 / 返回怪形状 → 静默降级为纯草稿，增强照常成功', async () => {
  const throwing = { id: 's', session: { deriveMessages: () => { throw new Error('boom'); } } };
  const m = mount(undefined, { stream: async function* () { yield { type: 'text-delta', text: 'ok' }; } });
  warnings.length = 0;
  const result = await call(m.definition, payload('草稿'), undefined, throwing);
  assert.deepEqual(result, { kind: 'success', text: 'ok' });
  assert.equal(promptTextOf(m), prompts.buildUserPrompt('草稿'));
  assert.equal(warnings.length, 1, '读历史失败应留一行宿主日志');

  const weird = { id: 's', session: { deriveMessages: () => 'not-an-array' } };
  const m2 = mount(undefined, { stream: async function* () { yield { type: 'text-delta', text: 'ok' }; } });
  assert.equal((await call(m2.definition, payload('草稿'), undefined, weird)).kind, 'success');
  assert.equal(promptTextOf(m2), prompts.buildUserPrompt('草稿'));
});

await okAsync('config：history:false 关掉历史；数值越界被收敛（轮数 ≤12）', async () => {
  const off = mount({ history: false }, { stream: async function* () { yield { type: 'text-delta', text: 'ok' }; } });
  await call(off.definition, payload('草稿'), undefined, agentWith(turnsOf(2)));
  assert.equal(promptTextOf(off), prompts.buildUserPrompt('草稿'));

  const many = mount({ historyTurns: 99 }, { stream: async function* () { yield { type: 'text-delta', text: 'ok' }; } });
  await call(many.definition, payload('草稿'), undefined, agentWith(turnsOf(20)));
  const prompt = promptTextOf(many);
  assert.ok(prompt.includes('问题20'), '最新一轮必须在');
  assert.ok(!prompt.includes('问题8'), '轮数上限必须收敛到 12（第 8 轮应被收敛值挡掉）');
  assert.ok(prompt.includes('问题9'), '第 9 轮应在 12 轮窗口内');
});

await okAsync('每次点击都打一行 history: <reason>（off / no-session / ok），定位"为什么没带上下文"', async () => {
  infos.length = 0;
  const offMode = mount({ history: false }, { stream: async function* () { yield { type: 'text-delta', text: 'ok' }; } });
  await call(offMode.definition, payload('草稿'), undefined, agentWith(turnsOf(2)));
  assert.ok(infos.some((line) => line.includes('history: off')), infos.join(' | '));

  infos.length = 0;
  const noSession = mount(undefined, { stream: async function* () { yield { type: 'text-delta', text: 'ok' }; } });
  await call(noSession.definition, payload('草稿'), undefined, { id: 's' });
  assert.ok(infos.some((line) => line.includes('history: no-session')), infos.join(' | '));

  infos.length = 0;
  const okMode = mount(undefined, { stream: async function* () { yield { type: 'text-delta', text: 'ok' }; } });
  await call(okMode.definition, payload('草稿'), undefined, agentWith(turnsOf(2)));
  assert.ok(
    infos.some((line) => line.includes('history: ok') && line.includes('2/2 turns')),
    infos.join(' | '),
  );
});

console.log('\n[4] 批 1：关联 ID / 载荷自识别 / 结构化日志');

await okAsync('v2 载荷里的 id 会变成日志里的同一个 req=（浏览器与宿主两端可对齐）', async () => {
  infos.length = 0;
  const m = mount(undefined, { stream: async function* () { yield { type: 'text-delta', text: 'ok' }; } });
  await call(m.definition, encode(JSON.stringify({ v: 2, text: '周报', id: 'ab12cd' })));
  const line = infos.find((text) => text.includes('req=ab12cd'));
  assert.ok(line, infos.join(' | '));
  assert.match(line, / ok /);
});

await okAsync('旧 v2 载荷没有 id：宿主自动补一个 6 位 req=（不改变载荷语义）', async () => {
  infos.length = 0;
  const m = mount(undefined, { stream: async function* () { yield { type: 'text-delta', text: 'ok' }; } });
  await call(m.definition, payload('草稿'));
  assert.ok(
    infos.some((line) => /req=[a-z0-9]{6} ok /.test(line)),
    infos.join(' | '),
  );
});

await okAsync('成功路径也留一行结构化日志（provider/model/finish/tokens/text/ms/history）', async () => {
  infos.length = 0;
  const m = mount(undefined, {
    stream: async function* () {
      yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 22, reasoningTokens: 33 } };
      yield { type: 'text-delta', text: '改写结果' };
      yield { type: 'finish', reason: 'stop' };
    },
  });
  await call(m.definition, payload('草稿'), undefined, agentWith(turnsOf(2)));
  const line = infos.find((text) => text.includes('reason=ok'));
  assert.ok(line, infos.join(' | '));
  for (const piece of [
    'reason=ok',
    'provider=deepseek',
    'model=chat',
    'finish=stop',
    'in=11',
    'out=22',
    'reasoning=33',
    'text=4',
    'maxTokens=2048',
    'history=ok/2of2',
    'historyMessages=4',
  ]) {
    assert.ok(line.includes(piece), `日志缺少 ${piece}: ${line}`);
  }
  assert.match(line, /ms=\d+/);
});

await okAsync('失败路径的日志带 reason=（empty-result / no-model），与成功日志同格式', async () => {
  infos.length = 0;
  const emptyResult = mount(undefined, { stream: async function* () { yield { type: 'text-delta', text: '   ' }; } });
  await call(emptyResult.definition, payload('草稿'));
  assert.ok(
    infos.some((line) => line.includes('fail') && line.includes('reason=empty-result')),
    infos.join(' | '),
  );

  infos.length = 0;
  const noModel = mount(undefined, { noModel: true });
  await call(noModel.definition, payload('草稿'));
  assert.ok(
    infos.some((line) => line.includes('reason=no-model')),
    infos.join(' | '),
  );
});

await okAsync('载荷自识别：v1（base64url 明文）仍可用；纯 ASCII 明文不会被解成乱码', async () => {
  const m = mount(undefined, { stream: async function* () { yield { type: 'text-delta', text: 'ok' }; } });
  assert.deepEqual(await call(m.definition, encode('旧版明文稿')), { kind: 'success', text: 'ok' });
  assert.ok(promptTextOf(m).includes('旧版明文稿'));

  // 'abc-123' 全由 base64url 字符组成，但解码不是合法 UTF-8：必须按非法载荷处理（走既有空输入文案），
  // 而不是把解码出的乱码当成草稿送去改写。
  const junk = mount(undefined, { stream: async function* () { yield { type: 'text-delta', text: 'ok' }; } });
  assert.deepEqual(await call(junk.definition, 'abc-123'), { kind: 'error', text: 'Enhance prompt: empty input.' });
});

await okAsync('历史诊断：日志带 history=<reason>/<kept>of<total>、historyChars、historyMessages', async () => {
  infos.length = 0;
  const m = mount(undefined, { stream: async function* () { yield { type: 'text-delta', text: 'ok' }; } });
  await call(m.definition, payload('草稿'), undefined, agentWith(turnsOf(2)));
  const line = infos.find((text) => text.includes('reason=ok'));
  assert.ok(line.includes('history=ok/2of2'), line);
  assert.match(line, /historyChars=\d+/);
  assert.ok(line.includes('historyMessages=4'), line);

  infos.length = 0;
  const off = mount({ history: false }, { stream: async function* () { yield { type: 'text-delta', text: 'ok' }; } });
  await call(off.definition, payload('草稿'), undefined, agentWith(turnsOf(2)));
  assert.ok(
    infos.some((text) => text.includes('history=off/0of0')),
    infos.join(' | '),
  );

  infos.length = 0;
  const noSession = mount(undefined, { stream: async function* () { yield { type: 'text-delta', text: 'ok' }; } });
  await call(noSession.definition, payload('草稿'), undefined, { id: 's' });
  assert.ok(
    infos.some((text) => text.includes('history=no-session/0of0')),
    infos.join(' | '),
  );
});

// ---- [5] 批 2（S1–S5）：保真闸 / 长度闸 / 总开关 / 模型覆盖 ----

const FIDELITY_INPUT =
  '把 `src/app.ts` 里的 `loadUser()` 改成 v1.2.3 的签名，参考 https://api.example.com/docs ，别动 ProseMirror 那部分。';

await okAsync('保真闸（S1）：硬事实丢失 → 硬失败，不写回，日志 fidelity=missing:N', async () => {
  infos.length = 0;
  const m = mount(undefined, { stream: async function* () { yield { type: 'text-delta', text: '把用户加载函数改写得更清楚一些。' }; } });
  const result = await call(m.definition, payload(FIDELITY_INPUT));
  assert.equal(result.kind, 'error');
  assert.match(result.text, /^Enhance prompt: fidelity check failed \(missing: /);
  // 缺失清单里必须点出被吃掉的硬事实（最多 5 条，超出部分以省略号截断）。
  assert.ok(result.text.includes('src/app.ts'), result.text);
  assert.match(result.text, /missing: .+\)\.$/);
  const line = infos.find((text) => text.includes('reason=fidelity'));
  assert.ok(line && line.includes('fidelity=missing:'), line);
});

await okAsync('保真闸（S1）：URL 不重复计入"路径"事实（缺失清单去子串噪音）', async () => {
  infos.length = 0;
  const m = mount(undefined, { stream: async function* () { yield { type: 'text-delta', text: '参考文档即可。' }; } });
  const result = await call(m.definition, payload('参考 https://api.example.com/docs 这里，别改链接。'));
  assert.equal(result.kind, 'error');
  const list = result.text.match(/\(missing: (.*)\)\.$/);
  assert.ok(list, result.text);
  assert.deepEqual(list[1].split(', '), ['https://api.example.com/docs']);
});

await okAsync('保真闸（S1）：硬事实全部保留 → 成功，日志 fidelity=ok', async () => {
  infos.length = 0;
  const kept = '把 `src/app.ts` 里的 `loadUser()` 改成 v1.2.3 的签名，参考 https://api.example.com/docs ，别动 ProseMirror 那部分，只改签名。';
  const m = mount(undefined, { stream: async function* () { yield { type: 'text-delta', text: kept }; } });
  const result = await call(m.definition, payload(FIDELITY_INPUT));
  assert.equal(result.kind, 'success');
  const line = infos.find((text) => text.includes('reason=ok'));
  assert.ok(line.includes('fidelity=ok'), line);
  assert.ok(line.includes('modelSource=session'), line);
});

await okAsync('保真闸可关：config fidelity:false 时即使丢事实也成功', async () => {
  const m = mount({ fidelity: false }, { stream: async function* () { yield { type: 'text-delta', text: '把用户加载函数改写得更清楚一些。' }; } });
  const result = await call(m.definition, payload(FIDELITY_INPUT));
  assert.equal(result.kind, 'success');
});

await okAsync('长度闸（S1）：输出超过 2.5x → 硬失败，日志 expand=N>limit', async () => {
  infos.length = 0;
  const input = '请把这段说明改得更清楚：' + '这段描述需要保持原意但更具体一些。'.repeat(4);
  assert.ok(input.length >= 80, '用例输入必须越过长度闸的最小输入阈值');
  const verbose = '改写后的说明：' + '更具体的细节'.repeat(220);
  const m = mount(undefined, { stream: async function* () { yield { type: 'text-delta', text: verbose }; } });
  const result = await call(m.definition, payload(input));
  assert.equal(result.kind, 'error');
  assert.match(result.text, /^Enhance prompt: result too long \(\d+ chars vs \d+ input chars, limit 2\.5x\)\.$/);
  const line = infos.find((text) => text.includes('reason=too-verbose'));
  assert.ok(line && /expand=\d+>\d+/.test(line), line);
});

await okAsync('长度闸：短输入（<80 字符）不做比例校验，只受输出上限约束', async () => {
  const m = mount(undefined, { stream: async function* () { yield { type: 'text-delta', text: '加'.repeat(300) }; } });
  const result = await call(m.definition, payload('天气怎么样'));
  assert.equal(result.kind, 'success');
});

await okAsync('总开关（S5）：config enabled:false → 直接拒绝，不调模型', async () => {
  infos.length = 0;
  const m = mount({ enabled: false }, { stream: async function* () { yield { type: 'text-delta', text: '不该被调用' }; } });
  assert.deepEqual(await call(m.definition, payload('草稿')), {
    kind: 'error',
    text: 'Enhance prompt: disabled by plugin config.',
  });
  const line = infos.find((text) => text.includes('reason=disabled'));
  assert.ok(line, infos.join(' | '));
});

await okAsync('模型覆盖（S5）：config 里 provider+model 都给了才生效，日志 modelSource=config', async () => {
  infos.length = 0;
  const m = mount({ provider: 'kimi', model: 'kimi-k2.6' }, { stream: async function* () { yield { type: 'text-delta', text: '改写好了' }; } });
  await call(m.definition, payload('草稿'));
  assert.equal(m.options.provider, 'kimi');
  assert.equal(m.options.model, 'kimi-k2.6');
  assert.equal(m.options.reasoningEffort, 'high', '覆盖模型时仍沿用宿主会话的思考档位');
  const line = infos.find((text) => text.includes('reason=ok'));
  assert.ok(line.includes('provider=kimi'), line);
  assert.ok(line.includes('model=kimi-k2.6'), line);
  assert.ok(line.includes('modelSource=config'), line);

  // 只给一半（provider 或 model 缺一个）时忽略覆盖，避免半覆盖造成 404。
  const half = mount({ provider: 'kimi' }, { stream: async function* () { yield { type: 'text-delta', text: '改写好了' }; } });
  await call(half.definition, payload('草稿'));
  assert.equal(half.options.provider, 'deepseek');
  assert.equal(half.options.model, 'chat');
});

await ok('Config（S1/S5）：新键都在，且默认值与 readOptions 一致', () => {
  const defaults = host.Config({});
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.fidelity, true);
  assert.equal(defaults.maxExpansionRatio, 2.5);
  assert.equal(defaults.provider, '');
  assert.equal(defaults.model, '');
  assert.equal(Object.keys({ ...defaults }).length, 12);
});

console.warn = realWarn;
console.info = realInfo;
console.log(`\n全部通过：${checks} 项检查\n`);
