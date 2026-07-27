# 本地模型部署说明

## 环境要求

- Python 3.11+
- NVIDIA GPU（推荐 8GB+ 显存，用于 Qwen3-ASR）
- CUDA 12.x 驱动
- FFmpeg（需在 PATH 中可用）
- [uv](https://docs.astral.sh/uv/getting-started/installation/)（推荐）或 pip

## 安装步骤

### 1. 克隆仓库

```powershell
git clone <你的仓库地址>
cd moys-asr-workflow
```

### 2. 安装依赖

**CPU 版（无 GPU 加速）：**

```powershell
uv sync --extra local
```

**CUDA 版（NVIDIA GPU 加速）：**

```powershell
uv sync --extra local
uv pip install torch --index-url https://download.pytorch.org/whl/cu124
```

验证 CUDA 可用：
```powershell
uv run python -c "import torch; print(torch.cuda.is_available())"
# 应输出 True
```

> 不使用 uv 时，可用 pip 替代：`pip install -e .[local]`，然后单独安装 CUDA torch。

### 3. 下载模型权重

模型文件较大（总计约 8GB），不会随仓库分发，需手动下载。

**方式一：ModelScope（国内推荐）**

```powershell
# Qwen3-ASR-0.6B（约 1.9GB，8GB 显存可用）
modelscope download --model Qwen/Qwen3-ASR-0.6B --local_dir ./models/Qwen3-ASR-0.6B

# Qwen3-ASR-1.7B（约 4.2GB，推荐 16GB+ 显存）
modelscope download --model Qwen/Qwen3-ASR-1.7B --local_dir ./models/Qwen3-ASR-1.7B

# ForcedAligner（字级时间戳，约 1.8GB）
modelscope download --model Qwen/Qwen3-ForcedAligner-0.6B --local_dir ./models/Qwen3-ForcedAligner-0.6B
```

**方式二：Hugging Face**

```powershell
huggingface-cli download Qwen/Qwen3-ASR-0.6B --local-dir ./models/Qwen3-ASR-0.6B
huggingface-cli download Qwen/Qwen3-ForcedAligner-0.6B --local-dir ./models/Qwen3-ForcedAligner-0.6B
```

> Web 控制台也支持从界面直接下载模型（ModelScope / HF 镜像）。

## 目录结构

安装完成后 `models/` 目录应包含：

```
models/
├── .gitkeep                          # 占位
├── Qwen3-ASR-0.6B/                   # 可选，约 1.9GB
├── Qwen3-ASR-1.7B/                   # 可选，约 4.2GB
├── Qwen3-ForcedAligner-0.6B/         # 可选，约 1.8GB
└── faster-whisper-large-v3/          # 可选，约 3.1GB
```

## 使用

### Web 控制台（推荐）

```powershell
console.bat
# 或
uv run python web-console\server.py
```

浏览器打开 http://127.0.0.1:10101

1. 选择模型类型（Qwen3-ASR-0.6B / 1.7B 或 faster-whisper）
2. 勾选"使用 CUDA"（如有 NVIDIA GPU，取消勾选则强制 CPU）
3. 点击「加载模型」等待加载完成
4. 在热词列表中添加热词（自动保存）
5. 选择或输入媒体文件路径
6. 点击「开始转写」

## 注意事项

- **模型权重**不会被提交到 git（已配置 .gitignore），每次 clone 后需重新下载
- **PyTorch** CUDA 版同时包含 CPU 内核，无 GPU 也可正常运行（自动回退 CPU）
- **8GB 显存**建议使用 Qwen3-ASR-0.6B；1.7B 版本需要 16GB+ 显存
- **faster-whisper** 适合英文识别，自动选择 GPU/CPU
- **热词**功能仅本地 Qwen3-ASR 模型支持（通过 context 软提示注入），云端 API 和 faster-whisper 不支持。热词属于 best-effort 软提示（非强制约束），效果取决于模型版本与音频质量，建议热词数量 ≤ 20 个、单个热词长度 ≤ 10 字符
- **CUDA 开关**在 Web 控制台中可随时切换，切换后需重新加载模型生效
- **Web 控制台端口**固定为 `10101`；编辑器端口为动态分配
