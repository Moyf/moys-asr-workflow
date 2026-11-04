# 实际画面表情包合成路线（真·所见即所得）

状态：未实施 · 评估完成（2026-11-04）。触发条件：cue-left 模式或同屏多张表情包成为日常排版手段时再投入。
前置止血已完成：实际画面层的 CSS 底衬/阴影/圆角已移除（`web/editor.css` 的
`.ass-frame-sticker-layer .sticker-overlay-content img`），单张 + 固定位置场景的预览已接近成片观感。
同日新增「自定义表情包背景」全局设置（`stickerBackground*`，默认关）：开启后
预览走 `--sticker-bg-*` CSS 变量、烧录在每个 placement 的 overlay 前画同矩形
`drawbox`（`_burn_sticker_chain_lines`），底衬只盖 contain 后的图片矩形且
预览/成片同源；关闭时维持上面一行描述的默认表现。

## 背景与结论

「📷 实际画面」窗口的设计初衷是暂停时看真实渲染，但只有一半做到了：

- **字幕已经是真的**：帧 PNG 由 `render_ass_frame_png` 用与烧录完全相同的
  `ass` 滤镜渲染（server-editor/serve.py:1300），字幕部分像素级一致。
- **贴纸是 CSS 近似**：前端用独立图层按 preview.sticker 几何摆放 `<img>`，
  与烧录管线的 FFmpeg overlay 不是同一条代码路径。

本路线把贴纸合成挪进 `render_ass_frame_png` 的同一次 FFmpeg 调用，让
实际画面 = 帧 + 贴纸 + 字幕全部出自烧录同款滤镜链。评估结论：**大件全是
现成的，约半天到一天（含测试）**，风险集中在动图 GIF 的帧相位对齐。

## 现状盘点与现成件清单

烧录侧（全部可复用，无需新写算法）：

| 件 | 位置 | 说明 |
| --- | --- | --- |
| placements 载荷解析 | serve.py:769 `_parse_burn_sticker_inputs` | fixed/cue-left 两种 mode，placement 含像素目标框 + 显示区间 |
| contain 矩形计算 | serve.py:750 `_fit_contain_box` | 按图片原始尺寸在目标框内 contain（不放大），fixed 居中 / cue-left 右对齐 |
| overlay 滤镜链 | serve.py:862 `_burn_sticker_chain_lines` | 输入按 rel 去重 + split 复用，scale + overlay 串联，enable 门控 |
| 输入上限 | serve.py:116/119 | 唯一图片 ≤ 32、placement ≤ 1000，单帧合成沿用 |
| 动图语义 | serve.py:120-130 | 静态位图 `-loop 1`；GIF 尊重自带循环次数 + `-stream_loop -1` 兜底；动画 WebP 直接拒绝（serve.py:843） |

前端侧：

| 件 | 位置 | 说明 |
| --- | --- | --- |
| placements 编译器 | web/editor/io/editor-sticker-burn-plan.js:77 `collectStickerPlans` | 烧录请求用的同一份编译：几何 × 分辨率 → 像素框、区间收集（跳禁用段、同 rel 合并）、cue-left 排版推导（:86 `computeStickerCuePlacements`） |
| ass-frame 接线 | web/editor/styles/editor-wiring-ass-frame.js | 暂停 + 服务器媒体才请求真帧（:1-2 注释）；已有贴纸层元素引用（:24-27）与签名缓存 |
| 请求端点 | serve.py:2974 `/api/ass-frame` | 现只收 ass 文本 + time_ms，需扩展 placements 载荷 |

CSS 近似层（保留，不删除）：

- `#sticker-overlay-layer`（舞台小窗）：布局草稿视图，保留底衬/阴影，浅色贴纸需要可见性。
- `.ass-frame-sticker-layer`（实际画面窗口）：播放中、file:// 本地媒体等
  不走服务器渲染的场景仍是它；合成路线落地后改为「合成成功时隐藏、
  失败/超时回退显示并在状态行提示近似」。

## 设计要点

1. **载荷同源**：ass-frame 请求带上 `collectStickerPlans` 的输出（与烧录
   请求同一份编译器、同一 preview.sticker 几何），分辨率用视频原生分辨率
   （`player.videoWidth/Height`，与 ass-frame 渲染分辨率一致），保证字幕
   与贴纸位置同源。
2. **服务端单帧合成**：`render_ass_frame_png` 增加可选 placements 参数；
   过滤出显示区间覆盖 time_ms 的 placement，按 rel 去重输入，scale +
   overlay 链，单帧输出不需要 enable 表达式。复用 `_fit_contain_box`，
   保持与烧录同一 contain / 对齐语义。
3. **GIF 帧相位（主要风险，先实测定基准）**：烧录里 GIF 输入不 seek、
   从滤镜图起点起播，理论上网帧相位 = t mod GIF 时长；实现前先烧一段
   含 GIF 表情包的样片逐帧确认，单帧预览按同一公式用输入侧 `-ss` 取帧。
   浏览器 `<img>` 的 GIF 相位本来就与烧录不同步，本路线顺带修掉。
4. **动画 WebP**：沿用烧录同一拒绝校验，保持预览与成片行为一致。
5. **绿幕分支**：`media_path is None` 时（纯音频/空白工程）绿幕上同样
   可以 overlay 贴纸，行为需与烧录绿幕导出（serve.py:988 一带）对齐。
6. **层叠次序差异要如实保留**：烧录是先 overlay 贴纸再 `ass`（serve.py:910），
   成片字幕压在贴纸上；合成路线天然继承这一次序，反而修掉现预览
   「贴纸盖住字幕」的偏差。
7. **交互代价**：ass-frame 本来就只在暂停/seek 时渲染一次（请求超时上限
   165s，serve.py:39 一带的节流与 generation 机制沿用），多叠 1~3 个输入
   约增加几十到两百毫秒，无实时性问题。贴纸几何拖拽发生在舞台层，
   不在 ass-frame 窗口内，无拖拽延迟问题。

## 止血后仍存的差异（本路线的增量价值）

| 场景 | 止血后预览 | 烧录成片 | 合成路线 |
| --- | --- | --- | --- |
| 单张 + 固定位置 | ≈ 一致 | 同左 | 不变（已达标） |
| 自定义底衬 | `--sticker-bg` 变量 | drawbox 同矩形 | 已随「自定义表情包背景」设置落地（2026-11-04），合成路线无需再处理 |
| cue-left 模式 | 永远画在固定位置（模板提示有说明，editor-template.html:1745 一带） | 贴字幕首字左侧 | 修正 |
| 同屏多张 | 垂直堆叠（各限半高） | 同一矩形内居中叠放 | 修正 |
| 动图 GIF 相位 | 浏览器加载时刻起播，随机 | 滤镜时钟 | 修正 |
| 贴纸压字幕 | 贴纸盖住字幕（字幕已烤进 PNG） | 字幕压贴纸 | 修正 |

## 验收方法

同一工程构造四个场景（单张 fixed、cue-left、同屏多张、GIF），分别截
实际画面 PNG 与烧录成片对应帧做像素比对；cue-left 与多张是本路线的
核心验收项，单张作为回归基线。相关既有测试：
tests/e2e/sticker-preview-lifecycle.spec.mjs、tests/e2e/ass-frame-preview.spec.mjs。

## 工作量与风险

- 服务端：`render_ass_frame_png` 扩展 + 单帧滤镜链组装 + 测试，约半天。
- 前端：请求载荷 + CSS 层退位/回退逻辑 + e2e，约 2~3 小时。
- 风险集中在 GIF 相位实测（见设计要点 3）；其余为拼装既有件。
- 长期耦合：落地后烧录滤镜链每次改动需同步单帧合成路径，评审时注意。
