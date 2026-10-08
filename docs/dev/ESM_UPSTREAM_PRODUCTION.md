# 部分 ESM 迁移的上游交接与冲突处理

本页对应正式生产批次：180 个输入中的 59 个工厂为 ESM，其余保持 classic 作用域；整个编辑器仍由 esbuild 生成一个 classic 产物。早期完整 180 文件隔离实验与它不是同一迁移方案，原实验的冲突数量不能直接用于本批。

## 当前真实 PR 预演

2026-10-08 再次通过 GitHub REST 查询，main 仍为 `d4e5dff2`。#177 已从早期快照的 `d1b03850` 前进到 `1ad2f641`；新快照保存其完整 SHA 和文件清单。预演以 classic `dfd5971f`、迁移 `ce398992`、完成类型修复后的实际 fork `096ca1ad` 为输入；所有操作在独立 objects 仓库和新导出目录中完成，没有合并远端 PR 或改写主工作区。

| 上游 PR | 当前 head | classic 冲突文件 | 直接合并冲突文件 | 处理 |
|---|---|---:|---:|---|
| [#177 字词时间码](https://github.com/Moyf/moys-asr-workflow/pull/177) | `1ad2f641` | 0 | 1 | 保留新增句级手柄、词块选择器与本批 JSDoc；同一文件内 2 个冲突片段 |
| [#178 文稿对齐](https://github.com/Moyf/moys-asr-workflow/pull/178) | `487bb24f` | 0 | 0 | 投影后重建完整产物 |
| [#179 设置整理](https://github.com/Moyf/moys-asr-workflow/pull/179) | `6e23fd75` | 0 | 2 | 保留词块选择器；测试继续在源码层检查 JS，在新版 timebase 设置页检查 HTML |
| [#180 Canvas 预览](https://github.com/Moyf/moys-asr-workflow/pull/180) | `40d8cca5` | 0 | 0 | 新增工厂暂留 classic，仍进入完整产物 |
| [#157 旧 esbuild 试点](https://github.com/Moyf/moys-asr-workflow/pull/157) | `0aaf51bd` | 2 | 8 | 阻塞：它与本批采用不同装配架构，需逐项审查取舍 |

这四个业务 PR 的冲突没有达到“巨量”，但 Git 零冲突仍不能代替产物检查。新增 classic 工厂也必须进入清单与 bundle。类型检查范围采用目录 glob，新工厂即使暂留 classic，也会进入诊断范围。

仅完成源码投影时，#177/#179 出现 43 项类型诊断，#180 出现 5 项，#178 为 0。主要是新词级组合方法未声明共同接收者、双方重复增加 cueListPatch、新 Canvas 参数形状及上游使用的 Array.findLast API 声明。独立的 `adapt-production-types.mjs` 补这些契约；它逐文件比较去掉位置和注释后的 AST，只有 JavaScript AST 不变才写入。词级类型补充保存为新的 d.ts，不提前放进当前产品源码。

最终逐个候选仍为 59 个 ESM 工厂；#177/#178/#179/#180 的完整输入数分别为 184/180/185/182，Node 测试分别为 470/449/466/454 项，全通过且各自类型诊断为 0。#179 的 12 个设置浏览器测试与 22 个波形 Python 契约也通过。#157 保持明确阻塞，未用选择整份文件的方式强行合并。

最新 #177 的 20 个浏览器测试在 ESM 候选中为 16 通过、4 失败；把同一真实 PR 合并到未迁移的 classic 基线后，仍是同样 4 项失败：文字取消后 items 未恢复、两项句块点击被词块遮挡、测试回调引用了浏览器中不存在的 wrapHeading。它们属于当前上游功能/测试待修项，保留失败证据，没有修改该 PR 或跳过用例。不能把 Node/类型通过写成 #177 全部交互通过。

## 可复现命令

先按[历史手册](../temp/ESM_UPSTREAM_MERGE_PLAYBOOK.md)准备独立 objects 仓库与真实 Git 对象，再从主仓库执行：

```powershell
$repo = (Get-Location).Path
$objects = Join-Path $repo '.worktrees/esm-upstream-replay/objects'
$destination = Join-Path $repo '.worktrees/esm-production-replay'
$python = Join-Path $repo '.venv/Scripts/python.exe'
$deps = Join-Path $repo 'node_modules'
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
& $python scripts/esm-mechanical/fetch-github-objects.py --object-repo $objects --snapshot docs/temp/ESM_PRODUCTION_PR_SNAPSHOT.json
& $python scripts/esm-mechanical/rehearse-production.py --destination $destination --object-repo $objects --base dfd5971f --migration-ref ce398992 --fork-ref 096ca1ad --snapshot docs/temp/ESM_PRODUCTION_PR_SNAPSHOT.json --dependencies $deps --resolutions docs/temp/ESM_PRODUCTION_MERGE_RESOLUTIONS.json --adapt-types
```

包含 #157 时命令返回 1，原因写入 results.json；其余 PR 仍分别检查构建、Node 与 typecheck。使用 `--prs 177,178,179,180` 可只研究普通业务 PR。省略 resolutions 或 adapt-types 可以重现冲突与类型红灯。

快照：[当前 PR 输入](../temp/ESM_PRODUCTION_PR_SNAPSHOT.json)。审查后的具体组合：[逐片段解决规则](../temp/ESM_PRODUCTION_MERGE_RESOLUTIONS.json)。最终结果：[部分迁移预演结果](../temp/ESM_PRODUCTION_MERGE_RESULTS.json)。构建、Node、类型诊断和候选 refs 分别记录。

## 合并时执行顺序

1. 固定新的 head SHA，先查询相对 classic 基线的业务变更；叠加 PR 保留实际双亲和祖先关系。
2. 在 classic 影子历史上合并，再用原先审查过的 59 文件列表进行同构转换。新工厂先保留 classic，避免一次业务合并扩大迁移范围。
3. 与实际 fork 做三方源码投影。丢弃三边的生成产物比较，再在解决后的源码上重建；fork 的业务改动和类型修复参与正常三方合并。
4. 冲突解决 JSON 必须同时匹配完整 head SHA、全部冲突文件、每一个 ours/theirs 片段。新增冲突、业务改动或片段变化都会停止。本轮最新 #177 确实触发了旧规则拒绝，随后逐片段重新审查。
5. 补新增功能的真实类型契约，再运行只读产物检查、类型、单元与该 PR 的交互测试。根目录 blank-editor.html 在发布前统一重生成。

工具不会覆盖整个目录或选择整份 ours/theirs；原消费端若被上游改动，投影会停止要求单独适配。特殊提交无法通过 API 原样恢复时应使用正常 Git 传输。所有实验目录保留供复查；脚本不使用 reset、clean 或递归删除。

本批生产开发使用 `npm ci`、`npm run build:editor`、`npm run check:editor`；用户运行 Python、Server 或单文件编辑器不需要 Node。watch 用于修改源码时重建，修改构建器后需重启。回滚以整个迁移 PR 为单位，源码、装配器与消费端一起恢复并重新验证。

## 验证边界

早期完整迁移已验证四个 PR 的组合顺序；本页部分迁移逐个验证四个当前业务 PR，不能把两种方案的组合证据混用。浏览器结果、最终测试数量和未验证项回写到[实施台账](ESM_MIGRATION.md)。发布包和远端 CI 属于独立验证层；桌面实验已退役，不再纳入验证。
