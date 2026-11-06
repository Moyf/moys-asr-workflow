# 部署备忘

版本边界：下文独立 HTML / 在线编辑器的生成步骤仅适用于 1.x。2.0（含预发布版）起停止生成、打包和部署；历史文件保留。本地 Server 与共享 Web 前端继续维护，推荐下载本地应用。Pages 使用 `scripts/prepare_editor_pages.py` 执行版本策略，不直接调用旧生成命令。

## Vercel（当前优先候选）

在 Vercel 导入本仓库，将 Root Directory 设为 `website`，Framework Preset 选择 Astro，Build Command 使用 `pnpm run build`，Output Directory 使用 `dist`。

正式使用时绑定自定义域名，不要只宣传 `*.vercel.app`。Vercel 官方说明中国大陆没有本地基础设施，默认域名可能被阻断或限速；即使绑定自定义域名也不能保证大陆可用性。

## GitHub Pages

GitHub Actions 在 `website/` 中运行 `pnpm install --frozen-lockfile`、同步当前仓库 docs、`pnpm run build`，然后通过 `scripts/prepare_editor_pages.py` 应用版本策略：仅 1.x 生成 `website/dist/editor/index.html`，2.0 起不生成 `/editor/`，若候选目录残留旧编辑器则拒绝部署。此过程不重生成仓库根目录的历史空白 HTML。项目站点使用 `BASE_PATH=/moys-asr-workflow` 和对应的 `SITE_URL`，Astro 内部链接必须经过 `sitePath()`。

## 镜像策略

如果 MAW 主要面向大陆用户，可以保留两份静态部署：Vercel 服务海外和 PR 预览，另一个静态托管服务作为大陆友好入口。两份都应从同一个 Git 提交构建，不在镜像上手工改文案。

## 发布检查

- 本地 `pnpm run build` 成功。
- `website/dist/` 不进入 Git。
- 网站没有 `.env`、API Key、媒体或个人绝对路径。
- 所有图片和字体都来自本地或仓库确认过的来源。
- 下载按钮仍指向主仓库的 `releases/latest`。
- 检查手机宽度和键盘焦点；不要依赖 hover 才能理解内容。
