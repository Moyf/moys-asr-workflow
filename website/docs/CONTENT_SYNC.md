# 官网文档同步

源文档位于本仓库根 README、JSON_SCHEMA 和 docs/user、docs/engineering；文档导航来自 docs/INDEX.md。`website/src/pages/docs/*.md` 是生成副本，不手工编辑正文。

## 刷新与检查

在仓库根目录运行：

```sh
pnpm --dir website install --frozen-lockfile
pnpm --dir website run sync:releases
pnpm --dir website run check
pnpm --dir website run build
```

开发、检查和构建在新建隔离目录生成当前 checkout 的文档和配图；缺少输入即失败，不从远端回退。旧生成页面和 `public/docs-assets/` 镜像不进入隔离输入，其他手写页面与资源保留。`legacy-doc-assets.json` 登记已知历史镜像；`public/docs-assets/` 内的手写文件须列入 `authored-doc-assets.json` 才会被复制，未登记的文件会使构建报错并保留原文件。`sync:docs` 可手动刷新旧副本，会覆盖对应文件；`check:docs` 只读比对旧副本，二者不是构建前置条件。`sync:releases` 会移动已有发布生成物，运行前先确认其操作范围。

同步清单显式列出公开页面，不自动发布 TEST_FEEDBACK 或 dev 内部记录。没有独立官网页面的文档通过 GitHub 原文访问；已有页面的相对 Markdown 链接会转换为本站路由。

`provider-research` 保留供应商调研的历史 URL，未列入现行使用指南导航；其来源、日期和适用范围以日志原文为准。

文档引用的本地图片会同步到 `website/public/docs-assets/`，保留源仓库目录结构，并转换为本站相对地址，支持 `BASE_PATH`。与 Markdown 副本一样，这些文件是生成产物；修改原图后重新运行同步，不手改副本。外部图片继续使用原地址。本地图片缺失时直接报错。

新增公开专题时，同步维护脚本清单、`stage-site.mjs` 的历史 slug 清单与 `website/src/lib/docs-navigation.ts` 的阅读分组；退役 slug 也须保留在历史清单中。清单中的路径留给生成页面。开发服务器同步源文档与手写网站文件的更改；清单变化、文件删除或配图引用减少时停止并提示重启。既有 Git 跟踪的生成副本保留，功能 PR 无需提交其变化。部署必须取得完整仓库源文档。脚本保留旧 README 演示凭据段的过滤防护；当前 README 没有共享凭据。

只修改文档不需要生成根目录 `blank-editor.html`。网站构建与线上部署是不同验证层；本地构建成功不能当作已发布。

## 正式版更新记录

`/releases/` 与每版详情从 `docs/releases/<版本>.md` 构建，不回头读取 CL 正文。首次本地检查或开发前，在根目录运行 `python scripts/build_release_site.py --preview`，或在 website 运行 `pnpm run sync:releases`；这会生成候选正式版页面，但公开更新 JSON 仍为空，不向软件宣告未发布版本。

核对真实发布记录时使用 `python scripts/build_release_site.py --github`；可用 `--facts <保存的完整 GitHub releases JSON>` 离线复核。`SITE_URL` 和 `BASE_PATH` 须与网站 build 一致，GitHub Pages 使用 `https://moyf.github.io` 与 `/moys-asr-workflow`。需要完整 tag 历史以读取固定版本图片。API 失败不会生成空的正式版索引。

Release 的 Markdown 页面、`src/generated/releases.json`、`public/releases/` 与 `public/release-assets/` 都是被忽略的构建输出，不手工修改、不提交。配图从指定 tag / commit 读取，按内容摘要去重，仅出现在网站部署产物；已有使用指南的生成副本仍遵循上面的同步流程。完整契约见[版本管线](../../docs/releases/README.md)。
