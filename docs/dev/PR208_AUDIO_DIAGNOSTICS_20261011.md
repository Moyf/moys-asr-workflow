# PR #208：Launcher 空转写与音轨诊断

## 基线与范围

- 独立 worktree：本聊天 `dfe6/maw-fork`；初始提交 `cfe2931b`，已通过 `236337d5` 合入上游 `09af19f`。
- 反馈：多音轨 OBS 录屏误选未录入声音的音轨，界面只提示转写失败。
- 原代码：OpenAI 对空字幕抛异常，本地模型无文本返回失败；Qwen / Soniox / Doubao / Bcut / Tencent 对无识别文字输出“错误: 未识别到任何内容”，但整理后全空仍可能写出空工程。Launcher 之前没有统一这些入口与音频证据诊断。
- 仅修改 Launcher 的执行与错误提示链，保留生成器 CLI 行为、选轨默认值和输出路径。不自动换音轨、不额外请求 ASR、不修改原工作区配置；保持 #208 Draft。

## 研究结论与边界

| 现象 | 本地证据与处理 | 状态 |
| --- | --- | --- |
| 视频没有音轨 | FFprobe 成功返回空音轨列表时使用明确无音轨提示；音频提取失败有选轨证据时也可进一步核实 | 已修复 |
| 空字幕或所有字幕文本为空 | 执行成功后检查工程文本；已知空文本失败也走诊断 | 已修复 |
| 所选音轨近乎静音 | FFmpeg astats 检查各声道总峰值，不进行单声道混合；≤ -60 dBFS 只说明检测片段音量极低 | 已修复 |
| 多轨选错 | 当前片段近乎静音、另一轨峰值 > -45 dBFS 时提示可能误选，引导复听和手动选轨 | 已修复 |
| 有信号但空结果、噪音太大或无人声 | 电平无法证明人声、信噪比或可识别性，只列为可能原因，不确定归因 | 仅说明 |
| 探测失败、超时、无采样 | 保留空结果与原错误详情，不能冒充无音轨或静音 | 已修复 |

依据：[FFmpeg astats 官方文档](https://ffmpeg.org/ffmpeg-filters.html#astats)，Peak_level / Number_of_samples 用于电平与采样证据，不能作为人声识别。

检查开头最多 60 秒，尊重更短 length-limit；不把开头静音外推到整段。音轨列表沿用 FFprobe 10 秒超时，电平检查共用 20 秒预算，单轨最多 8 秒，最多检查所选轨与另外三轨。取消会终止电平检查进程。日志记录实际音轨索引（从 0 开始）、检测范围与电平；界面中文/英文提示对应，批量清单沿用同一错误码。保留空输出供排障，不进入后处理或误报完成。

## 验证记录

验证对应 `236337d5` 加本次功能差异，代码、测试与本记录同批提交。使用锁文件一致、依赖完整的现有 Python 环境，只读复用且禁用写入 pyc，不同步共享环境。以下命令中的 `<python>` 指该已安装解释器；实际命令与退出码保存在对应 `result.json`。

| 层次 | 命令 / 证据 | 结果 |
| --- | --- | --- |
| 相关 Python | `scripts/run_check.py --timeout 180 -- <python> scripts/run_tests.py tests.test_audio_diagnostics tests.test_asr_errors tests.test_gui_workflow tests.test_gui_web tests.test_launcher_batch tests.test_gui_config tests.test_packaging_contract`，启用 `MAW_TEST_AUDIO_FFMPEG=1` | 554 通过、1 跳过；`.debug-runs/20261011T071309Z-be36537d/result.json` |
| 新入口补测 | 音频模块、空结果工作流、ASR 分类与打包契约 | 58 通过；`.debug-runs/20261011T071518Z-68b5815d/result.json` |
| 最终音频模块 | `scripts/run_tests.py tests.test_audio_diagnostics`，包含真实 FFmpeg 合成素材 | 14 通过；`.debug-runs/20261011T071734Z-601f7f70/result.json` |
| Launcher Node | `node --test tests/test_launcher_script_syntax.mjs tests/test_launcher_bundle.mjs tests/test_launcher_feedback_ui.mjs` | 14 通过；`.debug-runs/20261011T071733Z-5748dba2/result.json` |
| 真实浏览器 | Edge，`playwright test --project=chromium tests/e2e/launcher-api-errors.spec.mjs --reporter=line` | 6 通过；`.debug-runs/20261011T071439Z-2e18fc85/result.json`，含中英文截图及按钮间距 ≥ 8px 实测 |
| 静态与产物 | Launcher build / check、TypeScript、Ruff、`git diff --check` | 通过；未生成 `blank-editor.html` |
| Python 全量 | `scripts/run_check.py --timeout 300 -- <python> scripts/run_tests.py`，启用真实 FFmpeg | 最终 2006 项，1976 通过、30 跳过，退出码 0；`.debug-runs/20261011T071943Z-36d1dd86/result.json` |

初次 Python 解释器缺少 `send2trash`，已改用完整的现有环境；初次 Edge 在沙箱内启动即退出，外部同一 Edge 重跑通过。全量首轮的一处旧用例仍期待空文本为通用进程异常，已改为验证一般失败保留完整子进程输出，并新增通用云端 / 本地空文本进入诊断的用例。另一处超时清理用例被沙箱拒绝 `taskkill`；不修改运行器，改在沙箱外完成最终全量验证。环境失败不能作为产品失败或通过证据。

最终全量日志包含模拟不可解码媒体的预期警告，以及一条子进程读线程的 `UnicodeDecodeError`；unittest 最终为 `OK (skipped=30)`，退出码 0。线程警告未在本任务扩大修复，也不以退出码代替真实媒体和供应商验收。

官网同步脚本已运行，仅保留本任务的 FAQ 生成副本，未纳入其他上游文档副本的同步差异。人工核对 HTML 使用仓库模板生成，放在仓库外，不提交。已完成源码自审：正常结果不扫描音频；API / 文件失败保持既有优先级；失败不读取旧产物当本次结果；取消不变成空结果失败；批量条目保留诊断并继续后续任务；空输出保留但不进入后处理。

## 未验证与后续

不以合成信号替代真实录屏、人声识别或听审。不调用真实供应商 API；完整打包仍需单独验收。最终由维护者决定 #208 何时 ready / 合并。
