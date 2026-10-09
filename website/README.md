# MAW Website

Astro 官网草稿，面向 `Moy's ASR Workflow`（MAW）项目的下载、定位说明和快速上手入口。

## 本地开发

```powershell
pnpm install --frozen-lockfile
pnpm run dev
```

构建静态站点：

```powershell
pnpm run build
```

构建输出在 `dist/`。目前站点不包含后端、账号、上传接口或在线转写功能。

## 内容边界

- MAW 是本地优先的字幕工作流，以云端 API 转写为主，连接 MAWE 编辑、文稿整理、可逆空隙移除与字幕交付；本地模型入口仍属实验性。
- 主仓库是唯一的软件事实来源：<https://github.com/Moyf/moys-asr-workflow>
- 下载按钮指向主仓库的最新 Release，不在此仓库复制版本包。
- `/docs/` 是从当前仓库公开文档生成的静态阅读区；在 `website/` 中运行 `pnpm run sync:docs` 可刷新内容。
- 单独运行 Astro 构建不包含 `/editor/`。GitHub Pages 工作流在构建后把编辑器生成到 `website/dist/editor/index.html`，不会重生成仓库根目录的 `blank-editor.html`。
- `editor-screenshot.jpg` 来自主仓库的编辑器截图，更新截图时应人工确认许可证和内容。

## 计划部署

GitHub Pages 发布同一仓库的官网、文档和 `/editor/`；也可以在 Vercel 中把 `website/` 设为 Root Directory 单独部署。大陆访问不保证稳定；正式上线前应在不同运营商网络实测。

部署细节和内容清单见 [`docs/PROJECT_BRIEF.md`](docs/PROJECT_BRIEF.md) 与 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。

文档同步规则见 [docs/CONTENT_SYNC.md](docs/CONTENT_SYNC.md)。
