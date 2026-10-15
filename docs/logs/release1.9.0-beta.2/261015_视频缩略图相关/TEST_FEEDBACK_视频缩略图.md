# 视频缩略图（画面带，上游议题 229）相关反馈与处理记录

维护者在实测 1.9.0-beta.1 期间反馈的**视频缩略图 / 画面带**主题问题清单。
本账本按「一账本一主题」独立分账（维护者 2026-10-15 指示），与当时的通用批次
`../1.9.0-beta.1/261015_测试反馈/TEST_FEEDBACK_BETA1.md`（30 项，其他分支的问题）
分开维护；日志基线在 beta.2 发布后推进，故目录落在 `release1.9.0-beta.2/` 下。

- 基线：分支 `feat/video-thumb-realtime-toggle`，建账于 `a5baf2f4`，实施期间合并 main。
- 状态取值：`待处理`、`进行中`、`已修复`、`仅说明`、`阻塞`。
- 编号说明：条目 1-3 曾临时记入当时的通用账本（原条目 31-33），迁移后从 1 重新编号。
- 本主题当前实施分支即 `feat/video-thumb-realtime-toggle`，代码改动直接落在本分支。

## 问题清单

| # | 问题 | 状态 | 核实结论 / 方案 |
| --- | --- | --- | --- |
| 1 | 问：不显示「视频缩略图」时，性能是否完全不受影响、不会跑后台 ffmpeg？ | 仅说明 | 核对结论（2026-10-15，主会话读码）：编辑器侧**是**。开关关（`mawe-filmstrip-visible=false`）后客户端 `enabled=false`：`setView`/`poll`/`submit` 全部早退（`editor-thumbnails.js`），`setEnabled(false)` 立即 `release(false)` POST 释放租约并停掉轮询心跳；服务端 `_release` 移除租约后若活跃解码目标不再被任何租约需要，`active_cancel.set()` 取消在跑的 ffmpeg（`maw/thumbnail_jobs.py`，协调提取的 watcher 见 cancel 即停）。**边界**：Launcher「媒体缓存」阶段生成全片基础档 `.mothumbs` 是独立后台任务（`maw/thumbnail_jobs.py` `build_base`），不受编辑器显示开关控制——不显示缩略图只是不再触发「按需细化补帧」，不阻止 Launcher 自己的基础档生成 |
| 2 | 需求：加一个「实时生成补间」开关；关闭时只读取/显示已有 `.mothumbs` 缓存画面，不为当前视图实时解码 | 已修复 | 已实施（2026-10-15）：① `editor-thumbnails.js` 控制器 `decodeEnabled`（localStorage `mawe-filmstrip-decode`，默认开=保持现状），demand/播放控制请求携带 `decode` 布尔，切换后 view+1 重报租约；② `thumbnail_jobs.demand` 校验并存 per-lease `decode`，`_step` 仅把 decode 开启租约的目标加入解码批，`demand`/`_release` 的在跑批次取消判定同口径；③ decode 关闭租约 `pending` 恒假、不向协调器声明 visible（**不暂停 Launcher 基础档生成**），缺失格继续占位显示，基础档/其他窗口补完的新格随轮询自动出现；④ 模板新增 `#waveform-thumbnail-decode`（主开关关闭时禁用），状态文案「仅显示缓存画面，不实时补帧」。验证：JS 18 项（含开关/文案用例）、Python 定向 354 项、全量 2319 项、e2e filmstrip 2+2 项全过 |
| 3 | 视频缩略图生成特别慢：`examples/简单剪辑` 生成约 100 张用了约 5 分钟（日志 `[thumbnails] 16/137`、`32/137`、`48/157` 逐步推进） | 已修复 | **归因（2026-10-15 实测，`.artifacts/thumb-perf/`，只读测量）**：素材 = AV1 4K 24fps 5.2 分钟 → 157 目标/10 批。单批 18.0s，其中 `_frame_times` 用 ffprobe `-show_entries frame` **逐帧解码**拿 PTS 占 9.6s（53%），ffmpeg 抽帧解码 ~8.4s（`-threads 2`）。**修复 ①**：PTS 探测改 `-show_entries packet=pts_time,dts_time`（纯解封装不解码），实测同批 815 个 PTS 与逐帧解码**集合完全一致**，单次 9.6s→0.13s（74×）；**修复 ②**：`extract_frames` 增加 `threads` 参数（编辑器按需路径保持默认 2），`build_base` 后台构建用 `min(16, max(2, os.cpu_count()))`（AV1 4K 单批 9.3s→3.3s）。**端到端冷缓存复测：全片 157 帧 5 分钟 → 41.8s**（批均 ~4s，valid_count 157/157 与原 sidecar 一致）。对照验收目标：最难解码的 4K AV1 约 8s/分钟素材；常规 1080p H.264 解码快 3-8×，10 分钟 ≤1 分钟、60 分钟 ≤3 分钟可达。相关测试 64 项全过（test_thumbnails/_jobs/_cache/_media_cache/_server） |
| 4 | 若缩略图生成确实就是慢：Launcher「生成频谱数据」开关旁加「生成视频缩略图」开关，**默认关闭**，避免拖慢用户转写 | 已修复 | 已实施（2026-10-15）：主表单「其他」区新增 `#generateThumbnails`（默认不勾选，紧随 `generateSpectral`），formPayload/预设 BOOL_FIELDS（`asr_presets.py` + `launcher-presets.js`）与双语文案同步；gui_web 两处 payload 读取 `generateThumbnails` → 请求字段 `generate_thumbnails`（默认 True 保兼容）；转写子进程经 `_child_environment` 注入 `MAW_MEDIA_THUMBNAILS=0`（免于在 6 个 provider CLI 的长位置参数签名里穿线），`embed_media_caches(generate_thumbnails=False)` 跳过整个画面缓存阶段并打印「已按设置跳过画面缓存生成」。「生成波形工程」工具动作随表单默认同样跳过。CLI 直接调用行为不变（默认仍生成），后续如需 `--no-thumbnails` 再议 |
| 5 | 用户未勾「生成视频缩略图」时，工程打开后编辑器「视频缩略图」开关**默认关着**（不是隐藏；用户手动打开后走实时生成，随它） | 已修复 | 已实施（2026-10-15）：serve.py 绑定载荷新增 `thumbnailBaseReady`（对源媒体做一次 `load_base` 校验，含进程内 memo）；客户端 `createController` 初始 enabled = 显式偏好（localStorage `mawe-filmstrip-visible`）优先，无偏好时 `thumbnailBaseReady === false` → 默认关，其余默认开。手动打开即走按需补帧（配合条目 2 可只读缓存）。注意：控制器只在创建时读一次默认值，页面重载后才吃到新配置。e2e mock 已同步（`thumbnailBaseReady=true` + `setEnabled(true)`）。验证同条目 2 |

## 阶段汇总

- 2026-10-15：建账。条目 1-3 自当时通用账本迁入（原条目 31-33），条目 4-5 新录入。
  条目 2 实施进行中（代码已改、测试未补）；条目 3 归因测量待做；条目 4-5 待实施。
- 2026-10-15 续 1：**全部五条闭环**。条目 3 归因+优化+跨格式实测完成（AV1 4K 5.2min 41.8s /
  H.264 4K 10.6min 78.6s / H.264 720p 28.6min 64.9s / HEVC 4K60 44.8s 片 10.4s），
  途中发现并加固 probe 截断短读瞬态（重试一次 + 回归测试）。条目 2/4/5 实施完成：
  编辑器 decode 开关 + Launcher「生成视频缩略图」默认关 + `thumbnailBaseReady` 工程默认。
  验证分层：node `test_editor_thumbnails` 18 项、Python 定向 354 项、**全量 2319 项 OK**、
  e2e `filmstrip.spec.mjs` + `filmstrip-real.spec.mjs` 4 项（含设置面板间距实测断言）。
  bundle（editor/launcher）已重建，`check:editor`/`check:launcher`/typecheck 通过。
- 未验证边界（留人工实测）：① Launcher 界面新开关的实机渲染与预设保存/恢复；
  ② 未勾选开关跑一次完整转写，确认日志出现「已按设置跳过画面缓存生成」且编辑器
  画面带默认隐藏、手动打开可按需补帧；③ 真实高码率素材的生成速度体感（自动层
  已覆盖四个格式样本）；④ `MAW_MEDIA_THUMBNAILS` 环境变量在冻结包子进程链中的
  传递（本机为源码环境验证）。
