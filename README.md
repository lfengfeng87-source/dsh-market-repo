# dsh-market-repo

自更新的 DSH 插件市场索引仓库 — 与官方 `cdn.dsh.so/market/top-rank.json` 同款 format-1 结构，GitHub Actions 每日自动重建，GitHub Pages 托管。

## 最终市场 URL

```
https://<你的用户名>.github.io/dsh-market-repo/market.json
```

推送后在仓库 Settings → Pages → Source 选 `gh-pages` 分支即可（首次 Actions 部署后会自动出现）。

## 接入 DSH

`/root/projects/.dsh/profiles/web/cordis.patch.yml` 的 `plugin-market.config.indexes` 追加一行：

```yaml
- https://<你的用户名>.github.io/dsh-market-repo/market.json
```

替换原 `http://127.0.0.1:8099/my-top-rank.json` 行后重启 DSH 生效。

## 仓库结构

```
├── src/
│   ├── build.js            六榜合并核心（纯函数）
│   └── seed.json           种子清单（1200 条，来自原库提取 + 自动发现追加）
├── scripts/
│   └── refresh.mjs         抓 npm/GitHub 数据 → 重建六榜 → public/market.json
├── public/
│   └── market.json         生成品（875 条，官方校验器通过）
├── verify-official.mjs     官方 parseMarketIndex 校验
├── verify-install.mjs      marketInstallTarget 安装目标校验
└── .github/workflows/
    └── refresh.yml         每日 UTC 0 点自动抓取、重建、提交、Pages 部署
```

## 本地运行

```bash
node scripts/refresh.mjs --rebuild-only   # 只用缓存重建（无网络）
GITHUB_TOKEN=ghp_xxx node scripts/refresh.mjs   # 全流程（发现新包 + 抓指标）
node verify-official.mjs public/market.json     # 官方校验
node verify-install.mjs  public/market.json     # 安装目标校验
```

## 榜单规则（与原库一致）

| 优先级 | 榜 | 排序键 |
|---|---|---|
| 1 | stars（Star 总榜） | GitHub stars |
| 2 | star-gain（Star 周榜） | 近 7 天 ★ 增量 |
| 3 | npm-total | npm 累计下载 |
| 4 | npm-week | npm 周下载 |
| 5 | active（活跃榜） | 最近推送时间 |
| 6 | new-arrivals（新上架榜） | 首次发布时间 |

- 同插件上多榜只录入一次，归最高优先级榜；低榜名额由后续名次补位
- 全局 rank = 优先级序号 × perBoard + 榜内名次（连续分段）
- `top-rank-*` 标签记录上过的每一张榜
- 选型数字是 sortKeys 精确值，缺数据省键，绝不写 0

## Actions 需要的配置

- **无需额外 secret**：workflow 用 `github.token`（限 60 次/小时，够 1200 条种子分批跑）；想要不限速可在仓库 Settings → Secrets → Actions 添加 `MARKET_GH_TOKEN`（classic PAT，勾 `public_repo` 即可），workflow 会自动优先使用。
- **Pages**：首次运行后在 Settings → Pages 选择 `gh-pages` 分支 / 根目录。

## 数据源

- npm search（keywords: `dsh-plugin` / `cordis-plugin` / `dsh-better-sidebar` / `deepseek-harness`）— 自动发现新插件
- api.npmjs.org — 周 / 累计下载量
- api.github.com — stars / 最近推送
- 指标缓存 24h 增量（`cache/metrics.json`，断点续抓）
