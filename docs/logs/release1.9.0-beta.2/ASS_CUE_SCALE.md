# 主字幕单句缩放

基线：`feat/ass-cue-scale`，起始 HEAD `2cc67041`。fetch 后 `origin/main` 仍为 `2cc67041`，分支与 main ahead/behind 均为 0；PR #231 已合并。本功能提交为 `2d5333fd`，PR #248 已打开，初始 PR 文件差异为 23 个文件、786 行新增、108 行删除，无旧分支历史需要重放。账本按维护者本轮要求放在 release 基线目录，不增加日期目录。

## 方案

在 `assOverride` 增加可选 `scale`（0.1–5，1 表示默认且归一化为省略）。它独立于 `pos`：只缩放仍参与全局自动排布，重置大小保留位置，重置定位保留大小。缩放字号、字距、描边、阴影和字号动画目标，保持全局锚点与颜色/句内字号关系；预览与 ASS 导出共用计算。

选中当前可见的一条主字幕后显示四角等比缩放 handle；视频画面内滚轮缩放，连续滚动合成一次撤销。拖动 handle 一次事务，原地点选不变更，Esc/失焦取消。未选中、离屏字幕、控制区、视频外与浏览器缩放快捷键不拦截。比例变化后才在 X/Y 左侧显示倍率（如 `1.22`）和重置大小，不增加编辑区高度。X/Y 显示与新写入位置四舍五入到整数。

维护者先要求交付方案文档，再明确继续实施并提交独立 PR。本轮实现已完成，正在提交前收尾；目标 PR 创建后继续观察一轮 CI / 审查反馈。

## 清单

| 项目 | 状态 | 决定 / 证据 |
| --- | --- | --- |
| 基线、方案 | 已修复 | 已核对当前 main、PR #231 合并状态、原定位事务和共享 ASS 排布链路 |
| 开发文档交接 | 已修复 | 已写清用户数值修订、数据/交互/导出方案、6 文件草稿真实状态、风险与验收顺序；待维护者交给 Luna |
| 数据与预览/导出 | 已修复 | JS/Python 两位归一化、类型、自动排布、预览与 ASS 输出通过 Node/Python 测试；九锚点、横竖屏、震动和缩放的 Canvas/libass/导出帧对照通过 |
| handle 与滚轮 | 已修复 | 四角 handle、整数坐标、滚轮合并撤销、独立重置与取消事务完成；完整定位 e2e 13/13 通过，本地浏览器实测滚轮、拖动和两种重置 |
| 紧凑控件 | 已修复 | 倍率在 X/Y 左侧独立显隐；e2e 和本地页面测量确认间距、单行标签、编辑区高度与视频顶部位置稳定，并完成截图自查 |
| 测试与文档 | 已修复 | JSON 契约、用户指南、CHANGELOG、官网 JSON Schema 副本和开发方案已更新；bundle、类型检查、Node/Python 测试通过；未重生成 `blank-editor.html` |
| 提交与 PR | 已修复 | 提交 `2d5333fd`，普通推送至 `feat/ass-cue-scale`，已创建 PR #248；GitHub 文件清单与本地预期的 23 个文件一致 |
| 一轮 PR 反馈 | 已修复 | 三条 Greptile 意见均已处理、回复并解决。Editor CI run `38875181279` 的浏览器 e2e 29/29、全量 Node、Python assembly contracts、类型检查和构建通过；Python lint run `38875181328`、Windows 预览包 run `38875181281` 通过 |

验证记录逐层回写。用户真实素材、其它系统、完整视频编码与发行包不由合成页自动化代替。

## PR #248 首轮审查反馈

| 条目 | 反馈 | 状态 | 处理与实际验证 |
| --- | --- | --- | --- |
| 1 | 预览关闭或选中字幕当前未渲染时，视频区滚轮仍修改保存倍率。 | 已修复 | 滚轮现在要求 ASS 主字幕预览开启且选中 cue 有当前、可见、未跳过的渲染记录；Editor CI run `38875181279` 的隐藏预览 / 离屏浏览器回归通过，29 项全部通过。审查线程已回复并解决。 |
| 2 | 240ms 滚轮事务可与颜色编辑或定位/缩放拖动重叠，Esc 可能恢复过期快照。 | 已修复 | 其他编辑命令捕获快照前会提交未结束的滚轮事务；定位或 handle 指针手势期间拒绝滚轮。命令回归通过，Editor CI run `38875181279` 的浏览器事务场景通过；审查线程已回复并解决。 |
| 3 | ASS 导出将已按单句倍率测量的自动排布偏移再次乘以单句倍率，造成导出位置偏离预览。 | 已修复 | 自动排布偏移只应用组适配倍率，文字与效果使用组适配倍率和单句倍率的乘积。Node 契约 9/9、最终 Canvas/libass/导出帧自动堆叠 e2e 通过；审查线程已回复并解决。 |

## 最终验证

- `node scripts/build-editor.mjs --write` 后执行 `node scripts/build-editor.mjs --check`：通过，`Editor bundle is fresh`。bundle 为本地产物，不纳入提交。
- `node node_modules/typescript/bin/tsc --project tsconfig.typecheck.json`：通过。
- `node --test tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs tests/test_ass_cue_position.mjs tests/test_ass_canvas_layout.mjs tests/test_ass_shake.mjs`（经 `scripts/run_check.py --timeout 180`）：通过，48 项。结果 `.artifacts/checks/20261016T055721Z-acdd65c3/result.json`。
- `scripts/run_tests.py tests/test_ass_cue_position.py`（经 `scripts/run_check.py --timeout 180`）：通过，4 项。结果 `.artifacts/checks/20261016T055721Z-51bf8245/result.json`。
- `node node_modules/playwright/cli.js test tests/e2e/ass-cue-position.spec.mjs --project=chromium`（经 `scripts/run_check.py --timeout 600`）：通过，13/13；含九锚点、横竖屏、震动、ASS 导出帧、缩放 handle、滚轮、独立重置、撤销和取消。结果 `.artifacts/checks/20261016T055151Z-a1e66952/result.json`。
- 本地浏览器人工操作：实际视频区滚轮改变倍率；拖动字幕后显示整数 X/Y，缩放与定位互不覆盖；分别重置大小和定位均保留另一字段；清除后两组控件隐藏，编辑区高 `191.33px`、视频顶部 `116.67px` 未改变。截图仅用于本地自查，未入库。
- `git diff --check`：通过。

### PR #248 首轮反馈修正验证

验证对应 `feat/ass-cue-scale` 的提交前 HEAD `cb8d3b80` 加本轮 11 个暂存修改文件；以下命令与结果路径均对应此工作树内容。

- `node scripts/build-editor.mjs --write` 后 `node scripts/build-editor.mjs --check`：通过，bundle 新鲜。
- `node node_modules/typescript/bin/tsc --project tsconfig.typecheck.json`：通过。
- `python scripts/run_check.py --timeout 180 -- node --test tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs tests/test_editor_commands.mjs tests/test_ass_cue_position.mjs tests/test_ass_canvas_layout.mjs tests/test_ass_shake.mjs`：通过，57 项。
- `python scripts/run_check.py --timeout 180 -- python scripts/run_tests.py tests/test_ass_cue_position.py`：通过，4 项。
- `node --check tests/e2e/ass-cue-position.spec.mjs` 与 `git diff --check`：通过。
- `node node_modules/playwright/cli.js test tests/e2e/ass-cue-position.spec.mjs --project=chromium` 的新反馈用例：未完成。本机 runner 能启动 MAWE 并加载临时工程，但 30 秒内无法通过 `127.0.0.1` 探活；停止了本 worktree 的测试服务进程。该层等待 PR CI 结果，不计为通过。
- `python scripts/run_check.py --timeout 180 -- node --test tests/*.mjs`：未通过，180 秒超时。日志显示本机缺少 Playwright Chromium 可执行文件，服务/网络相关测试失败，进程生命周期用例超时；不能视为全量 Node 通过。结果 `.artifacts/checks/20261016T071959Z-d7aa39f3/result.json`；随后单独重跑本次受影响的 6 个 Node 文件，57/57 通过，结果 `.artifacts/checks/20261016T072354Z-18b3697f/result.json`。
- 本轮重新验证：Python 定位契约 4/4 通过（`.artifacts/checks/20261016T071959Z-6c9622ef/result.json`）；类型检查、bundle 新鲜度、清单源校验与 `git diff --check` 通过。`--diff-ref main` 个人路径扫描通过（`.artifacts/checks/20261016T071959Z-4e8094a2/result.json`）。
- 按源清单重建 `.artifacts/ass-cue-scale/verification.html`；源 Markdown 校验通过。浏览器策略拒绝打开 `file://` 页面，因此交互页浏览器预览仍未完成。
- 提交 `3c166d29` 的 Editor CI 全部通过，但检查 workflow 后确认其中的 e2e 命令只运行 `editor-bundle` 与 `editor-transactions` 两个 spec。已在 `6e77456c` 将 `ass-cue-position.spec.mjs` 加入该命令；Playwright `--list` 确认共 16 项，等待此更新后的 CI 结果。
- 提交 `6e77456c` 的全量 Node 737/737、Python assembly contracts 29/29 通过；新增 e2e 第一次运行失败于 `spawnSync ffmpeg ENOENT`，定位 spec 的 16 项在 beforeAll 生成视频时未执行，其余 e2e 的 13 项通过。本轮工作树在 `.github/workflows/editor-checks.yml` 增加 Ubuntu FFmpeg 安装；workflow YAML 解析、清单源校验、个人路径扫描、`git diff --check` 通过，待提交触发 CI 重跑。
- 提交 `6a08c2ae` 的全量 Node 737/737、Python assembly contracts 29/29 与 FFmpeg 安装通过；浏览器步骤运行 29 项，其中 23 项通过，定位 spec 的 6 个像素对照在 Python venv 缺 `PIL` 时失败，未报告为产品回归。Pillow 已加进默认 dev group，`uv.lock` 保留现有包版本并同步 dev 元数据；`uv lock --check --python python --cache-dir .artifacts/uv-cache` 通过。后续提交 `2d254988` 的 CI 浏览器项为 28/29，唯一失败为组适配倍率未触发，详见下一条。
- `tests/test_packaging_contract.py` 29/29 通过（`.artifacts/checks/20261016T080736Z-2c5ce0e8/result.json`），确认 Pillow 仍是开发依赖而非运行时依赖；`uv lock --check --python python --cache-dir .artifacts/uv-cache` 通过。
- 提交 `a04bcad4` 的 Editor workflow run `38873569216` 全量 Node 单测、Python assembly contracts、类型检查与 FFmpeg 步骤通过，浏览器测试仍为 28/29；唯一失败的 `scaled automatic stack...` 仍读到 `groupScale: 1`。之前 10 行夹具在 640×360 / 字号 90 的实际浏览器预览中没有触发自动适配。本轮将 e2e 字号改为 150，并把 `tests/test_ass_cue_position.mjs` 的契约场景匹配为 640×360 / 字号 150，单测 9/9 通过（`.artifacts/checks/20261016T083441Z-db30a2d0/result.json`）；`node --check` 通过（`.artifacts/checks/20261016T083441Z-6a0c3a26/result.json`）。下一轮 CI 尚待推送。
- 提交 `c03bf021` 的最终 Editor workflow run `38875181279` 成功：全量 Node 单测、TypeScript、Python assembly contracts、FFmpeg 准备及浏览器 e2e 均通过，浏览器共 29/29。Python lint run `38875181328` 与 Windows 预览包 run `38875181281` 通过；三个 Greptile review thread 均已回复并解决。
- 代码验证对应 PR head `c03bf021`（当时工作树干净）。该提交时 GitHub PR 显示 28 个文件、1,043 行新增、114 行删除；分支沿用原有提交历史，没有重放或覆盖上游历史。本轮最终本地夹具 Node 契约 9/9、e2e 语法、核对清单校验 / HTML 重建、workflow YAML、个人路径扫描及 `git diff --check` 均通过；浏览器策略仍拒绝打开 `file://` 核对页，且本机 e2e 服务无法通过 loopback 探活，浏览器 e2e 以 CI 29/29 为验证证据。

环境记录：`uv run --no-sync` 的解释器缓存和 `pnpm exec` 的包管理器自更新都被本机沙箱权限挡住；改用已安装解释器和本地 Playwright CLI。第一轮 e2e 的帧对比环境缺少 Pillow，改用已有 Pillow 的解释器后完整 13/13 通过。此次新增浏览器用例仍因本机回环探活失败而未完成；完整 Node 单测还因 Playwright 浏览器缺失及服务型用例超时而在 180 秒上限退出，具体如上，均不计为通过。核对清单 HTML 已生成且源文档通过校验，但浏览器策略拒绝 `file://` 页面，所以交互页预览未完成；最终仍需以 PR CI 结果为准。

未验证边界：维护者真实工程和目标播放器表现、完整视频烧录仍需人工验收。便携内联副本 `blank-editor.html` 按仓库约定留待发布前统一重生成。

## 2026-10-17 合并前复审

同步当前主线后，三条 Greptile 意见均与具体防护、命令边界和自动堆叠偏移测试对应，原线程已解决。另复现倍率 1.125 在 Python 为 1.12、JavaScript 为 1.13 的规范化差异，现按同一二进制值采用相同舍入，1.005／2.675 等既有行为保持。

67 项 Python、34 项 Node 与全部 18 项真实 Chromium 用例通过，包括 Canvas／Server libass／ASS 导出实际帧比较及震动缩放探针。构建新鲜度、类型、Ruff、个人路径和 diff 检查通过。原人工清单转为 v2，自动化证据改只读，六项人工确认及稳定 ID 保留。

已进一步组合 main 24c6b202；保留 PR253 与本功能两侧的 CI spec，四个 spec 共 56 项 Chromium 全通过。未重新生成仓库便携 HTML；内联副本待发布前统一重生成。
