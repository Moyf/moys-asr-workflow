# 表情包烧录视频 · 基础管线

## 目标

编辑器「烧录视频」支持把表情包图片烧进视频：

- 服务端在现有 `ass` 滤镜烧录管线上叠加 FFmpeg `overlay` 滤镜（静态 PNG），与字幕**一次性编码**完成，不引入第二次转码。
- 基础管线对应「方案一：固定位置」——所有表情包图片出现在 `preview.sticker` 几何对应位置。
- 「方案二：显示在字幕第一个字左侧」研究结论见 `STICKER_DISPLAY_MODES.md`，推荐二期实现。

## 状态

| # | 事项 | 状态 | 备注 |
| --- | --- | --- | --- |
| 1 | 服务端 `burn_ass_video` 支持 stickers + overlay 链 | 已修复 | `serve.py`：`_parse_burn_sticker_inputs` / `_burn_sticker_chain_lines` / `_burn_sticker_input_args` / `_burn_interval_filter(…, stickers)`；请求字段 `stickers` |
| 2 | 前端表情包烧录计划收集（区间 + 几何 + 去空隙收缩） | 已修复 | 新模块 `web/editor/io/editor-sticker-burn-plan.js`（门面 `MaweStickerBurnPlan`），已登记 `web/editor-scripts.txt` 并重建 bundle |
| 3 | 两个烧录入口请求带 stickers | 已修复 | `editor-wiring-burn-video.js` 完整烧录 + 去空隙烧录 |
| 4 | 服务端/前端单测 | 已修复 | `tests/test_burn_video_export.py::BurnStickerTests` 9 条；全文件 27 条通过 |
| 5 | 真实 FFmpeg 冒烟验证 | 已修复 | `.artifacts/sticker-burn/`：testsrc 320x240 + PNG，像素级验证表情包位置（t=1.5/2.0/3.5 均在指定层内）与字幕同帧渲染；一次性编码完成 |
| 6 | 方案一/方案二研究报告 | 已修复 | `STICKER_DISPLAY_MODES.md`（并行研究 agent 产出） |

## 关键设计

- **一次性编码**：overlay 链与 `ass` 在同一张 filter_complex 图串联，单次解码单次编码；
  表情包只有每帧一次 alpha blend 开销。
- **z-order 与预览一致**：overlay 在 `ass` 之前（预览中字幕层 z-index 20 > 表情包层 9）。
- **几何契约**：前端把归一化 `preview.sticker` × 视频分辨率换算成像素层矩形；
  服务端用 `scale=w=W:h=H:force_original_aspect_ratio=decrease`（contain 不放大）
  + `overlay=x='X+(W-w)/2':y='Y+(H-h)/2'`（层内居中）完成 contain 缩放与居中，
  前端/服务端都不需要读取图片尺寸。
- **时钟契约**：去空隙模式 overlay 链挂在 `select/setpts` 之后（`[burn_base]`），
  enable 用收缩时间轴——与前端 `mapGapRemovedTime` 收缩的区间、与 ASS 字幕同一时钟。
- **素材契约**：服务端用 `_sticker_rel_path()`（防穿越）在激活的 `project.sticker_root`
  下解析 rel，与 `/stickers/` 预览路由同一目录；rel 去重合并 enable 区间，一张图一个 FFmpeg 输入。
- **开关契约**：跟随编辑器「预览表情包」开关（`stickerOverlayToggle` + `stickersEnabled`），所见即所得。
- **shortest=1 必须显式**：静态图 `-loop 1` 与循环 GIF 都是无限输入，overlay 缺省
  `shortest=0`（输出持续到最长输入结束）会让 FFmpeg 永不退出（冒烟阶段实测踩坑）。

## 已知边界（基础管线明确不做）

- 同屏多张表情包时预览是垂直堆叠（各 contain 到层高 50%），烧录按「每张图独立
  contain 到整层、居中叠放」近似；多图同屏为边缘场景，方案二报告 §3.4 有收敛思路。
- 单帧「实际画面预览」（`render_ass_frame`）暂不叠表情包，烧录与预览层后续可共享同一份计划。
- 表情包 `rel` 缺失的老工程段落跳过（服务端契约需要 rel）。

## 格式支持结论（2026-10-18 实测）

| 格式 | 编辑器预览 | 烧录 | 说明 |
| --- | --- | --- | --- |
| PNG/JPEG/BMP | ✓ | ✓ | `-loop 1` 无限帧 |
| 静态 GIF | ✓ | ✓ | `-stream_loop -1 -ignore_loop 0`；GIF demuxer 默认 `ignore_loop=1` 会播一遍就停，必须显式遵循文件循环次数 |
| 动图 GIF | 浏览器循环播放 | ✓ 循环播放 | 同上；与预览一致 |
| 静态 WebP | ✓ | ✓ | `-stream_loop -1`（webp demuxer 无循环机制） |
| **动画 WebP** | 浏览器可播放 | **✗ 拒绝并提示** | FFmpeg webp demuxer 解码 0 帧，overlay 拿不到次输入帧、输出空文件；服务端检测 RIFF 头 ANMF chunk 后报错，提示改用 GIF |

### 实测踩掉的三个坑

1. **`overlay` 必须显式 `shortest=1`**：任一输入是无限流（`-loop 1`/循环 GIF）时，
   缺省 `shortest=0`（输出持续到最长输入结束）会让 FFmpeg 永不退出。
2. **`shortest=1` 又要求所有表情包输入无限化**：它是「任一输入终止即截断输出」，
   静态 WebP（1 帧 0.04s）曾是短输入，把整段输出截成 0.1 秒。修法：静态位图
   `-loop 1`、GIF `-stream_loop -1 -ignore_loop 0`、WebP `-stream_loop -1`。
3. **overlay 的表达式坐标在 `-stream_loop` 输入下被静默丢弃**（无警告、帧不上屏；
   `-loop 1` 输入下同一表达式正常）。修法：服务端用 `edit.image_dimensions()`
   读图片尺寸，静态计算 contain 显示矩形（整数），overlay 全部纯数字坐标。

## 验证记录

- `python scripts/run_check.py -- uv run --no-sync python -m unittest tests.test_burn_video_export`
  → 27/27 通过（含表情包解析/滤镜图/命令接线/HTTP 转发 9 条新测试）。
- `node --test tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs` → 通过。
- `pnpm run check:editor` → bundle 新鲜。
- 真实 FFmpeg 冒烟（本机完整版 FFmpeg）：
  表情包像素级验证 + 字幕带亮度对比全部通过，命令为一次性编码。
