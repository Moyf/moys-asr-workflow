# 版本更新文档与发布管线

`CHANGELOG.md` 是唯一人工维护的更新正文，包括正式版的图文精修。正式版发布前从对应条目生成 `<版本>.md`，随代码提交；GitHub Release 与官网读取归档，补上实际下载与发布信息。beta / rc 不新增归档，GitHub prerelease 仍直接从 CL 生成临时正文。

```text
CHANGELOG.md → docs/releases/<正式版本>.md → GitHub Release / 官网 / 更新 JSON
```

## 正式版归档

1. 在 [CHANGELOG](../../CHANGELOG.md) 中精修正式版条目 `## [2.0.0] - YYYY-MM-DD`，加入配图，日期填写实际发布日期。保留新的 `## [未发布]` 供后续开发使用。
2. 在仓库根目录生成版本文档：

   ```powershell
   uv run --no-sync python scripts/prepare_release_notes.py --tag v2.0.0 --write-doc
   ```

3. 检查文档和最终 Release 预览：

   ```powershell
   uv run --no-sync python scripts/prepare_release_notes.py --tag v2.0.0 --check-doc
   uv run --no-sync python scripts/prepare_release_notes.py --tag v2.0.0 --output .artifacts/release-preview.md
   ```

4. 若发布前调整文字，只改 CL，再执行 `--write-doc`。检查预览后，将 CL 和对应版本文档一起提交；版本号、README、便携页和打包检查仍遵循原有发布流程。

生成器不会归档未发布条目、修改软件版本、创建 tag 或发布，也不会拼接 beta 历史。`--write-doc` 拒绝 beta / rc；`--write-all-stable` 可按版本顺序补齐全部正式版归档。正文与 CL 必须一致，不在归档文件中独立精修。

## 发布时整理开发日志

仓库的软件版本在根 `pyproject.toml` 的 `[project].version`；CHANGELOG 的首个具体版本条目与 `docs/releases/<版本>.md` 用于核对发布正文。开发分支的版本元数据不保证已经发布，实际发布仍以对应 tag / Release 为准。

日志分组基线单独写在 `docs/logs/INDEX.md` 顶部，明确新日志属于哪个版本之后的开发；不会因为提前修改软件版本而自动切换。发布前检查本轮开发日志，将放错位置的本轮日志移到当前提示指定的 `docs/logs/release<version>/` 目录，核对可读主题名，并修正受移动影响的链接。整理范围只限开发日志，不要求移动其他文档、图片、数据或脚本；以往开发阶段的日志保持原位置。

确认实际发布成功后，更新 `docs/logs/INDEX.md` 顶部的 `log-release-baseline`、目录提示与“该版本之后的开发”文字，供之后新建的开发日志使用。例如发布 `2.0.0-beta.1` 后，新建日志放 `docs/logs/release2.0.0-beta.1/`；发布前这一轮已整理的日志继续留在原目录，不搬到新目录。将提示更新随正常文档提交保存；若发布取消，保留原基线。

旧日志原文继续保留在仓库内，不因新一轮目录提示更新而再次搬动，也不要求逐份登记。时间与改动通过 Git 历史追溯。日志漏登记索引只提示，关键文档索引和实际断链仍按文档检查阻塞。

所有正式版均要求新鲜归档，文档缺失、被手改、换行不符或与 CL 不一致都会阻止发布。本次补齐了 CL 中的历史正式版；`1.6.1` 与 `1.2.0` 正文从对应 tag 的 CL 恢复。归档存在不等于已经发布，官网仍以真实发布状态和附件筛选。

## beta 与正式版

- beta 正文只在 CL 维护，首个 beta 可汇总上一正式版后的变化；后续 beta 通常记录增量。旧 beta 文档移至 `docs/archived/release-notes/` 保留追溯，不进入 `--check-all`、官网和更新索引。
- 正式版在 CL 中写一份完整、精简的版本总结，覆盖本轮全部 beta 能力，再生成正式版文档。合并重复项、清除过时描述和内部修复细节需要人工判断，脚本不拼接 beta 历史。
- 发布后保留正式版归档。后续开发只修改未发布条目；历史正文确需勘误时，改 CL、重生成，并单独核对已发布的 GitHub Release。tag 不移动；涉及新图片时须有可读取的固定 tag / commit 引用。

## 小版本保留系列大更新

在小版本 CL 条目内增加一个独立的注释行，引用同系列正式版 `X.Y.0`：

```markdown
## [2.0.1] - YYYY-MM-DD

<!-- release-base: 2.0.0 -->

### 🐛 修复

- 本次修复内容。
```

先生成 `2.0.0.md`，再生成 `2.0.1.md`。基础版本引用也只在 CL 中维护，不增加第二份配置。

`2.0.1.md` 只保存本次增量与基础版本元数据。最终 Release 展示顺序为：下载与使用指引 → 本次更新 →「2.0 系列主要更新」中的完整 2.0.0 正文。不会追加此前小版本，也不会追加 beta 历史；需要覆盖前几个小版本的修复时，应在本次 CL 中人工汇总。

基础版本必须是相同 `X.Y` 的正式 `X.Y.0`，不能是 beta、自身或另一个小版本。正文和基础文档都要通过新鲜度检查；无需系列回顾的版本不写该注释。

## 文档格式与链接

版本文件名不带 `v`，如 `2.0.0.md`。文件为 UTF-8、LF Markdown；第一行是 `maw-release` JSON 注释，包含：

| 字段 | 含义 |
| --- | --- |
| `schema` | `maw.release.v1` |
| `version` | 不带 `v` 的版本号 |
| `date` | CL 标题中的 ISO 发布日期 |
| `channel` | 新归档固定为 `stable` |
| `base` | 可选的系列基础版本；无引用时为 `null` |
| `source_sha256` | 对应 CL 条目的摘要，用于追溯 |

注释之后是本版本正文，不包含下载或构建结果。官网读取归档生成正文 JSON，软件将来可选择展示增量或基础版本；本次不实现客户端更新检查或安装。

从根目录 CL 提取的相对链接在生成时转换为对应 tag 的 GitHub 链接，图片使用 raw URL；包括普通 Markdown 链接、引用定义与 HTML 的 `src` / `href`。代码示例保持原样。发布前 tag 尚不存在时，远端链接暂不可访问；本地仍需核对源资源是否存在。

## 自动验证与 CI

```powershell
uv run --no-sync python scripts/prepare_release_notes.py --check-all
uv run --no-sync python scripts/run_tests.py tests/test_release_notes.py
```

`--check-all` 只读校验全部正式版归档，并要求 CL 的每个正式版条目都有对应文档；beta / rc 和未发布区不参与。PR / main CI 同时运行检查和管线回归。发布 CI 在 Windows 打包前校验正文，发布阶段按实际产物补下载信息。

测试预演可用 `--changelog <路径>` 和 `--releases-dir <目录>` 指向临时夹具，不改真实 CL 或归档目录。`--failed macos,linux` 仅用于 `--output`，从实际构建结果决定下载列表，不能写入版本归档。

## 官网、图片与更新接口

```powershell
python scripts/build_release_site.py --preview
python scripts/build_release_site.py --github --site-url https://moyf.github.io --base-path /moys-asr-workflow
```

二者择一：预览包括本地候选正式版并显示预览标记，公开更新 JSON 保持空；生产模式完整读取 GitHub Release 分页，只收录非 draft、非 prerelease 的正式语义版本，并要求有实际上传的 Windows 完整包。macOS / Linux 按现有政策允许缺失，下载区只列真实附件；旧 `MAWxFF` 命名也正确区分完整与轻量包。`--facts PATH` 可使用完整 API 响应离线构建，`--expected-tag vVERSION` 校验本次发布版本确实入选。

图片由归档中的固定 tag / commit 引用读取，按内容摘要去重；缺失时构建失败，不使用 main 同名图片冒充。仅候选预览允许尚未存在的当前版本 tag 从工作树读取图片。需要 `git fetch --tags` 或完整 checkout。图片、HTML、JSON、页面 Markdown 均为构建产物、不入 Git，不增加安装包内容。现有外链图按原地址保留，不自动下载第三方资源。

站点输出 `/releases/`、`/releases/<版本>/`、`/releases/index.json` 和 `/releases/<版本>/notes.json`。索引 schema 版本为 `1`，包含 `latest_stable`、`generated_at` 与按语义版本倒序的 `releases`；每版包含日期、实际发布时间、介绍与正文 JSON URL、系列基础版本及实际附件的系统 / 架构 / 完整或轻量变体 / 大小 / URL。正文 JSON 包含版本、基础版本和 `body_markdown`，本仓库图片为绝对站点地址。图片故障不应阻止未来客户端显示纯文本；客户端渲染前仍须清理 HTML，不执行正文中的代码。

生成期间不解析 CL 来补缺失归档。新增正式发布缺归档、API 失败、资源丢失均使网站任务失败，上一份成功部署继续服务；不会用空索引覆盖。撤回后重建会移除旧页面与索引条目。旧生成物移动到被忽略的 `.artifacts/release-site-previous/`，不影响源码模板。

## 发布顺序与恢复

Release CI 使用 `scripts/publish_release.py`：准备草稿 → 上传白名单安装包 → 按大小和上传状态核验 → 公开并验证发布标记。首次失败时不公开草稿；重跑已公开的版本不会先撤回它。

正式版发布成功后显式调用官网 reusable workflow，串行构建最新 main。main 必须已包含该版归档；新 tag 不会自动替代 main。官网只读取 GitHub 元数据与附件事实，不读取远端手改正文覆盖归档。部署后检查索引、目标版本正文和详情 URL。测试版发布不触发正式版站点刷新。

GitHub 发布成功而网站失败时，安装包仍然可用，状态为“官网待同步”；可手动运行 Pages workflow，填入可选的 `expected_tag` 单独重试。此流程不依赖由自动化凭据创建的普通 Release 事件再次触发工作流。
