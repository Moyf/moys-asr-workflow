# 表情包烧录视频 · 基础管线与二期（字幕左侧贴放）

## 目标

编辑器「烧录视频」支持把表情包图片烧进视频：

- 服务端在现有 `ass` 滤镜烧录管线上叠加 FFmpeg `overlay` 滤镜（静态 PNG），与字幕**一次性编码**完成，不引入第二次转码。
- 方案一（固定位置）：所有表情包图片出现在 `preview.sticker` 几何对应位置。✅ 已上线
- 方案二（字幕第一个字左侧）：按排版计划逐句贴放。✅ 二期已实现（预览层接线除外，见下）
- 方案研究报告：`STICKER_DISPLAY_MODES.md`。

## 状态

| # | 事项 | 状态 | 备注 |
| --- | --- | --- | --- |
| 1 | 服务端 `burn_ass_video` 支持 stickers + overlay 链 | 已修复 | `serve.py`：`_parse_burn_sticker_inputs` / `_burn_sticker_chain_lines` / `_burn_sticker_input_args` / `_burn_interval_filter(…, stickers)`；请求字段 `stickers` |
| 2 | 前端表情包烧录计划收集（区间 + 几何 + 去空隙收缩） | 已修复 | 新模块 `web/editor/io/editor-sticker-burn-plan.js`（门面 `MaweStickerBurnPlan`），已登记 `web/editor-scripts.txt` 并重建 bundle |
| 3 | 两个烧录入口请求带 stickers | 已修复 | `editor-wiring-burn-video.js` 完整烧录 + 去空隙烧录 |
| 4 | 服务端/前端单测 | 已修复 | `tests/test_burn_video_export.py::BurnStickerTests` 9 条；全文件 27 条通过 |
| 5 | 真实 FFmpeg 冒烟验证 | 已修复 | `.artifacts/sticker-burn/`：testsrc 320x240 + PNG，像素级验证表情包位置（t=1.5/2.0/3.5 均在指定层内）与字幕同帧渲染；一次性编码完成 |
| 6 | 方案一/方案二研究报告 | 已修复 | `STICKER_DISPLAY_MODES.md`（并行研究 agent 产出） |
| 7 | **二期**：placement 纯函数模块 | 已修复 | `web/shared/utils/sticker-placement.js`（`computeStickerCuePlacements`）：窗口按主字幕句切段、逐句从 `assStackFrame` 推导墨盒左缘/垂直中心；legacy 句、句间空隙、出画、同屏多图第二张起回退固定位置；Node 测试 10 条（`tests/test_sticker_placement.mjs`） |
| 8 | **二期**：烧录载荷 `mode + placements[]` | 已修复 | 请求 `stickers` 接受对象形式（老数组=fixed 兼容）；同 rel 多 placement 经 FFmpeg `split` 复用一个输入，每 placement 一个 scale+overlay 节点；上限 placements 1000 / 唯一图片 32 |
| 9 | **二期**：模式设置与接线 | 已修复 | `EDITOR_SETTINGS.stickerBurnMode`（fixed/cue-left，默认 fixed）+ 设置页「烧录显示位置」下拉 + i18n；两个烧录入口经 `buildAss(onAssPlan)` 把与 ASS 同源的计划传入 placement 计算（去空隙 `buildGapRemovedAss` 补透传 onAssPlan，计划与 ASS 同一收缩时间轴） |
| 10 | **二期**：真实 FFmpeg 验证 | 已修复 | cue-left 双窗口：句内显示在指定位置、句间空隙无残留、split 单输入（当时本机 `.artifacts/sticker-burn/cue_left_verify.py`，不入库） |
| 11 | 二期：预览层跟随字幕 | 待处理 | 预览层仍显示固定位置；设置页 hint 已注明「最终以烧录结果为准」。实现路径见研究报告 §4.5（同一 placements 计算驱动 DOM 层） |
| 12 | Greptile PR 复审修复（PR 272） | 已修复 | 6 条评论全部处理：① 前端改发 `{mode, placements}` 载荷 + placement 自带 `align`（贴字幕段 right / 回退段 center），服务端 `_fit_contain_box` 右对齐修正为贴目标框右缘（窄图不再偏移）；② cue-left 目标框四边越界检查（越界回退 fixed，不再发出服务端会拒绝的负坐标）；③ 窗口切段加入 slice 起止边界（主句跨叠加字幕进出导致的布局切换不再被中点采样吞掉）；④ intervals 条目加 dict 类型检查（null 不再引发 500）；⑤ 动画 WebP 检测改为按 RIFF chunk 结构读 VP8X 动画标志（实测 flags 在 chunk data[0]，payload 含 ANMF 字节的静态文件不再误判）；⑥ 研究报告 §2.5/§3.5/§4.4/§6.1/§8 的「服务端减 seek_start」错误建议修正为「收缩时间轴原样使用」 |

## 关键设计

- **一次性编码**：overlay 链与 `ass` 在同一张 filter_complex 图串联，单次解码单次编码；
  表情包只有每帧一次 alpha blend 开销。
- **z-order 与预览一致**：overlay 在 `ass` 之前（预览中字幕层 `.subtitle-overlay`
  z-index 10 > 表情包层 `#sticker-overlay-layer` 9，web/editor.css）。
- **几何契约（静态坐标）**：前端把归一化 `preview.sticker`（方案一）或排版计划推导的
  目标框（方案二）× 视频分辨率换算成像素目标框；服务端用 `edit.image_dimensions()`
  读取图片尺寸静态计算 contain 显示矩形（整数），`scale=w=W:h=H` + `overlay=x=X:y=Y`
  全部纯数字坐标。早期「FFmpeg 表达式 contain（`force_original_aspect_ratio=decrease`
  + `overlay` 的 W/H 表达式）」方案已废弃——表达式坐标在 `-stream_loop` 输入下被
  静默丢弃（见下「实测踩掉的坑」3）。对齐规则：placement 自带 `align`，fixed/回退段
  框内居中，cue-left 贴字幕段框内右对齐垂直居中（贴字间隙不随图片宽窄移动）。
- **时钟契约**：去空隙模式 overlay 链挂在 `select/setpts` 之后（`[burn_base]`），
  enable 用收缩时间轴——与前端 `mapGapRemovedTime` 收缩的区间、与 ASS 字幕同一时钟。
- **素材契约**：服务端用 `_sticker_rel_path()`（防穿越）在激活的 `project.sticker_root`
  下解析 rel，与 `/stickers/` 预览路由同一目录；同一 rel 的多个 placement（方案二
  逐句贴放）经 FFmpeg `split` 复用一个输入，每个 placement 一个 scale+overlay 节点。
- **开关契约**：跟随编辑器「预览表情包」开关（`stickerOverlayToggle` + `stickersEnabled`），所见即所得。
- **shortest=1 必须显式**：所有表情包输入都被无限化（见下坑 2），主视频恒为最短
  输入；overlay 缺省 `shortest=0`（输出持续到最长输入结束）会让 FFmpeg 永不退出。
- **与绿幕互斥**：绿幕画布是固定尺寸档位而表情包 placements 按源视频分辨率换算，
  直接烧会整体错位，handler 与 `burn_ass_video` 双层明确拒绝（与「绿幕 + 去空隙」
  同一策略）；未来放开时表情包 overlay 仍应在 ass 之前、并需前端按绿幕档位重算几何。

## 已知边界（基础管线明确不做）

- 同屏多张表情包时预览是垂直堆叠（各 contain 到层高 50%），烧录按「每张图独立
  contain 到整层、居中叠放」近似；多图同屏为边缘场景，方案二报告 §3.3 有收敛思路。
- 单帧「实际画面预览」（`render_ass_frame`）暂不叠表情包，烧录与预览层后续可共享同一份计划。
- 表情包 `rel` 缺失的老工程段落跳过（服务端契约需要 rel）。

## 格式支持结论（2026-10-18 实测）

| 格式 | 编辑器预览 | 烧录 | 说明 |
| --- | --- | --- | --- |
| PNG/JPEG/BMP | ✓ | ✓ | `-loop 1` 无限帧 |
| 静态 GIF | ✓ | ✓ | `-stream_loop -1 -ignore_loop 0`；GIF demuxer 默认 `ignore_loop=1` 会播一遍就停，必须显式遵循文件循环次数 |
| 动图 GIF | 浏览器循环播放 | ✓ 循环播放 | 同上；与预览一致 |
| 静态 WebP | ✓ | ✓ | `-stream_loop -1`（webp demuxer 无循环机制）；含 VP8L 无损变体（`edit.image_dimensions` 已解析其帧头尺寸） |
| **动画 WebP** | 浏览器可播放 | **✗ 拒绝并提示** | FFmpeg webp demuxer 解码 0 帧，overlay 拿不到次输入帧、输出空文件；服务端按 RIFF chunk 结构读 VP8X 动画标志后报错，提示改用 GIF（不全文搜 ANMF 字节，避免静态文件元数据误判） |

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
  → 全文件通过（BurnStickerTests 16 条：表情包解析/滤镜图/命令接线/HTTP 转发；随迭代增至 37+ 条）。
- `node --test tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs` → 通过。
- `pnpm run check:editor` → bundle 新鲜。
- 真实 FFmpeg 冒烟（本机完整版 FFmpeg）：
  表情包像素级验证 + 字幕带亮度对比全部通过，命令为一次性编码。

### 2026-10-19 PR 272 定位边界复审

| 问题 | 状态 | 修复与回归 |
| --- | --- | --- |
| 100ms 布局后接三个 40ms 布局，被合并后中点落入后一个布局，连开头的位置也算错 | 已修复 | 保留每个布局边界，回归断言四段的坐标和起止 |
| 窗口开头连续两个 40ms 短段，首段起点被覆盖，开头 40ms 无贴纸 | 已修复 | 短段完整保留，相同几何仍合并 placement，回归断言全窗口连续覆盖 |
| 同一句跨静态及移动 slice，移动判断误用首个 slice，移动段未回退 | 已修复 | cue 必须同时覆盖采样时间及所属 slice，回归断言仅移动段回退固定位置 |

源码基于 `4d423028` 并纳入主线 `ba636318` 的文档检查修复。验证统一经
`scripts/run_check.py` 执行：定位 Node 单测 15 条、烧录服务端契约 40 条通过；
编辑器重建与新鲜度检查、TypeScript 检查、16 份发布文档检查、个人路径检查及
`git diff --check` 通过。服务端测试首次被 Windows 沙箱 TEMP 权限阻止，改用允许的
沙箱外执行后通过，未修改断言。

本轮只验证布局逻辑与服务端契约；浏览器真实烧录及成片观感仍按 PR 现有人工验收步骤
确认。内联副本待发布前统一重生成。

### 2026-10-20 与 SRT 烧录及主线顺序整合

普通合入已包含 PR270、PR267、PR268 的主线 `622411d2`。三处源码冲突同时保留
ASS/SRT 选择、烧录不将首句提前至零、ASS 排版回调，以及表情包参数和单次编码滤镜图。
去空隙字幕与贴纸共用收缩时间轴；SRT 没有浏览器 ASS 排版计划，沿用固定位置回退，
设置提示与英文翻译已说明。已发布 CHANGELOG 归档保持主线内容，未发布条目全部保留。

- Python 组合 115 项通过，无跳过：工程基础样式、HTTP SRT 与贴纸同时转交、真实
  FFmpeg 的字幕起点/贴纸窗口/输出时长、普通及去空隙、取消与清理。
- Node 组合 370 项通过，无跳过：包含三个定位边界，真实 `buildGapRemovedAss`
  同时保留起点偏好覆盖、时间映射与排版回调。
- Chromium 23 项通过：ASS/SRT × 普通/去空隙四组合使用真实贴纸计划，媒体替换撤权、
  保存/取消、帮助入口与真实服务端 SRT 烧录。
- 编辑器及启动器构建/新鲜度、类型、文档（无新增坏链）与 16 份发行归档检查通过。

原始日志保留在本工作树 `.artifacts/checks/`；推送后的精确组合提交仍以五项远端 CI
与 CLA 为合并门槛。上述自动化未替代真实工程、原生选择器、硬件编码和播放器人工验收。
