# 本地模型部署说明

## 环境要求

- Python 3.11+
- NVIDIA GPU（推荐 8GB+ 显存，用于 Qwen3-ASR）
- CUDA 12.x 驱动
- FFmpeg（需在 PATH 中可用）

## 安装步骤

### 1. 基础安装（云端 API + 编辑器）

```powershell
git clone <仓库地址>
cd moys-asr-workflow
pip install -r requirements.txt
```

### 2. 本地模型额外依赖

```powershell
pip install -r requirements-local.txt
```

### 3. 安装 CUDA 版 PyTorch

```powershell
pip install torch --index-url https://download.pytorch.org/whl/cu124
```

验证 CUDA 可用：
```powershell
python -c "import torch; print(torch.cuda.is_available())"
# 应输出 True
```

### 4. 下载模型权重

模型文件较大（总计约 8GB），不会随仓库分发，需手动下载。

**方式一：ModelScope（国内推荐）**

```powershell
# 安装 tools
pip install modelscope

# Qwen3-ASR-0.6B（约 1.9GB，8GB 显存可用）
modelscope download --model Qwen/Qwen3-ASR-0.6B --local_dir ./models/Qwen3-ASR-0.6B

# Qwen3-ASR-1.7B（约 4.2GB，推荐 16GB+ 显存）
modelscope download --model Qwen/Qwen3-ASR-1.7B --local_dir ./models/Qwen3-ASR-1.7B

# ForcedAligner（字级时间戳，约 1.8GB）
modelscope download --model Qwen/Qwen3-ForcedAligner-0.6B --local_dir ./models/Qwen3-ForcedAligner-0.6B

# Whisper large-v3（CPU 英文识别，约 1.8GB，可选）
# 需从其他来源获取 sherpa-onnx 格式的模型文件
```

**方式二：Hugging Face**

```powershell
pip install huggingface_hub
huggingface-cli download Qwen/Qwen3-ASR-0.6B --local-dir ./models/Qwen3-ASR-0.6B
huggingface-cli download Qwen/Qwen3-ForcedAligner-0.6B --local-dir ./models/Qwen3-ForcedAligner-0.6B
```

## 目录结构

安装完成后 models/ 目录应包含：

```
models/
├── .gitkeep                    # 占位，保证目录被 git 跟踪
├── Qwen3-ASR-0.6B/             # 可选，约 1.9GB
├── Qwen3-ASR-1.7B/             # 可选，约 4.2GB
├── Qwen3-ForcedAligner-0.6B/   # 可选，约 1.8GB
└── sherpa-onnx-whisper-large-v3/  # 可选，约 1.8GB
```

## 使用

### Web 控制台（推荐）

```powershell
console.bat
# 或
uv run python web-console\server.py
```

浏览器打开 http://127.0.0.1:10101

1. 选择模型类型
2. 点击「加载模型」等待加载完成
3. 选择或拖入媒体文件
4. 点击「开始转写」

### 命令行

```powershell
# 云端 API
uv run python generate_subtitle_qwen_api.py "video.mp4" --json

# 本地 Qwen3-ASR
uv run python generate_subtitle_local.py "video.mp4" --json --model-path ./models/Qwen3-ASR-0.6B --aligner-path ./models/Qwen3-ForcedAligner-0.6B
```

## 注意事项

- **模型权重**不会被提交到 git（已配置 .gitignore），每次 clone 后需重新下载
- **PyTorch** 需要 CUDA 版本，默认 pip 安装的是 CPU 版，务必使用 `--index-url` 指定 CUDA 源
- **8GB 显存**建议使用 Qwen3-ASR-0.6B；1.7B 版本需要 16GB+ 显存
- **Whisper** 自动选择 GPU/CPU（有 GPU 用 float16，否则 CPU int8），适合英文识别
- **热词**功能仅本地模型支持（通过 Qwen3-ASR 的 context 参数），云端 API 不支持
