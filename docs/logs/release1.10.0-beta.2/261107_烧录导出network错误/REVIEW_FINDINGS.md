# 提交前自审发现：烧录导出 network 错误修复

- 日期：2026-11-07（独立审查子代理通读全部 diff，实现者不参与评审；2026-11-08 归档）
- 审查对象：工作树未提交改动 `maw/media_jobs.py`、`server-editor/serve.py`、
  `web/editor/io/editor-wiring-burn-video.js`、`web/shared/editor-i18n.js`（4 文件 28 行）。
- 审查者自行验证：`git diff --check`、4 文件 UTF-8/LF/无 BOM 字节级检查、
  `pnpm run check:editor`、test_media_job_shutdown + test_gap_removed_media_jobs 实跑（33 tests OK）、
  vm 加载 editor-i18n.js 验证新条目翻译、JS 语法/顺序测试。
- 结论：**可提交，无 blocker / major**。

## Findings 分诊

| # | 级别 | 发现 | 处置 |
|---|------|------|------|
| F1 | minor | Firefox（`NetworkError when attempting to fetch resource.`）与 Safari（`Load failed`）的 fetch 失败文案不会被 `burnVideoSafeError` 特判命中（editor-wiring-burn-video.js:45 锚定匹配），仍显示英文原文 | 接受风险：维持改动前行为，非回归；Chromium（Windows 主流环境）已覆盖。放宽锚定有误伤风险，不顺手改 |
| F2 | minor | 同根因的「去空隙导出」下载路径（同一 `send_video_attachment`、同一 10s 写超时）前端安全错误函数在 `editor-wiring-export-actions.js:474`，无 network error 特判，同场景仍显示裸文案 | 记录为后续条目：一致性缺口，不在本次声明范围（烧录路径），非阻塞 |
| F3 | nit | 服务端对「写超时断流」本身无 stdout 痕迹（serve.py:4140-4142 静默 `return False`；`finish_download(success=False)` 不设 error） | 接受：本次意图限定 ffmpeg stderr 诊断；记录备查 |
| F4 | nit | 三处新行为无自动化测试钉住（失败打印无 stdout 断言；`burnVideoSafeError` 特判与 console.error 无单测/e2e 断言；i18n 无翻译完整性守门测试） | 接受：诊断性改动依赖人工实测；可选后续为 `burnVideoSafeError` 补 vm 加载轻量单测 |
| F5 | nit | `job.error` 为空字符串的异常不打印诊断（truthy 判断）；本次 diff 未含 CHANGELOG 条目 | CHANGELOG 在出 PR / 收口时按整体结果汇总（用户可感知项：慢盘下载不再轻易断流、连接中断友好文案） |

## 接受的风险（不计 finding）

- `test_shutdown_waits_for_open_download_disposal` 改为按写超时路径收尾，单测 ~2s→~10s。
- close() 预算余量从 3s 变为 2s（12−10），重负载并行偏紧但成立；真实最坏等待 ≈10-12s，
  仅在 GUI 退出恰逢死连接下载时出现。
- 核心不变量「写超时 < close 预算」经实跑测试证实成立。

## 总体结论

可提交。建议随提交/收口带上的后续条目：F1 文案变体补齐、F2 去空隙路径映射一致性、F5 CHANGELOG 汇总。
