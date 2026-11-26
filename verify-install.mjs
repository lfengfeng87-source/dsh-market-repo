import { parseMarketIndex, marketInstallTarget } from '/opt/dshapp/runtime/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js';
import { readFileSync } from 'node:fs';

const file = process.argv[2] || 'public/market.json';
const doc = JSON.parse(readFileSync(file, 'utf8'));
const parsed = parseMarketIndex(doc, 'http://127.0.0.1:8099/' + file);
let ok = 0, fail = 0, kinds = {};
for (const p of parsed.plugins) {
  try {
    const v = p.versions[p.versions.length - 1];
    const t = marketInstallTarget(p.name, v);
    kinds[t.spec.split('@')[0] === p.name && t.spec.startsWith('git+') ? 'git' : 'npm'] = (kinds[t.spec.startsWith('git+') ? 'git' : 'npm'] || 0) + 1;
    ok++;
  } catch (e) {
    fail++;
    if (fail <= 3) console.log(`  ⚠ ${p.name}: ${e.message}`);
  }
}
console.log(`安装目标: ✅ ${ok} 可解析（${JSON.stringify(kinds)}）  ❌ ${fail} 失败`);
