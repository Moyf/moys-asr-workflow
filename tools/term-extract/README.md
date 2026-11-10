# term-extract：视频术语提取（M1 独立工具）

游戏录像 → PP-OCRv6 画面扫描 → 聚合与规则评分 → **AI 语义筛选** → HTML 确认页 → 热词表。

目的是减少「真希 → 珍惜」这类同音错字：**画面提供写法，声音提供读音**。产出的热词表
可填回 Launcher 热词输入、批量 CLI 或豆包 `--hotword`，供 ASR 转写与后续 AI 处理使用。

完整规格与合并进 MAW 的预留点见 [SPEC.md](SPEC.md)。本工具是独立测试形态：不接
Launcher、不进打包；验证通过后按 SPEC §5 合并进工具箱「媒体工具」。

## 1. 环境准备（一次性）

```powershell
uv sync --group ocr --group test
```

之后统一用 `uv run --no-sync python …` 执行（也可先 `.venv\Scripts\Activate.ps1` 激活
venv 再用裸 `python`；**不要用系统 Python**，它没有仓库依赖）。

## 2. 三步用法

### 第一步：只做提取（测效果，无需任何 Key）

```powershell
uv run --no-sync python tools\term-extract\run.py "你的录像.mp4" --ocr local --no-ai
```

跑 提取 → 聚合 → 规则评分，直接产出确认页。打开产物目录里的 `report.html`：

- 按分数 / AI 判定 / 搜索过滤候选，展开「证据与理由」看评分明细；
- 顶部「导出预览」实时显示当前勾选的词，与「导出热词 txt」内容一致；勾选状态在搜索/筛选后保留；
- 顶部数字输入支持悬停滚轮步进（最低分数 ±5，其余 ±1；光标为 ⇅ 样式）；
- 证据缩略图点击放大后：‹ › 按钮或左右方向键在该候选的证据帧间循环切换（底部显示 n / 总数，Esc 关闭）；
- 候选按评分分四组显示（推荐 / 待定 / 观察 / 排除），各组带代表色（青 / 琥珀 / 灰蓝 / 灰）与左色条，组头点击折叠——「观察」「排除」默认折叠，整句噪声不刷屏；分档线跟随生成时的 `--min-score`；
- 证据缩略图与放大图上，OCR 识别到的文字位置画红框标注，快速定位画面文本；
- 「最多字数」默认 12——超过该长度的整句字幕/UI 文案默认隐藏，清空输入框可显示全部；「最少出现次数」按独立显示事件数过滤；
- 点证据缩略图放大原画面，核验时间点；
- 勾选后右上角「导出热词 txt」/「复制清单」；超热词硬限制（如非 ASCII > 15 字符）的项会标灰说明原因。

长视频建议先 `--fps 0.5`（每 2 秒一帧）全片粗看，再对重点段落 `--fps 1` 重跑。
速度量级：tiny 模型 CPU 约 2–4 帧/秒，静止画面会被自动跳过不再重复 OCR。

### 第二步（可选）：补 AI 语义筛选

`--no-ai` 的推荐项只来自规则评分（只有召回、没有语义判断），正式使用前应过一遍 AI：
规则评分管「找全」，AI 管「挑对」，HTML 人工勾选是最后一道关。

```powershell
$env:MAW_POSTPROCESS_ZHIPU_API_KEY="你的Key"
uv run --no-sync python tools\term-extract\run.py "你的录像.mp4" --resume --llm-preset zhipu
```

`--resume` 复用第一步的 `ocr.json`，**不重扫画面**，只跑聚合 + AI + 报告。
LLM 连接三选一：预设 `--llm-preset deepseek|zhipu|qwen`（Key 走对应
`MAW_POSTPROCESS_<预设>_API_KEY` 环境变量，与工具箱 AI 处理共用约定）；
或 `MAW_TERMS_LLM_API_KEY` + `--llm-base-url/--llm-model`；或显式 `--llm-api-key`。

AI 筛选失败会写 `ai-failure-record.md` 并以非零码退出，**不会静默降级**——
未经语义筛选的输出不该被当成最终热词表。

### 第三步：热词表进 ASR

确认页导出的 `hotwords.txt`（每行一词，或 `--weight-by-score` 时带 `词: 权重`）：

- Launcher「即时热词」直接输入或拖入该 txt；
- 批量流水线 / CLI 用热词文件参数传入。

## 3. 常用参数

| 参数 | 说明 |
| --- | --- |
| `--fps 1.0` | 采样密度 0.2–2.0；长视频建议 0.5 |
| `--model tiny\|small` | PP-OCRv6 档位；small 更准更慢 |
| `--region full\|bottom30\|custom x1 y1 x2 y2` | 只扫部分画面（如下方字幕区） |
| `--ocr runtime\|local` | 默认 `runtime`（托管环境，需在设置安装）；`local` 直连开发 venv |
| `--min-score 60` | 推荐分数线，低于此不预勾选 |
| `--resume` | 复用产物目录里的 `ocr.json`，跳过扫描 |
| `--weight-by-score` | 导出带权重：≥80→5、70–79→4、60–69→3 |
| `--max-frames 20000` | 采样帧数安全上限 |

## 4. 产物（默认视频旁 `<视频名>.termextract/`）

| 文件 | 内容 |
| --- | --- |
| `report.html` | **确认页**：过滤 / 勾选 / 证据 / 导出，`file://` 直接打开 |
| `candidates.json` | 完整候选与证据（时间点、事件、变体、评分理由、AI 判定），编辑器联动的数据源 |
| `report.csv` | 全量候选（带 BOM，Excel 直开） |
| `frames/` | 证据帧（仅有文字命中的画面） |
| `hotwords.txt` | 推荐项初始导出；以确认页导出为准 |
| `ocr.json` | 扫描原始块，`--resume` 复用 |

在产物目录新建 `ignore-extra.txt`（每行一个词，`#` 注释）可追加 UI 忽略词。

## 5. 测试

```powershell
uv run --no-sync python scripts/run_tests.py tests/test_ocr_scan.py tests/test_ocr_runtime.py tests/test_term_extract_aggregate.py tests/test_term_extract_score.py tests/test_term_extract_export.py tests/test_term_extract_ai_filter.py tests/test_term_extract_report.py
```

## 6. 边界（如实）

- 规则评分只管召回；语义判断 = AI 筛选 + HTML 人工确认两道关，OCR 结果不可全量收入。整句字幕/UI 文案（>12 字符）评分 −20 沉底，且超热词硬限制的词不进入推荐；确认页可用「最多字数」隐藏它们。
- 采样是成本与召回的平衡：闪现 <0.5s 且无场景切换的文字可能漏。
- 「命中次数」是采样帧数口径（`candidates.json` 里如实保留），评分用「有效命中」（每事件最多计 4 帧）；相隔超过采样间隔约 2.5s（fps=1 时）的两次出现计为独立事件，弹幕滚动/同屏双框不虚增。
