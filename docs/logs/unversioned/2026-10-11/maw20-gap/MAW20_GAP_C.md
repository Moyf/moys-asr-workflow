# PR-C: 去空隙视频后台任务

基线：`09af19f13bd87fb46d7ea9849ef81ac76ddbe574`。状态：候选完成，等待独立审查。
依赖 PR-A `08b5fd2c49a957da7771ed10b4662cb3ce8d891a`，父代理已整理为真实祖先，
并保留 A/C 的独立 CHANGELOG 提交。初始 C 代码重放为 `324144a`。

## 冻结契约

服务器选择 source，客户端只提供整数毫秒 intervals、token 及 PR-A 的
`bindingGeneration` / `sourceMediaId`。任务固定 source、绑定身份和 intervals；
任务 ID 随机生成，不暴露源路径。仅当前工程视频、同容器流复制。

新增 `POST /api/exports/gap-removed-video/jobs` 返回 202 和任务快照。
`GET /api/exports/gap-removed-video/jobs/{id}` 查询状态；
`POST /api/exports/gap-removed-video/jobs/{id}/cancel` 幂等停止；
`GET /api/exports/gap-removed-video/jobs/{id}/download` 消费最终附件。
查询和下载携带 `X-MAW-Request-Token`，启动和取消 JSON 携带 requestToken。
旧同步路由保持兼容，并共享同一槽位。

快照包含 jobId、state、stage、progress、两绑定字段和可选 error。
阶段 preparing/rebuilding/verifying/ready/downloading；state 为
running/ready/downloading/cancelling/completed/cancelled/failed。
FFmpeg `out_time_us` 仅表示流复制阶段进度，尚未结束时限制到 99%；
探测/验证不伪造百分比，下载由浏览器显示收到字节。

取消设置控制器事件，进程 kill/wait、关闭管道，然后清临时目录并释放槽。
正在停止仍占槽；晚到成功不能覆盖取消。下载期间取消推迟清理至文件关闭。
完成状态不再变成取消；ready 未消费 30 分钟自动清理。原文件只读。

File System Access 的 `writable.close()` 是原生原子保存提交边界。
开始 close 前做最后一次停止/绑定检查，期间被接受的停止会 abort 保存。
close 已开始时显示“正在完成保存”并禁用停止，成功反馈只在 close 返回后。
不承诺能够回滚已经进入 close 的文件；close 失败仍报告失败并清理任务。
这项验收边界已由父代理确认。

服务关闭拒绝新任务，并取消活动任务。进程控制复用现有 Windows Job /
POSIX group helper，父进程提前退出也清理继承管道的子进程；drain 有界。
临时输出清理失败会明确返回 cleanupError，并保留槽位；下次 cancel/start/close
重试清理，不能把尚未清理的任务标为 disposed 或继续堆积输出。

## 验证

2026-10-11，以下测试覆盖初始候选代码及 bundle；原始输出与 `result.json`
位于本工作树 `.debug-runs/`，没有执行全量 Python / 全量 e2e。

| 验证 | 命令（均由 `python scripts/run_check.py --timeout … --` 包装） | 结果 / result.json |
| --- | --- | --- |
| Python、媒体、HTTP、绑定、页面、打包 | `python scripts/run_tests.py tests/test_gap_removed_media_jobs.py tests/test_gap_removed_binding.py tests/test_local_editor_server.py tests/test_packaging_contract.py tests/test_editor_assets.py` | 164 passed，52.77s；`20261011T072059Z-1d608b22/result.json` |
| 真实 Edge、生产 handler 与渲染页面 | `node node_modules/@playwright/test/cli.js test tests/e2e/gap-removed-media-jobs.spec.mjs tests/e2e/gap-removed-video-transfer.spec.mjs tests/e2e/gap-removed-video-binding.spec.mjs --project=chromium --workers=1` | 23 passed，20.42s；`20261011T072230Z-02364b3f/result.json` |
| bundle 构建 | `node scripts/build-editor.mjs --write` | exit 0；`20261011T072152Z-72276c6e/result.json` |
| bundle 新鲜度 | `node scripts/build-editor.mjs --check` | exit 0；`20261011T072241Z-8196da44/result.json` |
| JS 装配/语法 | `node --test tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs` | 2 passed；`20261011T072153Z-1b08568a/result.json` |
| typecheck | `node node_modules/typescript/bin/tsc -p tsconfig.typecheck.json` | exit 0；`20261011T072242Z-94bf0dba/result.json` |
| Python lint | `python -m ruff check maw/media_jobs.py server-editor/serve.py` | exit 0；`20261011T072240Z-bb9a50d3/result.json` |

真实媒体层：FFmpeg 连续运行停止后进程已退出、输出目录清除、原输入 hash
不变；MP4/MKV/TS 三流（双音轨）、非零起点的短 GOP 样本复制通过，保真检查
覆盖默认轨、语言、标题（容器可表示的字段）。长 GOP 极短 TS 区间可能缺少
视频参数，现有严格流校验拒绝导出；不放宽校验、不引入精确转码。

浏览器层：准备/重建/传输/write 停止、停止后重试、旧绑定隔离、磁盘写入及
close 失败、错误响应 body 取消均覆盖。完整真实链路额外执行：合成 MP4 →
真实 ServerEditor → 后台 FFmpeg → 附件 HTTP → 真实渲染页面，源文件字节
不变。保存 handle 为受控浏览器替身，未自动化 OS 原生文件选择器或真实磁盘满。
真实页面截图：`test-results/gap-removed-media-jobs-ren-91da8-hows-native-commit-boundary-chromium/real-editor-media-job-commit.png`；
已目视确认进度面板、提交阶段文案及停止禁用。

初始沙箱 Temp ACL / Edge 启动错误属于环境失败，保留原日志；测试 Temp 指向
本工作树 `.debug-runs`，浏览器用正常 Windows 权限复验通过。内联便携副本待
发布前统一重生成，未更新 `blank-editor.html`。

### 独立审查返修

Q/A 对初始候选实证发现四个 P2，均已最窄修复：

1. 取消 HTTP 的响应头或 JSON 正文挂起：整段 fetch/json/poll 共用 30s
   deadline 和 AbortController，超时明确提示“无法确认视频任务已停止”并
   释放前端 UI；不宣称后端已取消，服务器槽仍以真实生命周期为准。
2. 单行进程输出无字节界限：`readline(4096)` 分段，探测 stdout 最大 2MiB；
   超限明确失败，不静默截断 JSON 后解析。stderr 只保留末尾最多 64KiB，
   FFmpeg progress 实时消费而不累计保存。
3. ready 过期回调已排队与下载接纳竞态：专用 expiry 在同一锁下只处理仍
   为 ready 的任务，不能取消已接纳的下载；实际过期清理与排队竞态均测试。
4. 关闭时下载文件仍打开：begin_download 与 transport 取消回调注册在同一
   锁内；cancel/close 使用 socket.shutdown 中断阻塞网络写，handler 关闭
   文件后再 dispose。close 有界等待 dispose 完成，未完成则明确报错；不
   强删打开文件，不把关闭返回与随后 daemon 清理混为一谈。

Q 两份纯测试已按父授权接入：`469e53c`（headers/json-body deadline）和
`c084933`（真实 32MiB 下载关闭），修复 checkpoint 为 `4999fbc`。

| 最新返修验证 | 结果 / result.json |
| --- | --- |
| `python scripts/run_tests.py tests/test_gap_removed_media_jobs.py tests/test_media_job_shutdown.py tests/test_packaging_contract.py` | 49 passed，14.33s；`20261011T073159Z-4b1e621c/result.json` |
| `node node_modules/@playwright/test/cli.js test tests/e2e/gap-removed-media-jobs.spec.mjs tests/e2e/gap-removed-media-cancel-timeout.spec.mjs --project=chromium --workers=1` | 14 passed，15.70s；`20261011T073210Z-c0840e56/result.json` |
| ruff | exit 0；`20261011T073214Z-a560e602/result.json` |
| bundle freshness | exit 0；`20261011T073214Z-d93ce3e9/result.json` |
| typecheck | exit 0；`20261011T073216Z-2e12911a/result.json` |

最新真实页面 getBoundingClientRect 测量：状态文字→progress 为 **12px**，
progress→停止按钮为 **12px**；getComputedStyle 的 progress marginTop /
marginBottom 均 `12px`，面板 padding 为 `16px`。两个相邻边界均断言 ≥8px。
数值证据保存于同一真实页面截图目录的 `media-job-panel-spacing.json`；最新
截图已再次目视检查。OS 原生 picker / writable 的未验证边界保持上述说明。

## 拟 CHANGELOG

### Windows Preview CI 测试 setup 修正

PR #211 的 Windows Preview Python job 在干净 checkout 中报 21 个 setup
错误。已下载日志定位到 `TemporaryDirectory(dir=ROOT / ".debug-runs")`
父目录不存在（WinError 3）；这不是媒体重组或停止代码断言失败。日志证据：
父整合树 `.debug-runs/20261011T075910Z-d898c442/output.log` 第 349 行起。

本轮只改独有测试及本报告。控制器与 HTTP 夹具共用 helper，先
`mkdir(parents=True, exist_ok=True)` 创建测试临时根，再申请私有子目录。
shutdown 组合夹具自动复用同一修正。新增回归实际传入不存在的嵌套根目录，
分别执行控制器、HTTP 和 shutdown 的真实 setUp/清理，不依赖当前树已经
存在的 `.debug-runs`；没有弱化原测试、修改生产代码、CI 配置或 CHANGELOG。

| 本轮验证（run_check 包装） | 结果 / result.json |
| --- | --- |
| 两个缺失临时根 setup 回归 | 2 passed，4.20s；`20261011T080103Z-0d676f66/result.json` |
| `python scripts/run_tests.py tests/test_gap_removed_media_jobs.py tests/test_media_job_shutdown.py` | 25 passed，18.38s；`20261011T080107Z-b2b74474/result.json` |

基线 `448d232`，本地验证通过。未推送远端；Windows Preview 的新一轮 CI
仍待父代理发布修正后确认，不能将本地 25 项通过等同于远端 CI 已绿。

父代理最终包装核查补齐 OCR 源码清单中 `media_jobs` 的本地依赖
`gui_platform.py`；当前 OCR 入口不使用媒体任务，不视为实际 OCR 故障。
新增导入闭包契约，检查 local/OCR 两个复制目录均包含媒体任务及其本地
依赖，包装契约 27 项通过：`20261011T074155Z-b7410636/result.json`。

- 去空隙视频流复制导出增加后台阶段进度和主动停止，停止真实 FFmpeg 并清理
  私有输出；传输/写入失败、工程重绑和服务退出均处理任务清理与旧结果隔离。
- 保留视频容器、多流及轨道元信息验证；保存提交阶段明确禁用停止，避免对
  原生原子保存承诺不可实现的回滚。
