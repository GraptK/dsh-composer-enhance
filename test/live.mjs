// 真模型回归（opt-in）。默认跳过，所以可以安全地挂在 CI 里。
//
// 用法（PowerShell）：
//   $env:DEEPSEEK_API_KEY="sk-..."; node test/live.mjs
// 可选：
//   $env:DEEPSEEK_BASE_URL="https://api.deepseek.com/chat/completions"
//   $env:DEEPSEEK_MODEL="deepseek-flash"
//
// 它验证的是「提示词资产 + 后处理」在真模型上的行为，而不是 DSH 插件链路：
// 插件的宿主半/浏览器半由 verify-host.mjs / verify-client.mjs 用假 ctx 覆盖。
// 这里不碰 DSH，直接按插件同一套参数调一次 Chat Completions。

import { SYSTEM_PROMPT, buildUserPrompt, cleanupEnhancedText, clampEnhancedText } from '../prompts.js';

const apiKey = process.env.DEEPSEEK_API_KEY ?? '';
const baseUrl = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/chat/completions';
const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-flash';

if (apiKey.trim() === '') {
  console.log('[live] 跳过：未设置 DEEPSEEK_API_KEY（这是 opt-in 用例，不配置时退出码为 0）');
  process.exit(0);
}

const CJK = /[\u4e00-\u9fff]/;
const factsOf = (text) => {
  const patterns = [
    /`([^`\n]{2,80})`/g,
    /(https?:\/\/[^\s)]+)/g,
    /((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,8})/g,
    /\b(?:v\d+\.\d+(?:\.\d+)*|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/g,
  ];
  const facts = new Set();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) facts.add(match[1] ?? match[0]);
  }
  return [...facts].filter((fact) => fact.length >= 2).slice(0, 40);
};

async function enhance(draft) {
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(draft) },
      ],
      temperature: 0.3,
      max_tokens: 2048,
      stream: false,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${body === null ? '<非 JSON 响应>' : JSON.stringify(body).slice(0, 300)}`);
  }
  const text = body?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw new Error('响应里没有 choices[0].message.content');
  return clampEnhancedText(cleanupEnhancedText(text));
}

const cases = [
  {
    name: '中文输入 → 中文输出，长度不炸（≤3x，且不是逐字复述）',
    draft: '帮我把这个周报写得像点人写的，别太模板化',
    check: (draft, out) => {
      const problems = [];
      if (out.trim() === '') problems.push('输出为空');
      if (!CJK.test(out)) problems.push('输出里没有中文（语言必须跟随输入）');
      if (out.length > draft.length * 3 && out.length > 200) problems.push(`过度扩写：${draft.length} → ${out.length}`);
      if (out === draft) problems.push('输出与输入逐字相同（没有增强）');
      return problems;
    },
  },
  {
    name: '硬事实保真：路径 / 版本号 / URL / 反引号片段必须逐字保留',
    draft: '把 `src/app.ts` 里的 `loadUser()` 改成 v1.2.3 的签名，参考 https://api.example.com/docs ，别动 ProseMirror 那部分。',
    check: (draft, out) => {
      const missing = factsOf(draft).filter((fact) => !out.includes(fact));
      return missing.length === 0 ? [] : [`丢失硬事实：${missing.join(', ')}`];
    },
  },
  {
    name: '已经足够清楚的草稿 → 轻度润色，不套长模板、不输出解释',
    draft: '用 TypeScript 写一个函数 parseDate(input: string): Date，非法输入抛 RangeError。只给代码。',
    check: (draft, out) => {
      const problems = [];
      if (out.trim() === '') problems.push('输出为空');
      if (/^(-{3,}|\*\*\*)/.test(out)) problems.push('输出以分隔线/加粗开头，像在写解释而不是给提示词');
      if (out.length > Math.max(400, draft.length * 3)) problems.push(`过度扩写：${draft.length} → ${out.length}`);
      if (factsOf(draft).some((fact) => !out.includes(fact))) problems.push('丢失输入里的代码片段或类型签名');
      return problems;
    },
  },
];

let failed = 0;
for (const item of cases) {
  process.stdout.write(`[live] ${item.name} … `);
  try {
    const output = await enhance(item.draft);
    const problems = item.check(item.draft, output);
    if (problems.length === 0) {
      console.log('ok');
    } else {
      failed += 1;
      console.log('FAIL');
      console.log(`  ${problems.join('\n  ')}`);
      console.log(`  输出（前 200 字）：${output.slice(0, 200)}`);
    }
  } catch (error) {
    failed += 1;
    console.log('ERROR');
    console.log(`  ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(failed === 0 ? '\n[live] 全部通过\n' : `\n[live] 失败 ${failed} 项\n`);
process.exit(failed === 0 ? 0 : 1);
