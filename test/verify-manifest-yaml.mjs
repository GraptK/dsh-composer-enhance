/**
 * 用真实的 yaml 解析器验证 cordis.patch.yml —— 这是唯一一个 DSH 会在引导期解析的文件，
 * 语法错了会导致整个插件树挂掉，所以必须用解析器过一遍而不是肉眼看。
 * 用法：node test/verify-manifest-yaml.mjs [目标目录]；本机找不到 yaml 解析器时自动 SKIP。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = (process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url))).replace(/\\/g, '/').replace(/\/$/, '');
const CANDIDATES = [
  `${DIR}/node_modules/yaml/dist/index.js`,
  'C:/Users/Kiki/.dsh/profiles/desktop/node_modules/dsh-better-sidebar/node_modules/yaml/dist/index.js',
  'C:/Users/Kiki/.dsh/profiles/desktop/node_modules/yaml/dist/index.js',
  'C:/Users/Kiki/.dsh/profiles/desktop/node_modules/dshmarket/node_modules/yaml/dist/index.js',
];

let YAML = null;
let used = null;
for (const candidate of CANDIDATES) {
  if (!existsSync(candidate)) continue;
  const mod = await import(pathToFileURL(candidate).href);
  YAML = mod.default ?? mod;
  used = candidate;
  break;
}

if (YAML === null || typeof YAML.parse !== 'function') {
  console.log('SKIP: 本地没有可用的 yaml 解析器，请在有 yaml 依赖的环境重跑');
  process.exit(0);
}

const doc = YAML.parse(readFileSync(`${DIR}/cordis.patch.yml`, 'utf8'));
assert.deepEqual(doc, [
  {
    insert: [
      {
        id: 'dsh-composer-enhance',
        name: 'dsh-composer-enhance',
        config: {
          temperature: 0.3,
          maxTokens: 2048,
          timeoutMs: 60000,
          history: true,
          historyTurns: 3,
          historyMaxChars: 3000,
          historyPerMessageChars: 800,
        },
      },
    ],
  },
]);
console.log(`  ok  cordis.patch.yml 由 ${used} 解析通过，结构与 index.js 的 readOptions() 一致`);
console.log('\nyaml 校验通过\n');
