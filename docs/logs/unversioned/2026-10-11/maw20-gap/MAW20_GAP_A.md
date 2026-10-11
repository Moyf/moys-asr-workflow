# MAW20 PR-A：视频导出绑定时序

基线：`09af19f13bd87fb46d7ea9849ef81ac76ddbe574`。状态：已修复（定向验证通过，等待父代理 review/PR 交付）。

- 保存器前固定 config 对象、`bindingGeneration`、`sourceMediaId`、本地 epoch、URL/token 与 intervals 副本；恢复后变更即提示重新导出，不 POST、不创建输出。
- `bindingGeneration` 从 1 开始；`sourceMediaId` 是不含路径的随机字符串。初始化异步载入、最近工程重开、浏览器工程接管、服务器另存为均经 `_bind_project_locked` 轮换，包含同一路径重开。普通保存保留身份。
- `MaweProjectLoad.projectBindingEpoch` 是只读 getter；canonical 工程加载和 detach 递增，普通自动保存不变。
- 服务器 `gap_removed_video_source_snapshot(request)` 在 `settings_lock` 下校验身份并取原始媒体 Path。陈旧或缺失身份返回 HTTP 409 / `ok:false` / `error:工程或媒体绑定已变更，请重新打开工程后导出`。授权仍独立检查 token。
- 页面渲染取工程和身份的共同快照；sticker / reapeaks 的工程对象替换也使用 `settings_lock`，防止缓存更新恢复已经被替换的 source。绑定锁不与 FFmpeg 执行或流传输重叠。
- 取 source 与规范化 intervals 后释放绑定锁再运行 FFmpeg；接受后的重绑定不会改变已接受请求的 source/intervals。
- 保留流复制精度边界和既有失败传输取消/导出锁释放逻辑。不生成便携 blank-editor.html，不加入后台任务。

## 定向验证

测试均由 `python scripts/run_check.py` 执行，Python 内层使用 `scripts/run_tests.py`；下列路径均为本工作树 `.debug-runs/` 下的 `result.json`。

| 检查 | 命令（省略相同外层） | 结果与证据目录 |
| --- | --- | --- |
| 单元 / HTTP / 原服务器回归 | `python scripts/run_tests.py tests.test_gap_removed_binding tests.test_local_editor_server` | 98 tests passed；`20261011T070740Z-1ea541d4` |
| 新增接管身份轮换后完整绑定用例 | `python scripts/run_tests.py tests.test_gap_removed_binding` | 8 tests passed；`20261011T070913Z-d411c488` |
| Editor 构建与新鲜度 | `node scripts/build-editor.mjs --write` / `--check` | exit 0；`20261011T071017Z-1d566257` / `20261011T071018Z-2f9f3f99` |
| JS 语法 / 装配顺序 | `node --test tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs` | 2 tests passed；`20261011T070633Z-8de7ccf4` |
| Typecheck | `node node_modules/typescript/bin/tsc -p tsconfig.typecheck.json` | exit 0；`20261011T070914Z-83e36839` |
| 真实 Edge 浏览器 | `node node_modules/@playwright/test/cli.js test tests/e2e/gap-removed-video-binding.spec.mjs tests/e2e/gap-removed-video-transfer.spec.mjs --project=chromium --workers=1` | 13 tests passed；最终闭包冻结后 `20261011T071022Z-acdf12df` |
| 文本与 diff | 严格 UTF-8 decode / 无 CR 字节；`git diff --check` | 10 个文件通过；`20261011T071113Z-1205900b` |

环境：已安装 Python 3.13，`PYTHONPATH` 只读复用既有 site；Node 只读复用 seed 的 node_modules 本地 junction，不修改共享依赖。`MAW_E2E_CHROMIUM_PATH` 显式使用 Edge。初轮 sandbox Python Temp 权限失败，命令级提升后通过；首轮浏览器 1 个成功路径 fixture 使用了只读 `window.closed` 而失败，改为 `window.outputClosed` 后通过。失败记录保留在被忽略的 `.debug-runs`，不冒充代码回归失败。

建议 CHANGELOG：修复选择去空隙视频保存位置期间切换或解除工程绑定后仍继续旧导出的问题，避免将旧剪辑区间应用到新的媒体。

浏览器层使用 Chromium/Edge 执行生产 handler 和 canonical reload；保存器 Promise/存储句柄为可控 fixture，不代表人工原生保存对话框验收。真实 FFmpeg 输出精度与完整产品回归不属于本次定向验证。

跨标签页服务器重绑时，旧页面保留旧身份直到重新打开正确工程；它可以发出被拒绝的 POST，但不会运行重组或创建输出。已接受请求则继续固定的 source/intervals，不因后续重绑改用新源。源码与 editor bundle/meta 一并提交；内联副本待发布前统一重生成。
