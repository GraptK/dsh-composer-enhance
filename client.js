/**
 * Client 半（浏览器）：在 composer 的发送键前放一个「增强提示词」按钮。
 *
 * 形态说明（务必保留）：
 *   1. 文件必须是**纯 JavaScript**、无 JSX / 无 TypeScript / 无 import，
 *      通过 window.__ModuleLoader__.load 注册，`id` 必须等于包名。
 *   2. 只能通过 `require('react')` 取 React（基线模块表里已有）；
 *      **不得** require 任何 @deepseek-ai/dsh-client-* 包作为模块，
 *      要复用的样式/行为请拷贝到自己插件前缀的 CSS 里。
 *   3. 挂载点是 `conversation.input.right`（list 槽、replaceRisk: none，位于模型选择器之前）。
 *      槽 props 自带 `useInput`（草稿快照选择器）、`inputActions`、`sessionId`、`t`。
 *   4. 写回草稿用 `inputActions.setDraft(text)`；它在每个 Session 上操作该 Session 私有的编辑器。
 *   5. Client→Host 只走已验证的稳定 Remote：
 *      ctx.remote.commands.execute(sessionId, line, attachments, signal)
 *      返回 `{ok:true,value}` | `{ok:false,error:{code,message}}`，value 是 CommandExecution | undefined。
 *
 * 错误文案：Host 侧失败一律是稳定的英文 `Enhance prompt: …` 家族（见 index.js 顶部契约），
 * 这里用 hostErrorText() 前缀匹配翻译成本地化文案，避免中文界面里冒出英文。
 */

window.__ModuleLoader__.load({
  id: 'dsh-composer-enhance',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-composer-enhance';
    const SLOT = 'conversation.input.right';
    /** 预览卡片挂在 composer 卡片下方的 ambient 槽（官方 Slot：Ambient entries below the composer card）。 */
    const DOCK = 'conversation.composer.dock';
    const COMMAND = '/enhance-prompt ';
    const MIN_TEXT_LENGTH = 1;
    // 与 Host 侧 index.js 的 MAX_INPUT_CHARS 必须一致（浏览器半与 Host 半分属两个运行时，无法共享常量）。
    const MAX_TEXT_LENGTH = 8000;
    /** v2 载荷（JSON 经 base64url）的长度上限：8000 字符草稿最坏约 32KB，留一倍余量。 */
    const MAX_PAYLOAD_CHARS = 65_536;
    /** 客户端兜底超时：必须比宿主默认 timeoutMs（60s）略长，否则会抢在宿主超时文案之前报错。 */
    const CLIENT_TIMEOUT_MS = 65_000;
    const LOG_PREFIX = '[dsh-composer-enhance]';

    // 可见文案必须走 Client locale 服务（注册见 apply 内的 ctx.locale.register）。
    const zh = {
      'action.title': '增强提示词',
      'action.enhancing': '增强中，点击取消',
      'action.revert': '回退到原文',
      'action.empty': '请先输入内容',
      'action.tooLong': '内容过长，无法增强',
      'action.failed': '增强失败',
      'action.noModel': '请先在模型选择器里选中一个模型',
      'action.timeout': '增强超时，请重试',
      'action.emptyResult': '模型没有返回可用内容',
      'action.outputBudget': '模型的输出额度被思考过程用完了，请重试或提高 maxTokens',
      'action.unknownCommand': '增强命令不可用，请刷新页面后重试',
      'action.draftChanged': '草稿在增强期间被改动，未覆盖你的新内容，请重试',
      'action.historyHint': '增强时会带入本会话最近的对话作为语境；Alt+点击 本次不带，Shift+点击 本次带全部',
      'action.selectionHint': 'Ctrl+点击 只增强选中的文字；没选中就整段增强',
      'action.fidelity': '保真校验未通过：原文里的路径/版本/URL 没被完整保留，已拒绝写回，请重试',
      'action.tooVerbose': '改写结果比原文长太多，已拒绝写回，请重试',
      'action.disabled': '插件已在配置里关闭（enabled = false）',
      'action.chipBlocked': '草稿含引用内容（@文件等），整段改写会丢失引用；请先移除引用，或选中纯文本后 Ctrl+点击',
      'action.previewHint': 'Alt+Shift+点击 先预览改写结果，不直接写回',
      'preview.title': '改写预览（草稿尚未改动）',
      'preview.apply': '采用',
      'preview.discard': '放弃',
    };
    const en = {
      'action.title': 'Enhance prompt',
      'action.enhancing': 'Enhancing, click to cancel',
      'action.revert': 'Revert to original',
      'action.empty': 'Type something first',
      'action.tooLong': 'Draft is too long to enhance',
      'action.failed': 'Enhance failed',
      'action.noModel': 'Select a model first',
      'action.timeout': 'Enhance timed out, please retry',
      'action.emptyResult': 'The model returned nothing usable',
      'action.outputBudget': 'The model spent its whole output budget on thinking; retry or raise maxTokens',
      'action.unknownCommand': 'Enhance command unavailable, please reload the page',
      'action.draftChanged': 'Draft changed while enhancing — your new text was kept, please retry',
      'action.historyHint': 'Recent conversation is used as context; Alt+click to skip it, Shift+click to use all',
      'action.selectionHint': 'Ctrl+click enhances only the selected text; nothing selected = whole draft',
      'action.fidelity': 'Fidelity check failed — the rewrite dropped a path, version or URL; nothing was written, please retry',
      'action.tooVerbose': 'The rewrite was much longer than the draft; nothing was written, please retry',
      'action.disabled': 'This plugin is disabled in its config (enabled = false)',
      'action.chipBlocked': 'The draft contains references (@files etc.); a whole-draft rewrite would drop them. Remove them or select plain text and Ctrl+click',
      'action.previewHint': 'Alt+Shift+click to preview the rewrite without writing it back',
      'preview.title': 'Rewrite preview (draft unchanged)',
      'preview.apply': 'Use it',
      'preview.discard': 'Discard',
    };

    // 只使用 Theme 提供的别名 token，不写字面色值。
    const css = `
.dsh-composer-enhance_button{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none}
.dsh-composer-enhance_button:hover{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}
.dsh-composer-enhance_button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dsh-composer-enhance_button[disabled]{color:var(--dsw-alias-label-tertiary);cursor:default;background:transparent}
.dsh-composer-enhance_button.is-error{color:var(--dsw-alias-state-error-primary)}
.dsh-composer-enhance_button.is-blocked{opacity:.55}
.dsh-composer-enhance_icon{width:16px;height:16px;display:block}
.dsh-composer-enhance_spinner{animation:dsh-composer-enhance-spin .9s linear infinite;transform-origin:50% 50%}
@keyframes dsh-composer-enhance-spin{to{transform:rotate(360deg)}}
.dsh-composer-enhance_preview{display:flex;flex-direction:column;gap:6px;margin:6px 8px 0;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-elevated)}
.dsh-composer-enhance_previewHead{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px}
.dsh-composer-enhance_previewTitle{font-weight:500}
.dsh-composer-enhance_previewMeta{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dsh-composer-enhance_previewBody{max-height:160px;overflow:auto;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.dsh-composer-enhance_previewActions{display:flex;gap:8px;justify-content:flex-end}
.dsh-composer-enhance_previewPrimary,.dsh-composer-enhance_previewSecondary{display:inline-flex;align-items:center;height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}
.dsh-composer-enhance_previewPrimary{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}
.dsh-composer-enhance_previewPrimary:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}
.dsh-composer-enhance_previewSecondary:hover{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}
.dsh-composer-enhance_previewPrimary:focus-visible,.dsh-composer-enhance_previewSecondary:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
@media (prefers-reduced-motion:reduce){.dsh-composer-enhance_spinner{animation:none}}
`;

    // 模块体内注入一次样式：官方 client.js 的同款幂等写法（data-plugin-css 去重）。
    (function ensureStyle() {
      try {
        if (typeof document === 'undefined') return;
        const tagId = 'dsh-composer-enhance/client.css';
        const selector = 'style[data-plugin-css=' + JSON.stringify(tagId) + ']';
        if (document.querySelector(selector) !== null) return;
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-composer-enhance';
        tag.dataset.pluginCss = tagId;
        tag.textContent = css;
        document.head.appendChild(tag);
      } catch {
        /* 样式失败不应阻断插件加载 */
      }
    })();

    /** 把请求编码成 base64url：草稿是任意多行文本，必须编码才能安全地作为命令参数传输。 */
    function encodeBase64Url(text) {
      const bytes = new TextEncoder().encode(text);
      let binary = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    /**
     * v2 载荷：`{ v:2, text, history? }`。
     * history 只在用户按了修饰键时出现——不按就交给宿主按插件配置决定（默认带最近 3 轮）。
     * 宿主仍兼容 v1 的"纯草稿明文"载荷，所以这里不带 history 时不写该字段。
     */
    /**
     * v2 载荷：`{ v:2, text, id?, history? }`。
     * id 是本次点击的关联 ID，宿主会用它打同一行 `req=` 日志（新增可选字段，旧宿主忽略它）。
     * history 只在用户按了修饰键时出现——不按就交给宿主按插件配置决定（默认带最近 3 轮）。
     */
    function encodeRequest(text, history, id) {
      const payload = { v: 2, text };
      if (typeof id === 'string' && id !== '') payload.id = id;
      if (history === 'off' || history === 'all') payload.history = history;
      return encodeBase64Url(JSON.stringify(payload));
    }

    /** 6 位 base36 关联 ID；宿主也接受任意 ASCII 字母数字，但两端都用这个格式最省心。 */
    function newRequestId() {
      return Math.random().toString(36).slice(2, 8).padEnd(6, '0');
    }

    /**
     * Host 侧错误 → 本地化文案。
     * 只认 index.js 里那组稳定的英文前缀；认不出来就原样回显，把真实报错暴露给用户，
     * 而不是悄悄吞成一句"增强失败"。
     */
    function hostErrorText(raw, t) {
      const text = String(raw === undefined || raw === null ? '' : raw).trim();
      if (text === '') return t('action.failed');
      if (/^Enhance prompt: empty input\.?$/i.test(text)) return t('action.empty');
      if (/^Enhance prompt: input too long\b/i.test(text)) return t('action.tooLong');
      if (/^Enhance prompt: no default model selected\.?$/i.test(text)) return t('action.noModel');
      if (/^Enhance prompt: timed out\b/i.test(text)) return t('action.timeout');
      if (/^Enhance prompt: model ran out of output budget\b/i.test(text)) return t('action.outputBudget');
      if (/^Enhance prompt: empty result\.?$/i.test(text)) return t('action.emptyResult');
      if (/^Enhance prompt: fidelity check failed\b/i.test(text)) return t('action.fidelity');
      if (/^Enhance prompt: result too long\b/i.test(text)) return t('action.tooVerbose');
      if (/^Enhance prompt: disabled by plugin config\b/i.test(text)) return t('action.disabled');
      // 取消由调用方按 aborted 处理，正常到不了这里；真到了也按失败显示。
      if (/^Enhance prompt: cancelled\.?$/i.test(text)) return t('action.failed');
      const failed = /^Enhance prompt failed:\s*([\s\S]*)$/i.exec(text);
      if (failed !== null) return failed[1] === '' ? t('action.failed') : t('action.failed') + ' — ' + failed[1];
      return text;
    }

    function errorMessageOf(error, t) {
      const raw = error instanceof Error ? error.message : String(error === undefined || error === null ? '' : error);
      return hostErrorText(raw, t);
    }

    /** 调宿主命令，把结果信封翻译成"增强后的文本"或抛出可读错误。 */
    async function requestEnhance(ctx, sessionId, text, signal, t, history, id) {
      const line = COMMAND + encodeRequest(text, history, id);
      // 载荷护栏：正常草稿远到不了这里，但一旦超过就是 RPC 层不可预期的失败，提前拦成可读错误。
      if (line.length > MAX_PAYLOAD_CHARS) throw new Error(t('action.tooLong'));
      const response = await ctx.remote.commands.execute(sessionId, line, [], signal);
      if (!response || response.ok !== true) {
        const failure = (response && response.error) || {};
        const detail = [failure.message, failure.code].filter(Boolean).join(' ');
        throw new Error(detail === '' ? t('action.failed') : t('action.failed') + ' — ' + detail);
      }
      const execution = response.value;
      if (execution === undefined) throw new Error(t('action.unknownCommand'));
      const result = execution.result;
      if (!result) throw new Error(t('action.failed'));
      if (result.kind !== 'success') throw new Error(hostErrorText(result.text, t));
      // 宿主契约上不会这样返回；真出现时按「模型没有返回可用内容」报，而不是笼统的失败。
      if (!result.text) throw new Error(t('action.emptyResult'));
      return result.text;
    }

    /**
     * 客户端兜底超时：宿主自己有 timeoutMs（默认 60s），但桥接/RPC 也可能永远不结算。
     * 这里再包一层略长的定时信号，保证按钮最终一定能退出"增强中"。
     * AbortSignal.timeout/any 缺失时退化为只透传用户取消信号（不引入新失败路径）。
     */
    function withClientTimeout(controller) {
      const signal = controller.signal;
      if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return { signal, alarm: null };
      const alarm = AbortSignal.timeout(CLIENT_TIMEOUT_MS);
      if (typeof AbortSignal.any === 'function') return { signal: AbortSignal.any([signal, alarm]), alarm };
      return { signal, alarm };
    }

    /**
     * 读「当前选区」，两路证据同时成立才认账：
     *   1) 编辑器自己认为有选区 —— `inputActions.captureInsertion()` 的 span 非折叠。
     *      注意 span 是 **detect 坐标**（mention/chip 按占位计），不是可见文本坐标；
     *   2) 浏览器 Selection 落在可编辑区里，`toString()` 非空、能在草稿里找到，
     *      且长度与 span 大体对得上（差超过换行数 + 2 就认为跨了 chip，放弃）。
     * 任一条不成立返回 null，调用方静默退回「整段增强」——宁可多改，也不改错地方。
     */
    function readSelection(inputActions, draft) {
      if (typeof draft !== 'string' || draft === '') return null;
      if (!inputActions || typeof inputActions.captureInsertion !== 'function') return null;
      if (typeof inputActions.insertText !== 'function') return null;
      let span = null;
      try {
        span = inputActions.captureInsertion();
      } catch {
        return null;
      }
      if (!span || typeof span.start !== 'number' || typeof span.end !== 'number') return null;
      if (!(span.end > span.start)) return null;

      let selected = '';
      try {
        const selection = typeof window !== 'undefined' && typeof window.getSelection === 'function' ? window.getSelection() : null;
        if (selection && selection.rangeCount > 0 && selection.isCollapsed !== true) {
          const node = selection.anchorNode;
          const element = node && node.nodeType === 1 ? node : node && node.parentElement;
          const scope =
            element && typeof element.closest === 'function'
              ? element.closest('[contenteditable="true"],[contenteditable=""],[role="textbox"]')
              : null;
          if (scope !== null) selected = selection.toString();
        }
      } catch {
        selected = '';
      }
      if (typeof selected !== 'string' || selected.trim() === '') return null;
      // 草稿里没有这段文字（例如选区跨了未同步的区间）就别猜位置。
      if (draft.indexOf(selected) === -1) return null;
      const newlines = (selected.match(/\n/g) || []).length;
      if (Math.abs(span.end - span.start - selected.length) > newlines + 2) return null;
      return { span, text: selected };
    }

    // ---- 预览状态（跨槽共享）------------------------------------------------
    // 按钮在 conversation.input.right、预览卡在 conversation.composer.dock，是两棵组件树，
    // 所以用一个模块级小 store 传"待采用的改写结果"。默认路径（直接写回）完全不经过这里，
    // 只有 Alt+Shift+点击 才会写入预览。
    const previewStore = { current: null, listeners: new Set() };
    function publishPreview(next) {
      previewStore.current = next;
      for (const listener of previewStore.listeners) listener();
    }
    function usePreview() {
      const [value, setValue] = React.useState(previewStore.current);
      React.useEffect(() => {
        const listener = () => setValue(previewStore.current);
        previewStore.listeners.add(listener);
        return () => {
          previewStore.listeners.delete(listener);
        };
      }, []);
      return value;
    }

    /**
     * 改写预览卡：只显示结果、不改草稿。「采用」才 setDraft；「放弃」什么都不做。
     * 与既有行为的关系：默认点击仍是"直接写回 + 回退按钮"，只有 Alt+Shift 才走这里。
     */
    function PreviewDock(props) {
      const t = props.t;
      const inputActions = props.inputActions;
      const sessionId = props.sessionId;
      const pending = usePreview();
      if (pending === null) return null;
      // 会话切走时隐藏（不清空全局状态：另一个会话可能正等着这张卡）。
      if (sessionId !== undefined && pending.sessionId !== undefined && pending.sessionId !== sessionId) return null;
      const delta = pending.text.length - pending.original.length;
      return h(
        'div',
        { className: 'dsh-composer-enhance_preview', 'data-dsh-enhance': 'preview' },
        h(
          'div',
          { className: 'dsh-composer-enhance_previewHead' },
          h('span', { className: 'dsh-composer-enhance_previewTitle' }, t('preview.title')),
          h('span', { className: 'dsh-composer-enhance_previewMeta' }, `${delta >= 0 ? '+' : ''}${delta} chars`),
        ),
        h('div', { className: 'dsh-composer-enhance_previewBody' }, pending.text),
        h(
          'div',
          { className: 'dsh-composer-enhance_previewActions' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-composer-enhance_previewPrimary',
              onClick: () => {
                inputActions.setDraft(pending.text);
                publishPreview(null);
              },
            },
            t('preview.apply'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-composer-enhance_previewSecondary',
              onClick: () => publishPreview(null),
            },
            t('preview.discard'),
          ),
        ),
      );
    }

    function WandIcon() {
      return h(
        'svg',
        { className: 'dsh-composer-enhance_icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M5 19 16.5 7.5' }),
        h('path', { d: 'M14.5 5.5 18.5 9.5' }),
        h('path', { d: 'M17 3.5 17.7 5.3 19.5 6 17.7 6.7 17 8.5 16.3 6.7 14.5 6 16.3 5.3Z' }),
      );
    }

    function RevertIcon() {
      return h(
        'svg',
        { className: 'dsh-composer-enhance_icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M4 10h11a5 5 0 0 1 0 10h-6' }),
        h('path', { d: 'M8 6 4 10l4 4' }),
      );
    }

    function Spinner() {
      return h(
        'svg',
        { className: 'dsh-composer-enhance_icon dsh-composer-enhance_spinner', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M12 3a9 9 0 1 0 9 9' }),
      );
    }

    /**
     * 按钮三态：空/待增强 → 增强中（可取消）→ 已有备份（可回退）。
     * 用户手动改动增强结果 → 视为"内容已偏离"，丢弃回退点。
     */
    function EnhanceButton(props) {
      const t = props.t;
      const sessionId = props.sessionId;
      const inputActions = props.inputActions;
      const useInput = props.useInput;
      const runEnhance = props.runEnhance;

      const draft = useInput((state) => state.draft);
      const text = typeof draft === 'string' ? draft : '';
      // 草稿里带引用 chip（@文件/会话引用）时，整段 setDraft 会把 chip 抹成纯文本，
      // 所以整段路径直接禁用；局部增强仍可用（它只替换选中的纯文本区间）。
      const chipCount = useInput((state) => (state && Array.isArray(state.occurrences) ? state.occurrences.length : 0));
      const blocked = chipCount > 0;

      const [enhancing, setEnhancing] = React.useState(false);
      const [backup, setBackup] = React.useState(null);
      const [failed, setFailed] = React.useState(false);
      const [error, setError] = React.useState('');
      const controllerRef = React.useRef(null);
      const appliedRef = React.useRef(null);
      const aliveRef = React.useRef(true);
      // 请求在途期间的最新草稿：用来判断期间用户有没有继续输入（见 start() 的冲突分支）。
      const draftRef = React.useRef(text);

      React.useEffect(() => {
        aliveRef.current = true;
        return () => {
          aliveRef.current = false;
          if (controllerRef.current) controllerRef.current.abort();
        };
      }, []);

      // 同一次挂载被复用到另一个会话时中止在途请求：
      // 否则上一个会话的增强结果会被 setDraft 写进新会话的草稿。
      React.useEffect(
        () => () => {
          if (controllerRef.current) controllerRef.current.abort();
        },
        [sessionId],
      );

      React.useEffect(() => {
        if (backup === null) return;
        if (appliedRef.current !== null && text !== appliedRef.current) {
          appliedRef.current = null;
          setBackup(null);
        }
      }, [text, backup]);

      // 草稿一变，上一次的失败提示立即作废：否则按钮会一直停在红色错误态，
      // tooltip 里还挂着一条与当前内容已经无关的旧报错，用户以为这次也失败了。
      React.useEffect(() => {
        draftRef.current = text;
        setFailed(false);
        setError('');
      }, [text]);

      const hasContent = text.trim().length >= MIN_TEXT_LENGTH;

      const start = async (history, preview = false) => {
        // 连点/双击：onClick 读的是渲染期闭包里的 enhancing，可能还没来得及重渲染；
        // 真正的重入闸门放在这里——已有在途请求就直接忽略，不发起第二次模型调用。
        if (controllerRef.current !== null) return;
        if (text.length > MAX_TEXT_LENGTH) {
          setFailed(true);
          setError(t('action.tooLong'));
          return;
        }
        const original = text;
        const requestId = newRequestId();
        const startedAt = Date.now();
        const controller = new AbortController();
        const guarded = withClientTimeout(controller);
        controllerRef.current = controller;
        setEnhancing(true);
        setFailed(false);
        setError('');
        console.info(LOG_PREFIX, `req=${requestId} start whole chars=${original.length} history=${history ?? 'auto'}`);
        try {
          const enhanced = await runEnhance(sessionId, original, guarded.signal, t, history, requestId);
          if (!aliveRef.current || controller.signal.aborted) return;
          // 请求期间用户又敲了字：整段 setDraft 会吃掉他刚写的内容，这里改成"不覆盖 + 提示重试"。
          if (draftRef.current !== original) {
            setFailed(true);
            setError(t('action.draftChanged'));
            console.info(LOG_PREFIX, `req=${requestId} fail ms=${Date.now() - startedAt} reason=draft-changed`);
            return;
          }
          // 预览模式：把结果交给 composer.dock 的预览卡，等用户选「采用」再写回。
          // 不设置 backup（草稿此时没变），也不碰 appliedRef。
          if (preview) {
            publishPreview({ text: enhanced, original, sessionId, requestId });
            console.info(LOG_PREFIX, `req=${requestId} ok ms=${Date.now() - startedAt} text=${enhanced.length} mode=preview`);
            return;
          }
          appliedRef.current = enhanced;
          setBackup(original);
          inputActions.setDraft(enhanced);
          console.info(LOG_PREFIX, `req=${requestId} ok ms=${Date.now() - startedAt} text=${enhanced.length} mode=whole`);
        } catch (failure) {
          if (controller.signal.aborted || !aliveRef.current) {
            console.info(LOG_PREFIX, `req=${requestId} aborted ms=${Date.now() - startedAt}`);
            return;
          }
          const clientTimeout = guarded.alarm !== null && guarded.alarm.aborted;
          setFailed(true);
          setError(clientTimeout ? t('action.timeout') : errorMessageOf(failure, t));
          console.info(
            LOG_PREFIX,
            `req=${requestId} fail ms=${Date.now() - startedAt} reason=${clientTimeout ? 'client-timeout' : 'error'}`,
          );
        } finally {
          if (controllerRef.current === controller) controllerRef.current = null;
          if (aliveRef.current) setEnhancing(false);
        }
      };

      // 局部增强：只改选中区间。写回用 insertText(text, span) —— 它在编辑器里是一次独立撤销操作，
      // 所以不留「回退」状态（Ctrl+Z 就是回退）；span 过期或编辑器不可写时 insertText 返回 false，
      // 这种情况下一个字符都不动，只把原因显示出来。
      const startPartial = async (selected, history) => {
        // 与 start() 同一道重入闸门：局部增强也不允许并发。
        if (controllerRef.current !== null) return;
        const requestId = newRequestId();
        const startedAt = Date.now();
        const controller = new AbortController();
        const guarded = withClientTimeout(controller);
        controllerRef.current = controller;
        setEnhancing(true);
        setFailed(false);
        setError('');
        console.info(LOG_PREFIX, `req=${requestId} start partial chars=${selected.text.length} history=${history ?? 'auto'}`);
        try {
          const enhanced = await runEnhance(sessionId, selected.text, guarded.signal, t, history, requestId);
          if (!aliveRef.current || controller.signal.aborted) return;
          let applied = false;
          try {
            applied = inputActions.insertText(enhanced, selected.span) === true;
          } catch {
            applied = false;
          }
          if (!applied) {
            setFailed(true);
            setError(t('action.draftChanged'));
            console.info(LOG_PREFIX, `req=${requestId} fail ms=${Date.now() - startedAt} reason=insert-rejected`);
            return;
          }
          console.info(LOG_PREFIX, `req=${requestId} ok ms=${Date.now() - startedAt} text=${enhanced.length} mode=partial`);
        } catch (failure) {
          if (controller.signal.aborted || !aliveRef.current) {
            console.info(LOG_PREFIX, `req=${requestId} aborted ms=${Date.now() - startedAt}`);
            return;
          }
          const clientTimeout = guarded.alarm !== null && guarded.alarm.aborted;
          setFailed(true);
          setError(clientTimeout ? t('action.timeout') : errorMessageOf(failure, t));
          console.info(
            LOG_PREFIX,
            `req=${requestId} fail ms=${Date.now() - startedAt} reason=${clientTimeout ? 'client-timeout' : 'error'}`,
          );
        } finally {
          if (controllerRef.current === controller) controllerRef.current = null;
          if (aliveRef.current) setEnhancing(false);
        }
      };

      const onClick = (event) => {
        if (enhancing) {
          if (controllerRef.current) controllerRef.current.abort();
          return;
        }
        if (backup !== null) {
          inputActions.setDraft(backup);
          appliedRef.current = null;
          setBackup(null);
          setFailed(false);
          setError('');
          return;
        }
        // 草稿里有引用 chip：整段改写会把 chip 抹成纯文本，这里直接拒绝并说明原因。
        if (blocked) {
          setFailed(true);
          setError(t('action.chipBlocked'));
          return;
        }
        if (!hasContent) {
          setFailed(true);
          setError(t('action.empty'));
          return;
        }
        // 修饰键优先级：Alt+Shift = 本次只预览；单独 Alt = 本次不带历史；单独 Shift = 带全部轮次
        // （仍受宿主预算约束）；不按则由宿主按插件配置决定（默认带最近 3 轮）。
        const preview = Boolean(event && event.altKey && event.shiftKey);
        const history =
          event && event.altKey && !event.shiftKey ? 'off' : event && event.shiftKey && !event.altKey ? 'all' : undefined;
        // Ctrl/Cmd+点击 = 只增强当前选区（需要编辑器与浏览器两路证据同时成立，见 readSelection）。
        // 没选中或证据对不上时静默退回整段增强，普通点击的行为完全不变。
        if (event && (event.ctrlKey || event.metaKey)) {
          const selected = readSelection(inputActions, text);
          if (selected !== null) {
            void startPartial(selected, history);
            return;
          }
        }
        void start(history, preview);
      };

      // 既无可增强内容、也没有可回退结果时不占位。
      if (!enhancing && backup === null && !hasContent) return null;

      const label = enhancing ? t('action.enhancing') : backup !== null ? t('action.revert') : t('action.title');
      // title（悬停提示）额外带一行历史快捷键说明；aria-label 只报状态，
      // 避免读屏用户每次聚焦都要听完一句长说明。
      const detail = failed && error ? label + ' — ' + error : blocked ? label + ' — ' + t('action.chipBlocked') : label;
      const title =
        detail + '\n' + t('action.historyHint') + '\n' + t('action.selectionHint') + '\n' + t('action.previewHint');
      const className =
        'dsh-composer-enhance_button' +
        (enhancing ? ' is-enhancing' : '') +
        (failed ? ' is-error' : '') +
        (blocked ? ' is-blocked' : '');

      return h(
        'button',
        {
          type: 'button',
          className,
          onClick,
          // 点按钮时不要把焦点从 composer 抢走：中文输入法正在组词时 blur 会打断/吞掉候选词，
          // 普通情况下也会丢掉光标位置。mousedown 里 preventDefault 即可，click 照常触发。
          onMouseDown: (event) => {
            if (event && typeof event.preventDefault === 'function') event.preventDefault();
          },
          // 引用 chip 在场时禁用（点击不会走到 onClick，tooltip 说明原因）。
          disabled: blocked && !enhancing ? true : undefined,
          title,
          // 失败原因同时进 aria-label：键盘/读屏用户也能拿到，而不是只有鼠标悬停才看得到。
          'aria-label': detail,
          'aria-busy': enhancing ? 'true' : undefined,
        },
        enhancing ? h(Spinner, null) : backup !== null ? h(RevertIcon, null) : h(WandIcon, null),
      );
    }

    function apply(ctx) {
      // 文案注册：槽注册项上的 locale: NS 会把 t 作为 standard prop 传给组件。
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-composer-enhance: locale');

      // 槽注册：回调随声明收起而销毁、恢复而重装。
      ctx.slots.inject(SLOT, () =>
        ctx.slots.register(
          {
            name: SLOT,
            id: 'dsh-composer-enhance',
            order: 10,
            locale: NS,
            // 额外 props：把 ctx 与 Remote 调用封进闭包（标准 props 里没有 ctx）。
            // t 随调用一起传入，让 Remote 失败也能给出本地化文案。
            inject: () => ({
              runEnhance: (sessionId, text, signal, t, history, id) =>
                requestEnhance(ctx, sessionId, text, signal, t, history, id),
            }),
          },
          EnhanceButton,
        ),
      );

      // 预览卡：composer 卡片下方的 ambient 槽。默认不显示（只有 Alt+Shift+点击 才会产生预览）。
      ctx.slots.inject(DOCK, () =>
        ctx.slots.register({ name: DOCK, id: 'dsh-composer-enhance-preview', order: 20, locale: NS }, PreviewDock),
      );
    }

    // 两段都要声明：`remote` 才能读 ctx.remote（否则 cannot get property "remote"），
    // `remote.commands` 才能读 ctx.remote.commands（否则 cannot get property "remote.commands"）。
    // 官方 dsh-client-ui-plan/lib/client.js:605-609 正是 ["slots","remote","remote.commands",…]。
    return { inject: ['remote', 'remote.commands', 'slots', 'locale'], apply };
  },
});
