# 部署备忘

## Vercel（当前优先候选）

在 Vercel 导入本仓库，将 Root Directory 设为 `website`，Framework Preset 选择 Astro，Build Command 使用 `npm run build`，Output Directory 使用 `dist`。

正式使用时绑定自定义域名，不要只宣传 `*.vercel.app`。Vercel 官方说明中国大陆没有本地基础设施，默认域名可能被阻断或限速；即使绑定自定义域名也不能保证大陆可用性。

## GitHub Pages

GitHub Actions 在 `website/` 中运行 `npm ci`、同步当前仓库 docs、`npm run build`，然后把 `website/dist/` 发布到 Pages；再将 `blank-editor.html` 生成为 `website/dist/editor/index.html`。项目站点使用 `BASE_PATH=/moys-asr-workflow` 和对应的 `SITE_URL`，Astro 内部链接必须经过 `sitePath()`。

## 镜像策略

如果 MAW 主要面向大陆用户，可以保留两份静态部署：Vercel 服务海外和 PR 预览，另一个静态托管服务作为大陆友好入口。两份都应从同一个 Git 提交构建，不在镜像上手工改文案。

## 发布检查

- 本地 `npm run build` 成功。
- `website/dist/` 不进入 Git。
- 网站没有 `.env`、API Key、媒体或个人绝对路径。
- 所有图片和字体都来自本地或仓库确认过的来源。
- 下载按钮仍指向主仓库的 `releases/latest`。
- 检查手机宽度和键盘焦点；不要依赖 hover 才能理解内容。
