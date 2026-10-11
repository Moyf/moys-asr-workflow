# MAW20 PR-B：普通文稿匹配取消

基线：`09af19f13bd87fb46d7ea9849ef81ac76ddbe574`。范围：G03 / P03、P04。独立分支：`code/maw20-match-cancel-261011`。

## 行为与接口

普通文稿匹配复用 `_PostprocessOperation` 的任务 ID、admission、重复 ID 拒绝、终态清理与 `begin_commit` 锁。Launcher 不勾选 AI 整理时也生成 ID，收到对应 admission 后显示“停止字幕处理”；取消完成后可以立即重启，并隔离之前任务的迟到状态。

`run_script_match(request, *, is_cancelled=None, begin_commit=None, on_status=None)` 的回调全部可选；旧 CLI、后处理流水线和未提供 operation ID 的 bridge 调用继续工作。`_match_project`、`_match_project_with_character_timings` 及字符匹配领域函数只新增可选 keyword-only 取消回调。

读取、预处理阶段边界，文稿断句、归一化、segment/item、时间重建与输出段循环都有协作检查。最耗时的 difflib 搜索使用既有 `scripts/mosp_match_text.py` 中的 `_CancellationText` 包装：在字符索引建立时每 256 个字符、搜索/前后缀扩展访问字符串索引时检查。算法、autojunk=False 和匹配结果保持一致；没有回调时 difflib 使用原始字符串。候选位置的单轮内部比较、JSON 编解码、deepcopy、底层文件读取与正则操作仍在当前调用返回/下一检查点响应，不能承诺任意输入恒定毫秒级停止。

提交前最后检查取消，再由 `begin_commit` 原子决定取消或写入。取消胜出不调用 `write_artifacts`；提交胜出后停止请求返回 cancelled=false，正常保存成功/失败照实返回。没有新增 runtime 模块、AI 判断协议、网络 transport 或工程 schema。

## 验证账本

测试均经 `scripts/run_check.py`，Python unittest 经 `scripts/run_tests.py`。依赖只读复用，测试产物、截图和日志不提交。

| 层 | 命令摘要 | 实际结果与 result.json |
| --- | --- | --- |
| 既有匹配/GUI | `python scripts/run_tests.py tests.test_postprocess_match tests.test_gui_web` | 运行 347 项，OK（1 跳过）；`.debug-runs/20261011T070525Z-439fd52a/result.json` |
| 新增取消 | `python scripts/run_tests.py tests.test_script_match_cancel` | 9 通过；`.debug-runs/20261011T070739Z-067553b6/result.json` |
| Launcher 构建 | `node scripts/build-launcher.mjs --write` | exit 0；`.debug-runs/20261011T070741Z-02807ab8/result.json` |
| Node 定向 | `node --test tests/test_launcher_feedback_ui.mjs tests/test_launcher_script_syntax.mjs` | 12 通过；`.debug-runs/20261011T070741Z-64e03bee/result.json` |
| Launcher 新鲜度 | `node scripts/build-launcher.mjs --check` | exit 0；`.debug-runs/20261011T070947Z-1840e6c4/result.json` |
| Editor 新鲜度 | `node scripts/build-editor.mjs --check` | exit 0；`.debug-runs/20261011T070948Z-0357a20c/result.json` |
| TypeScript | `node node_modules/typescript/bin/tsc -p tsconfig.typecheck.json` | exit 0；`.debug-runs/20261011T070949Z-b3619f66/result.json` |
| 最终匹配/取消/流水线/打包 | `python scripts/run_tests.py tests.test_postprocess_match tests.test_script_match_cancel tests.test_postprocess_pipeline tests.test_packaging_contract` | 109 通过；`.debug-runs/20261011T071311Z-e6eb881e/result.json` |
| 真实 Edge + Python bridge | `playwright test --project=chromium tests/e2e/launcher-script-match-cancel.spec.mjs --workers=1` | 2 通过；`.debug-runs/20261011T071337Z-a54d7d10/result.json` |
| 全量 Python（最终源码） | `.debug-runs/test-venv/Scripts/python.exe scripts/run_tests.py` | 运行 1970 项，1940 通过、30 跳过；`.debug-runs/20261011T071442Z-adfa797c/result.json` |
| 最终生产 Python 规则 | `python -m ruff check maw/gui_web.py maw/postprocess_match.py scripts/mosp_match_text.py` | exit 0；`.debug-runs/20261011T071549Z-bad28e89/result.json` |
| 既有 AI 浏览器生命周期 | `playwright test --project=chromium tests/e2e/launcher-interactions.spec.mjs --grep 'AI (cleanup\|llm)' --workers=1` | 7 通过；`.debug-runs/20261011T071104Z-60bebf98/result.json` |

新增取消用例对普通/字词两条真实路径各使用 12000 字重复输入，确认已进入原 difflib 搜索再停止，2 秒内返回，源工程字节不变、无输出；覆盖提交前取消、开始写入后重复取消拒绝、admission 前置、重复 ID、失败/取消后重启、旧调用和算法结果一致。

浏览器用实际 Edge 打开 Launcher，并通过专用 JSON-lines 测试桥调用真实 Python `LauncherApi`，使用磁盘合成 MOSP/文稿，停止后检查目录只有两个输入文件，然后用短文稿重新匹配得到实际产物。界面按钮与状态同一 flex 行，间距按实际水平/垂直排列测量至少 8 px；两条路径截图已自查，位于被忽略的 `test-results/`。宿主配置使用 Launcher 演示环境；没有在原生 pywebview 桌面窗口内操作。

## 修复过程中的失败与边界

首次沙箱测试的临时目录清理被 Windows 权限拒绝，后续按已授权的常规执行权限运行，现有定向回归通过；误指定不存在的 `tests.test_mosp_match_text` 模块已撤销，字符路径由真实输入和现有匹配回归覆盖。

首次浏览器验收把同一水平 flex 行误当作垂直排列测量，得到负距离；只修正测试测量方向，再次运行两项通过，没有为测试改变生产布局。既有 AI 浏览器筛选首次加开头锚点未找到测试，去掉锚点后 7 项通过。

第一次全量 Python 回归仅复用旧依赖目录，缺少 quapeaks 等生成依赖，1914 项中 8 失败、4 错误、26 跳过；结果为 `.debug-runs/20261011T070910Z-45cbb954/result.json`。补齐依赖后运行 1976 项仍有 1 个环境失败、26 跳过（`.debug-runs/20261011T071130Z-c646bc42/result.json`）：既有 `test_local_entry_imports_without_rust_kernel` 主动移除 PYTHONPATH，使全局解释器的子进程找不到 requests。仅在本树 `.debug-runs/test-venv` 创建无 pip 的独立解释器，以本地 `.pth` 只读指向已备齐的依赖，保持测试语义不变；最终完整运行 1970 项，1940 通过、30 跳过。该环境的发现/跳过数量不同，不能把前轮计数移植给最终运行。全量日志包含既有失败输入夹具和后台 reader 的编码诊断，unittest 最终为 OK，未修改这些无关范围。

没有修改便携 `blank-editor.html`；其内联副本按仓库发布规则留待统一生成。本轮没有远端 push、PR 创建、merge 或发布，也没有外部 LLM/原生保存器验收。

CHANGELOG 建议（父代理统一写）：普通文稿匹配支持主动停止，取消后保留原输入并可重新运行；开始保存后会明确提示无法取消。
