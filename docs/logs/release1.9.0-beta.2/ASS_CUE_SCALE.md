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
| 一轮 PR 反馈 | 进行中 | 最近快照：Python lint 已通过；Editor build and contracts、Preview Windows Release 仍在运行；尚无 review、inline thread 或普通 comment |

验证记录逐层回写。用户真实素材、其它系统、完整视频编码与发行包不由合成页自动化代替。

## 最终验证

- `node scripts/build-editor.mjs --write` 后执行 `node scripts/build-editor.mjs --check`：通过，`Editor bundle is fresh`。bundle 为本地产物，不纳入提交。
- `node node_modules/typescript/bin/tsc --project tsconfig.typecheck.json`：通过。
- `node --test tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs tests/test_ass_cue_position.mjs tests/test_ass_canvas_layout.mjs tests/test_ass_shake.mjs`（经 `scripts/run_check.py --timeout 180`）：通过，48 项。结果 `.artifacts/checks/20261016T055721Z-acdd65c3/result.json`。
- `scripts/run_tests.py tests/test_ass_cue_position.py`（经 `scripts/run_check.py --timeout 180`）：通过，4 项。结果 `.artifacts/checks/20261016T055721Z-51bf8245/result.json`。
- `node node_modules/playwright/cli.js test tests/e2e/ass-cue-position.spec.mjs --project=chromium`（经 `scripts/run_check.py --timeout 600`）：通过，13/13；含九锚点、横竖屏、震动、ASS 导出帧、缩放 handle、滚轮、独立重置、撤销和取消。结果 `.artifacts/checks/20261016T055151Z-a1e66952/result.json`。
- 本地浏览器人工操作：实际视频区滚轮改变倍率；拖动字幕后显示整数 X/Y，缩放与定位互不覆盖；分别重置大小和定位均保留另一字段；清除后两组控件隐藏，编辑区高 `191.33px`、视频顶部 `116.67px` 未改变。截图仅用于本地自查，未入库。
- `git diff --check`：通过。

环境记录：`uv run --no-sync` 的解释器缓存和 `pnpm exec` 的包管理器自更新都被本机沙箱权限挡住；改用已安装解释器和本地 Playwright CLI。第一轮 e2e 的帧对比环境缺少 Pillow，改用已有 Pillow 的解释器后完整 13/13 通过。核对清单 HTML 已生成且源文档通过校验，但本地浏览器策略拒绝打开 `file://` 页面（该策略只允许 `http:` / `https:`，并禁止换入口绕过），所以 HTML 的浏览器预览未完成。初次测试失败均为环境启动问题，不是产品断言失败；最终仍需以 PR CI 结果为准。

未验证边界：维护者真实工程和目标播放器表现、完整视频烧录、外部 CI / reviewer 反馈。便携内联副本 `blank-editor.html` 按仓库约定留待发布前统一重生成。
