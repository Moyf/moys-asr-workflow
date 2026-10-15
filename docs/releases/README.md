# 版本更新文档与发布管线

`CHANGELOG.md` 是唯一人工维护的更新正文。发布前从对应版本条目生成 `<版本>.md`，随代码提交；发布时读取版本文档，补上下载链接、使用指引及实际平台构建状态。

```text
CHANGELOG.md → docs/releases/<版本>.md → GitHub Release
```

## 从 2.0 beta 开始

1. 在 [CHANGELOG](../../CHANGELOG.md) 中整理本次内容，将待发布条目归档为 `## [2.0.0-beta.1] - YYYY-MM-DD`，日期填写实际发布日期。保留新的 `## [未发布]` 供后续开发使用。
2. 在仓库根目录生成版本文档：

   ```powershell
   uv run --no-sync python scripts/prepare_release_notes.py --tag v2.0.0-beta.1 --write-doc
   ```

3. 检查文档和最终 Release 预览：

   ```powershell
   uv run --no-sync python scripts/prepare_release_notes.py --tag v2.0.0-beta.1 --check-doc
   uv run --no-sync python scripts/prepare_release_notes.py --tag v2.0.0-beta.1 --output .artifacts/release-preview.md
   ```

4. 若发布前调整文字，只改 CL，再执行 `--write-doc`。检查预览后，将 CL 和对应版本文档一起提交；版本号、README、便携页和打包检查仍遵循原有发布流程。

生成器不会归档未发布条目、修改软件版本、创建 tag 或发布。实际 2.0 更新内容尚未归档时，不生成占位版本文档；beta 到正式版也不会自动升级。

## 发布时整理开发日志

仓库的软件版本在根 `pyproject.toml` 的 `[project].version`；CHANGELOG 的首个具体版本条目与 `docs/releases/<版本>.md` 用于核对发布正文。开发分支的版本元数据不保证已经发布，实际发布仍以对应 tag / Release 为准。

日志分组基线单独写在 `docs/logs/INDEX.md` 顶部，明确新日志属于哪个版本之后的开发；不会因为提前修改软件版本而自动切换。发布前检查本轮开发日志，将放错位置的本轮日志移到当前提示指定的 `docs/logs/release<version>/` 目录，核对可读主题名，并修正受移动影响的链接。整理范围只限开发日志，不要求移动其他文档、图片、数据或脚本；以往开发阶段的日志保持原位置。

确认实际发布成功后，更新 `docs/logs/INDEX.md` 顶部的 `log-release-baseline`、目录提示与“该版本之后的开发”文字，供之后新建的开发日志使用。例如发布 `2.0.0-beta.1` 后，新建日志放 `docs/logs/release2.0.0-beta.1/`；发布前这一轮已整理的日志继续留在原目录，不搬到新目录。将提示更新随正常文档提交保存；若发布取消，保留原基线。

旧日志原文继续保留在仓库内，不因新一轮目录提示更新而再次搬动，也不要求逐份登记。时间与改动通过 Git 历史追溯。日志漏登记索引只提示，关键文档索引和实际断链仍按文档检查阻塞。

从 2.0 起，文档缺失、被手改、换行不符或与 CL 不一致都会阻止发布。1.x 没有版本文档时保留旧的 CL 提取方式，便于历史版本重跑；也可主动用 `--write-doc` 补生成历史文档。

## beta 与正式版

- 每个 beta 文档对应自己的 CL 条目。首个 beta 可汇总上一正式版后的变化；后续 beta 通常记录增量，不重复前面已经说明的能力。
- 正式版在 CL 中写一份完整、精简的版本总结，覆盖本轮全部 beta 能力，再生成正式版文档。合并重复项、清除过时描述和内部修复细节需要人工判断，脚本不拼接 beta 历史。
- 发布后保留 beta 与正式版归档。后续开发只修改未发布条目；历史正文确需勘误时，同时重新生成对应文档，并单独核对已发布的 GitHub Release。

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

版本文件名不带 `v`，如 `2.0.0-beta.1.md`。文件为 UTF-8、LF Markdown；第一行是 `maw-release` JSON 注释，包含：

| 字段 | 含义 |
| --- | --- |
| `schema` | `maw.release.v1` |
| `version` | 不带 `v` 的版本号 |
| `date` | CL 标题中的 ISO 发布日期 |
| `channel` | `stable`、`beta`、`rc` 等版本渠道 |
| `base` | 可选的系列基础版本；无引用时为 `null` |
| `source_sha256` | 对应 CL 条目的摘要，用于追溯 |

注释之后是本版本正文，不包含下载或构建结果。未来应用内可读取这些元数据与正文，选择展示增量或基础版本；本次尚未实现更新检查、版本比较或远端索引。

从根目录 CL 提取的相对链接在生成时转换为对应 tag 的 GitHub 链接，图片使用 raw URL；包括普通 Markdown 链接、引用定义与 HTML 的 `src` / `href`。代码示例保持原样。发布前 tag 尚不存在时，远端链接暂不可访问；本地仍需核对源资源是否存在。

## 自动验证与 CI

```powershell
uv run --no-sync python scripts/prepare_release_notes.py --check-all
uv run --no-sync python scripts/run_tests.py tests/test_release_notes.py
```

`--check-all` 只读校验全部已有版本文档，并要求 CL 中所有 2.x 及后续版本条目有对应文档；未发布区不会参与。PR / main CI 同时运行此检查和管线回归。发布 CI 在 Windows 打包前生成预览以尽早拦截问题，发布阶段再次校验并读取文档，按实际产物补下载信息。

测试预演可用 `--changelog <路径>` 和 `--releases-dir <目录>` 指向临时夹具，不改真实 CL 或归档目录。`--failed macos,linux` 仅用于 `--output`，从实际构建结果决定下载列表，不能写入版本归档。
