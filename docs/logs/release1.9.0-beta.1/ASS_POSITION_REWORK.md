# PR #231 定位与震动返工账本

## 基线与授权范围

- 起始 HEAD：`8c97b4b3`，detached HEAD，工作树和暂存区干净。震动已独立提交，当前历史已包含它。
- 实际 JS/Python/类型仍包含逐句 `an`，没有所述返工的未提交 diff；本轮重新落实，不沿用先前验证结论。
- 功能尚未发布，不实现旧 `an` 工程迁移。只保存 X/Y，使用全局样式锚点。
- 不生成 `blank-editor.html`；截图、测试原始输出、人工核对 HTML 只进入 `.artifacts/`。

## 反馈清单

| 项目 | 状态 | 处理决定与证据 |
| --- | --- | --- |
| 状态核对、账本 | 已修复 | 已查 Git 历史、状态、源码；震动提交 `8c97b4b3` |
| 逐句定位模型 | 已修复 | JS/Python/类型只保存 pos.x/y；全局九种锚点的横竖屏真实帧比较通过 |
| 编辑区布局 | 已修复 | X/Y 位于文本框右侧、仅定位后显示；实测行 gap 8px、文本间距 12px；选中/定位/重置/取消选中时编辑区 193px、视频 188.78125px 高度与 top 均不变（1280×800 Chromium） |
| 点击选中再拖动 | 已修复 | 首次只选中、位移才开启事务；一次拖动一次撤销，原地点选/回原点不留历史，Esc/失焦取消，拖动中保存/撤销保护通过 |
| 震动基准坐标 | 已修复 | 使用基准 anchor；自动堆叠上方字幕转为手动时转换为全局附着点，避免 top/centre 样式拖动起跳；新增浏览器回归通过 |
| 整句符号组合 | 已修复 | 样例与两种 fade/shake 嵌套顺序、预览/导出/右键/批量回归通过；重复 fade 维持原 parse-once 语义；工程 segment 不拆分 |
| 契约、指南、CHANGELOG | 已修复 | JSON_SCHEMA、ASS 指南、编辑器指南、英文界面与整体 CHANGELOG 已更新 |
| 自动化验证 | 已修复 | Node 356+25、Python 131+19 通过；类型、新鲜度、文档检查通过，详见验证记录 |
| 浏览器交互与截图 | 已修复 | 9 个不同定位 spec 均有通过记录；人工合成页已操作首选/拖动/重置/右键强调并查看截图；独立于维护者素材验收 |
| HTML 人工核对页 | 已修复 | 统一工具生成并校验 `.artifacts/rework/verification.html`；浏览器 URL 策略拒绝打开 file 协议，未绕过限制；维护者可自行打开，真实素材检查保持未勾选 |
| 提交、推送、PR 更新 | 已修复 | 功能提交 568300e3，基于 main 3e8ff38a 重放；精确旧 HEAD 租约推送成功，远端 SHA 一致；PR #231 标题、实现与验证描述已更新，远端确认 40 文件、1394 增/64 删 |
| 旧工程兼容 | 仅说明 | 按维护者明确要求不实现未发布功能的旧 an 迁移 |

## 验证记录

- `node --test tests/test_ass_cue_position.mjs tests/test_ass_shake.mjs tests/test_editor_utils.mjs`：首次 341/348，未配置共享 Python；配置后 347/348，唯一失败为重复 fade parse-once。日志 `.artifacts/checks/20261014T160214Z-38ba72fe/result.json`。修正后待重验。
- `pnpm run typecheck`：通过，`.artifacts/checks/20261014T160224Z-f3a2b28f/result.json`。
- Python 28 项：沙箱 Temp 权限导致 68 个错误，属于环境失败；移到提升权限运行重验，不记为通过。`.artifacts/checks/20261014T160232Z-49b25171/result.json`。
- Node 依赖安装：沙箱 pnpm EPERM；提升权限后锁文件安装与 postinstall 构建通过。
- PR #231 为 open，源为贡献者 fork。已核实上游重写历史，远端 `dd31a30f` 与本地对应内容仅两个历史日志链接差异；禁止直接 merge 历史。完成后将功能补丁重新应用到远端 HEAD，普通非强制推送；历史日志链接差异不带入本轮。

### 最终通过记录（2026-10-15）

以下测试均通过 `python scripts/run_check.py --timeout N --` 包装；每个目录的 `result.json` 含命令、退出码、耗时与 PID。Python 只读复用既有 venv，Node 跨语言与 e2e 显式指定对应解释器；像素 oracle 使用自带 Pillow 的独立解释器，不改共享 venv。

| 层 | 命令 / 范围 | 真实结果 | result.json 所在目录 |
| --- | --- | --- | --- |
| Node | `node --test` 定位、震动、editor_utils、commands、脚本语法/顺序 | 356 通过 | `.artifacts/checks/20261015T013346Z-d6f70634/` |
| Node Canvas | `node --test tests/test_ass_canvas_layout.mjs tests/test_ass_canvas_raster.mjs` | 25 通过 | `.artifacts/checks/20261015T013401Z-42e112e2/` |
| Python | 工程定位、后处理重分段、工程契约/保存、编辑器资产、ASS 样式 | 131 通过 | `.artifacts/checks/20261014T160540Z-3da18195/` |
| 文档回归 | `scripts/run_tests.py tests/test_docs_check.py` | 19 通过 | `.artifacts/checks/20261014T161401Z-dac9ac31/` |
| 浏览器 | 首轮 2/8；修正残留数据、测试选择器与 Pillow 环境后 7/8，剩余旧测试未重新选中便开始拖动 | 失败原因保留；不当作最终通过 | `.artifacts/checks/20261014T160523Z-972dacfa/`、`.artifacts/checks/20261014T160821Z-6e55a7b1/` |
| 浏览器补验 | `ass-cue-position.spec.mjs --grep 'box drag'`，撤销后先重新选中 | 1 通过 | `.artifacts/checks/20261014T161108Z-e93ea571/` |
| 浏览器控件/布局 | 同 spec 的 inspector、离屏缓存、未选中、震动拖动 | 4 通过；截图与尺寸在 `.artifacts/rework/e2e-evidence/` | `.artifacts/checks/20261015T013203Z-14a26c4d/` |
| 浏览器锚点 | 同 spec 全局九种锚点横竖屏、震动拖动、自动堆叠上方字幕 | 4 通过；真实 Canvas/Server libass/ASS 帧比较 | `.artifacts/checks/20261015T013324Z-368996a3/` |
| 构建 | `node scripts/build-editor.mjs --write` | 重建通过 | `.artifacts/checks/20261015T013319Z-21a09779/` |
| 新鲜度 / 类型 | `node scripts/build-editor.mjs --check` / `pnpm run typecheck` | 最后 Canvas 基准坐标补丁后通过 | `.artifacts/checks/20261015T013518Z-b60331d1/`、`.artifacts/checks/20261015T013516Z-8f1fa3b2/` |
| 文档结构 | `python scripts/check_docs.py` | 1023 文件、0 新断链、0 结构错误 | `.artifacts/checks/20261015T013607Z-03797a01/` |

人工合成页使用专用 Paseo 终端，只监听 `127.0.0.1`。通过真实 UI 开启 ASS、先点击选中、再次拖动、重置，再在右键「高级操作 → 左右添加字符」添加强调；原文变成 `++!!**喂喂喂嗯**!!++`，预览放大、强调与震动同时生效。截图已自查。实际 UI 间距为 8px / 约 12px；不同浏览器窗口尺寸与字体导致绝对区域高度不同，稳定性由同一窗口前后测量验证。

临时 Paseo 终端已终止（`.artifacts/checks/20261015T013612Z-23054875/`），没有保留本轮长驻服务。核对页生成命令：`python tools/verification-checklist/build.py --data .artifacts/rework/checklist.json --output .artifacts/rework/verification.html`；浏览器直接打开本地文件被 URL 策略阻止，该打开层保持未验证，不影响已通过的编辑器浏览器交互层。

### 未验证边界

未替代维护者真实素材与偏好验收；未运行全量 e2e、全套 Python、跨平台发行包与完整视频编码。未生成或修改 `blank-editor.html`，内联副本待发布前统一重生成。


## 历史重写后的实际整合

再次 fetch 确认 main 已前进到 `3e8ff38a`；旧 PR HEAD `dd31a30f` 仍属于旧历史，先前计划直接在旧 PR HEAD 上提交已撤销。保存本地完整快照 `c6db05ea`，从 `origin/main` 建立 `feat/ass-position-shake`，只将原功能基线 `a34d502a` 到完成快照的内容补丁通过 `git apply --3way --index` 重放。未 merge 或推送旧历史。补丁 133195 字节、34 文件、1339 增/63 删，无冲突；CHANGELOG/日志入口单独按新 main 合并，保留视频画面导航、AI 核对与发布版本等上游变更。

新 main 的日志规则已改为 release 基线目录，因此账本迁入 `docs/logs/release1.9.0-beta.1/`，不增加新日期目录。最终验证以重放后的当前工作树为准；前文结果保留为快照验证证据。更新旧 PR 分支使用精确旧 HEAD 的 `--force-with-lease`，租约不匹配则停止，避免覆盖并发提交。

### 当前 main 上的最终补验

- Node 定位、震动、编辑器工具/命令、脚本语法/顺序、Canvas 布局/光栅：381 项通过，`.artifacts/checks/20261015T013929Z-bcb9d458/result.json`。
- Python 定位、重分段、工程契约/保存、编辑器资产、ASS、文档回归：154 项通过，`.artifacts/checks/20261015T013938Z-54f45f08/result.json`。
- `ass-cue-position.spec.mjs` 整轮 9/9 通过，`.artifacts/checks/20261015T014004Z-28437b36/result.json`。最终截图、8px/12px 间距与四种状态稳定尺寸证据位于 `.artifacts/rework/final-e2e/`。
- 当前 main 的 63 工厂 / 191 源构建通过，`.artifacts/checks/20261015T013847Z-121d6a56/result.json`；类型与新鲜度通过，`.artifacts/checks/20261015T014032Z-fbdf0712/result.json`、`.artifacts/checks/20261015T014035Z-e8bf1b50/result.json`。
- 官网 ASS、编辑器指南及 JSON 契约副本已同步；`website sync:docs / check / build` 全通过，Astro 0 错误/警告，22 页构建完成。对应 `.artifacts/checks/20261015T014017Z-0c088bf1/`、`20261015T014111Z-a5e6bc80/`、`20261015T014125Z-e0a6552c/` 的 `result.json`。
- 文档检查通过：1063 文件、0 新断链/结构错误；仅提示 main 已有的 `release1.8.0-beta.1/Agent-e2e验证踩坑.md` 缺少导航，不扩大本轮范围。`.artifacts/checks/20261015T014140Z-35bdea95/result.json`。
- `blank-editor.html` 与版本号保持当前 main 原状。仅功能补丁、用户文档/契约及对应官网副本进入提交；截图、媒体、测试日志与核对页都不入库。

## 交付与远端核对

整合功能提交为 `568300e3a632f2a2fdd9fbd47df3ab8a1beb1bbd`，父提交为当时当前 main `3e8ff38a`。精确租约以 PR 原 HEAD `dd31a30f` 为条件，推送后 `git ls-remote` 确认同一 SHA；GitHub API 确认 PR #231 仍为 open、40 文件/1394 增/64 删，标题更新为「ASS：主字幕点击后定位与整句震动」。查询时 main 已继续前进到 `1d961b90`，PR 的差异范围仍正确。

本次仅额外提交这段真实交付证据，不改功能。表中没有待处理、进行中或代码阻塞项；真实素材、跨平台、完整视频编码及核对页自动打开的边界沿上文说明。PR 保持打开，不执行合并或发布。

## PR 评论补修（2026-10-15）

本轮从 PR HEAD `ef77f758` 继续，工作分支 `codex/pr231-completion`。fork 与上游 main 均为 `1d961b90`。暂停时保留的本地 main 合并只有 CHANGELOG 冲突；现保留双方未发布条目，其他自动合并内容已核查。此处仅整合 main 到开发分支，不合并 GitHub PR，不改写历史。

| 评论 / 收尾项 | 状态 | 决定与当前证据 |
| --- | --- | --- |
| main 冲突 | 已修复 | 保留 ASS 与上游文本编辑、字词码、波形条目；合并后相关 Node/Python、定位浏览器及布局验证通过 |
| 拖动期间修改型快捷键污染撤销 | 已修复 | window capture 隔离活动手势，Esc 与历史入口取消；新增真实浏览器回归 1/1 通过，完整比较工程、选区、dirty、模态和撤销/重做，`.artifacts/checks/20261015T040632Z-6611f432/result.json` |
| SRT 的 both 规则与嵌套 fade/shake | 已修复 | fade→shake；双语在逐句清理后直接序列化，避免跨句误配标记；15 种嵌套/规则及说话人回归，与 editor_utils 共 343 项通过，`.artifacts/checks/20261015T040836Z-6084e6c6/result.json` |
| ASS 震动跨布局边界相位 | 已修复 | 事件在原句 60ms 相位边界或布局边界截断，保留 ASS 厘秒量化基准；3 项新增回归先失败，修复后震动/SRT 共 15/15 通过（逐毫秒唯一覆盖、非厘秒输入、move piece），`.artifacts/checks/20261015T041019Z-61329f8b/result.json`；真实帧补验待完成 |
| 早期 aria-label 与离屏缓存 nit | 仅说明 | 动态节点由当前 i18n MutationObserver 翻译；无定位句现不显示坐标面板，旧缓存性能问题在当前交互中未触发，不扩大本轮范围 |
| 验证、清单、提交与原 PR 推送 | 已修复 | 范围验证通过，统一 HTML 已生成；普通提交与推送至原分支成功，远端 SHA 一致；PR open、mergeable=true、未合并。远端 CI 单独查询，不计作本地通过 |

真实素材、跨平台发行包、全量 e2e 与完整视频编码保持未验证；自动化、浏览器、远端 CI 分层记录。截图、核对 HTML 与原始输出只留 `.artifacts/pr231-completion/` 和 `.artifacts/checks/`。

本轮失败记录：依赖安装首次因 pnpm 沙箱缓存写入被拒绝（`20261015T040421Z-3788566e`），提升权限按锁文件安装通过（`20261015T040537Z-419521a9`），未改锁文件或共享 Python 环境。浏览器首条筛选 `keyboard` 未匹配测试（`20261015T040617Z-7ab0233a`），改用实际标题 `isolates` 后通过。SRT 新增回归先复现两项失败（`20261015T040750Z-2e218a70`）；修复后首次剩一个测试夹具错误（断言误将时间箭头 `-->` 视作 fade 标记，且说话人未配置颜色映射，`20261015T040809Z-2ee08c81`），纠正为合法映射与精确内容断言后 343 项通过。

### 本轮最终验证

命令均由 `python scripts/run_check.py --timeout N --` 包装，证据目录均为 `.artifacts/checks/<记录>/result.json`。验证对应 PR 起点 `ef77f758` 加本轮未提交合并与补修，后续只更新记录不改变已验证源码。

| 层 / 命令范围 | 实际结果 | 记录 |
| --- | --- | --- |
| Node：定位、震动、Canvas 布局/光栅、editor_utils、commands、history gestures、脚本语法/顺序、waveform display presets | 407/407 通过 | `20261015T041610Z-fc81fc9b` |
| Python：定位、重分段、工程契约/IO、编辑器资产、ASS 样式、文档回归 | 155/155 通过 | `20261015T040951Z-cf0d053f` |
| 定位完整 spec（11 项） | 10 项通过；新增相位夹具被旧面板草稿覆盖而失败，失败保留 | `20261015T041202Z-ed2d318a` |
| 相位夹具修正后定向补验 | 1/1 通过；11 个不同测试都有通过记录，未重跑已通过的 10 项 | `20261015T041543Z-e0b4f12a` |
| 新增相位单测 | 修复前 3 项失败，修复后 15/15（含 SRT）通过 | `20261015T040948Z-19ead0bc` / `20261015T041019Z-61329f8b` |
| editor 构建 / 新鲜度 / 类型 | 全通过；类型直接调用锁定的 TypeScript CLI，避开 pnpm 沙箱缓存限制 | `20261015T041057Z-f02a2b79` / `20261015T041153Z-a5bcb955` / `20261015T041150Z-36717fb6` |
| 官网文档同步 / 文档结构 | 同步通过，0 新断链、0 结构错误；保留 main 已有历史日志导航提示 | `20261015T041156Z-837b6236` / `20261015T041317Z-f09ad28d` |
| 额外全量 Node | 180s 到限，未完成；沙箱内预设库浏览器项失败，不能记作全量通过。按该次 PID 检查无后代残留 | `20261015T041118Z-29e7821f` |
| 预设库失败项独立环境复验 | 允许 Chromium 启动后 1/1 通过，无源码修改 | `20261015T041655Z-84d34755` |

定位 spec 的横屏合成媒体改为 50fps，让 220ms / 340ms 对应真实帧 PTS；竖屏仍为 25fps。相位新夹具在变更文字和时间前先释放当前文本面板草稿，避免重新选择时将旧草稿提交覆盖测试设置。横竖屏九锚点共 18 组、另加重叠震动 220ms / 340ms 两组实际帧比较：Server libass 与导出包围盒差异 0px，Canvas 与导出最大差异 1px。移动方案仍按事件起点采样基准坐标，本轮只保证震动相位连续，不扩大为连续移动逐帧完全一致的承诺。

合并后实测定位区行间距 8px、文本间距 12px；同窗口选中/定位/重置/取消选中时，编辑区高度 193px、视频高度 188.78125px，top 均不变。已查看定位控件截图。相关截图、布局 JSON 与真实帧证据在 `.artifacts/pr231-completion/final-e2e/` 和 `phase-recheck/`。未生成 `blank-editor.html`，内联副本待发布前统一重生成；全量 Node 尝试未完成，未运行 Python 全套、全量 e2e、跨平台发行包或完整视频编码。

### 本轮提交与远端交付

- `123c8eff`：保存 main 整合及 CHANGELOG 冲突解决，父提交为 `ef77f758` 与 `1d961b90`；保留上游波形、字词码和颜色修复。
- `60fe80595b8db0bbd658378e117c5cc4571e2845`：评论三项补修、回归测试和指南/官网同步。普通 push 到原 `codex/issue-226-ass-cue-position`；`git ls-remote` 与 GitHub API 均确认同一 SHA。API 确认 PR #231 仍为 open、未合并、mergeable=true。
- 本段只追加交付记录；本轮清单表不再有待处理、进行中或代码阻塞项。真实素材及跨平台等未验证边界保持独立，远端 CI 以最终提交实时状态报告，不用先前提交状态代替。
- 核对页由统一工具生成于 `.artifacts/pr231-completion/verification.html`，6 条人工项均保持未勾选；Codex 浏览器打开请求返回 queued，未将其记作已显示。没有启动额外长驻服务。
