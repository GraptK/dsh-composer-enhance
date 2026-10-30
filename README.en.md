# dsh-composer-enhance

A DeepSeek Harness (DSH) plugin that rewrites the composer draft — or only the selected fragment — into a sharper, ready-to-send prompt with **one model call**.

It borrows the interaction shape of WorkBuddy's "enhance prompt" button, but runs entirely inside DSH: it uses the session's current model, writes the result back into the real editor, and keeps every step observable in logs.

- **One click** in the composer toolbar (left of Send): rewrite the whole draft.
- **Click again** while the wand button shows the revert arrow: put the original draft back.
- **Click while it is spinning**: cancel the in-flight call (the draft is untouched).
- **`Ctrl`/`⌘` + click with a selection**: rewrite only the selected fragment; the editor treats it as one independent undo step.
- **`Alt` + click**: this run skips conversation history. **`Shift` + click**: this run includes the whole conversation (still budget-capped). **`Alt` + `Shift` + click**: preview instead of writing back.
- **Conversation awareness**: by default the last 3 turns are attached as context (with a per-message clip and a total budget) so the rewrite matches the current thread.

## Why another prompt enhancer

The differentiators we deliberately keep:

1. **Observable end to end.** Every call logs one line on both sides with the same `req=` id (`start` / `ok` / `fail`, `reason=…`, latency, provider/model/finish, token usage, history diagnostics, fidelity/expansion verdicts). The browser half logs the same id, so a user report can be matched to exactly one host log line.
2. **Mechanical fidelity gate.** Hard facts found in the draft — inline-code fragments, URLs, file paths, semantic versions — must survive verbatim; otherwise the result is rejected instead of silently destroying them.
3. **Expansion guard.** Output that balloons past `maxExpansionRatio` (default 2.5x) on non-trivial drafts is rejected instead of dumping a 2000-character template into the composer.
4. **Selection-level enhancement.** Most plugins replace the whole draft; we can rewrite just the selected fragment.
5. **Failure paths are bounded.** Payload self-identification, client-side payload cap, a client-side backstop timeout, and a re-entrancy lock (double clicks never fire a second model call).

## Install

```bash
# from the plugin directory
dsh plugin install .        # or use Plugin Manager → Install bundle
```

Requirements: DSH `>=0.2.0-rc.2 <1.0.0`, Node `>=20`.

## Configuration

`cordis.patch.yml` ships the defaults; the same keys are exposed as a native Config schema, so Plugin Manager / Config Inspect can render them.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. `false` makes the button return "disabled by plugin config". |
| `temperature` | `0.3` | Sampling temperature (0–2). |
| `maxTokens` | `2048` | Output budget. Thinking tokens count against it. |
| `timeoutMs` | `60000` | Host-side timeout for one call. |
| `history` | `true` | Attach recent conversation as context. |
| `historyTurns` | `3` | How many of the most recent turns to consider (1–12). |
| `historyMaxChars` | `3000` | Total character budget for the attached history. |
| `historyPerMessageChars` | `800` | Per-message clip (head 40% + tail 60%). |
| `fidelity` | `true` | Reject results that drop hard facts from the draft. |
| `maxExpansionRatio` | `2.5` | Reject results longer than this multiple of the draft (drafts ≥80 chars). |
| `provider` / `model` | `''` | Override the session's model for this plugin only; both must be set to take effect. |

## Logs

Host side (DSH log / terminal):

```
[dsh-composer-enhance] req=k3f9aq ok ms=1240 provider=deepseek model=chat finish=stop in=1987 out=142 reasoning=0 text=156 history=ok/3of3 historyChars=2411 historyMessages=6 maxTokens=2048 modelSource=session fidelity=ok expand=156<=200
[dsh-composer-enhance] req=7c1d2e fail ms=830 reason=fidelity fidelity=missing:2
```

Browser side (DevTools console): the same `req=` with `start` / `ok` / `fail` and the resolved mode (`whole` / `partial` / `preview`).

## Testing

```bash
npm test          # offline suites: host 57 + client 31 + manifest 1
npm run check     # node --check on the three production files
npm run test:live # opt-in real-model regression; skips without DEEPSEEK_API_KEY
```

## Known limitations

- The host half is a Node module: changing it requires a DSH restart. The browser half only needs a page refresh.
- Config values are type-checked by the native schema; a wrong type can make plugin activation fail (by design, it is loud instead of silent).
- Partial enhancement depends on a real text selection and on the editor accepting the insertion; when either fails we report it and leave the draft untouched.
- Preview mode is opt-in per call (`Alt`+`Shift`); it does not change the default one-click flow.
- The proposal travels over the session-command channel, so DSH renders a command node in the chat flow (`recordInput: false` keeps the draft itself out of the log).

## License

MIT
