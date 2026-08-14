# 文档同步

官网的 `/docs/` 页面不是手工复制的一份说明，而是由 `scripts/sync-maw-docs.mjs` 从当前仓库根目录的 MAW 文档生成的静态 Markdown 页面。

## 本地刷新

在 MAW 仓库根目录运行：

```powershell
npm --prefix website run sync:docs
```

默认读取 `../moys-asr-workflow`。如果原始库位于其他位置，可以指定：

```powershell
$env:MAW_SOURCE_DIR = 'D:\Projects\moys-asr-workflow'
npm --prefix website run sync:docs
```

脚本只同步公开导航中的文档，写入 `website/src/pages/docs/`，并把原库内部的 Markdown 链接改成网站路由；没有对应页面的图片和文档链接会指向 MAW GitHub 原文。生成文件需要和网站代码一起提交，这样 Vercel 或 GitHub Pages 构建时不依赖本机存在 MAW 原始库。

README 中的共享演示凭据段不会同步到官网，只保留使用自有 API Key 的提示。

如果本地没有原始库，脚本会尝试从 MAW GitHub `main` 分支读取源文件。同步完成后仍应运行 `npm run check` 和 `npm run build`，确认上游文档的 Markdown 变化没有破坏页面。
