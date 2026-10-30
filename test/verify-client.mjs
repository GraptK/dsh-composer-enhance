/**
 * 浏览器半（client.js）的离线验证：在 vm 里模拟 __ModuleLoader__ / document / React，
 * 覆盖模块注册、locale 字典、槽注册、宿主错误文案本地化、按钮的全部点击与失败路径，
 * 以及 useEffect 的依赖语义（失败态随草稿清除、会话切换中止在途请求）。不联网、无第三方依赖。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// 用法：node test/verify-client.mjs [目标目录]；默认校验本脚本上一级目录（仓库根）。
const DIR = (process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url))).replace(/\\/g, '/').replace(/\/$/, '');
const SRC = readFileSync(`${DIR}/client.js`, 'utf8');

let checks = 0;
function ok(label, fn) {
  fn();
  checks += 1;
  console.log(`  ok  ${label}`);
}

// ---------------------------------------------------------------- 迷你 React
// 需要支持"同一实例的连续渲染"才能验证 useEffect 的依赖语义（失败态随草稿清除、会话切换中止在途请求），
// 所以这里按 hook 槽位记录依赖，并在 flush() 时按依赖决定是否重跑（含 cleanup）。
function makeReact() {
  const cells = [];
  const sets = [];
  const effectSlots = [];
  let pending = [];
  let index = 0;
  const sameDeps = (a, b) =>
    Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, k) => Object.is(value, b[k]));
  return {
    sets,
    /** 全新挂载：丢掉 state 与 effect 槽位（不跑 cleanup）。 */
    reset: () => {
      index = 0;
      cells.length = 0;
      effectSlots.length = 0;
      pending = [];
    },
    /** 一次渲染开始；同实例重渲染时 cells / effectSlots 保留。 */
    begin: () => {
      index = 0;
      pending = [];
    },
    /** 渲染结束：依赖变化的 effect 先跑 cleanup 再跑本体。 */
    flush: () => {
      for (const slot of pending) {
        const previous = effectSlots[slot.i];
        if (previous !== undefined && sameDeps(previous.deps, slot.deps)) continue;
        if (previous !== undefined && typeof previous.cleanup === 'function') previous.cleanup();
        const cleanup = slot.fn();
        effectSlots[slot.i] = { deps: slot.deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined };
      }
      pending = [];
    },
    api: {
      createElement: (type, props, ...children) => ({ type, props: Object.assign({}, props, { children }) }),
      useState: (init) => {
        const i = index++;
        if (!(i in cells)) cells[i] = typeof init === 'function' ? init() : init;
        return [
          cells[i],
          (value) => {
            sets.push([i, value]);
            cells[i] = value;
          },
        ];
      },
      useRef: (init) => {
        const i = index++;
        if (!(i in cells)) cells[i] = { current: init };
        return cells[i];
      },
      useEffect: (fn, deps) => {
        const i = index++;
        pending.push({ i, fn, deps });
      },
    },
  };
}

// ---------------------------------------------------------------- 装载 client.js
const styles = [];
let captured = null;
/** 当前浏览器选区（由局部增强的用例设置；null = 没有选区）。 */
let currentSelection = null;

function makeDocument() {
  return {
    querySelector: () => null,
    createElement: () => {
      const tag = { dataset: {}, textContent: '' };
      return tag;
    },
    head: {
      appendChild: (tag) => {
        styles.push(tag);
      },
    },
  };
}

const sandbox = vm.createContext({
  window: {
    // 局部增强要用浏览器的 Selection；默认没有选区 = 退回整段增强。
    getSelection: () => currentSelection,
    __ModuleLoader__: {
      load: (definition) => {
        captured = definition;
      },
    },
  },
  document: makeDocument(),
  TextEncoder,
  AbortController,
  AbortSignal,
  setTimeout,
  clearTimeout,
  btoa: (binary) => Buffer.from(binary, 'binary').toString('base64'),
  console,
});
vm.runInContext(SRC, sandbox, { filename: 'client.js' });

console.log('\n[4] client.js 浏览器半');

ok('通过 window.__ModuleLoader__.load 注册，且 id 等于包名', () => {
  assert.ok(captured !== null, 'client.js 没有调用 __ModuleLoader__.load');
  assert.equal(captured.id, 'dsh-composer-enhance');
  assert.equal(typeof captured.factory, 'function');
});

// ---------------------------------------------------------------- 挂载
const react = makeReact();
let hostHandler = null;
let hostCalls = [];
let localeRegistration = null;
let slotRegistration = null;
let dockRegistration = null;

const ctx = {
  effect: (fn) => {
    fn();
  },
  locale: {
    register: (ns, dicts) => {
      localeRegistration = { ns, dicts };
      return () => {};
    },
  },
  slots: {
    inject: (_name, fn) => fn(),
    register: (spec, Component) => {
      // 现在注册两个槽：按钮（input.right）与预览卡（composer.dock）。
      if (spec.name === 'conversation.composer.dock') dockRegistration = { spec, Component };
      else slotRegistration = { spec, Component };
      return () => {};
    },
  },
  remote: {
    commands: {
      execute: (...args) => {
        hostCalls.push(args);
        if (hostHandler === null) throw new Error('no host handler installed');
        return hostHandler(...args);
      },
    },
  },
};

const mod = captured.factory((id) => {
  if (id === 'react') return react.api;
  throw new Error(`client.js 只能 require('react')，却 require 了 ${id}`);
});

ok('模块契约：只需 remote / remote.commands / slots / locale', () => {
  // client.js 在 vm 里求值，它的数组来自另一个 realm，deepStrictEqual 会因原型不同而误报
  assert.equal(mod.inject.join('|'), 'remote|remote.commands|slots|locale');
  assert.equal(typeof mod.apply, 'function');
});

mod.apply(ctx);

ok('样式只注入一次，且全部使用自己前缀与主题 token', () => {
  assert.equal(styles.length, 1);
  const css = styles[0].textContent;
  assert.equal(styles[0].dataset.plugin, 'dsh-composer-enhance');
  assert.equal(styles[0].dataset.pluginCss, 'dsh-composer-enhance/client.css');
  assert.ok(!/\.wb-/.test(css));
  assert.ok(css.includes('@keyframes dsh-composer-enhance-spin'));
  const colors = css.match(/#[0-9a-fA-F]{3,8}|rgba?\(/g) || [];
  assert.equal(colors.length, 0, `CSS 里出现了字面色值: ${colors.join(', ')}`);
  assert.ok(css.includes('var(--dsw-alias-label-secondary)'));
});

ok('locale 字典：中英键集完全一致，且覆盖全部 action.* 用法', () => {
  assert.equal(localeRegistration.ns, 'dsh-composer-enhance');
  const { zh, en } = localeRegistration.dicts;
  assert.deepEqual([...Object.keys(zh)].sort(), [...Object.keys(en)].sort());
  // 必须排除 document.createElement('style') 这类误匹配
  const used = new Set([...SRC.matchAll(/(?<![A-Za-z0-9_$.])t\('([^']+)'\)/g)].map((m) => m[1]));
  for (const key of used) assert.ok(key in zh, `字典缺少 ${key}`);
  for (const key of Object.keys(zh)) {
    assert.ok(key.startsWith('action.') || key.startsWith('preview.'), key);
  }
});

ok('槽注册：list 槽 conversation.input.right，order 10，注入 runEnhance', () => {
  assert.equal(slotRegistration.spec.name, 'conversation.input.right');
  assert.equal(slotRegistration.spec.id, 'dsh-composer-enhance');
  assert.equal(slotRegistration.spec.order, 10);
  assert.equal(slotRegistration.spec.locale, 'dsh-composer-enhance');
  const injected = slotRegistration.spec.inject();
  assert.deepEqual(Object.keys(injected), ['runEnhance']);
  assert.equal(typeof injected.runEnhance, 'function');
});

// ---------------------------------------------------------------- runEnhance
const t = (key) => `T:${key}`;
const injected = slotRegistration.spec.inject();
/** 命令行 → v2 载荷对象（`{ v:2, text, history? }`）。 */
const decodePayload = (line) => JSON.parse(Buffer.from(line.replace(/^\/enhance-prompt /, ''), 'base64url').toString('utf8'));

async function rejects(hostReply, expected) {
  hostHandler = () => hostReply;
  hostCalls = [];
  await assert.rejects(() => injected.runEnhance('session-1', '你好', undefined, t), (error) => {
    assert.equal(error.message, expected);
    return true;
  });
}

let checks2 = 0;
async function okAsync(label, fn) {
  await fn();
  checks2 += 1;
  console.log(`  ok  ${label}`);
}

await okAsync('成功路径：命令行是 /enhance-prompt + base64url(v2 JSON)，返回结果文本', async () => {
  hostHandler = () => ({ ok: true, value: { result: { kind: 'success', text: '增强后的提示词' } } });
  hostCalls = [];
  const text = await injected.runEnhance('session-1', '你好', undefined, t);
  assert.equal(text, '增强后的提示词');
  assert.equal(hostCalls.length, 1);
  assert.equal(hostCalls[0][0], 'session-1');
  assert.deepEqual(decodePayload(hostCalls[0][1]), { v: 2, text: '你好' });
  assert.equal(hostCalls[0][2].length, 0);
});

await okAsync('载荷 history 字段：只在 off/all 时出现，未知值被忽略', async () => {
  hostHandler = () => ({ ok: true, value: { result: { kind: 'success', text: 'ok' } } });
  const run = async (history) => {
    hostCalls = [];
    await injected.runEnhance('session-1', '你好', undefined, t, history);
    return decodePayload(hostCalls[0][1]);
  };
  assert.equal((await run(undefined)).history, undefined);
  assert.equal((await run('off')).history, 'off');
  assert.equal((await run('all')).history, 'all');
  assert.equal((await run('bogus')).history, undefined);
});

await okAsync('宿主错误文案逐条本地化', async () => {
  await rejects({ ok: true, value: { result: { kind: 'error', text: 'Enhance prompt: empty input.' } } }, 'T:action.empty');
  await rejects(
    { ok: true, value: { result: { kind: 'error', text: 'Enhance prompt: input too long (12 > 8000 characters).' } } },
    'T:action.tooLong',
  );
  await rejects(
    { ok: true, value: { result: { kind: 'error', text: 'Enhance prompt: no default model selected.' } } },
    'T:action.noModel',
  );
  await rejects(
    { ok: true, value: { result: { kind: 'error', text: 'Enhance prompt: timed out after 60s.' } } },
    'T:action.timeout',
  );
  await rejects(
    { ok: true, value: { result: { kind: 'error', text: 'Enhance prompt: empty result.' } } },
    'T:action.emptyResult',
  );
  await rejects(
    { ok: true, value: { result: { kind: 'error', text: 'Enhance prompt: cancelled.' } } },
    'T:action.failed',
  );
  await rejects(
    { ok: true, value: { result: { kind: 'error', text: 'Enhance prompt failed: upstream 502' } } },
    'T:action.failed — upstream 502',
  );
  // 认不出来的文案必须原样透出，而不是被吞成一句"增强失败"
  await rejects({ ok: true, value: { result: { kind: 'error', text: 'something brand new' } } }, 'something brand new');
});

await okAsync('桥接异常与未知命令', async () => {
  await rejects({ ok: false, error: { code: 'E_TIMEOUT', message: 'bridge down' } }, 'T:action.failed — bridge down E_TIMEOUT');
  await rejects({ ok: false }, 'T:action.failed');
  await rejects({ ok: true, value: undefined }, 'T:action.unknownCommand');
  await rejects({ ok: true, value: {} }, 'T:action.failed');
  // kind:'success' 但没有文本，按"模型没有返回可用内容"报，而不是笼统的失败
  await rejects({ ok: true, value: { result: { kind: 'success' } } }, 'T:action.emptyResult');
});

// ---------------------------------------------------------------- 组件点击路径
let lastWritten;
/** insertText 的调用记录：`[text, span]`。 */
let inserted = [];
function makeProps(draft, sessionId, partial, occurrences = []) {
  const inputActions = {
    setDraft: (text) => {
      lastWritten = text;
    },
  };
  if (partial !== undefined) {
    // span 是 detect 坐标；draftRev 只是一枚不透明标记，这里用固定值即可。
    inputActions.captureInsertion = () => ({ start: partial.start, end: partial.end, draftRev: 7 });
    inputActions.insertText = (text, span) => {
      inserted.push([text, span]);
      return partial.applied !== false;
    };
  }
  return {
    t,
    sessionId: sessionId ?? 'session-1',
    inputActions,
    useInput: (selector) => selector({ draft, occurrences }),
    runEnhance: injected.runEnhance,
  };
}
/** 让 element.written 读的永远是"最近一次 setDraft"，重渲染后的 element 也适用。 */
function withWritten(element) {
  if (element !== null && typeof element === 'object') {
    Object.defineProperty(element, 'written', { get: () => lastWritten, configurable: true });
  }
  return element;
}
function render(draft, hostReply, sessionId, partial) {
  react.reset();
  react.sets.length = 0;
  lastWritten = undefined;
  inserted = [];
  hostHandler = () => hostReply;
  hostCalls = [];
  react.begin();
  const element = withWritten(slotRegistration.Component(makeProps(draft, sessionId, partial)));
  react.flush();
  return element;
}
/** 同一实例的下一次渲染：保留 state 与 effect 槽位，用来验证"草稿变了 / 会话切了"。 */
function rerender(draft, hostReply, sessionId) {
  hostHandler = () => hostReply;
  react.begin();
  const element = withWritten(slotRegistration.Component(makeProps(draft, sessionId)));
  react.flush();
  return element;
}

await okAsync('空草稿：不占位（返回 null）', async () => {
  assert.equal(render(''), null);
  assert.equal(render('   '), null);
});

await okAsync('成功点击：把结果写回草稿', async () => {
  const element = render('你好', { ok: true, value: { result: { kind: 'success', text: '增强后的提示词' } } });
  assert.equal(element.type, 'button');
  element.props.onClick();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(element.written, '增强后的提示词');
  const errored = react.sets.filter(([i, v]) => i === 3 && v !== '');
  assert.deepEqual(errored, []);
});

await okAsync('修饰键：Alt 点击本次不带历史、Shift 点击带全部、事件缺失不抛', async () => {
  const reply = { ok: true, value: { result: { kind: 'success', text: 'enhanced' } } };
  const click = async (event) => {
    const element = render('你好', reply);
    element.props.onClick(event);
    await new Promise((r) => setTimeout(r, 0));
    return decodePayload(hostCalls[0][1]);
  };
  assert.equal((await click(undefined)).history, undefined);
  assert.equal((await click({})).history, undefined);
  assert.equal((await click({ altKey: true })).history, 'off');
  assert.equal((await click({ shiftKey: true })).history, 'all');
});

await okAsync('宿主报错时按钮进入失败态并显示本地化原因', async () => {
  const element = render('你好', { ok: true, value: { result: { kind: 'error', text: 'Enhance prompt: no default model selected.' } } });
  element.props.onClick();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  const errors = react.sets.filter(([i]) => i === 3).map(([, v]) => v);
  assert.ok(
    errors.includes('T:action.noModel'),
    `实际 setState 序列: ${JSON.stringify(react.sets)} / 宿主调用: ${JSON.stringify(hostCalls)}`,
  );
  assert.equal(element.written, undefined, '失败时不得改写草稿');
});

await okAsync('max-tokens 预算错误被翻译成本地化文案（不再落到笼统"增强失败"）', async () => {
  const element = render('你好', {
    ok: true,
    value: { result: { kind: 'error', text: 'Enhance prompt: model ran out of output budget (max-tokens, maxTokens=2048).' } },
  });
  element.props.onClick();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  const errors = react.sets.filter(([i]) => i === 3).map(([, v]) => v);
  assert.ok(errors.includes('T:action.outputBudget'), `实际 setState 序列: ${JSON.stringify(react.sets)}`);
  assert.equal(element.written, undefined, '失败时不得改写草稿');
});

await okAsync('超长草稿在浏览器侧就被拦下，不发起请求', async () => {
  const element = render('x'.repeat(8001), { ok: true, value: { result: { kind: 'success', text: 'nope' } } });
  element.props.onClick();
  await new Promise((r) => setTimeout(r, 0));
  const errors = react.sets.filter(([i]) => i === 3).map(([, v]) => v);
  assert.ok(errors.includes('T:action.tooLong'));
  assert.equal(hostCalls.length, 0, '不该把超长草稿发给宿主');
});

await okAsync('点按钮不抢焦点：mousedown 里 preventDefault（保护中文输入法组词与光标位置）', async () => {
  const element = render('你好', { ok: true, value: { result: { kind: 'success', text: 'x' } } });
  assert.equal(typeof element.props.onMouseDown, 'function');
  let prevented = 0;
  element.props.onMouseDown({ preventDefault: () => { prevented += 1; } });
  assert.equal(prevented, 1);
  element.props.onMouseDown(undefined); // 事件对象缺失也不能抛
  element.props.onMouseDown({});
});

await okAsync('失败态随草稿变化自动清除（按钮不会一直红着挂着旧报错）', async () => {
  const failedReply = { ok: true, value: { result: { kind: 'error', text: 'Enhance prompt: no default model selected.' } } };
  const element = render('你好', failedReply);
  element.props.onClick();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));

  // 草稿没变：失败提示必须留着（否则等于一闪而过）
  react.sets.length = 0;
  rerender('你好', failedReply);
  assert.equal(react.sets.some(([i, v]) => i === 3 && v === ''), false, `草稿未变却清了失败态: ${JSON.stringify(react.sets)}`);

  // 草稿一变：failed / error 都要清
  react.sets.length = 0;
  rerender('你好，再详细一点', failedReply);
  assert.ok(react.sets.some(([i, v]) => i === 2 && v === false), `缺少 setFailed(false): ${JSON.stringify(react.sets)}`);
  assert.ok(react.sets.some(([i, v]) => i === 3 && v === ''), `缺少 setError(''): ${JSON.stringify(react.sets)}`);
});

await okAsync('失败原因同时进 aria-label（不只鼠标悬停的 tooltip）', async () => {
  const failedReply = { ok: true, value: { result: { kind: 'error', text: 'Enhance prompt: no default model selected.' } } };
  const element = render('你好', failedReply);
  element.props.onClick();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  const next = rerender('你好', failedReply);
  assert.ok(next.props.title.includes('T:action.noModel'), next.props.title);
  assert.ok(next.props['aria-label'].includes('T:action.noModel'), next.props['aria-label']);
});

await okAsync('会话切换：同一实例换 sessionId 会中止在途请求，且不写回草稿', async () => {
  react.reset();
  react.sets.length = 0;
  lastWritten = undefined;
  let aborted = false;
  hostHandler = (_sessionId, _line, _attachments, signal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });
  react.begin();
  const first = withWritten(slotRegistration.Component(makeProps('你好', 'session-1')));
  react.flush();
  first.props.onClick();
  await new Promise((r) => setTimeout(r, 0));

  react.sets.length = 0;
  react.begin();
  withWritten(slotRegistration.Component(makeProps('你好', 'session-2')));
  react.flush();
  assert.equal(aborted, true, '会话切换必须中止在途请求');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(lastWritten, undefined, '不得把上一个会话的结果写进新会话草稿');
  assert.equal(react.sets.some(([i, v]) => i === 2 && v === true), false, '被中止不应进入失败态');
});

await okAsync('请求期间用户又改了草稿：不覆盖新输入，改为提示重试', async () => {
  const reply = { ok: true, value: { result: { kind: 'success', text: '增强后的提示词' } } };
  const element = render('你好', reply);
  element.props.onClick();
  rerender('你好，我又补了一句', reply); // 请求还没回来，用户继续输入
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(lastWritten, undefined, '不得覆盖用户在请求期间的新输入');
  assert.ok(
    react.sets.some(([i, v]) => i === 3 && v === 'T:action.draftChanged'),
    `缺少 action.draftChanged 提示: ${JSON.stringify(react.sets)}`,
  );
});

// ---------------------------------------------------------------- 局部增强（Ctrl/Cmd+点击）
/** 造一个"落在可编辑区里"的浏览器选区。 */
function selectionOf(text, { editable = true } = {}) {
  const node = { nodeType: 1, closest: () => (editable ? {} : null), parentElement: null };
  return { rangeCount: 1, isCollapsed: false, anchorNode: node, toString: () => text };
}
const DRAFT = '把这段改好，另一段别动';
const partialReply = { ok: true, value: { result: { kind: 'success', text: '把这段改得更具体' } } };
/** 等两轮宏任务，让 runEnhance 的 await 链走完。 */
const tick = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

await okAsync('Ctrl+点击 + 有选区：只把选中文字发给宿主，结果用 insertText 写回局部', async () => {
  currentSelection = selectionOf('把这段改好');
  const element = render(DRAFT, partialReply, undefined, { start: 0, end: 5 });
  element.props.onClick({ ctrlKey: true });
  await tick();
  assert.equal(decodePayload(hostCalls[0][1]).text, '把这段改好', '宿主只该收到选区文本');
  assert.equal(inserted.length, 1, '必须调用 insertText');
  assert.equal(inserted[0][0], '把这段改得更具体');
  assert.deepEqual({ ...inserted[0][1] }, { start: 0, end: 5, draftRev: 7 });
  assert.equal(lastWritten, undefined, '局部增强不得整段 setDraft');
  currentSelection = null;
});

await okAsync('insertText 被编辑器拒绝（span 过期/不可写）：报草稿已变，且一个字符都不动', async () => {
  currentSelection = selectionOf('把这段改好');
  const element = render(DRAFT, partialReply, undefined, { start: 0, end: 5, applied: false });
  element.props.onClick({ ctrlKey: true });
  await tick();
  assert.equal(inserted.length, 1);
  assert.equal(lastWritten, undefined);
  const errors = react.sets.filter(([i]) => i === 3).map(([, v]) => v);
  assert.ok(errors.includes('T:action.draftChanged'), `实际 setState: ${JSON.stringify(react.sets)}`);
  currentSelection = null;
});

await okAsync('Ctrl+点击但没有浏览器选区：静默退回整段增强', async () => {
  currentSelection = null;
  const element = render(DRAFT, partialReply, undefined, { start: 0, end: 5 });
  element.props.onClick({ ctrlKey: true });
  await tick();
  assert.equal(decodePayload(hostCalls[0][1]).text, DRAFT, '没有选区时按整段发送');
  assert.equal(inserted.length, 0);
  assert.equal(lastWritten, '把这段改得更具体');
});

await okAsync('选区文本不在草稿里（跨 chip / 未同步）：退回整段，不做猜测性局部写入', async () => {
  currentSelection = selectionOf('草稿里没有这段');
  const element = render(DRAFT, partialReply, undefined, { start: 0, end: 8 });
  element.props.onClick({ metaKey: true });
  await tick();
  assert.equal(decodePayload(hostCalls[0][1]).text, DRAFT);
  assert.equal(inserted.length, 0);
  assert.equal(lastWritten, '把这段改得更具体');
  currentSelection = null;
});

console.log('\n[5] 批 1：重入锁 / 关联 ID / 载荷护栏');

await okAsync('连点三次只发一次请求（渲染期闭包还没更新时也挡得住）', async () => {
  hostHandler = () => new Promise(() => {});
  react.reset();
  react.sets.length = 0;
  lastWritten = undefined;
  hostCalls = [];
  react.begin();
  const element = withWritten(slotRegistration.Component(makeProps('你好')));
  react.flush();
  element.props.onClick();
  element.props.onClick();
  element.props.onClick();
  await tick();
  assert.equal(hostCalls.length, 1, `实际发起了 ${hostCalls.length} 次模型调用`);
});

await okAsync('载荷带 6 位关联 ID，且浏览器 console 的 req= 与载荷 id 一致', async () => {
  const logs = [];
  const realInfo = console.info;
  console.info = (...args) => logs.push(args.join(' '));
  try {
    const element = render('你好', { ok: true, value: { result: { kind: 'success', text: 'x' } } });
    element.props.onClick();
    await tick();
  } finally {
    console.info = realInfo;
  }
  const sent = decodePayload(hostCalls[0][1]);
  assert.match(sent.id, /^[a-z0-9]{6}$/);
  assert.ok(
    logs.some((line) => line.includes(`req=${sent.id} start`)),
    logs.join(' | '),
  );
  assert.ok(
    logs.some((line) => line.includes(`req=${sent.id} ok`)),
    logs.join(' | '),
  );
});

await okAsync('局部增强同样带 id 与重入锁（连点只发一次）', async () => {
  currentSelection = selectionOf('把这段改好');
  hostHandler = () => new Promise(() => {});
  react.reset();
  react.sets.length = 0;
  inserted = [];
  hostCalls = [];
  react.begin();
  const element = withWritten(slotRegistration.Component(makeProps(DRAFT, undefined, { start: 0, end: 5 })));
  react.flush();
  element.props.onClick({ ctrlKey: true });
  element.props.onClick({ ctrlKey: true });
  await tick();
  assert.equal(hostCalls.length, 1);
  assert.match(decodePayload(hostCalls[0][1]).id, /^[a-z0-9]{6}$/);
  currentSelection = null;
});

// ---- [5] 批 2（S2/S3/S5）：chip 保护 / 预览 / 新错误文案 ----

/** 在假 React 里单独渲染一个组件并返回根元素。 */
function renderComponent(Component, props) {
  react.reset();
  react.sets.length = 0;
  react.begin();
  const element = Component(props);
  react.flush();
  return element;
}

/** 深度收集元素树里的 button（预览卡的两个动作按钮）。 */
function collectButtons(element) {
  const found = [];
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return;
    if (node.type === 'button') found.push(node);
    for (const child of node.props.children ?? []) walk(child);
  };
  if (Array.isArray(element)) element.forEach(walk);
  else walk(element);
  return found;
}

await okAsync('引用 chip 保护（S2）：草稿里有 chip 时按钮禁用并说明原因，点击不发请求', async () => {
  const reply = { ok: true, value: { result: { kind: 'success', text: '不该被采用' } } };
  const element = (() => {
    react.reset();
    react.sets.length = 0;
    hostCalls = [];
    lastWritten = undefined;
    hostHandler = () => reply;
    react.begin();
    const root = withWritten(slotRegistration.Component(makeProps('你好', undefined, undefined, [{ type: 'file', receiptId: 'r1' }])));
    react.flush();
    return root;
  })();

  assert.equal(element.props.disabled, true, '有 chip 时按钮应禁用');
  assert.ok(String(element.props.className).includes('is-blocked'), element.props.className);
  assert.ok(String(element.props.title).includes('T:action.chipBlocked'), element.props.title);

  element.props.onClick();
  await tick();
  assert.equal(hostCalls.length, 0, '有 chip 时不应发起请求');
  assert.deepEqual(
    react.sets.filter(([i, v]) => i === 3 && v === 'T:action.chipBlocked'),
    [[3, 'T:action.chipBlocked']],
  );
});

await okAsync('预览（S3）：Alt+Shift 点击只产生待确认结果，不写回草稿', async () => {
  const reply = { ok: true, value: { result: { kind: 'success', text: '预览版提示词' } } };
  const logs = [];
  const realInfo = console.info;
  console.info = (...args) => logs.push(args.join(' '));
  let element;
  try {
    element = render('你好', reply);
    element.props.onClick({ altKey: true, shiftKey: true });
    await tick();
  } finally {
    console.info = realInfo;
  }
  assert.equal(lastWritten, undefined, '预览模式不得直接写回草稿');
  assert.equal(hostCalls.length, 1);
  const sent = decodePayload(hostCalls[0][1]);
  assert.equal(sent.history, undefined, 'Alt+Shift 只表示预览，不改历史语义');
  assert.match(sent.id, /^[a-z0-9]{6}$/);
  assert.ok(
    logs.some((line) => line.includes('mode=preview')),
    logs.join(' | '),
  );
});

await okAsync('预览卡（S3）：草稿未被改动 → 采用后写入；放弃则清空', async () => {
  const dock = await (async () => {
    // 复用上一条用例留下的待确认结果：composer.dock 槽注册的预览卡读的是同一份 store。
    assert.notEqual(dockRegistration, null, '应已向 conversation.composer.dock 注册预览卡');
    const element = renderComponent(dockRegistration.Component, {
      t,
      sessionId: 'session-1',
      inputActions: { setDraft: (text) => (lastWritten = text) },
    });
    return element;
  })();

  assert.notEqual(dock, null, '有待确认结果时应渲染预览卡');
  const [apply] = collectButtons(dock);
  lastWritten = undefined;
  apply.props.onClick();
  assert.equal(lastWritten, '预览版提示词', '采用按钮把结果写回草稿');

  // store 已清空：同一组件再渲染应返回 null。
  const again = renderComponent(dockRegistration.Component, {
    t,
    sessionId: 'session-1',
    inputActions: { setDraft: () => {} },
  });
  assert.equal(again, null);
});

await okAsync('新错误文案本地化（S1/S5）：保真闸 / 长度闸 / 总开关', async () => {
  const cases = [
    ['Enhance prompt: fidelity check failed (missing: a, b).', 'T:action.fidelity'],
    ['Enhance prompt: result too long (900 chars vs 200 input chars, limit 2.5x).', 'T:action.tooVerbose'],
    ['Enhance prompt: disabled by plugin config.', 'T:action.disabled'],
  ];
  for (const [hostText, expected] of cases) {
    const element = render('你好', { ok: true, value: { result: { kind: 'error', text: hostText } } });
    element.props.onClick();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const errors = react.sets.filter(([i]) => i === 3).map(([, v]) => v);
    assert.ok(errors.includes(expected), `${hostText} → ${JSON.stringify(react.sets)}`);
    assert.equal(element.written, undefined, '失败时不得改写草稿');
  }
});

console.log(`\n浏览器半全部通过：${checks + checks2} 项检查\n`);
