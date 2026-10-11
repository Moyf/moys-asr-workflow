# TEST_FEEDBACK_20261011

任务：合并 `rustic-donkey` 并完成 Launcher / 字幕编辑器反馈调整。本记录按源码、测试和实际交互更新。

状态仅使用：`待处理`、`进行中`、`已修复`、`仅说明`、`阻塞`。

## 事实基线

- 起始 HEAD：`20c8ede6`，起始工作区干净；`rustic-donkey` 起始未提交恰为 5 个文件。
- 已创建本地分支 `fix/editor-feedback-20261011`。先在源分支提交 `a06b76c8`，再将源分支全部历史合入，当前合并 HEAD：`65c2a338`。
- 没有生成或修改 `blank-editor.html`。

## 任务清单

| # | 事项 | 状态 | 处理、验证与边界 |
|---|---|---|---|
| 1 | 提交并合并 `rustic-donkey` | 已修复 | 仅提交原有 5 个文件；Python 波形测试 25/25，Chromium `overlay-track.spec.mjs` 26/26；本地 merge commit `65c2a338`。 |
| 2 | 服务器运行时“打开编辑器”带 🎬 | 已修复 | 中英文 Launcher 文案均已更新，静态与 Launcher E2E 已补充；本轮 E2E 服务启动受当前沙箱环境阻塞，见验证记录。 |
| 3 | 新警告出现时滚动到可见位置 | 已修复 | Launcher 字段错误 / 后处理警告和 Editor 行内警告已接入可见性处理；相同文本去重、已可见不滚动，顶部 Toast 保持原行为。新增回归测试；浏览器层未能启动。 |
| 4 | 波形复核标记浮层增加静音操作 | 已修复 | 波形弹窗复用管理面板的资格判断、状态按钮和操作；刷新时同步管理面板 / 弹窗状态。静音、撤销重做、区段修改与语言切换的回归 E2E 已补充，浏览器层未能启动。 |
| 5 | 字词拆分弹窗采用统一样式与简洁警告 | 已修复 | 复用 `.modal` 字号、背景、圆角和按钮布局；警告、统计 hint 与红色确认按钮已更新。原有 E2E 已改为新文案并检查间距 / 按钮样式，浏览器层未能启动。 |
| 6 | 文本处理分组、ASS 注释预设与自定义包裹 | 已修复 | ASS 与普通字符分行单选，增加 `//注释文本//`、可取消预设和左右自定义输入。相关文本工具与副字幕 E2E 已更新，浏览器层未能启动。 |
| 7 | 文本处理加入保守的中文数字转换 | 已修复 | 已接入纯函数与「数字转换」控件；整数、逐位、负数、小数及歧义保护单测已补充，UI E2E 已更新，浏览器层未能启动。 |
| 8 | 纯文本编辑入口独立，并加入查找 / 替换 | 已修复 | 工具栏 📝 入口独立于批量操作；逐条 / 整体视图共用查找、循环、大小写、正则、捕获组替换和草稿应用 / 取消。新增查找滚动、高亮和替换 E2E，浏览器层未能启动。 |
| 9 | 确认默认主题为深色 | 仅说明 | 当前空白 / 无偏好启动回退为深色；编辑器设置规范化对无效值也回退深色，无需改动主题默认值。 |
| 10 | 跟随播放状态反馈 | 已修复 | 手动翻看暂停后按钮显示「恢复跟随」，启用时显示「跟随中」并更新说明，解决播放字幕已可见时点击看似无反应的问题；浏览器用例受服务启动环境阻塞。 |
| 11 | 字幕列表工具栏图标与分隔符 | 已修复 | 「仅看超长」使用 🧐 并保留无障碍名称 / tooltip；移除纯文本编辑按钮左侧分隔符。浏览器用例受服务启动环境阻塞。 |
| 12 | 文本处理预览全部展开 / 收缩 | 已修复 | 预览摘要右侧增加切换文本，单条展开状态变化会同步切换按钮；样式间隔设为 12px，E2E 已补充但服务启动失败。 |
| 13 | 文本处理和批量替换显示「当前范围」 | 已修复 | 两个窗口统一显示当前全部 / 已选字幕数；浏览器用例受服务启动环境阻塞。 |
| 14 | 批量替换复用纯文本编辑的查找替换规则 | 已修复 | 预览与应用均使用共享查找、匹配和捕获组替换工具；保留字幕内部换行。新增共享规则单测 1/1 通过，typecheck 与 bundle 新鲜度检查通过。 |
| 15 | Shift 范围选择时白色外框的原因 | 仅说明 | `.cue.selected` 为范围选中的字幕行绘制 1px 主题色描边；深色主题变量为琥珀黄。列表容器未发现 Shift 专属外框或焦点描边规则。 |

## 验证记录

- rustic-donkey：`python scripts/run_check.py --timeout 180 -- uv run --no-sync python scripts/run_tests.py tests/test_waveform.py` → 25 项通过。
- rustic-donkey：`python scripts/run_check.py --timeout 600 -- node node_modules/@playwright/test/cli.js test --project=chromium tests/e2e/overlay-track.spec.mjs` → 26 项通过，含新增 Shift 拖动边界回归。
- rustic-donkey：`node --check`（拖动源码和 E2E spec）、`git diff --check` → 通过。
- 本轮：`node scripts/build-editor.mjs --write` → 成功；editor 与 Launcher bundle 新鲜度检查、typecheck → 通过。
- 本轮：`node --test --test-name-pattern='batch replacement preview shares' tests/test_editor_utils.mjs` → 1/1 通过。
- 本轮：完整 `tests/test_editor_utils.mjs` → 322/328 通过；6 项调用 `uv` 的跨语言用例无法写入沙箱 Python 缓存，非产品断言失败；未重跑整文件。
- 本轮：定向 Chromium E2E 两次均无法启动本地测试服务器（30 秒未响应）；第一次明确报告沙箱拒绝写入 AppData 临时目录，改用仓库临时目录后仍受 PowerShell `InitializeDefaultDrives` 失败阻塞。启动失败路径会等待终止服务进程树；CIM 进程枚举同样被当前环境拒绝。
- 本轮：定向 E2E 命令只筛选预览展开与共享捕获组替换两项，没有运行其他浏览器用例。

## 未验证边界

- Chromium 页面交互和视觉截图未验证：本地测试服务器无法在当前沙箱中启动；预览摘要的按钮间距由 CSS 设置为 12px，并由 E2E 检查，但该 E2E 未能进入页面。
- 未执行 tag 或发布；Chromium 人工检查仍待维护者在可启动 Server 的环境中完成。

## 最新主线合并与收尾验证

- 合并 `origin/main` 的 `d2d12b42`：冲突已解决；Launcher 桥同时保留警告滚动与 API Key 校验接口，供应商设置沿用主线的槽位过滤及设置页隔离行为。CHANGELOG 同时保留两边新增的用户可见条目。
- `node scripts/build-editor.mjs --write` 与 `node scripts/build-launcher.mjs --write` → 成功；随后两条 `--check` 新鲜度检查均通过。
- `node node_modules/typescript/bin/tsc -p tsconfig.typecheck.json` → 通过。
- `node --test tests/test_launcher_feedback_ui.mjs` → 21/21 通过，包含运行中编辑器图标和供应商槽位行为。
- `pnpm run check:editor`、`pnpm run check:launcher`、`pnpm run typecheck` 未能进入脚本：pnpm 尝试在沙箱临时目录更新自身时遇到 `EPERM`；已用本地 Node 直接运行对应 bundle 新鲜度检查和 TypeScript 编译。
- 单个 Python 定向测试在测试初始化写入系统临时目录时遇到 `PermissionError`，未进入断言；没有重试，也没有扩大测试范围。浏览器交互仍按前述环境限制待人工核验。

## 最终交付

- 主线合并提交：`6d9b58c695485050ea1cfce3e03ec63c8a738685`（父提交为功能提交 `8013d7f0` 与 `origin/main` 的 `d2d12b42`）；PR 创建时显示可自动合并。
- 已推送 `fix/editor-feedback-20261011` 并创建 [PR #223](https://github.com/Moyf/moys-asr-workflow/pull/223)，目标分支为 `main`。
- Python 定向用例的完整运行结果记录在 `.artifacts/checks/20261011T172129Z-bafab296/result.json`；该文件位于本地忽略目录，不提交。
- 未打 tag 或发布；`blank-editor.html` 保持未生成，按仓库约定待发布前统一更新。
