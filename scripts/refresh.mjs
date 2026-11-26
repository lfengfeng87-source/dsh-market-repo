/**
 * scripts/refresh.mjs — 抓取 npm / GitHub 数据，重建六榜，生成 public/market.json
 *
 * 用法:
 *   node scripts/refresh.mjs                    # 全流程（发现 + 指标 + 重建）
 *   node scripts/refresh.mjs --rebuild-only     # 只用 src/seed.json + 缓存重建
 *
 * 环境变量（可选）:
 *   GITHUB_TOKEN   — GitHub API token（无 token 时限流 60 次/小时，建议提供）
 *   PER_BOARD      — 每榜条数，默认 200
 *
 * 数据源:
 *   1. src/seed.json            — 种子清单（首次来自原库 top-rank.json 提取的 1200 条）
 *   2. npm registry search      — 自动发现新包（keywords: dsh-plugin / cordis-plugin 等）
 *   3. api.npmjs.org            — 周下载 / 累计下载
 *   4. api.github.com           — stars / 最近推送
 *
 * 输出:
 *   public/market.json          — DSH format-1 市场索引
 *   cache/metrics.json          — 指标缓存（增量更新，断点续抓）
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { rankBoards, buildMarket } from '../src/build.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CACHE_DIR = path.join(ROOT, 'cache');
const CACHE_FILE = path.join(CACHE_DIR, 'metrics.json');
const SEED_FILE = path.join(ROOT, 'src', 'seed.json');
const OUT_FILE = path.join(ROOT, 'public', 'market.json');

const PER_BOARD = parseInt(process.env.PER_BOARD || '200', 10);
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const UA = 'dsh-market-repo/1.0 (market index builder)';

const NPM_KEYWORDS = ['dsh-plugin', 'cordis-plugin', 'dsh-better-sidebar', 'deepseek-harness'];
const DISCOVER_TOP = 250; // 每个 keyword 抓前 250 条

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJSON(url, opts = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'user-agent': UA,
          accept: 'application/json',
          ...(GITHUB_TOKEN && url.startsWith('https://api.github.com')
            ? { authorization: `Bearer ${GITHUB_TOKEN}` }
            : {}),
          ...opts.headers,
        },
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 404) return null;
      if (res.status === 403 || res.status === 429) {
        const retry = parseInt(res.headers.get('retry-after') || '5', 10);
        console.warn(`  ⚠ ${res.status} 限流 ${url}，等待 ${retry}s（第 ${attempt}/3 次）`);
        await sleep((retry + 1) * 1000);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      console.warn(`  ⚠ ${e.message} ${url}（第 ${attempt}/3 次）`);
      if (attempt === 3) return null;
      await sleep(2000 * attempt);
    }
  }
  return null;
}

// ---- 发现: npm search 各关键词，合并去重 ----
async function discoverPackages() {
  const found = new Map(); // name -> { name, version, description, links }
  for (const kw of NPM_KEYWORDS) {
    console.log(`发现: npm search keywords:${kw}`);
    const url = `https://registry.npmjs.org/-/v1/search?text=keywords:${encodeURIComponent(kw)}&size=${DISCOVER_TOP}`;
    const data = await fetchJSON(url);
    for (const obj of data?.objects || []) {
      const p = obj.package;
      if (p?.name && !found.has(p.name)) {
        found.set(p.name, {
          name: p.name,
          version: p.version,
          description: p.description || '',
          links: p.links || {},
          publisher: p.publisher?.name || p.author?.name || '',
          date: p.date || '',
        });
      }
    }
    await sleep(300);
  }
  console.log(`发现: 共 ${found.size} 个包`);
  return found;
}

// ---- 指标: npm 下载量 ----
async function npmDownloads(name) {
  const week = await fetchJSON(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(name)}`);
  const total = await fetchJSON(
    `https://api.npmjs.org/downloads/point/2015-01-01:2030-01-01/${encodeURIComponent(name)}`,
  );
  return {
    downloads: week?.downloads ?? null,
    'npm-total': total?.downloads ?? null,
  };
}

// ---- 指标: GitHub stars / pushedAt（从 repo URL 解析 owner/repo）----
function parseRepo(url) {
  if (!url) return null;
  const m = String(url).match(/github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

async function githubRepoMetrics(repoUrl) {
  const r = parseRepo(repoUrl);
  if (!r) return null;
  const data = await fetchJSON(`https://api.github.com/repos/${r.owner}/${r.repo}`);
  if (!data) return null;
  return {
    stars: data.stargazers_count ?? null,
    pushedAt: data.pushed_at ? new Date(data.pushed_at).getTime() : null,
    // 真实 repo 可能与种子记录不同（改名/转移）
    htmlUrl: data.html_url,
    defaultBranch: data.default_branch,
  };
}

// ---- 组装插件条目（市场 format-1 结构）----
async function loadCachedMetrics() {
  if (existsSync(CACHE_FILE)) {
    try {
      return JSON.parse(await readFile(CACHE_FILE, 'utf8'));
    } catch {
      /* 损坏缓存当无缓存 */
    }
  }
  return {};
}

async function saveCachedMetrics(cache) {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(cache));
}

function oneWeekAgoTs() {
  return Date.now() - 7 * 24 * 3600 * 1000;
}

/** description 兼容处理：种子可能是字符串或 {en,zh} 对象；空白回退为 name */
function normalizeDescription(d, fallback) {
  let en, zh;
  if (d && typeof d === 'object') {
    en = typeof d.en === 'string' ? d.en : '';
    zh = typeof d.zh === 'string' ? d.zh : en;
  } else {
    en = typeof d === 'string' ? d : '';
    zh = en;
  }
  if (!en.trim()) en = fallback;
  if (!zh.trim()) zh = en;
  return { en, zh };
}

function buildEntry(rec, metrics) {
  // rec: { name, source, version, commit?, url?, description, author, title?, keywords, labels }
  // metrics: { stars?, pushedAt?, downloads?, 'npm-total'?, prevStars? }
  const sortKeys = {};
  if (metrics.stars != null) sortKeys.stars = metrics.stars;
  if (metrics.prevStars != null && metrics.stars != null) {
    const gain = metrics.stars - metrics.prevStars;
    if (gain > 0) sortKeys['star-gain'] = gain; // 原库规则: 无增量不写键
  }
  if (metrics['npm-total'] != null) sortKeys['npm-total'] = metrics['npm-total'];
  if (metrics.downloads != null) sortKeys.downloads = metrics.downloads;

  // rec.source==='git' 但 url/commit 缺失或 GitHub 查询失败时，回退为 npm 源（官方校验要求 source.url 非空）
  const gitUrl = rec.url || rec.repo || metrics.htmlUrl || null;
  const source = rec.source === 'git' && rec.commit && gitUrl
    ? { type: 'git', url: gitUrl, commit: rec.commit }
    : { type: 'npm' };

  const entry = {
    name: rec.name,
    description: normalizeDescription(rec.description, rec.name),
    author: rec.author || rec.publisher || '',
    repository: { url: metrics.htmlUrl || rec.url || `https://www.npmjs.com/package/${rec.name}` },
    metadata: {
      keywords: rec.keywords || [],
      labels: rec.labels?.length ? rec.labels : ['install-unverified', 'risk-pending'],
      sortKeys,
    },
    versions: [
      {
        version: rec.version,
        publishTimestamp: rec.publishTimestamp || Math.floor(new Date(rec.date || Date.now()).getTime() / 1000),
        source,
        ...(rec.engines ? { engines: rec.engines } : {}),
      },
    ],
  };
  if (rec.title) entry.title = rec.title;
  return entry;
}

// ---- main ----
const rebuildOnly = process.argv.includes('--rebuild-only');
await mkdir(path.dirname(OUT_FILE), { recursive: true });

const seed = JSON.parse(await readFile(SEED_FILE, 'utf8'));
const cache = await loadCachedMetrics();
console.log(`种子: ${seed.count} 条  缓存: ${Object.keys(cache).length} 条`);

if (!rebuildOnly) {
  // 1) 发现新包
  const discovered = await discoverPackages();
  const known = new Set(seed.plugins.map((p) => p.name));
  let added = 0;
  for (const [name, info] of discovered) {
    if (known.has(name)) continue;
    // 新包: 从 npm registry 拉全量元数据入库
    const reg = await fetchJSON(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
    if (!reg?.['dist-tags']?.latest) continue;
    const v = reg.versions?.[reg['dist-tags'].latest];
    if (!v) continue;
    seed.plugins.push({
      name,
      source: 'npm',
      version: v.version,
      description: (info.description || v.description || '').slice(0, 300),
      author: typeof v.author === 'string' ? v.author : v.author?.name || info.publisher || '',
      title: null,
      keywords: Object.keys(v.keywords || {}).length ? v.keywords : info.links?.repository ? [] : [],
      labels: ['install-unverified', 'risk-pending'],
      url: info.links?.repository || null,
      date: info.date,
      publishTimestamp: v.time ? Math.floor(new Date(v.time).getTime() / 1000) : Math.floor(Date.now() / 1000),
      engines: v.engines?.dsh ? { dsh: v.engines.dsh } : undefined,
    });
    known.add(name);
    added++;
    await sleep(150);
  }
  console.log(`新发现入库: ${added} 个`);

  // 2) 指标抓取（增量: 缓存 24h 内且带 star 基线的跳过）
  const now = Date.now();
  let fetched = 0, skipped = 0, failed = 0;
  for (const rec of seed.plugins) {
    const c = cache[rec.name];
    const fresh = c && now - c.fetchedAt < 24 * 3600 * 1000 && c.stars != null;
    if (fresh) {
      // 计算 star-gain: 用缓存里的 starsAtWeekStart
      rec._metrics = { ...c, prevStars: c.starsAtWeekStart ?? c.stars };
      skipped++;
      continue;
    }
    const gh = await githubRepoMetrics(rec.url || rec.repo);
    const dl = await npmDownloads(rec.name);
    const prevStars = c?.starsAtWeekStart ?? c?.stars ?? gh?.stars ?? null;
    rec._metrics = {
      stars: gh?.stars ?? null,
      pushedAt: gh?.pushedAt ?? null,
      downloads: dl.downloads,
      'npm-total': dl['npm-total'],
      prevStars,
      starsAtWeekStart: gh?.stars ?? c?.starsAtWeekStart ?? null, // 本周基线（下次算增量用）
      fetchedAt: now,
    };
    if (gh || dl.downloads != null) fetched++; else failed++;
    cache[rec.name] = rec._metrics;
    if ((fetched + failed) % 25 === 0) {
      console.log(`  进度: ${fetched + failed}/${seed.plugins.length}（成功 ${fetched} 失败 ${failed}）`);
      await saveCachedMetrics(cache); // 断点续存
    }
    await sleep(120); // 礼貌限速
  }
  console.log(`指标: 新抓 ${fetched}  缓存复用 ${skipped}  无数据 ${failed}`);
  await saveCachedMetrics(cache);
} else {
  for (const rec of seed.plugins) {
    rec._metrics = cache[rec.name] || {};
  }
}

// 3) 剔除 stale 基线: star-gain 只保留 7 天内有意义的增量
const weekAgo = oneWeekAgoTs();
for (const rec of seed.plugins) {
  if (rec._metrics && rec._metrics.pushedAt && rec._metrics.pushedAt < weekAgo) {
    rec._metrics.pushedAt = rec._metrics.pushedAt; // 保留活跃榜排序值
  }
}

// 4) 组装 → 六榜 → 合并
const entries = seed.plugins.map((rec) => buildEntry(rec, rec._metrics || {}));
const boards = rankBoards(entries, { perBoard: PER_BOARD });
const market = buildMarket(boards, {
  perBoard: PER_BOARD,
  titleEn: 'DSH Curated Leaderboard Market',
  titleZh: 'DSH 精选榜单市场',
});

await writeFile(OUT_FILE, JSON.stringify(market));
const catCount = {};
for (const p of market.plugins) catCount[p.metadata.category] = (catCount[p.metadata.category] || 0) + 1;
console.log(`✅ 已生成 ${OUT_FILE}: ${market.plugins.length} 条`);
console.log(`   分类: ${JSON.stringify(catCount)}`);

// 5) 顺带保存更新后的种子清单（新发现持久化）
seed.count = seed.plugins.length;
seed.generatedAt = new Date().toISOString();
await writeFile(SEED_FILE, JSON.stringify(seed, null, 2));
console.log(`✅ 种子清单已更新: ${seed.count} 条`);
