# 测试反馈账本：烧录视频导出 network error

- 流程：先记录后调查；结论随时回填，发现早前结论有错当场更正并注明。
- 状态取值：`待处理` / `进行中` / `已修复` / `仅说明` / `阻塞`。
- 基线：`docs/logs` 顶部 `log-release-baseline: 1.10.0-beta.2`；分支 `main` @ `101b5967`（2026-11-07 记录时工作树干净）。
- 截图约定：截图不入库。条目 1 原图为编辑器深色警告 toast，全文：「烧录视频导出失败：network error」。

## 问题清单

| # | 问题 | 状态 | 核实结论 / 方案 |
|---|------|------|-----------------|
| 1 | 编辑器点「烧录视频」导出，弹出警告 toast：「烧录视频导出失败：network error」（2026-11-07 维护者截图） | 已修复（2026-11-08 自审放行；待维护者实测验收后随提交收口） | 见「条目 1 调查结论」+ REVIEW_FINDINGS.md。改动：下载连接 socket 写超时 2s→10s（常量 `MEDIA_JOB_DOWNLOAD_WRITE_TIMEOUT_S`）；`burnVideoSafeError` 对 network error / Failed to fetch 映射「与本地服务的连接中断，请重试」（含 i18n 英文条目）。 |
| 2 | 烧录视频导出失败，toast：「烧录视频导出失败：视频烧录失败，请检查源文件或缩短区间后重试」（2026-11-07 维护者反馈） | 已修复（2026-11-08 自审放行；待维护者实测验收后随提交收口；真实死因需下次复现经诊断出口抓取） | 见「条目 2 调查结论」+ REVIEW_FINDINGS.md。改动：poll failed 分支 console.error 有界 errorDetails 尾部（前端）；media_jobs 失败分支打印 error/error_details 尾部到 stdout（服务端）。诊断出口已建立，具体死因待下次复现抓取。 |

## 条目 1 调查结论

### 报错链路（file:line）

1. toast 出处：`web/editor/io/editor-wiring-burn-video.js:343`——整段烧录导出流程的兜底 catch，把 `error.message` 经 `burnVideoSafeError`（同文件 41-48 行，只过滤 ffmpeg/路径类噪音）拼在「烧录视频导出失败：」后面。
2. `network error` 全仓无此字符串（`rg` 验证）；`MaweHost.server.fetch` 是原生 fetch 薄封装（`web/shared/host/server-api.js:6-8`）。即文案来自浏览器网络层：Chromium 在流式响应体未收满声明的 Content-Length 就断开时，`reader.read()` reject `TypeError: network error`（与连接建立失败的 "Failed to fetch" 文案不同）。
3. 前端流程：POST 准入 → 轮询 JSON → `GET {jobsUrl}/{id}/download` 流式下载并写入磁盘（`editor-wiring-burn-video.js:287-328`）。POST/Poll 是小 JSON、失败文案形如「服务器返回 N」；因此 network error 几乎只可能出现在**下载阶段**——即 ffmpeg 烧录本身已成功，死在回传/写盘。

### 服务端疑点（最可能根因）

`server-editor/serve.py:4107` `send_video_attachment`：媒体任务下载连接先 `self.connection.settimeout(2)`（4115-4117 行）再按 128 KiB 分块发流；任意一次 socket 写阻塞 >2s 即抛 socket.timeout → `except (OSError, ...)` → `close_connection` 主动断流 → 浏览器侧 `network error`。

客户端读取速度受磁盘写入反压（`writable.write` → 浏览器 swap 临时文件），以下情况都会造成 >2s 停顿：

- 保存目标在慢速盘（USB/移动硬盘/网络盘）或 OneDrive/Dropbox 等同步目录；
- 杀软对浏览器 swap 文件实时扫描；
- `fetch` 返回（服务端已开始发流）到 `createWritable()` 完成之间的窗口（`editor-wiring-burn-video.js:297-307`），磁盘慢时建临时文件可能超过 2s；
- 烧录刚结束系统高负载导致的短暂卡顿。

次要可能：本地服务进程在下载中途退出（GUI 关闭、系统休眠）。

### 关键判断依据

- 取消的主路径不靠这个超时：下载开始后 `MediaJobManager.cancel()` 直接 `abort_download()` → `connection.shutdown(SHUT_RDWR)` 立即断流（`maw/media_jobs.py:330-334`、`server-editor/serve.py:3605-3606`）。`settimeout(2)` 只是客户端消失时的兜底，调大到 10~15s 不影响「停止视频烧录」的响应速度。
- 全链路 127.0.0.1 回环，与互联网、代理无关；也不是字幕内容或 ffmpeg 失败。
- 失败后服务端 `finish_download(success=False)` 会清理临时目录（`maw/media_jobs.py:351-354`），不留垃圾文件。

### 修复方向（待定级后派发，均属小规模实施）

1. `serve.py:4117` 的 `settimeout(2)` 调大（如 10s），容忍慢盘/杀软造成的短暂写停顿。
2. `burnVideoSafeError` 对 `network error` / `Failed to fetch` 映射友好中文提示（如「与本地服务的连接在传输中断开，请重试」），不再裸露浏览器原文。
3. 需同步的测试：`tests/` 中媒体下载/取消相关用例（超时语义变化）；i18n 文案表 `web/shared/editor-i18n.js`。

### 待维护者补充

- 偶发还是必现？重试能成功吗？
- 保存位置是本地物理盘还是外接/同步盘？
- 用浏览器还是 Launcher 打开的编辑器？
- 下载进度条大概走到多少时断（刚开始 / 中途 / 快满）？

## 条目 2 调查结论

### 报错链路（file:line）

1. toast 前缀同条目 1：`web/editor/io/editor-wiring-burn-video.js:343`。本条的后半句来自轮询：任务状态 `failed` 时 `throw new Error(state.error)`（同文件 274 行）。
2. `state.error` 即服务端 `BurnVideoExportError("视频烧录失败，请检查源文件或缩短区间后重试", details=stderr)`（`server-editor/serve.py:1261`）——ffmpeg 烧录编码命令**退出码非 0** 时的兜底文案；全部编码器尝试耗尽时经 `last_error` 从 1269 行抛出同一文案。
3. `details=stderr` 附带 ffmpeg 原始报错尾部，但见下「诊断缺口」。

### 编码器尝试语义

- 编辑器烧录路径写死 `normalize_video_encoder(None)` → 恒为 `auto`（`serve.py:1193`），Launcher 工具箱的编码器下拉不影响编辑器烧录。
- auto 尝试顺序 `nvenc → amf → qsv → cpu`（`maw/postprocess_ffmpeg.py:56`，按 `ffmpeg -encoders` 实际存在过滤，370-380 行）。
- 失败分支（`serve.py:1260-1265`）：硬件编码器失败 → 静默 `continue` 换下一个；**cpu（libx264）失败 → 立即抛出**。因此看到这个 toast 基本意味着 libx264 也失败了（或全部尝试耗尽）。
- 缺字形（libass missing glyph）走独立报错（1223/1257 行），缺字 toast 不是本文案。

### 诊断缺口（本条核心发现）

ffmpeg 的真实 stderr 存进了 `job.error_details`（`maw/media_jobs.py:289-295`，尾部 4000 字符）并随任务快照下发（snapshot `errorDetails` 字段，`maw/media_jobs.py:91`；轮询接口返回 `gap_removed_job_snapshot`，`serve.py:452-458`），但：

- `rg errorDetails web/` 无任何匹配——前端从不读取该字段；
- 服务端失败路径也不打印日志。

即**真实失败原因当前没有任何出口**，只能靠复现抓取。设计意图本是不把原始工具输出当 toast（`serve.py:447-449` docstring），但现状是诊断信息无处可去。

### 可能的真实原因（需 errorDetails 才能定）

源视频解码错误、ass 滤镜/libass 运行期失败、表情包滤镜链失败、aac 音轨编码失败、临时目录磁盘满或杀软拦截 ffmpeg 写输出、内存不足等——toast 文案暗示「源文件/区间」，但实际原因未必与此相关。

### 无需改码的抓取方法（下次复现时）

DevTools → Network → 失败前最后一次轮询请求 `GET /api/exports/burned-video/jobs/{id}`（`serve.py:1708`）→ Response JSON 的 `errorDetails` 字段即 ffmpeg stderr 尾部。任务失败后临时文件已清理，但快照仍留在服务端内存（最近 31 个）。

### 修复方向（小规模实施，待拍板）

1. 前端：`failed` 分支读取 `state.errorDetails` 时 `console.error` 有界尾部（零 UI 噪音、开发者可查）；可选再加 toast「查看详情」入口。
2. 服务端：`media_jobs.py` work() 失败分支打印 error/error_details 尾部到 stdout（Launcher 用户也可见）。
3. 测试同步：`tests/test_burn_video_export.py`（文案断言不变）+ 新增 errorDetails 透出断言；i18n 表若加文案需同步 `web/shared/editor-i18n.js`。

## 阶段汇总

- 续 1（2026-11-07）：条目 1 建账并完成主会话直查（报错链路 + 服务端疑点，结论见上）；状态 `进行中`，等维护者补充复现条件后定级并派发修复。
- 续 2（2026-11-07）：条目 2 入账并直查完毕：定位到 serve.py:1261 兜底文案与编码器回退语义，确认 errorDetails 诊断缺口（前端/服务端均无出口）。
- 续 3（2026-11-07）：维护者拍板合并派发。实现规格（4 项）：① `serve.py` send_video_attachment 的 `settimeout(2)`→10s（注释说明取消主路径是 abort_download shutdown，超时只是兜底）；② `editor-wiring-burn-video.js` burnVideoSafeError 特判映射 `network error`/`Failed to fetch`→友好文案「与本地服务的连接中断，请重试」（走 burnVideoText + editor-i18n.js 英文表同步）；③ poll failed 分支（274 行附近）`state.errorDetails` 存在时 `console.error` 有界尾部；④ `maw/media_jobs.py` work() 失败分支 print error/error_details 尾部（带 job id，flush=True）。边界：不加「查看详情」UI、不改 toast 结构、不生成 blank-editor.html、`tests/test_burn_video_export.py:278` 文案断言不变。已派 general 子代理实施，完成后主会话抽查 diff 复核。
- 续 4（2026-11-08）：实施完成并自审放行。经过：实现子代理在上限中断前完成大部分改动，主会话抽查发现 ① 只加注释未改值（注释写 10s 代码仍 `settimeout(2)`），当场补改；复跑时暴露 `test_shutdown_waits_for_open_download_disposal` 依赖「写超时 < close 预算」——把超时提为共享常量 `MEDIA_JOB_DOWNLOAD_WRITE_TIMEOUT_S`（media_jobs.py）并将 close() 等待预算跟随该值+2s，问题消除。验证：`pnpm run check:editor`（bundle 重建后 fresh）、`pnpm run typecheck`、JS 语法/顺序/utils 354 pass、burn_video_export+gap_removed_media_jobs+media_job_shutdown 90 tests OK、全量 Python 2836 tests OK（17 skip）、`git diff --check`、个人路径检查全过。独立审查（子代理 ses_e494ab689ffeey6F6sarpvXIFf）：可提交，无 blocker/major；F1-F5 分诊见同目录 REVIEW_FINDINGS.md（Firefox/Safari 文案变体、去空隙路径映射一致性为后续候选条目）。条目 1、2 → `已修复`（待维护者实测验收 + 提交收口）。
- 续 5（2026-11-08）：提交 `dd84adca`（8 文件，含 CHANGELOG 未发布条目与本账本/审查记录）并创建 PR：https://github.com/Moyf/moys-asr-workflow/pull/351，分支 `fix/burn-video-export-resilience`，正文按「为什么改/改了什么/验证/边界」四段回读核对无误。条目 1、2 待 PR 合并 + 维护者实测后完全闭环。
- 续 6（2026-11-08）：Greptile 评审（置信 4/5，总体可合并）提出 P2「Launcher 无法取回失败日志」——核实属实：`gui_web.start_server` 把服务子进程 stdout 接到 `TemporaryFile`（gui_web.py:2137），启动成功后不读取，`_read_server_log()` 仅启动失败时使用，退出即丢弃，stdout 诊断对 Launcher 用户不可达。修复：media_jobs 失败诊断改经现成 `LocalLogSink` 按天落盘到用户日志目录（`maw-YYYY-MM-DD.log`，与 GUI 同目录，自带脱敏/时间戳/静默降级/7 天清扫），stdout 保留给控制台用户；两个 HTTP 夹具补 sink 补丁防测试污染，新增失败落盘+脱敏、取消不落盘两用例。定向 123 tests OK，真实日志目录验证无测试污染。待 resolve thread + re-trigger。
- 续 7（2026-11-08）：re-trigger 后 Greptile 处理完毕（P2 thread 已回复并 resolve）；并行独立 review 子代理抓到 **blocker B1**——续 6 引入的 `_diagnostic_sink` 模块级变量与函数同名自遮蔽，def 覆盖变量绑定，生产路径调用返回函数对象 → `.write_text` AttributeError，落盘与 stdout 诊断双双失效，而两个 mock 夹具恰好掩盖了它（子代理在 8a8b0b2e 实测复现）。修复：全局变量改名 `_diagnostic_sink_instance`，并在 MediaJobsTests 增加不打 mock 的真实路径回归守门（负面对照实测：bug 版红、修复版绿）。顺带：M1 账本 EOF 空行（git diff --check 红灯来源）已删、M2 CHANGELOG 补「Chromium 内核浏览器」限定、M4 未用 import 已在 e2e77a64 删除；M3（close 预算余量/Windows shutdown 不打断阻塞写）维持接受风险备案。工作树曾被并行会话切回 main，本分支无损，已 merge main（解决 INDEX.md 行冲突）后继续。
- 续 8（2026-11-08）：PR #351 以 squash 合入 main（`5e6d8c14`），分支已删。合并前最终验证：全量 Python 2864 tests OK（17 skipped）、ruff 全绿、Windows 打包 CI 在修复后的 head 通过（run 42454612723，含打包契约）。流程遗留说明：本 PR 的 pull_request 事件始终未触发 CI（opened + 两次 synchronize 共 3 次均无 run，平台状态页正常、workflow_dispatch 正常），改以本地全量 + dispatch 打包等价覆盖，原因未查明，待维护者留意后续 PR 是否复现。B1 负面对照与两处守门测试（compact mixin、打包契约）在修复过程中由守门机制抓出并当场修复，账本同步。