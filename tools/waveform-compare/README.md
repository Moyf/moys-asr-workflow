# 波形对比工具

从仓库根目录运行：

```powershell
uv run --no-sync python tools/waveform-compare/build.py
```

然后打开命令输出的 `comparison.html`。页面可切换素材与片段、缩放、定位和播放。素材包括 16 kHz 单声道 WAV、44.1/48 kHz 立体声 WAV、48 kHz 三声道 WAV、AAC，以及 FFmpeg 支持编码时的 MP3。

要单独复测速度，运行 `uv run --no-sync python tools/waveform-compare/bench.py`。它对各类型的 320 秒素材预热后分别测量五次并报告中位数。旧版、新版和可用时的 quapeaks 都从文件经 FFmpeg 解码；结果只代表本机及这些合成素材，不是 1 小时文件的端到端结果。

生成器在系统临时目录中创建各类型的 8 秒试听素材、320 秒计时素材、两份 `.mopeaks`，以及在本机 Rust 内核可用时创建实际 `.quapeaks`。这些测试媒体和缓存不会进入仓库；mopeaks 自身的生成与读写不依赖 quapeaks 内核。

旧版算法使用 FFmpeg 将音频混为单声道、降到 1 kHz 后每 10 ms 取峰。新版仍降到 1 kHz，但保留原声道后合并极值，仍写为同样大小的 MPK1。它能改善反相、单侧声道，不能保证高频或极短脉冲的细节。如果缺少 quapeaks Rust 内核，页面只显示两份真实 mopeaks，不伪造 QPK 曲线。

已有缓存继续复用，避免升级后批量重建波形。要在旧素材上观察新版效果，请将该素材的旧缓存移入回收站后重新生成；不要把测试媒体和缓存提交到仓库。
