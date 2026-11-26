/**
 * src/build.js — 六榜合并核心（纯函数，无 IO）
 * 规则与原库 top-rank.json 完全一致：
 *  1. 六榜固定优先级 stars > star-gain > npm-total > npm-week > active > new-arrivals
 *  2. 同一插件只录入一次（归最高优先级榜），低优先级榜名额由后续名次补位
 *  3. 全局 rank = 优先级序号 × perBoard + 榜内最终名次
 *  4. top-rank-* 标签记录上过的每一张榜（全量扫描，与是否录入无关）
 *  5. sortKeys 精确值；缺数据省键（保留真实 0）；rank 恒写
 */
export const BOARD_ORDER = ['stars', 'star-gain', 'npm-total', 'npm-week', 'active', 'new-arrivals'];
export const BOARD_METRIC = {
  stars: 'stars',
  'star-gain': 'star-gain',
  'npm-total': 'npm-total',
  'npm-week': 'downloads',
  active: null,
  'new-arrivals': null,
};
const SORTKEY_ORDER = ['stars', 'downloads', 'rank', 'star-gain', 'npm-total'];

export const CATEGORIES = {
  stars: { title: { en: 'Most starred', zh: 'Star 总榜' } },
  'star-gain': { title: { en: 'Weekly star gain', zh: 'Star 周榜' } },
  'npm-total': { title: { en: 'npm downloads (total)', zh: 'Npm 总榜' } },
  'npm-week': { title: { en: 'npm downloads (weekly)', zh: 'Npm 周榜' } },
  active: { title: { en: 'Most active', zh: '活跃榜' } },
  'new-arrivals': { title: { en: 'New arrivals', zh: '新上架榜' } },
};

export const LABELS = {
  'install-verified': { title: { en: 'Install verified', zh: '安装已验证' } },
  'install-unverified': { title: { en: 'Install not verified', zh: '安装未验证' } },
  'risk-low': { title: { en: 'Low risk', zh: '低风险' } },
  'risk-pending': { title: { en: 'Audit pending', zh: '审计待定' } },
  'top-rank-stars': { title: { en: 'Stars leaderboard', zh: 'Star 总榜' } },
  'top-rank-star-gain': { title: { en: 'Weekly star gain', zh: 'Star 周榜' } },
  'top-rank-npm-total': { title: { en: 'npm downloads (total)', zh: 'Npm 总榜' } },
  'top-rank-npm-week': { title: { en: 'npm downloads (weekly)', zh: 'Npm 周榜' } },
  'top-rank-active': { title: { en: 'Most active', zh: '活跃榜' } },
  'top-rank-new-arrivals': { title: { en: 'New arrivals', zh: '新上架榜' } },
};

export const SORT_KEYS_META = {
  stars: { title: { en: 'GitHub stars', zh: 'GitHub 星标' }, order: 'desc' },
  downloads: { title: { en: 'Weekly npm downloads', zh: 'npm 周下载量' }, order: 'desc' },
  'npm-total': { title: { en: 'npm downloads (total)', zh: 'npm 累计下载量' }, order: 'desc' },
  rank: { title: { en: 'Leaderboard rank', zh: '榜单名次' }, order: 'asc' },
  'star-gain': { title: { en: 'Weekly star gain', zh: '近 7 天 ★ 增量' }, order: 'desc' },
};

function orderedSortKeys(sk) {
  const out = {};
  for (const k of SORTKEY_ORDER) if (sk[k] !== undefined && sk[k] !== null) out[k] = sk[k];
  for (const k of Object.keys(sk)) if (!(k in out) && sk[k] !== undefined && sk[k] !== null) out[k] = sk[k];
  return out;
}

function orderedLabels(baseLabels, boardTags) {
  const risk = baseLabels.filter((l) => l.startsWith('risk-'));
  const instV = baseLabels.filter((l) => l === 'install-verified');
  const instU = baseLabels.filter((l) => l === 'install-unverified');
  const rest = baseLabels.filter((l) => !l.startsWith('risk-') && !l.startsWith('install-'));
  return [...instV, ...risk, ...instU, ...rest, ...boardTags];
}

/**
 * 把"插件目录"（含各指标）切成六张榜。
 * @param {Array} plugins 全量插件，每条需含 metadata.sortKeys 里的指标
 * @param {object} opts { perBoard, excludeLabels[], starGainWindow }
 * @returns {object} boards: { stars: [...], ... }
 */
export function rankBoards(plugins, opts = {}) {
  const perBoard = opts.perBoard ?? 200;
  const exclude = new Set((opts.excludeLabels || []).filter(Boolean));
  const eligible = plugins.filter((p) => {
    const labels = (p.metadata?.labels) || [];
    if (labels.some((l) => exclude.has(l))) return false;
    if (!p.versions || p.versions.length === 0) return false;
    if (!p.versions[0].version) return false;
    return true;
  });

  const boards = {};
  for (const b of BOARD_ORDER) {
    const metric = BOARD_METRIC[b];
    let list;
    if (metric) {
      list = eligible
        .filter((p) => {
          const v = p.metadata?.sortKeys?.[metric];
          return v !== undefined && v !== null;
        })
        .sort((x, y) => {
          const d = y.metadata.sortKeys[metric] - x.metadata.sortKeys[metric];
          if (d !== 0) return d;
          return String(x.name).localeCompare(String(y.name)); // 稳定次序
        });
    } else if (b === 'new-arrivals') {
      // 新上架: 按首次发布时间倒序
      list = eligible
        .filter((p) => p.versions?.[0]?.publishTimestamp)
        .sort((x, y) => {
          const d = y.versions[0].publishTimestamp - x.versions[0].publishTimestamp;
          if (d !== 0) return d;
          return String(x.name).localeCompare(String(y.name));
        });
    } else {
      // 活跃: 按最近提交/发布时间倒序
      list = eligible
        .filter((p) => p.metadata?.sortKeys?.pushedAt || p.versions?.[0]?.publishTimestamp)
        .sort((x, y) => {
          const px = x.metadata?.sortKeys?.pushedAt || x.versions?.[0]?.publishTimestamp || 0;
          const py = y.metadata?.sortKeys?.pushedAt || y.versions?.[0]?.publishTimestamp || 0;
          const d = py - px;
          if (d !== 0) return d;
          return String(x.name).localeCompare(String(y.name));
        });
    }
    boards[b] = list.slice(0, perBoard * 3); // 多取一些，供补位
  }
  return boards;
}

/** 六榜合并成最终市场文档 */
export function buildMarket(boards, opts = {}) {
  const perBoard = opts.perBoard ?? 200;
  const seen = new Set();
  const charted = new Map();
  const filed = [];

  BOARD_ORDER.forEach((board, idx) => {
    const list = boards[board] || [];
    let taken = 0;
    for (const p of list) {
      if (!charted.has(p.name)) charted.set(p.name, []);
      if (!charted.get(p.name).includes(board)) charted.get(p.name).push(board);
      if (!seen.has(p.name) && taken < perBoard) {
        taken++;
        seen.add(p.name);
        filed.push({ plugin: p, board, boardIdx: idx, posInBoard: taken });
      }
    }
  });

  const plugins = filed.map(({ plugin: p, board, boardIdx, posInBoard }) => {
    const raw = Object.assign({}, p.metadata?.sortKeys || {});
    delete raw.rank;
    delete raw.pushedAt;
    const sk = orderedSortKeys(raw);
    sk.rank = boardIdx * perBoard + posInBoard;

    const boardTags = charted
      .get(p.name)
      .filter((b) => BOARD_ORDER.includes(b))
      .map((b) => 'top-rank-' + b)
      .sort((x, y) => BOARD_ORDER.indexOf(x.slice(9)) - BOARD_ORDER.indexOf(y.slice(9)));

    const baseLabels = (p.metadata?.labels || []).filter((l) => !l.startsWith('top-rank-'));
    const entry = { name: p.name };
    if (p.title) entry.title = p.title;
    entry.description = p.description;
    entry.author = p.author;
    if (p.repository) entry.repository = p.repository;
    entry.metadata = {
      category: board,
      keywords: p.metadata?.keywords || [],
      labels: orderedLabels(baseLabels, boardTags),
      sortKeys: orderedSortKeys(sk),
    };
    entry.versions = p.versions;
    return entry;
  });

  return {
    format: 1,
    title: {
      en: opts.titleEn || 'DSH Curated Leaderboard Market',
      zh: opts.titleZh || 'DSH 精选榜单市场',
    },
    description: {
      en: 'One curated market index built from six installable-plugin leaderboards (total stars, weekly star gain, npm downloads all-time and weekly, recent commits, newest arrivals). A plugin charting on several boards is filed once under the highest-priority board; lower-board slots are refilled by the next ranked plugin, and top-rank-* labels list every board it appears on. Selection numbers are exact sortKeys; a missing number omits the key instead of writing 0. Third-party content — review before installing.',
      zh: '把六张可安装插件榜（Star 总榜、Star 周榜、npm 累计 / 周下载、活跃榜、新上架榜）合并成一份文档。同一插件上多张榜时不丢条目：只录入一次（归榜优先级最高的那张），其在后续榜上的名额由该榜后续名次顶替，top-rank-* 标签记录它上过的每一张榜。选型数字是 sortKeys 的精确值，缺数据就不写这个键，绝不写 0。第三方内容，安装前请自行确认。',
    },
    metadata: { categories: CATEGORIES, labels: LABELS, sortKeys: SORT_KEYS_META },
    plugins,
  };
}
