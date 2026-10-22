# MAW Website

Astro 官网草稿，面向 `Moy's ASR Workflow`（MAW）项目的下载、定位说明和快速上手入口。

## 本地开发

在仓库根目录执行（需要 Node 20+ 与 pnpm；`sync:releases` 另需 Python 在 PATH 上）：

```powershell
pnpm --dir website install --frozen-lockfile   # 安装依赖（仅首次或锁文件变更后）
pnpm --dir website run sync:releases           # 生成 /releases/ 数据；生成物不入库，缺它构建会失败
pnpm --dir website run dev                     # 开发服务器 http://localhost:4321，改源码热更新
```

其余常用命令：

```powershell
pnpm --dir website run check          # astro check：类型与 .astro 语法检查
pnpm --dir website run sync:docs      # 从仓库公开文档重新生成 /docs/ 阅读区
pnpm --dir website run build          # 构建静态站点到 website/dist/
pnpm --dir website run preview        # 本地预览 dist/ 构建产物
```

在 `website/` 目录内执行时去掉 `--dir website` 前缀即可；同步与生成输出均被 Git 忽略，重新克隆或拉取后需要重新生成。构建输出在 `dist/`。目前站点不包含后端、账号、上传接口或在线转写功能。

## 内容边界

- MAW 是本地优先的字幕工作流，以云端 API 转写为主，连接 MAWE 编辑、文稿整理、可逆空隙移除与字幕交付；本地模型入口仍属实验性。
- 主仓库是唯一的软件事实来源：<https://github.com/Moyf/moys-asr-workflow>
- 下载按钮指向主仓库的最新 Release，不在此仓库复制版本包。
- `/docs/` 是从当前仓库公开文档生成的静态阅读区；在 `website/` 中运行 `pnpm run sync:docs` 可刷新内容。
- 单独运行 Astro 构建不包含 `/editor/`。GitHub Pages 工作流在构建后把编辑器生成到 `website/dist/editor/index.html`，不会重生成仓库根目录的 `blank-editor.html`。
- 首页（中文 `/`、英文 `/en/`）由 `src/components/Home.astro` 渲染，文案集中在 `src/i18n/home.ts`，样式为独立的 `src/styles/home.css`（令牌沿用 Launcher 改版：亮色红白 / 暗色黑橙，明暗可切换），交互脚本在 `src/scripts/home.ts`。文档页仍使用 `global.css` / `docs.css`。
- 首页配图在 `public/home/`，来自主仓库 `docs/assets/` 与 Launcher 改版原型截图；更新截图时应人工确认内容。演示走马灯在 `home.ts` 的 `demos` 里填 `video`（悬停播放）或 `img`，都不填显示「即将推出」。
- `/releases/` 采用月份索引和连续正文，保留 `/releases/<版本>/` 独立说明与实际下载；`UpdatesLayout.astro` 与 `releases.css` 共同呈现独立的更新页主题。

## 计划部署

GitHub Pages 发布同一仓库的官网、文档和 `/editor/`；也可以在 Vercel 中把 `website/` 设为 Root Directory 单独部署。大陆访问不保证稳定；正式上线前应在不同运营商网络实测。

部署细节和内容清单见 [`docs/PROJECT_BRIEF.md`](docs/PROJECT_BRIEF.md) 与 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。

文档同步规则见 [docs/CONTENT_SYNC.md](docs/CONTENT_SYNC.md)。

## 依赖安全补丁

官网锁文件将 `fast-uri` 更新至 3.1.9，并将外部 `source-map-js` 统一至 1.2.2。
`magicast@0.5.5` 最新发布包仍内嵌 `source-map-js@1.2.1`，因此通过
`pnpm-workspace.yaml` 注册版本限定补丁，回移上游 [CVE-2026-93749 修复](https://github.com/7rulnik/source-map-js/commit/cf76580)：
校验单层及累计 section offset、缓存嵌套 sources、避免逐行字符串累积和越过源代码末尾的填充。
该副本是安全修复回移，包内版本标记仍为 1.2.1；不能仅凭外部依赖树判断补丁状态。
待 magicast 上游发布包含这些修复的版本后，可升级父包并移除此补丁。

安装后从仓库根目录运行 `node --test website/tests/security-dependencies.test.mjs`，
检查实际安装的内嵌副本与配置修改能力；测试对同步放大路径设置执行期限。
