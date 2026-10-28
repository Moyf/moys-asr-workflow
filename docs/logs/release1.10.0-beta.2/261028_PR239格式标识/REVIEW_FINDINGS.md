# PR239 工程格式标识改名与提交前复核

## 来源与范围

- 起点：`codex/issue234-integration@4b35d3f69df75b1d9c06179dbafac09132414285`，PR239 的 fork head。`origin` 没有该同名分支；已核对 fork 分支与 PR head 一致，使用 `origin` 的 `refs/pull/239/head` 建立本地工作分支。未修改主仓工作树。
- 约定：[PR311 评论](https://github.com/Moyf/moys-asr-workflow/pull/311#issuecomment-6470711705)：v1 → v1.5（subtitle_groups）→ v2（未来顶层 tracks 真源）。本次仅将独立组格式改名，不变更结构、组关系或导出行为。
- Python 组常量、独立文稿匹配脚本、Web 支持判断/迁移/校验同步为 `moy.asr.project.v1.5`。无 schema 与 v1 兼容保留；v2 及其他未知版本拒绝，不提供旧 v2 别名。
- 六份分组保存 golden 改为 `.v1.5.browser.json`；逐个与旧文件解析比较，除了 schema 外所有字段相等。原 v1 输入、历史 JSON 与 ASS/SRT 快照不变。现行集成/烧录测试改用无版本歧义的文件名，e2e 输入与预期同步。
- 同步 JSON_SCHEMA、双语字幕指南、现行 changelog 和对应官网镜像。镜像通过文档同步脚本生成，只保留本任务对应页面；不混入其他页面已有同步漂移。历史日志保持原时间语境，Resolve 的独立 v2 命名空间不变。

## 双向回归证据

在改生产代码之前先运行新增断言：

- Python writer/IO 2 测试失败（3 个断言）：旧实现接受 v2，并覆盖原文件。run-id `20261028T154930Z-f9f4162f`。
- Node schema 支持 / 共享边界 2 测试失败：旧 Web 不支持 v1.5，且接受保留的 v2。run-id `20261028T154937Z-e3b4f4a3`。
- 新实现完整复验通过，见下表。新增 v2 共享 fixture 同时验证 Python/JS 严格校验、导入结果、输入不变及错误路径一致；writer、文稿匹配和烧录均覆盖未来版本拒绝。

## 自动化验证

所有测试经 `scripts/run_check.py`，完整命令、退出码与耗时在本地 `.artifacts/checks/<run-id>/result.json`，原始输出在同目录 `output.log`。复用主仓 Python venv，只读运行，未同步共享依赖。Node 使用工作树内 TMPDIR。

| 检查 | 结果 | run-id |
| --- | --- | --- |
| Python：test_subtitle_groups / test_project_boundary / test_project_io / test_project_contract，另加 test_project_ass_export_groups | 81 passed | `20261028T155037Z-c0c8c935` |
| `node --test tests/*.mjs` | 1155 passed，0 skipped | `20261028T155039Z-af40d85c` |
| `pnpm run typecheck` | exit 0 | `20261028T155041Z-804502ce` |
| `pnpm run check:editor` | exit 0，bundle fresh | `20261028T155135Z-d5fe9667` |
| `pnpm run build` | exit 0，编辑器 + Launcher | `20261028T155200Z-e8e75e27` |
| Chromium：v1.5 工程导入保存、字幕导入、v2 拖入拒绝 | 3 passed | `20261028T155334Z-4e65510b` |
| Chromium：补全 v2 负例 cue ID 后重验版本拒绝 | 1 passed | `20261028T155453Z-00e53bf4` |
| `python scripts/check_docs.py --base-ref HEAD` | exit 0，0 new broken links / 0 structure errors | `20261028T155449Z-589e51d9` |
| `python scripts/check_personal_paths.py`（已暂存完整改动） | exit 0 | `20261028T155546Z-8dc3a692` |
| `git diff --cached --check` | exit 0 | 提交前暂存区 |

初次基线 Python 在沙箱中只有 localhost 绑定权限错误，之后以允许 localhost 的执行权限完整通过。当前 Node v25.8.2 不在项目声明的 engines 范围，pnpm 有警告；未改 engines，实际测试及类型检查通过。完整 Playwright e2e、Windows 打包及远端 CI 未执行，本地单测通过不代表这些层已验收。未生成便携 HTML，构建产物不入库。

## 独立审阅

由未参与实现的审查者通读完整 diff、新文件及重命名文件，独立比较六份 golden 和 99 个原共享边界 case。无未处置 blocker / major；以下问题已解决或明确接受：

| 项目 | 证据与处置 | 状态 |
| --- | --- | --- |
| 未来版本负例避免机械改名 | `tests/e2e/open-project-drop.spec.mjs` 保留 v2；补合法组表及 cue ID，仅拒绝版本。统一校验流程实际输出 `$.schema` 支持集合错误，旧提示文案断言已同步；当前工程全量不变断言保留。首轮为 2 passed / 1 failed（`20261028T155236Z-44d6195d`），修正后 3 passed，补 ID 后再验 1 passed | 已修复 |
| 改标题产生旧锚点 | docs checker 实报 `MULTI_SUBTITLE.md` 仍链接旧 v2 标题（`20261028T155335Z-f15fefd9`）。同步当前格式描述为 v1.5 与 `#v15-独立颜色--表情包组` 链接，Resolve 独立 v2 输出保留；官网对应页面经脚本同步 | 已修复 |
| 官网 schema 生成同步漂移 | 生成页同时补入源文档本已存在的 `audio_processing` 示例和字段说明；保留源与生成页一致，没有修改该功能代码。其他无关页面的同步漂移未纳入 | 接受 |
| 预发布旧 v2 文件 | 当前约定不提供 v2 旧别名；开发期用旧标识保存的文件被拒绝。本任务没有实现迁移工具，应保留原文件/备份 | 接受 |
| 验证范围 | 只补跑三条相关浏览器用例，没有全量 Playwright、Windows 包或远端 CI 证据；Node engines 警告见上 | 接受 |

生产结构、v1 历史快照、ASS/SRT 行为不变；没有待处理或阻塞的本次实现项。文档检查仅保留原先三条日志索引 warning。提交前第二次核对 fork head 仍为起点 `4b35d3f6`，未发现协作分支推进。
