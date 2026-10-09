# 波形对比工具

从仓库根目录运行：

```powershell
uv run --no-sync python tools/waveform-compare/build.py
```

然后打开命令输出的 `comparison.html`。页面可选择测试片段、缩放、定位和播放。

要复测速度，运行 `uv run --no-sync python tools/waveform-compare/bench.py`。它对 8 秒和 64 秒 WAV 各预热一次、测量五次并报告中位数。两条路径都从文件经 FFmpeg 解码；结果只代表本机及这份测试音频。

生成器在系统临时目录中创建 8 秒测试 WAV、旧版提取方式的 `.mopeaks`、当前改进方式的 `.mopeaks`，以及在本机 Rust 内核可用时创建实际 `.quapeaks`。这些测试媒体和缓存不会进入仓库。

旧版算法使用 FFmpeg 将音频混为单声道、降到 1 kHz 后每 10 ms 取峰。改进版调用 MAW 当前的 `extract_waveform()`，从源采样率与全部声道的 PCM 中取同一时间窗的极值，仍写为 MPK1。如果缺少 quapeaks Rust 内核，蓝色曲线会明确标为“原始 PCM 300 峰/秒参考曲线”，不冒充实际 QPK 输出。
