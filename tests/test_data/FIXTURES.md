# `.ReaPeaks` Fixture 规格

> 目标：用 **REAPER 真机生成**的 `.ReaPeaks` 作为解析测试的真实 fixture，验证 MAW 解析器与 REAPER 字节级格式兼容（P2-3 核心缺口）。
>
> 源 wav 由 `gen_fixtures.py` 生成（`*.wav` 被 gitignore，不入库）；`.ReaPeaks` 由用户在 REAPER 中打开对应 wav 生成后放回本目录（`.ReaPeaks` 可提交）。

## 生成流程

1. 运行 `uv run python tests/test_data/gen_fixtures.py`，生成 3 个 wav 到本目录。
2. 在 REAPER 中依次打开这 3 个 wav（REAPER 会自动生成 `<name>.ReaPeaks`）。
3. 将生成的 `.ReaPeaks` 文件复制回 `tests/test_data/`。
4. 运行 `uv run python -m unittest tests.test_reapeaks -v`，fixture 测试类应通过。

> 若 REAPER 未自动生成，可在 REAPER 中加载项目后触发一次 peak 构建（选中素材并播放/构建 peaks）。

## Fixture 清单

### 1. `tone30.wav.ReaPeaks`（主 fixture）

- **时长**：30 分钟（1800s）
- **采样率**：44.1 kHz，单声道
- **内容时间轴**（便于按段断言波形/频谱）：

| 时间段 | 内容 | 断言用途 |
|--------|------|---------|
| 0-10s | 静音 | 波形振幅≈0 的边界 |
| 10-600s | 200Hz 纯音 | 低频段波形/频谱 |
| 600-900s | 粉噪声 | 宽频、非纯音频谱密度 |
| 900-1350s | 1kHz 纯音 | 中频段 |
| 1350-1790s | 3kHz 纯音 | 高频段（自研 1000Hz 欠采样区） |
| 1790-1800s | 静音 | 末尾边界 |

- **叠加**：每 5 分钟（300s）最后 30s 叠加白噪声（跨频段，验证噪声尾）。

### 2. `tone_dual.wav.ReaPeaks`（双声道）

- **时长**：20s
- **采样率**：44.1 kHz，**双声道**
- **内容**：左声道 1kHz 纯音；右声道白噪声（或 500Hz 纯音）。
- **断言用途**：多声道 wave/spectral 数据交错布局、每声道独立 peak。

### 3. `tone_48k.wav.ReaPeaks`（采样率维度）

- **时长**：10s
- **采样率**：**48 kHz**（视频标准），单声道
- **内容**：前 5s 440Hz 纯音，后 5s 白噪声。
- **断言用途**：48kHz 下 division factor 计算路径（与 44.1k 不同）。

## 版本说明

REAPER 当前版本通常只产一种 `.ReaPeaks` 版本（RPKN v1.1 或 RPKL v1.2）。fixture 只覆盖"当前 REAPER 的真实产物"；其余版本（RPKM v1.0 / 未覆盖的 v1.2）由合成 `build_reapeaks` 补足，不需切换 REAPER 版本手动生成。