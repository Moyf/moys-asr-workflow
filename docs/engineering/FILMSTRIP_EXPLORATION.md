# #229 视频缩略图实验与方案比较

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
