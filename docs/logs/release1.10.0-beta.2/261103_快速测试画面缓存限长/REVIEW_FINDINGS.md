# 快速测试画面缓存限长 — 提交前独立自审记录

- 分支：`fix/testrun-skip-thumbnails`（自审时 HEAD `ca4eb54a` + 本轮未提交改动）
- 审查方式：未参与实现的后台 subagent 通读全部 diff 并实际运行相关测试（thumbnails/cache 59 例、jobs+media_cache、gui_workflow 33 例、gui_web 请求子集 25 例），另用真实 ffmpeg 9.0.2 实测输入侧 `-t` 语义。
- 结论：1 major 已修复复验；3 nit 已修复/记录；4 项观察按设计接受。无未处置 blocker / major。

## Findings

| 编号 | 严重度 | 内容 | 处置 |
| --- | --- | --- | --- |
| F1 | major | `extract_keyframes` 限长解码命令 `-t begin+limit+0.5` 把 `begin_s` 计入读取时长：ffmpeg 输入侧 `-t` 从首包起算，`start_ms > 0` 的媒体（MPEG-TS 捕获等已知形态）按 `begin+limit` 超量解码，`begin ≥ duration−limit` 时退化为全片解码；`start_ms < 0` 时 `-t` 为负，ffmpeg 直接报错、关键帧档整体失败。审查者用真实 ffmpeg 实证（PTS 起点 60s 的媒体 `-t 65.5` 解出 65.5 秒内容）。 | ✅ 已修复：`-t = limit + 0.5`（内容时长），并新增 `start_ms=60000` 用例断言 `-t == "12.500"`（修前该数值为 72.5，测试不敏感的缺口一并补上）。 |
| F2 | nit | 总开关关闭时 `_keyframes_duration_limit_from_env()` 仍在早退前执行，日志先「只生成前 120 秒」再「已按设置跳过」，自相矛盾。 | ✅ 已修复：解析移到早退之后。 |
| F3 | nit | `_limit_variants_for` 大小写敏感比较，与 Windows/macOS 大小写不敏感文件系统及 `_source_key` 的 normcase 行为不一致；媒体改名换大小写后限长 sidecar 漏发现、多建一份。 | ✅ 已修复：比较改用 `casefold()`。 |
| F4 | nit | 限长 manifest 的 `coverage` 终点 `min(duration_ms, video_start_ms + limit)` 与建议式 `video_start_ms + min(duration, limit)` 在 `video_start + limit > duration` 时不同。 | ✅ 接受现实现：该分歧仅在「限长 manifest 完成（complete=True）」时才可能落到该分支，而 complete 要求网格全部命中，`video_start` 较大时扫描窗口内无视频包、complete 不成立——分歧不可达；且现实现把终点钳在 `duration_ms` 内，与全片 manifest 的覆盖包络一致，越界值反而更危险。 |

## 观察项（按设计接受）

- O1 编辑器按需补帧以限长为边界：快速测试后手动延长工程的场景，限长外格子停在 preview/空，直到一次全量转写重建全片缓存。已写入 LAUNCHER_GUIDE 与 CHANGELOG 为预期行为；若将来要更平滑，可在编辑器侧检测需求越过 limit 时提示重建。
- O2 命中循环取第一个满足候选而非按 rank 择优：生产路径 interval 由媒体时长唯一确定，同 limit 完整候选无差别。
- O3 `base_candidates` 新增目录枚举：本地 SSD 亚毫秒级，可接受；支持 NAS 媒体时再按目录 mtime 记忆化。
- O4 `point == decode_limit_ms` 的单个边界格不在网格也不在按需解码范围，永久 preview：与网格语义一致，不另立条目。

## 复验

修复后重跑：`uv run --no-sync python scripts/run_check.py --timeout 300 -- uv run --no-sync python scripts/run_tests.py tests/test_thumbnails.py tests/test_thumbnail_media_cache.py tests/test_thumbnail_cache.py tests/test_thumbnail_jobs.py tests/test_gui_workflow.py tests/test_gui_web.py` → 539 项通过（1 项既有跳过）。全量 Python 套件 2799 项通过（19 项既有跳过）；Node 套件 998 项通过。`git diff --check`、`check_personal_paths --diff-ref main` 干净。

## 2026-11-03 PR 复审与独立验收

复审基线为 PR 头 `6c7f5b08`，以下处理位于该提交后的工作树改动。原记录保留当时的结论；其中 F4、O1 和 O4 的判断由本节更新。

| 发现 | 判断与处理 |
| --- | --- |
| Greptile 两条限长补帧意见 | 默认关键帧构建不保存限长基础清单；同时基础清单按媒体共享，旧快速测试清单也无法代表新打开的完整工程。取消从共享基础清单推断补帧边界：快速测试只限制转写阶段的预生成，编辑器仍按可见区需求补帧。指南和更新日志已同步。 |
| 首次中断限长高精度构建后，单独存在的 `.mothumbs.partial` 不被候选枚举发现 | 已修复发现与去重；恢复读取和当前媒体的清理保护沿用原有逻辑。新增测试通过中断实际构建、清空内存清单并从磁盘读回已封装样本验证。 |
| 延迟视频流的限长覆盖终点计算错误 | F4 的原判断不成立。终点改为媒体时间轴的限长值，视频开始时间不在范围内时覆盖为空；部分清单的覆盖也裁到限长终点。测试覆盖延迟视频和限长范围内无视频的情况。 |
| 目录枚举成本 | 基础缓存查询会枚举限长变体，目录很大时可能增加交互开销。本轮未做大目录压测，暂列为非阻塞观察。 |

Sol 独立审阅完整 PR 和修复，使用真实 FFmpeg 检查非零起始时间、带 B 帧的视频：多种限长提取结果与全片提取的对应前缀一致；复核上述修复后未发现新的合并阻塞项。该验收不代表浏览器交互或长视频性能实测通过。

三项回归测试在修复前分别重现补帧、部分缓存发现或覆盖范围错误；修复后定向运行通过（`.artifacts/checks/20261103T084945Z-f4544779/result.json`）。
中断恢复测试随后去掉对进度文案和固定样本数的依赖，重新运行通过（`.artifacts/checks/20261103T085208Z-8a35f695/result.json`）。

复用锁文件一致的已有 Python 环境运行 PR 六个相关测试文件：541 项中 2 项因当前工作树缺少编辑器 bundle 报错、2 项跳过（`.artifacts/checks/20261103T084904Z-8e908e3f/result.json`）。安装锁定的 Node 依赖并构建 bundle 后，两项失败用例单独重跑通过（`.artifacts/checks/20261103T085121Z-d293d7b6/result.json`）；未再次运行整组。浏览器交互与长视频人工实测待完成。
