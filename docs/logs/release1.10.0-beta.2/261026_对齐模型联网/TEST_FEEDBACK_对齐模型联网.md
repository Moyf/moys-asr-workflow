# 测试反馈账本：对齐模型联网（261026）

- 分支: `main` @ `350c3b02`（建账时工作区干净）
- 来源: 维护者转述终端用户反馈（用户称"修改了代码才能正常使用"）
- 流程约定: 每条反馈先入账再调查;调查结论随时回填。
- 状态取值: `待处理` / `进行中` / `已修复` / `仅说明` / `阻塞`

## 问题清单

| # | 问题 | 状态 | 核实结论/方案 |
| --- | --- | --- | --- |
| 1 | 对齐模型加载一直要先连接 Hugging Face，用户修改代码后才能正常使用 | 仅说明 | 加载路径（模型已完整下载时）核实为完全离线，不连 HF；"先连 HF"发生在**准备/首次下载**路径，属 c1c8a23b 的刻意设计（HF 优先、失败回退 ModelScope）。改进顺序待维护者拍板。 |

## 核实结论（条目 1）

### 加载路径：模型已下载时不联网（已核实）

- `QwenForcedAlignerBackend._load`（`maw/timestamp_alignment.py:154-165`）先经 `resolve_alignment_model_path` 解析本地快照，命中即把**本地目录**传给 `Qwen3ForcedAligner.from_pretrained`，仅在目录不存在时才调 `prepare_hub_snapshot`。
- 运行时安装的 qwen_asr 0.0.6 的 `from_pretrained` 只是把路径转发给 `AutoModel`/`AutoProcessor`（transformers 对本地目录不联网）；全包 grep 无 `snapshot_download`/`hf_hub_download` 调用点。
- 本地快照发现覆盖三种布局：HF（`huggingface/hub/models--*--*/snapshots/<rev>`）、ModelScope 新布局（modelscope_hub 0.3.0 写 `modelscope/models/<owner>--<name>/snapshots/<rev>`，compat 层文档证实）、ModelScope 旧布局。用合成缓存对当前 HEAD 实测三种布局全部命中（含仅靠环境变量定位缓存根的场景）。
- 缓存根传递完整：显式参数与 worker 环境（`local_runtime.py` `_runtime_env` 注入 `MAW_MODEL_CACHE_ROOT`/`HF_HUB_CACHE`/`MODELSCOPE_CACHE`）双通道；`local_runtime_worker.py` 对 timestamp-align/script-align 均显式传 `resolve_model_cache_root()`。ASR 字词时间码路径（`local_asr.py` `QwenAsrEngine`）也先 `resolve_engine_model_source` 解析本地快照。
- ModelScope 镜像 `Qwen/Qwen3-ForcedAligner-0.6B` 文件齐全（config.json / preprocessor_config.json / tokenizer_config.json / model.safetensors 均在），完整下载可通过发现判据。
- 版本考古：该链路（resolve-first + MS 回退）自 v1.9.0 起无差异，v1.10.0-beta.2 与 HEAD 一致。排除"已发布版本加载必联网"。

### "先连 HF"的真实来源：准备路径 HF 优先（设计如此）

- 模型尚未下载时（首次直接跑对齐、未先点 GUI「下载对齐模型」），`_load` → `prepare_hub_snapshot`（`maw/hub_download.py:152-166`）：**先连 huggingface.co，连接失败后才回退 ModelScope**。这是 c1c8a23b 的刻意设计。
- HF 不可达网络下的等待量级有限：huggingface_hub 0.36.2 etag 超时默认 10 秒（`DEFAULT_ETAG_TIMEOUT = 10`）+ 重试；但走半可用系统代理时感知会明显拉长。
- 与"一直（每次）都先连"吻合的边界：**快照不完整**（下载中断或手动拷贝，缺权重 + config.json + preprocessor_config.json + tokenizer_config.json 任一）→ 发现永远失败 → 每次加载重复 HF→MS 全流程。
- 用户"修改代码才能用"最可能是调整了下载源顺序或跳过 HF；本质是 HF-first 策略在国内网络的体验问题，不是"加载必须联网"的缺陷。

### 可选改进（待维护者拍板，未实施）

- A. 准备顺序反转或可配置：ModelScope 优先、失败再 HF；改动集中在 `prepare_hub_snapshot`。
- B. 发现到不完整快照时给出明确提示（"缓存不完整，正在续传"），避免用户误判为必联网。

## 阶段汇总

- 续 1: 收到条目 1，完成核实闭环（加载路径合成缓存实测 + 上游包 grep + 版本考古；准备路径设计溯源至 c1c8a23b）。结论已回填问题清单；改进方向待拍板。
