# ESM 迁移后的上游 PR 合并预演

日期：2026-10-08。classic fork 基线：`dfd5971f`（产品源码等同 `d4e5dff2`）。实时 PR 快照：`ESM_UPSTREAM_PR_SNAPSHOT.json`，记录原始 HEAD、目标分支及文件清单。

**当前这些 PR 并不会全部产生巨量文本冲突，但直接合并确实不可靠：Git 可以零冲突、页面也可以正常启动，而新增功能根本没有进入 bundle。** 已做真实提交的隔离预演，并保存可复现的合并、保护、反例和验证脚本。

本次模拟上一轮的完整编辑器 ESM 兼容阶段：180 个编辑器文件、同一 esbuild 产物供 Python / Server / Rust 消费；保留路径、注册表、依赖袋及必要门面，旧 editor-scripts.txt 仅供对照。Launcher 未转换为 ESM。若继续改目录、移除兼容层、删除旧清单或全面格式化，冲突数会变化，需要重跑，不能外推此表。

主工作区产品源码、生成 HTML、现有测试和上游 PR 均未改动；所有实验在 `.worktrees/esm-upstream-rehearsal-20261008` 的独立 Git 仓库和副本中完成。维护者已允许类型诊断与旧资产字符串契约在整体迁移后统一处理，本轮未把它们改绿。

## 进度账本

| 项目 | 状态 | 结果 / 后续 |
| --- | --- | --- |
| 上游 PR / 原始 SHA 快照 | 仅说明 | REST 查询 #177–#180 与 #157；原始 Git 对象完整校验 |
| 直接三方合并冲突规模 | 已修复 | 逐 PR 文件与冲突块数已记录 |
| 同构转换与源码差量投影脚本 | 已修复 | 四个功能 PR 独立重放及组合均通过装配 / Node 验证 |
| fork 自有变更与负例 | 已修复 | 非重叠改动保留；重叠逻辑拒绝自动处理；零冲突但缺功能反例复现 |
| 连续合并 / 增量冲突解决 | 已修复 | 保留双亲历史；两处 changelog 插入和一处测试插入严格合并 |
| 新功能浏览器与工程契约验证 | 已修复 | 组合 34 E2E、49 工程契约通过；file / HTTP 功能探针通过 |
| 旧架构试点 #157 | 仅说明 | 原本就有冲突；不能作为普通业务 PR 自动重放，应审查可复用部分 |
| 类型、旧字符串契约、完整桌面打包 | 仅说明 | 按维护者决定延期；本轮不称为通过或已发布 |
| fork 新增模块 / 大规模目录改写后的兼容性 | 仅说明 | 未穷尽验证；需相应更新基线、转换规则和测试后重新预演 |

## 当前真实 PR 结果

| PR | classic 冲突文件 | 直接合入 ESM 的冲突文件 / 块 | 新模块未进入 ESM 清单 | 重放后源码数 | 装配 / Node |
| --- | ---: | ---: | ---: | ---: | --- |
| [#177 字词时间码](https://github.com/Moyf/moys-asr-workflow/pull/177) | 0 | 0 / 0 | 4 | 184 | 10 / 462 全通过 |
| [#178 文稿驱动对齐](https://github.com/Moyf/moys-asr-workflow/pull/178) | 0 | 0 / 0 | 0，但 bundle 过期 | 180 | 10 / 445 全通过 |
| [#179 设置重组](https://github.com/Moyf/moys-asr-workflow/pull/179) | 0 | 5 / 6 | 5（含继承 #177 的 4 个） | 185 | 10 / 462 全通过 |
| [#180 ASS Canvas](https://github.com/Moyf/moys-asr-workflow/pull/180) | 0 | 1 / 1 | 2 | 182 | 10 / 450 全通过 |
| [#157 旧 ESM 试点](https://github.com/Moyf/moys-asr-workflow/pull/157) | 2 | 8 / 11 | 混合轨旧 bundle 条目 | 未重放 | 脚本明确阻塞，非零退出 |

每行是独立场景，测试数不能相加称为一次全量回归。#179 的目标分支是 feat/word-timing，其 HEAD 继承字词功能；预演使用完整历史和实际 merge-base，不把它仅当作孤立的设置 diff。

#179 的 5 个 ESM 冲突文件：editor-sticker-root.js（2 块）、editor-wiring-sticker-root.js、editor-history.js、editor-wiring-ass-manager.js、editor-wiring-settings-help.js。#180 是 editor-wiring-ass-preview.js（1 块）。这些冲突在统一表示层的投影中均消失；没有选择 ours / theirs 丢掉另一方改动。

## 零冲突也会漏功能：已实际复现

直接合并 #177 后，file 与 localhost 页都能启动，没有 pageerror，但 `AsrEditorUtils.getWordTimingEntries` 不存在，4 个新增模块未进入 editor-sources.txt，产物新鲜度失败。直接合并 #178 也能启动，但产物新鲜度失败。故“Git merge 成功 + 能打开页面”不能当门禁。

新增模块包括 #177 的 utils/word-timing、waveform/word-blocks、editor-word-timing、editor-wiring-word-timing；#179 再加 editor-project-settings；#180 增加 ass-canvas-layout 与 editor-wiring-ass-canvas。需要重新生成整个依赖与初始化图，不只是修冲突标记或重新打包旧输入清单。

`probe-projection.py` / `verify-upstream.mjs` 保存了以上反例。负例正常非零退出，不修复旧 bundle 之后再检测，也不跳过断言。

## 推荐的处理算法

设 A 为迁移前 classic 集成基线，P 为上游原始 HEAD，M 为固定版本转换器，O=M(A) 为 ESM 对照，F 为实际 fork ESM 分支：

1. 在隔离仓库做 U=merge(A,P)。先记录已有 classic 冲突，不把它们归因于 ESM；保留实际 P 作为 merge 的第二个父提交。
2. 对 U 运行相同转换器，得到 V=M(U)。新增文件、清单、活绑定、外部桥、消费者和测试加载器一并迁移。
3. 用 O 作显式共同基线，将 V 的差量三方合并到 F。完整 V 只是投影输入，不能整体覆盖 F。
4. 三个版本均排除生成 bundle / metafile 的文本合并；源和元信息合并后显式重建产物，纯读核对新鲜度，再跑结构和功能测试。
5. 保存 A、P、U、O、F、最终候选与转换器哈希。当前脚本把候选和 classic 集成结果固定在隔离 refs/esm-rehearsal 下，不改主仓库引用。

对没有迁移后私有改动的预演，F=O；有实际 fork 分支时传 --fork-ref。真实场景中，脚本保留了 fork 在启动模块增加的可运行标记，同时带入 #180 的新 Canvas；file 与 HTTP 均证实二者存在。另一个场景把 fork 的旧 ASS 字号计算增加 1.1 倍，而 #180 删除该 DOM 计算路径：脚本保留真实冲突，不能自动选边。这类调整必须迁入新的 Canvas 算法并验证效果。

classic 影子历史用于暂存和变更投影，不参与产品运行 / 发布。每次成功集成后推进它，并保留相应 ESM 对照；不能永远拿最初的快照覆盖当前 fork。若 fork 新增模块、重命名或退役 initialize / 注册桥，需要更新对照、转换策略与行为基线；当前脚本会报构建、结构或测试问题，不承诺这些架构变更自动判绿。

## 组合预演与严格解决规则

实际顺序：#177 → #179 → #178 → #180。保留双亲提交后，#177 / #179 无冲突；#178 在 CHANGELOG.md 与 tests/test_project_contract.py 产生插入冲突；#180 再产生一处 CHANGELOG.md 插入冲突。

脚本仅对显式选中的 Markdown / Python 文件启用“只新增”合并：相对共同基线，两边必须只有插入，不能替换或删除。Python 另核对原函数 AST 完全不变、新增函数的并集一致、无重复名称。保留项目 ASS / 说话人导出契约和文稿标点契约全部测试，不删任何一边。JavaScript、CSS、schema 的实质修改不使用这条规则。

原型最初的单亲临时提交曾让连续预演错误地丢失 PR 祖先、产生假冲突，现已修正并加入反例。旧 sequence-1 结果作废，最终采用 sequence-3；不能只保留树内容而丢掉合并历史。

组合最终结果：187 个源码文件、62 个工厂导出；10 项装配契约、467 项 Node、49 项工程契约、34 项相关 E2E 全通过，均无 skip。浏览器中的字词 API、项目设置门面和 Canvas 接线在 file / localhost 同时通过，产物新鲜。

独立新功能 E2E：#177 16 项、#179 设置 12 项、#178 两个 spec 5 项。组合的 word-timing spec 包含 #179 增加的用例，因此组合是 34 项，并非简单相加的 33 项。没有声称整个 E2E 或 Python 全量都通过。

## #157 与后续真实冲突怎么处理

#157 本来就与 classic 当前基线冲突，涉及旧清单与资产测试；完整 ESM 树另与 host 模块及加载器 / host 测试冲突。它改变的是装配架构，不能像业务 PR 一样自动转换。应逐项审查其中可复用的构建、新鲜度和宿主测试约定；完整打包终态已覆盖四模块试点目标，不应叠加旧 esm-bundle.js 第二条运行轨。本轮没有关闭或修改该 PR。

遇到实际业务冲突时保留冲突源与两侧意图，修改源逻辑再重建；不得手合成生成产物、用旧 bundle 掩盖遗漏、删除上游测试或通过自动选边消除红灯。公开门面 / 新增模块被省略的风险必须用相应运行断言保护。

这轮只验证上一轮转换规则。未来若改变 M，需要先对固定 PR 快照重跑，再用于新 PR。前轮类型门 235 条诊断只代表原 180 文件实验；本轮没有复跑已延期门禁，不假设 187 文件仍是同一诊断数。Rust 测试仅证明实际渲染路径，未验证完整桌面 App / 安装包；Canvas 探针证明接线和布局 API，不证明描边画质；文稿对齐 E2E 使用测试替身，不代表真实模型准确率。

## 工具与证据

使用说明：[ESM_UPSTREAM_MERGE_PLAYBOOK.md](ESM_UPSTREAM_MERGE_PLAYBOOK.md)。汇总证据：ESM_UPSTREAM_MERGE_RESULTS.json。原始 PR 快照：ESM_UPSTREAM_PR_SNAPSHOT.json。

- snapshot-upstream.py：只读 REST 快照，发现采集时 HEAD 变化即停止。
- fetch-github-objects.py：Git 传输失败时的 API 备用读取，所有 blob / tree / commit 校验原始 SHA，有限重试和缓存；不接受伪造替代提交。
- rehearse-upstream.py：实际 Git 三方合并、源码投影、fork 保护、序列合并、严格新增内容解决与装配 / Node 验证。
- probe-projection.py：当前真实 PR 上的 fork 非重叠 / 重叠，以及零冲突漏功能反例。
- verify-upstream.mjs：file / HTTP 的实际功能接线与纯读新鲜度。
- test-upstream.py：冲突、双亲历史、测试不丢失、仓库 / 路径保护的 14 项夹具。

本机证据目录：run-1（独立预演及 feature-e2e.log）、sequence-3（最终组合）、proof-1（正负例）、fixtures-final.log。组合日志包括 assembly.log、node.log、combined-python.log、combined-feature-e2e.log 和 upstream-feature-verdict.json。大日志、媒体夹具、生成页面和 Git 仓库均留在忽略目录，不纳入任务成果。

网络 Git 两次连接重置后，API 已取得并验证 19 个缺失提交及其树 / blob，固定原始 PR HEAD。浏览器 Pull 列表缓存落后，本轮以 REST SHA 和实际 Git 内容为准。主工作区未合并任何 PR、未切换为 ESM、未推送或操作远端 PR。
