# 视频画面轨道与缓存（#229）

正式实现依据 [Moyf 的详细计划](https://github.com/Moyf/moys-asr-workflow/issues/229#issuecomment-6138129094)。画面带放在每行波形/字幕区域上方，初始 48px；用户已确认该位置，owner 最新正文也已统一为上方。以下描述当前 Server 实现；文末保留阶段 0 的独立实验历史，不能将旧原型指标当作生产算法数据。

## 入口与数据边界

- Launcher 的媒体缓存阶段从 `source_media_path` 原视频生成两级画面缓存：**关键帧地标档**总是生成（`-skip_frame nokey` 单遍，只解码关键帧，每关键帧一格、按自身 PTS 存 SQLite preview 行——密度即关键帧密度，超 4000 格均匀抽稀），网格请求由 `sample_manifest` 做「≤ 目标时间的最近地标」持有回退；**高精度画面预览图**由开关控制（默认开，转写子进程经 `MAW_MEDIA_THUMBNAILS=0` 传递，provider CLI 无需逐一透传），走原精确批处理把显示网格升级为精确格。纯音频与 attached_pic 封面不生成。错误采用 best-effort，字幕和工程保存仍可继续。
- Server 只登记当前工程授权的原媒体。状态首次请求仅探测媒体；缺少基础文件时，只处理当前视图，不在打开或空闲时扫描全片。客户端不传文件路径。
- 画面带采用源时间零点网格250/500/1000/2000/5000/10000ms，按CSS显示宽度/时间比例选择密度，带迟滞与200ms防抖。代表画面、可见目标、前后各15%有限预取依次处理，多行去重。
- `.mosp` 的 `segments` 仍为字幕真源。图片、sprite及补帧索引均在工程外；音轨、字幕和空隙修改不改变同一原视频的画面身份。便携空壳与浏览器未绑定File自动隐藏，不尝试读取相邻sidecar。

## 模块与契约

| 模块 | 职责 |
| --- | --- |
| `maw/thumbnails.py` | 排除封面的视频探测、短区间批量解码、真实源PTS、SAR/旋转、160×90 JPEG、取消回收 |
| `maw/thumbnail_cache.py` | 基础`.mothumbs`、独立补帧、身份、原子发布、配额、保护与会话降级 |
| `maw/thumbnail_jobs.py` | 单Server worker、视图差集、租约、跨进程flight去重、播放暂停与Launcher恢复、cache-only租约 |
| `maw/media_cache.py` | 原视频全片编排与best-effort结果，不向工程合并图片 |
| `server-editor/serve.py` | 绑定、配置注入、受限状态/需求/登记资产接口、`thumbnailBaseReady`下发 |
| `web/editor/media/editor-thumbnails.js` | 自动密度、传输、版本隔离、图片LRU与资源释放、decode偏好 |
| `web/editor/media/waveform/thumbnails.js` | 上方画面带、局部绘制、总stride、点击/拖动与原seek接线、双开关 |

缓存schema为`moy.asr.thumbnails.v1`，生成器版本3。身份含原媒体位置的摘要、name/size/modified_ms/modified_ns、视频流、图片规格与生成器版本。旧生成器版本按miss重建。`time_origin`为`source-format-start-ms`，以源容器起点归一化，保留视频晚于音频开始的偏移；前置无画面网格以unavailable明确记录，不显示未来帧。这些合法空格可计入目标档位完成，但不计valid_count。FrameResult区分`requested_ms`、归一化`actual_pts_ms`、`target/preview/unavailable`与JPEG字节，不通过名义FPS推算PTS。

基础文件为`<完整媒体名>.mothumbs`，ZIP_STORED封装manifest和最多64帧一块的sprite，尾块记录真实有效格数。manifest含`cache_revision/source_signature/video_stream_index/duration_ms/time_origin/image_spec/coverage/sampling_interval/target_interval/base_complete/valid_count/samples/assets`；样本含asset与crop_rect。`base_complete`仅证明`target_interval`所要求网格已完成，10秒粗档不会被当作5秒/2秒档命中。升级时复用已有兼容时间点。

媒体旁、`_maw`和每视频输出目录沿用waveform候选位置。只读目录退到应用`thumbnail-cache`，持久写入失败退到本次会话；同一身份停止重复写入警告。基础文件临时写入/原子替换，OS写锁与Windows有限重试保护旧有效版本；部分文件独立发布，完成的短批次补帧立即可复用。新补帧不重写基础文件。

同源任务的SQLite登记独立于字幕/ASR。播放租约8秒、flight续期30秒、最多512条flight、每Server最多8个页面/512目标、单解码worker、每目标最多2次失败尝试。Source批次最多16目标/30秒跨度，Server优先批次使用8秒邻近范围；不为凑64格等待首屏。Launcher全片期限20分钟，播放/可见需求优先于它的下一批；暂停或失联释放租约后恢复原任务。

POST需求与释放校验随机requestToken及loopback Host/Origin，JSON≤64KiB；GET索引与JPEG只接受绑定和已登记opaque asset，版本过期409，HEAD不写正文。响应同时区分binding、source_identity与view；旧view不能撤回新playing状态，旧源结果只可进入它自己的缓存命名空间。`decoding`表示实际调用仍在运行，可与`paused`共同确认解码已经退出。

## 资源与显示

统一decoded-image LRU预算48MiB，sprite和独立帧一起计量；Bitmap/Blob URL按淘汰释放。当前视图读图、请求、失败重试与图片admission有界。三次连续网络失败停止本轮传输并释放租约，保留已解码图片，实际新视图/在线恢复允许重新尝试。隐藏撤销需求、保留本页可复用图片；换源/关闭释放资源。

Launcher媒体缓存阶段最多清理8个30天前未使用的登记基础文件，保护当前源候选、其他视图pins和在途预留；仅将经验证的旧sidecar移至回收站，不扫描未登记媒体目录。补帧与登记基础文件合计预算64MiB/媒体、512MiB全局，SQLite额外限制索引和物理页增长。保护按页面owner隔离并续租，释放一个窗口不放开其他窗口正在使用的图片。配额不足优先淘汰非活动补帧，停止预取；写入失败不无限重抽。基础封装流式staging，最多持有64张源JPEG，sprite逐块入ZIP，取消不再启动额外封装。

总行高由原波形高度加独立画面带统一计算，虚拟化、reveal、播放跟随、跨行Y命中与尾行宽度共用stride。图片就绪只重绘相交画面行，播放帧只更新播放头。画面带事件复用既有暂停、拖动预览与帧吸附，阻止误触字幕创建或空隙修改。

## 实时补间开关与工程默认（2026-10-15）

- 编辑器波形设置在「视频画面」下新增「实时生成补间」开关（localStorage `mawe-filmstrip-decode`，默认开）：demand 请求携带 `decode` 布尔，服务端为 per-lease 标志。decode 关闭的租约仍读取缓存显示（`lookup_frames`/`sample_manifest` 照旧），但 `_step` 只把 decode 开启租约的目标加入解码批处理；其 `pending` 恒为假，不向协调器声明 visible 需求，**不暂停 Launcher 基础档生成**。demand 里把 decode 置假也会让活跃解码批次的取消判定按 decode 租约集合计算（`demand`/`_release` 同口径）。
- 绑定载荷新增 `thumbnailBaseReady`（`has_cached_frames`：基础 manifest 或 SQLite 关键帧/精确格任一存在即真）：客户端无显式模式偏好时，无缓存 → 默认隐藏，否则默认关键帧标记模式。显式偏好始终优先。

## 实时补间开关与显示模式（2026-10-15 第二批）

- 显示模式三态（对齐达芬奇）：**铺满画面带**（原 Film Strip）/ **关键帧标记**（Thumbnail，默认——每个关键帧位置一帧画面，其余留白）/ **隐藏**。模式存 `mawe-filmstrip-mode`；默认值 = 用户显式偏好 > 无任何画面缓存时 hidden > marks。标记模式跳过实时解码（demand 恒 `decode:false`），直接绘制响应携带的 `keyframes` 标记（真实关键帧密度）；铺满模式按显示网格取「≤ 格时间的最近样本」持有渲染，缺失格由实时解码补精确。
- 关键帧地标档实测（keyframe-only 单遍）：AV1 4K 5.2min 全片 1.25s（精确档 41.8s 的 1/33）；H.264 4K 10.6min 5.2s（78.6s 的 1/15）。地标密度 = 关键帧密度（2h 流媒体素材可达固定 10s 档的 2.5-5 倍），超 4000 格均匀抽稀；关键帧 JPEG 按内容寻址存储。

## 生成速度（2026-10-15 归因与修复）

此前每批先用 ffprobe `-show_entries frame` **逐帧解码**读取 PTS，再由 ffmpeg 解码同一跨度抽帧，双端 `-threads 2`：4K AV1 素材单批 ~18s（其中探测占 9.6s），5.2 分钟片全片 ~5 分钟。现改为：PTS 探测读 `-show_entries packet=pts_time,dts_time`（纯解封装不解码，实测与逐帧解码的 PTS 集合完全一致，单批 9.6s→0.13s）；`extract_frames` 增加 `threads` 参数（编辑器按需路径保持默认 2），`build_base` 用 `min(16, cpu_count)`。实测冷缓存全片（Ryzen 7 6800H / FFmpeg 8.1.1）：AV1 4K 5.2min 157格 41.8s；H.264 4K 10.6min 127格 78.6s；H.264 720p 28.6min 344格 64.9s；HEVC 4K60 0.75min 23格 10.4s；结果 valid_count 与旧 sidecar 一致。另加固：`probe_video` 对一次观测到的截断 JSON 短读重试一次（回归测试覆盖）。

## 生产算法测量与验证边界

2026-10-13，Windows 11 / Ryzen 7 6800H / FFmpeg8.1.1。资源测量为生成器版本2、源起点为零的生产模块；版本3补齐混合流起点和清理，未重新运行长片profile。使用合成夹具，冷表示新身份/缓存目录；OS文件缓存及其它工作负载未隔离。带10ms进程采样的测量与无采样测量分开。

| 素材/操作 | 实际结果 |
| --- | --- |
| 30s H.264，2s基础档 | 15有效样本；带监测冷1.056s，热0.0094s/0工具进程 |
| 4K3840×2160/15fps/5s，首批4目标 | 冷1.743s，热0.0125s；带监测父+子峰值137.82MiB |
| 4K短片，2s基础档 | 3有效样本；带监测冷1.738s |
| 2h320×180/2fps，10s基础档 | 720样本；带监测冷82.704s，热0.0171s/0工具进程 |
| 2h同规格，无高频监测的新冷缓存 | 冷79.783s，热0.0211s，720有效样本 |
| 2h缓存体积 | sidecar2,106,465B，frames.sqlite3约3,264,512B |
| 2h带监测资源 | 父Python峰43.27MiB、子进程峰28.48MiB、同时合计峰68.69MiB；累计子CPU36.61s |
| 4K源FFmpeg取消 | 信号至返回32.8ms，ThumbnailCancelled，全部子进程回收 |
| 正在运行的64帧sprite取消 | 信号至返回52.3ms，ThumbnailCancelled，全部子进程回收 |

HEVC、ProRes、旋转、VFR及双视频流容器的默认真实视频流冷/热抽帧均取得有效JPEG；抽帧能力不证明浏览器能播放所有原codec。温缓存记录的RSS=0表示短请求未被采样捕获，不是零内存。48MiB图片预算不包括视频解码器、Canvas、GPU或整个浏览器进程。

首次交付完成相关JS412项、真实/mocked浏览器4项及Python定向112项（111通过、1项Windows软链接权限跳过）。本机早期全量360秒限时未完成的记录保留；随后GitHub提交d903ca15的Windows全量2254项通过（80项工具/环境相关跳过），预览包构建和可执行文件检查通过。对照owner计划复核后，相关JS六文件410项通过，真实/mocked浏览器4项再次通过，构建、新鲜度、类型、Ruff与文档检查通过；新增缓存/Server/跨进程回归和当前提交的CI证据分别记录在PR与本地审查账本，不能将单一验证层冒充所有平台或人工验收。

原始JSON和截图留在忽略的`.artifacts/filmstrip`；不提交媒体、截图、sidecar或个人路径。Python覆盖PTS/末帧/缓存/取消/损坏/只读/粗档升级/原视频编排；Server覆盖受限HTTP、可见区warm不解码、绑定/版本/视图；跨进程测试使用真实FFmpeg验证播放停止<1秒、原Launcher等待/恢复及同目标去重。实际浏览器用真实Server/FFmpeg视频，另有mock transport测试覆盖几何与失败恢复；两层分开记录。音频0秒/视频2秒的混合起点素材也与实际浏览器画面比对：currentTime2.5s的缓存实际PTS2.5s，缩放JPEG与原播放器平均RGB差8.37，另一个4.5s帧差26.20；0/1秒明确无画面。

真实高码率两小时高清素材、弱机器、网络磁盘、Firefox/Safari、macOS/Linux和安装包未由本机合成矩阵覆盖。人工核查重点为镜头导航质量、原字幕/字词/marker操作、去空隙试听/派生绑定与长时播放；这些边界在PR和核查页保留，不用自动化替维护者勾选。内联副本待发布前统一重生成。


## 对照 owner 计划的恢复与调度复核

正常 Server 入口缺少波形缓存时会先自动抽取，已有 ReaPeaks 波形也可作为时间轴载荷兜底。若明确跳过波形且没有载荷，或所有波形均不可用（包括无音轨视频），当前整个时间轴没有可见行，画面带也不显示。缩略图任务状态仍独立；本期没有新增独立的无波形/无音轨视频时间轴，不能将这一现有几何前提误写成单纯缺少基础图片缓存。


完整粗档和细档部分文件可以同时存在。查询融合源签名、视频流、图片规格、生成器版本及源时间语义一致的候选，复用各自原始 sprite 裁切；完整状态和目标档位仍取最佳原 manifest，不将细档部分覆盖提升为完整细档。运行态合成版本由参与文件的版本稳定计算，不写回 sidecar；资产请求校验当前合成版本，源替换或布局变化后拒绝过期查询。

部分文件发布在同路径锁内保护最后有效覆盖：新结果没有包含旧目标集合时保留原文件，不用立即取消产生的空文件覆盖已封装结果。继续生成并增加覆盖后可正常发布。保留原文件时返回实际持久化的 manifest，不返回即将删除的 staging 资产。原子替换仅对同身份、同路径文件的增长预留配额，旧登记保持至替换成功；不同路径并发写入不能重复使用替换额度，临时封装预算保持独立上限。

前端提交原始可见区间，后端仅扩张一次前后 15% 的低优先级预取；图片读取使用同一有界范围。代表样本在合并区间前按原可见行选择，先覆盖每行中心，再补起点，去重且保持 32 点上限。暂停时移动播放头只更新同一视图的任务优先级，约 200ms 合并请求；播放过程中只更新本地位置，控制请求与正常心跳携带源时间，不逐帧发送需求。

图片容量拒绝仅抑制当前需求，切换到较小视图后可重新加载；网络失败、损坏图片和单资产超预算仍有界抑制。浏览器 File 或工程解绑先清 Server 配置再同步刷新状态，画面、开关和未绑定提示保持一致。Launcher 正常入口将逐批进度送入现有日志，并在同源播放或可见需求优先时报告一次暂停和恢复；显式进度回调仍可替换默认输出。

复核回归覆盖完整粗档与细档 partial 跨会话复用、取消再次恢复、保留文件时资产可读、单媒体/全局替换预算及并发预留、大视图缩小后的图片恢复、单次预取、多行代表、暂停 seek 合并和播放不逐帧请求。Server 真实合成夹具的完成等待使用有界 30 秒并在失败时报告实际状态；这只调整测试完成等待，实际播放停止小于 1 秒的要求及生产解码期限保持原标准。合成生产资源数据沿用前文版本与机器条件，本次恢复/调度复核没有重新测量长片 profile，也不替代真实高码率素材与多平台人工验收。

---

# 阶段 0：原型与方案比较（历史）

本页保留阶段 0 的原型与合成测量历史。后续依据 [owner 的详细实现计划](https://github.com/Moyf/moys-asr-workflow/issues/229#issuecomment-6138129094) 开始正式接线；当前分支包含未完成的开发检查点，上方画面带位置已确定。以下原型数据和旧决策状态不代表正式一期已验收。

2026-10-13；基线 `a34d502a33cfe9fcff0288c13b04f6bba3ca48fa`。
范围：[Issue #229](https://github.com/Moyf/moys-asr-workflow/issues/229) 的发散原型与证据；owner 尚未决定正式方案。本页不改变正式编辑器、MOSP schema、缓存真源或产品默认值。没有产品 CHANGELOG 条目。

## 运行原型

安装本分支锁定的 Node 开发依赖，Python 原型只用标准库与既有 MAW 模块。需要 FFmpeg/FFprobe，缺失时本地 Server 原型无法探测注册媒体；浏览器抽帧原语不依赖它们，但本页的独立离线重开仍需人工核验。

```powershell
pnpm install --frozen-lockfile
python tools/filmstrip-lab/benchmark.py --fixtures
node tools/filmstrip-lab/build.mjs
python tools/filmstrip-lab/serve.py --media .artifacts/filmstrip/media/short.mp4 .artifacts/filmstrip/media/long.mp4 .artifacts/filmstrip/media/vfr.mp4 .artifacts/filmstrip/media/rotated.mp4 .artifacts/filmstrip/media/prores.mov .artifacts/filmstrip/media/hevc.mp4 .artifacts/filmstrip/media/multistream.mp4 .artifacts/filmstrip/media/audio.wav
```

打开 `http://127.0.0.1:8769`。前台运行服务，Ctrl+C 停止；默认无访问 15 分钟自动退出。素材仅为 testsrc2 和合成音频，全部在忽略目录，不提交。用户选择“本地媒体”时走独立浏览器 video/Object URL，不向第三方上传；本页不提供 Server 任意路径注册接口。

[后端与缓存](../../tools/filmstrip-lab/backend.py)、[窄范围 Server](../../tools/filmstrip-lab/serve.py)、[合成与测量](../../tools/filmstrip-lab/benchmark.py)、[前端原型](../../web/experiments/filmstrip/lab.mjs)、[可复用原语](../../web/experiments/filmstrip/core.mjs)。

## 实际实现与边界

| 路线 | 可运行实现 | 成本与边界 |
| --- | --- | --- |
| A 整片固定 | 默认 100 帧，fps/scale/pad/tile，整张 JPEG 原子发布 | 第一批显示等于整张完成；限帧数限制输出体积，仍解码完整素材 |
| A 自适应 | 每 15 秒一帧，上限由预算参数限定（默认 100，最大 240） | 30 秒仅 2 帧，容易缺少镜头信息；长片到预算上限后与固定方案产生同一密度 |
| A 窗口 | 最多 32 帧；源跨度 ≤120 秒顺序解码，宽窗口使用输入侧稀疏 seek 后拼图 | 不把低缩放的大窗口偷偷截成开头 120 秒；多次 FFmpeg 启动有显著开销 |
| B 可视区 | 一个独立 video，seeked 后复制当前帧；每行最多 32 个目标 | 不整片枚举；浏览器 codec、随机 seek、后台调度决定性能；本试验不声称帧精确 |
| C 分级小试 | 粗 sprite 先画，随后 B 逐格替换 | 有缓存时首批很快，冷缓存先支付 A 成本；目前每个缩放都细化，正式版需定义阈值 |

复用 `maw.ffmpeg.resolve_ffmpeg_tools`、`maw.waveform.media_signature/extract_waveform`、现有波形 scale 工厂及 `gap-remove-core` 的保留区间/源时钟映射。`maw.media_cache` 和正式 `server-editor/serve.py` 仅作接口分析，未增加公开 API 或产品工厂注册。原型的 cues 是演示数据；多行是独立可视窗，不冒充完整编辑器的接线或事务。

Server 只绑定 127.0.0.1。媒体由 CLI 精确注册；路由只接受媒体 ID、选择流和采样参数，不接受客户端文件路径。变更 API 检查 Host、Origin 和随机 token；媒体支持单 Range，sprite 只提供本进程已注册结果。一个生成 worker，过期队列取消；显式取消会 kill/wait FFmpeg。每次最多 240 帧、8 MiB sprite、90 秒；总实验缓存预算 128 MiB，达到预算拒绝新抽取，保留诊断 staging，需选择新缓存目录或人工清理。不是正式的磁盘 LRU 管理器。

缓存身份包含媒体签名、纳秒 mtime、路径哈希、视频流、采样参数、版本和 FFmpeg 文件 mtime；JPEG SHA-256 校验避免复用损坏结果。完整目录 rename 原子发布图片+manifest；切换后不接受旧代次 UI 结果。正式多进程共享 sidecar 还需要跨进程锁、全局淘汰与更严格的输入解码资源控制。

B 的 LRU 限 96 帧/12 MiB RGBA，淘汰关闭 ImageBitmap；粗图最多保留 4 份，窗口图切换/移除时释放。指标中 RGBA 是估算，不包括 video 解码器、GPU 或整个浏览器进程内存。它不能拿来声称总内存低于 12 MiB。

`fps` 按输出帧率丢弃或复制帧，不是关键帧选择器；见 [FFmpeg fps 文档](https://ffmpeg.org/ffmpeg-filters.html#fps)。显示“≈”的采样时间是导航标签，不是实际解码帧 PTS；正式精度研究可用 FFmpeg 的输入/输出 PTS 映射记录。旋转夹具使用 input `-display_rotation`，ffprobe 已确认 90° display matrix；见 [FFmpeg 视频选项](https://ffmpeg.org/ffmpeg.html#Video-Options)。仅设置旧 rotate metadata 在本机 FFmpeg 8.1.1 没写入有效旋转，原无旋转样本的记录已替换。

## 测量矩阵

机器：Windows 11 build 26300，AMD Ryzen 7 6800H，8 核/16 线程；Python 3.13.15、FFmpeg 8.1.1 Gyan full build。单次实测，OS 文件缓存、其它工作负载未隔离，时延波动明显；不能把 2.44 秒和 3.46 秒的差值解释为算法速度优势。

短素材：30s，640×360，24fps H.264，GOP 10s，合成音频。
长素材：7200s，320×180，2fps H.264，GOP 10s，无音频。它证明时长与采样/缓存行为，不代表真实 1080p/4K 长片吞吐。

### A 后端：最终 v2 算法记录

首次批次就是完整 sprite。warm 列是再次读取同一缓存，不含浏览器 HTTP/绘制。CPU 为 FFmpeg 子进程累计 CPU 秒，内存为子进程峰值 working set；稀疏窗口多进程取峰值最大值，不包含 Python/浏览器。

| 素材 / 路线 | 帧数 | 首批=完整(s) | 缓存读取(s) | JPEG(KiB) | CPU(s) | FFmpeg 峰值(MiB) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 30s 固定 | 100 | 1.094 | 0.113 | 236.9 | 0.469 | 33.7 |
| 30s 自适应 | 2 | 1.335 | 0.117 | 5.4 | 0.375 | 29.6 |
| 30s 窗口 | 8 | 2.060 | 0.090 | 19.1 | 0.359 | 30.3 |
| 2h 固定 | 100 | 3.458 | 0.076 | 278.0 | 3.641 | 33.9 |
| 2h 自适应封顶 | 100 | 2.435 | 0.073 | 278.0 | 3.859 | 34.3 |
| 2h，源3000–4800s 稀疏窗口 | 8 | 8.926 | 0.082 | 23.2 | 0.906 | 27.2 |

首轮 v1 的 30 秒长片窗口曾测得 0.576s，但没有覆盖低缩放下的宽可视区；最终宽窗口使用稀疏 seek。将两者写成同一算法或同一窗口会误导。v2 稀疏抽取降低解码 CPU 和图片字节，却在本样本中被进程启动/调度成本拖慢；不能据此替所有高清长视频选择整片扫描。

JSON 位于本机 `.artifacts/filmstrip/backend-results.json`。重跑时同键 cold 记录复用此前真实生成证据，`measurementReused` 标记复用；新键重新测量，不能把命中时间当作冷抽取。日志输出同时注明是否命中/复用。

### 浏览器实际采样

IAB 前台页面，默认每窗 6 格（后期视口变化为 5 格）。B 的“完成”只指可见格，不是完整影片；C 的缓存状态单独列出。后台抽帧期间主播放器时钟变化=0，seeking=0。

| 素材 / 路线 | 首批(ms) | 当前窗口完成(ms) | 可见帧 / 缓存状态 |
| --- | ---: | ---: | --- |
| 30s A 固定 | 1151 | 1152 | 100 帧 sprite；Server 未命中 |
| 30s B | 70 | 525 | 6 帧，内存缓存清空；OS/媒体解码缓存未隔离 |
| 30s C | 6 | 444 | 粗 sprite 已在内存；6 帧细化 |
| 2h B | 24 | 110 | 6 帧，独立解码器，内存缓存清空 |
| 2h C | 2500 | 2601 | 粗 sprite 冷缓存，6 帧细化 |
| 2h A 宽可视窗口 | 3798 | 3799 | 6 帧，约 2035 秒可视区；不同于上表 8 帧/1800 秒 |
| ProRes B | 无 | 拒绝 | 当前浏览器不能解码 |
| ProRes A 窗口 | 464 | 464 | 6 格可正常显示 |
| HEVC B | 107 | 421 | 当前浏览器可解码这一合成样本 |

B 长片更快与低分辨率/低帧率/GOP/OS 缓存有关；不能推广到所有 2h 片源。C 有粗图命中的 6ms 不能与 A 冷抽取做公平速度排行。真实高码率、长 GOP、网络磁盘、弱机器仍需 owner 素材验证。

### 兼容、交互与布局

- H.264、HEVC、ProRes、VFR、90° 旋转和双视频流：FFmpeg 均成功；两个流分别产生不同图像和缓存键。VFR 实际 PTS 间隔 0.125/0.20833/0.29167 秒，不只是文件名叫 VFR。
- 浏览器：H.264、该 HEVC、VFR、旋转样本成功；旋转 videoWidth/videoHeight=180/320；ProRes 明确拒绝。B 不提供跨浏览器视频流选择 API，选择非默认流会拒绝，A 可用于替代流；主播放器仍保持浏览器默认流，本原型不负责多流播放转换。
- 水平滚动、高缩放、快速媒体切换、去除示例空隙、多行、折叠和纯音频在对比页验收。定位共享源时间转换；短片撑满视口中心点击实际约15s。真正 MOSP 切换/撤销/波形多行指针路由还没有接入，不能视作正式编辑器回归。
- 位置三档：波形上方、波形与 cues 之间、独立底部 lane；48/72/96px 高度和 96/144/192px 格宽。布局间距实测：controls/player 12px、timeline 8px、main/workspace 20px。截图在本机 `.artifacts/filmstrip/`。
- 页面只按可见宽度绘制，不创建全片宽 canvas；横向 spacer 是 CSS 宽度，不是全片位图。视窗每行最多32格，密度和行数增加的是可见工作量。

## sidecar 与便携 payload

Server 使用本地可重建目录，原型目录名不是拟定的正式 `.mothumbs` 契约。不写 MOSP。sidecar 易复用、工程小，但媒体迁移时需重建/带走缓存，权限应沿用当前工程授权媒体。

“导出便携试验页”实际生成约426547字节（416.6KiB）：sprite 242538字节、base64 膨胀、内联脚本/CSS/小型波形。没有媒体字节，也不嵌入个人绝对路径。100帧图片通常比2帧图更适合导航，内嵌预算需要明确按字节和尺度限制。

已静态验证3段内嵌脚本、无外链 JS/CSS、JPEG SHA-256 一致、脚本语法有效。浏览器工具禁止 file://，离线双击重开/重新选媒体未验证；不能用 localhost 结果冒充离线验收。本机 `.artifacts/filmstrip/filmstrip-portable.html` 留给人工确认。

portable 媒体重绑只有 name/size/modified_ms 一致才复用默认流粗图；不同文件清缓存。这个签名沿用现有媒体缓存思路，不是密码学的媒体内容证明。替代流便携复用、媒体仅更改中间内容但元数据相同等情况，正式开发需定义更强失效策略。

## 建议与待 owner 决定点

建议保留共同的可见区调度/源时间映射/小 LRU 接口，把 Server A 和便携 B 作为独立 provider。Server 可优先试现有缓存粗图或限额窗口，后台生成全片粗图是另一个可取消工作；便携页在浏览器能解码时使用 B。这是实验建议，尚未确定产品默认路线。

保留 C 为高缩放细化备选：应先确定阈值、缓存命中收益和真实长片性能，再承担第三层调度复杂度。暂不推荐一加载工程就同步生成完整 sprite，也不推荐便携页把整部片逐点 seek；当前对比尚不足以把 A 窗口或 B 永久定为全部场景的赢家。

需要 owner 决定：
1. 轨道位置、默认开关、折叠方式；72px/144px 只是本页对比中档，不是产品默认。
2. 粗图预算与采样间距、稀疏长片能接受的导航误差，是否需要显示近似采样标记。
3. sidecar 默认与可选内嵌的预算，离线没 FFmpeg/浏览器 codec 不支持时的降级。
4. 多视频流选择是否与主播放器一致；当前 A 辅助流与浏览器默认播放流可能不同。
5. 原型流程接入正式波形单行/多行、gap-remove 播放/预览与工程代次的方式。

正式开发阶段建议：
- 先用 owner 真实30s/2h高清素材、长GOP/VFR/旋转及弱机器补齐性能和导航质量测量。
- 然后确定 provider/cancel/cache API，复用媒体授权与侧车管理，不修改 segments 真源。
- 再接入波形坐标、布局与事务，建立正式 Server/便携/多行/gap-remove 定向浏览器回归。
- 最后定义 payload/schema 可选缓存契约、总磁盘清理、多进程锁、版本迁移和发布产物；届时才维护产品文档、CHANGELOG 与便携内联副本。

## 验证与未验证层

通过：12 项实验 Python 授权/Range/预算/取消测试；66 项 Node（4 项原语+62项既有波形）；实验 bundle、editor bundle 新鲜度、仓库 typecheck；导出与素材静态验证。实际命令/result.json 由本机会话账本与核查 HTML 给出。

未验证：真实高码率长素材与导航听审、Firefox/Safari/macOS/Linux、离线 browser 重开、正式 MOSP/Editor Server 接入、安装包/发布与远端 CI。实验没有模型调用；ASR 模型层不适用。没有评论/关闭 issue、推送、PR、合并、tag 或发布。内联副本待发布前统一重生成。

文档结构检查另有 1 项基线继承失败：`docs/logs/agent-e2e-pitfalls-261011.md` 未登记日志导航。已用 `git ls-tree/git grep` 确认 a34d502 中文件已存在、导航无登记；本任务不改其它记录。检查结果是 0 新断链、1 结构错误，不算全通过。文档检查器19项回归通过；可由后续文档维护补登记后重跑。

播放中也实测 B：5格首批约102ms、完成377ms，主播放器继续播放（正常时间前进0.252s），后台 seeking=0。多行高缩放15格约141ms；滚动后只新增5格，复用10格。整片去空隙显示6480s，中心点击源时间约3962.866s，理论3960s；本次单像素约9.405s，差异在像素定位分辨率内。拖动定位约15.368s；纯音频 canvas 高度130px、visibleFrames=0。
