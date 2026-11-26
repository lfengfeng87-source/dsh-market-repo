import { parseMarketIndex } from '/opt/dshapp/runtime/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js';
import { readFileSync } from 'node:fs';

const file = process.argv[2] || 'public/market.json';
try {
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const parsed = parseMarketIndex(doc, 'http://127.0.0.1:8099/' + file);
  const cats = {};
  for (const p of parsed.plugins) cats[p.metadata.category] = (cats[p.metadata.category] || 0) + 1;
  console.log(`✅ ${file}`);
  console.log(`   标题: ${parsed.title.zh}`);
  console.log(`   条目: ${parsed.plugins.length}  分类: ${JSON.stringify(cats)}`);
  console.log(`   分类字典: ${Object.keys(parsed.metadata.categories).join(', ')}`);
  console.log(`   标签字典: ${Object.keys(parsed.metadata.labels).length} 项  sortKeys 字典: ${Object.keys(parsed.metadata.sortKeys).join(', ')}`);
} catch (e) {
  console.log(`❌ ${file}: ${e.constructor.name} ${e.message}`);
}
