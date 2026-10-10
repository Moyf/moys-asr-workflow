---
title: MAW 1.2 本地模型 Launcher 开发记录
created_at: 2026-08-03
updated_at: 2026-08-03
status: development
---

# MAW 1.2 本地模型 Launcher 开发记录

## 这次确认的产品方向

Launcher 的「供应商」改名为「识别方式」，新增「本地模型」。用户仍在同一条媒体 → SRT / `.mosp` → MAWE 流程中切换云端 API 与本地引擎，不另开一套本地转录界面。

本地模式的第一版交互是：

1. 选择「本地模型」。
2. 在「模型」中选择 Qwen3-ASR 或 FunASR。
3. Launcher 扫描上游缓存并显示状态。
4. 没有模型时显示「下载模型」；也可以选择已有模型目录。
5. 检测到模型后显示「已检测到本地模型」和目录信息，继续显示设备、语言等选项。
6. 点击「生成字幕和工程」时复用 `generate_subtitle_local.py`，输出契约与云端流程保持一致。

## 第一阶段范围

- 新增 `local` Provider 配置，但不改变 Qwen / Soniox 既有 API 配置契约。
- 懒检测本地运行时：基础安装没有 Torch、QwenASR 或 FunASR 时，Launcher 仍可启动，并明确提示需要本地依赖。
- 检测 Hugging Face / ModelScope 的常见缓存目录。
- 支持通过文件夹选择器指定已有模型目录；该路径只在当前 Launcher 会话中使用，不写入 `.env`、工程 JSON 或日志。
- 「下载模型」第一版调用 QwenASR / FunASR 自己的 `from_pretrained` / `AutoModel` 加载器，让上游负责下载与缓存；日志显示准备过程。
- 本地转写使用已有 `maw.local_asr` 适配器，保持 Qwen Forced Aligner、FunASR 时间戳归一化和 MAW 整数毫秒工程契约。
- 普通 Windows 冻结包仍不捆绑 GPU Torch 或模型权重；源码环境仍可安装 `uv sync --extra local` 后直接使用本地模式。

## 第二阶段：GUI 完成本地运行环境部署

为避免新用户遇到“请先运行 `uv sync --extra local`”的开发者提示，Launcher 将本地功能拆成两个明确阶段：

1. **安装本地模型支持** ：在用户目录创建独立 Python 运行环境，自动安装 Torch、TorchAudio、FunASR、QwenASR 和相关依赖。
2. **下载模型** ：环境就绪后，使用该独立环境调用 QwenASR / FunASR 上游加载器，把模型缓存写入 MAW 独立模型缓存目录。

运行环境与模型缓存分开：

- 运行环境：Windows 默认位于 `%LOCALAPPDATA%\\MAW\\local-runtime`。
- 模型缓存：Windows 默认位于 `%LOCALAPPDATA%\\MAW\\model-cache`，同时兼容既有 Hugging Face / ModelScope 缓存。
- 正式 Windows 包只携带小型 `uv.exe` 安装器和本地转录 helper，不携带数 GB 的 Torch 或模型权重。
- 本地转录时，冻结版 MAW 使用独立环境的 Python 执行随包提供的本地转录脚本；云端 API 路径保持原有路由。

## 状态契约

| 状态 | Launcher 行为 |
| --- | --- |
| `runtime_missing` | 显示本地运行时未安装，禁止开始转写 |
| `missing` | 显示「下载模型」和可选的已有目录选择 |
| `partial` | 显示缺少的模型组件，允许再次准备 |
| `installed` | 显示已检测到本地模型、目录和其他运行选项 |
| `path_invalid` | 标记目录输入错误，要求重新选择 |

运行环境另有 `missing`、`installing`、`ready`、`broken` 四种 Launcher 状态；安装阶段显示当前阶段、百分比、命令输出，支持取消、重试、修复和重新扫描。模型下载阶段继续显示等待时长、缓存文件数和缓存体积；上游没有百分比时使用不确定进度条，不伪造下载百分比。

## 有意保留的边界

- 这不是独立的模型管理器：第一版不提供模型删除、版本锁定、断点续传、磁盘空间规划或所有模型仓库的完整枚举。
- 「下载模型」是“准备运行时缓存”的入口，不承诺 MAW 自己掌握每个上游模型的下载进度和校验细节。
- FunASR 的 VAD、标点和说话人组件暂不在 Launcher 中扩展为完整组件选择器；需要特殊组件时仍使用 CLI 参数。
- 本地模式暂不在基础 Windows 发行包中启用完整推理能力，避免让云端用户承担 GPU 依赖和数 GB 模型下载。

## 开发状态与验收清单

- [x] Provider / model 数据结构增加 `local` 分支。
- [x] 检测本地运行时和常见模型缓存。
- [x] Launcher 增加模型状态、目录选择、准备模型按钮和设备选择。
- [x] 模型准备阶段增加组件提示、等待时长、缓存文件数和缓存体积心跳，避免上游下载器无输出时看起来像卡死。
- [x] 本地转写命令路由到 `generate_subtitle_local.py`，冻结入口预留 `--transcribe-local`。
- [x] 增加 GUI 管理的独立本地运行环境、进度事件、取消 / 修复 / 重新扫描入口。
- [x] 冻结版本地转录切换到独立环境 Python，并保持模型缓存与运行环境分离。
- [ ] 在安装了 GUI 运行环境的真实 Windows 机器上分别验证 Qwen3-ASR / FunASR 首次准备和已有缓存复用。
- [ ] 验证 CUDA / CPU、长媒体、模型下载失败和用户中途关闭窗口时的体验。
- [ ] 根据另一个 agent 的本地模型转录测试结果，补齐真实运行时差异和模型路径说明。

## 实施记录

| 日期 | 项目 | 状态 | 备注 |
| --- | --- | --- | --- |
| 2026-08-03 | 本地模型 Launcher 方向 | 已确认 | 维护者确认把本地模型放入 Launcher 的识别方式选择器，并采用“未检测到 → 下载/选择目录；已检测到 → 状态信息 + 运行选项”的交互。 |
| 2026-08-03 | 第一阶段实现 | 开发中 | 保留另一个 agent 正在进行的本地 Qwen/FunASR 依赖与转录测试，Launcher 只连接已有本地 CLI / adapter。 |
| 2026-08-03 | GUI 运行环境部署 | 开发中 | 增加用户目录独立环境、自动依赖安装、模型缓存隔离、进度条和冻结版外部 Python 路由；首次安装仍需要下载约 2–3 GB 依赖。 |
