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
| 4 | 若缩略图生成确实就是慢：Launcher「生成频谱数据」开关旁加「生成视频缩略图」开关，**默认关闭**，避免拖慢用户转写 | 已修复 | **最终形态（2026-10-15，经条目 6 两档方案与维护者两轮拍板）**：主表单「其他」区新增 `#generateThumbnails`，更名「生成高精度画面预览图」（避开与关键帧底图撞名），**默认不勾选**（中途曾短暂默认开，维护者最终改回关闭）；开关仅门控精确网格阶段——关键帧地标档不受影响、总是生成（秒级）。旧载荷缺省字段按关闭处理；转写子进程经 `_child_environment` 注入 `MAW_MEDIA_THUMBNAILS=0`（免于在 6 个 provider CLI 的长位置参数签名里穿线）；「生成波形工程」工具动作随表单默认同样跳过精确档；CLI 直接调用经函数默认值仍含精确档，后续如需 `--no-thumbnails` 再议 |
| 5 | 用户未勾「生成视频缩略图」时，工程打开后编辑器「视频缩略图」开关**默认关着**（不是隐藏；用户手动打开后走实时生成，随它） | 已修复（已按后续指示更正） | **后续演进**：显示开关升级为三态（铺满画面带/关键帧标记/隐藏，存 `mawe-filmstrip-mode`）；默认值 = 显式偏好优先，无偏好时无缓存（`has_cached_frames`）→ 隐藏，有缓存 → **关键帧标记**（维护者指定的默认显示方案）。用户手动选择铺满后走按需补帧 |
| 6 | 问：有没有更优化的方法？我们只需要其中特定的一些画面——找开源项目案例看看怎么做 | 已修复 | **调研**（2026-10-15）：Jellyfin Trickplay（issue 11336，`-skip_frame nokey` 约 110× 提速、可选开关）与 LosslessCut 时间轴缩略图（生产命令同款）均为「关键帧only + 精度换速度」路线；本机实测关键帧单遍：AV1 4K 5.2min 全片 1.25s（精确档 41.8s 的 1/33）、H.264 4K 10.6min 5.2s（1/15）。**实施（维护者逐点拍板后）**：① 两级生成——关键帧地标档总是生成（每关键帧一格、按自身 PTS 存 SQLite preview 行 + 独立 `keyframes` 位置表，精化永不移除地标；超 4000 格均匀抽稀），高精度档由「生成高精度画面预览图」开关控制（默认关，仅门控精确批处理；维护者最终拍板）；② 编辑器显示三态（铺满画面带/关键帧标记/隐藏，默认关键帧标记，无任何缓存时回退隐藏），标记模式直接绘制地标、恒不参与实时解码，铺满模式保留实时补间开关；③ 响应携带 `keyframes` 标记数组，`sample_manifest` 对网格请求做「≤ 目标时间的最近地标」持有回退。验证：Python 定向 75 项 + 全量 2324 项、node 20 项、e2e 4 项、bundles/typecheck/docs/个人路径检查全过 |

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
- 2026-10-15 续 2：条目 6 开源调研入账（Jellyfin/LosslessCut 的 keyframe-only 路线 +
  本机两格式实测 15-33×），两阶段方案草案就绪，**等维护者拍板底图精度契约**后再实施。
- 2026-10-15 续 3：**条目 6 实施完成（维护者逐点拍板：关键帧密度、三态显示、
  Thumbnail 默认、高精度档默认关、粗底无开关）**。落地形态：关键帧地标档按自身
  PTS 入 SQLite preview 行 + 独立位置表（精化不移除地标，4000 格抽稀上限）；
  `sample_manifest` 持有回退 + `keyframes` 标记数组；编辑器三态选择器 +
  标记模式绘制（缓存优先、无地标回退网格去重）；Launcher 开关更名
  「生成高精度画面预览图」默认开（仅门控精确档）。密度认知修正：地标密度=
  关键帧密度，与片长档位解耦（维护者指出的 10s 网格残留约束已消除）。
  验证：Python 定向 75 项 + 全量 2324 项、node 20 项、e2e 4 项、全部构建与
  规范检查通过。
- 2026-10-16 续 4：**PR #242 评审（Request changes）6 条行内意见全部属实并修复**：
  ① 旧识别预设因 BOOL_FIELDS 新字段被整体拒绝加载 → `validate_options` 补
  `generateThumbnails` 缺省 False（沿用 qwenAudioKeepDialect 迁移模式）+ 旧文件回归测试；
  ② marks 模式标记图片不进 preload/保护/重绘链路 → preload 候选并入 keyframesData、
  加载完成 repaint 匹配范围扩展；③ 标记资源缺元数据声明（响应 5 标记仅 2 assets）→
  标记资产并入 assets 字典（前端可下载 + `_snapshot` pin 覆盖防回收）；
  ④ 持有回退窗口下界排除远前置地标（视口越过末关键帧返回空）→ 拆分「跨度内标记」
  与「≤ 首目标的最近前帧」两段查询；⑤ 4000 格上限在生成后才执行 → 抽稀移到规划期
  （封包扫描后、解码前 select 抽稀），探测分块共享整体 deadline；⑥ 关键帧阶段绕过
  播放优先调度 → `build_base` 注入暂停感知的 keyframe_extract（watcher + before_batch
  等待 + 暂停中断后重试），播放/可见需求期间关键帧 ffmpeg 让位。
  另：评审复现的「双扫描不一致」（负载下 ffprobe 排空静默丢包，合法 JSON 内缺包）
  → 关键帧扫描每分块两遍取并集；Ruff 未用 bisect 导入移除。send2trash 已在
  pyproject 声明（工程自动备份设置时加入），评审者/维护者环境属未 uv sync 的正常情况。
  验证：Python 定向 93 项 + 全量 2327 项、node 21 项、e2e 4 项、ruff 全绿。
