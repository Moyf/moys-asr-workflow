# 官网文档同步

源文档位于本仓库根 README、JSON_SCHEMA 和 docs；`website/src/pages/docs/*.md` 是生成副本，不手工编辑正文。

## 刷新与检查

在仓库根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm run sync:docs
pnpm run check
pnpm run build
```

脚本 `website/scripts/sync-maw-docs.mjs` 默认读取当前仓库根目录。只有从其他仓库取源文档时，才设置 `MAW_SOURCE_DIR`。某个源文件不存在时，脚本尝试从 GitHub main 获取；离线同步须确保源文件完整。

同步清单显式列出公开页面，不自动发布 TEST_FEEDBACK 或 dev 内部记录。没有独立官网页面的文档通过 GitHub 原文访问；已有页面的相对 Markdown 链接会转换为本站路由。

文档引用的本地图片会同步到 `website/public/docs-assets/`，保留源仓库目录结构，并转换为本站相对地址，支持 `BASE_PATH`。与 Markdown 副本一样，这些文件是生成产物；修改原图后重新运行同步，不手改副本。外部图片继续使用原地址。本地图片缺失时尝试从 GitHub main 获取；离线同步须同时保留原图。

新增公开专题时，同步维护脚本清单与 `website/src/lib/docs-navigation.ts` 的阅读分组；docs 首页和 DocLayout 侧栏共用这份导航。生成副本与源文件一起提交，部署时不依赖本机其他仓库。脚本保留旧 README 演示凭据段的过滤防护；当前 README 没有共享凭据。

只修改文档不需要生成根目录 `blank-editor.html`。网站构建与线上部署是不同验证层；本地构建成功不能当作已发布。
