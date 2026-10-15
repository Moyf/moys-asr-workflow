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
| 提交、推送、PR 更新 | 进行中 | 源 fork 已核实、允许维护者修改；已保存本地快照 c6db05ea，将完整功能内容补丁三方应用到当前 main 3e8ff38a；无冲突，待当前基线补验后提交与租约推送 |
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
