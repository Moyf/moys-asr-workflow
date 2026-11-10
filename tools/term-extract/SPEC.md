# 视频术语提取工具（term-extract）规格与整合计划

状态：**M1 已完成（独立工具阶段，待维护者实测）**。本工具先以 `tools/term-extract/` 独立形态开发测试，不接入 Launcher、不进打包；验证通过后再合并进 MAW 工具箱（见文末整合清单）。

## 1. 背景与目标

游戏录像出字幕时，ASR 常把画面中的专有名词写成同音错字（如「真希」→「珍惜」）。外部设计文档《字幕中控台 OCR 游戏专有术语提取工作原理与技术交接说明》（维护者提供，不入库）验证了「画面 OCR 提供写法、ASR 提供读音」的互补路线，但其「术语库注入 ASR」与「AI 语义筛选」两端从未实装。本工具在 MAW 内补全这条链路：

```
视频 → 抽帧采样（fps 可配，默认 1）→ PP-OCRv6（现有 OCR runtime，raw-blocks 模式）
    → 聚合为「显示事件」+ 变体分组 + 候选挖掘（内置中文游戏模板）
    → 可解释规则评分 → AI 语义筛选（默认开启，LLM 判 keep/reject + 类型 + 理由）
    → HTML 确认页（人工勾选 + 证据帧）→ 导出热词表
    → 供 ASR 转写热词 / 后续 AI 处理使用
```

核心原则（继承自外部文档，须在报告与 README 中如实呈现）：

- 规则评分只管**召回**，语义判断必须经 AI 筛选 + 人工确认两道关；OCR 结果不可能全量收入热词。
- 区分「原始 OCR 命中次数」与「独立显示事件次数」，防止固定 UI 凭重复采样刷分。
- 每个候选保留可追溯证据（时间点、帧图、评分理由），误判可回查而不必重扫视频。
- 近似变体（编辑距离）只分组展示，不自动合并——「LJ-8」与「LJ-84」可能是两个真实物品。
- 采样是成本与召回的平衡：闪现 <0.5s 且无场景切换的文字可能漏，不承诺不漏字。

## 2. 交付部分 A：OCR runtime 通用化（maw/ 核心小改）

现有 OCR worker（`maw/ocr_runtime_worker.py`）只服务字幕去重。扩展为通用模块：

1. `ocr_runtime_worker.py` 新增 `scan` 子命令（保留原 `run` 不动）：
   - 输入：`--video-path`、`--model-id`、`--region-*`（复用现有六参）、`--fps`（float，默认 1.0，允许 0.2–2.0）、`--frames-dir`（证据帧输出目录，可空）、`--max-frames`（安全上限）。
   - 职责：按 fps 均匀采样时间点 → ffmpeg 逐点抽帧（复用 `postprocess_ocr._extract_frame` 的方式，缩放宽 ≤960）→ 像素哈希去重（与上一保留帧相同则跳过，不 OCR）→ OCR → 逐帧输出 JSON 行：
     `{"type":"blocks","tMs":<int>,"blocks":[{"text":str,"score":float,"box":[x1,y1,x2,y2]}],"frame":"<相对帧文件名或null>"}`
   - 有文字命中的帧，若提供 `--frames-dir`，存 jpg（宽 ≤960）作证据；无文字帧不落盘。
   - 结束输出 `{"type":"result","framesTotal":n,"framesOcr":n,"framesSkippedDup":n,"blocksTotal":n}`，失败走现有 `{"type":"error"}`。
2. `maw/ocr_runtime.py` 新增驱动函数 `run_ocr_scan_in_runtime(...)`：组装 `scan` 参数、复用 `_run_process`/`_runtime_env`，流式收集 `blocks` 行，返回汇总 dict（含全部 blocks）。语义对齐 `run_ocr_in_runtime`（ready 检查、取消、错误类）。
3. `maw/runtimes/ocr_spec.py`：`OCR_RUNTIME_VERSION` 4 → 5（协议新增子命令，旧环境提示升级；依赖清单不变，不新增 runtime 依赖）。
4. 测试：仿 `tests/test_ocr_runtime.py` 现有模式——参数组装、JSON 行解析（blocks/status/error）、版本号，不跑真实 OCR。

## 3. 交付部分 B：独立工具 `tools/term-extract/`

### 3.1 结构

```
tools/term-extract/
  README.md          # 用法、依赖（uv sync --group ocr）、整合预留点
  run.py             # 入口引导：sys.path 注入仓库根后调用包
  term_extract/
    __init__.py
    __main__.py      # CLI
    provider.py      # OCR 执行器接口：runtime 模式（run_ocr_scan_in_runtime）+ local 直连（懒导入 rapidocr，开发/冒烟用）；均可被测试注入替换
    aggregate.py     # 事件聚合、变体分组、候选抽取（模板）
    score.py         # 内置忽略词清单、可解释评分
    ai_filter.py     # LLM 语义筛选（复用 maw.postprocess_llm 的客户端与设置约定）
    report.py        # candidates.json / report.csv / report.html
    export.py        # 热词导出与硬限制预检（对齐 maw.qwen_audio 校验规则）
```

聚合核心（aggregate/score）**仅用标准库 + 已有依赖**，不依赖 OCR 运行时，保证单测可在裸 venv 运行。

### 3.2 CLI

```
python tools/term-extract/run.py <video>
  [--fps 1.0]                    # 采样密度，0.2–2.0；长视频建议 0.5
  [--model tiny|small]           # PP-OCRv6 档位，默认 tiny
  [--region full|bottom30|custom x1 y1 x2 y2]
  [--min-score 60]               # 推荐线：分数 ≥ 此值且非忽略词 → 预勾选
  [--ocr runtime|local]          # 默认 runtime（托管环境）；local 直连 rapidocr（开发）
  [--no-ai]                      # 显式跳过 AI 筛选（仅开发/离线调试；默认必须跑 AI）
  [--out DIR]                    # 默认视频旁 sidecar：<视频名>.termextract/
  [--resume]                     # 复用已有中间产物（ocr.json/candidates.json），失败续跑
  [--weight-by-score]            # 导出时按分数带映射权重：≥80→5、70–79→4、60–69→3（默认纯词表）
```

### 3.3 产物目录

```
<视频名>.termextract/
  frames/          # 证据帧（仅有文字命中的帧）
  ocr.json         # scan 原始块（含 tMs）
  candidates.json  # 聚合+评分+AI 判定的完整结构（时间点全保留，为编辑器联动留接口）
  ai-failure-record.md   # AI 协议失败时写（重命名规则仿 .ai-cleanup-record.md）
  report.csv       # 全量候选
  report.html      # 确认页
  hotwords.txt     # 确认后导出（工具生成；每行一词或「词: 权重」）
```

### 3.4 聚合与评分规格

- **显示事件**：归一化文本相同 + 时间间隔 ≤ `2/fps + 500ms` 的连续命中归为一个事件（不看位置框：弹幕滚动、同屏双框、画面轻微变化属于同一连续显示时段，位置门槛会虚增事件数）；每事件记 start/end（整数 ms）、命中数、平均置信度、代表帧与文字框证据。
- **变体**：Levenshtein 相似度 ≥ 0.85 归入同组，取最高频写法为标准候选，其余列为 variants；不合并证据。
- **候选抽取**：事件文本本身 + 上下文模板抽取。内置 v1 模板（正则，后续可外置）：`前往X`、`与X交谈/对话`、`获得/取得/拾取X`、`解锁(技能)?「X」`、`「X」『X』《X》` 标点包围、`[A-Za-z]+-?\d+` 型号词形。类型猜测：地点/人物/物品/技能/型号。
- **内置忽略词**（v1 固化清单 + sidecar 可追加 `ignore-extra.txt`）：继续、设置、保存、取消、确认、退出、返回、关闭、任务完成、加载中、按任意键继续、是、否 等 ~30 条常见 UI 词。
- **可解释评分**（0 起步，理由逐条入报告）：

  | 特征 | 分值 |
  | --- | --- |
  | 长度适合名称（2–12 字符） | +12 |
  | 独立事件数 ≥ 3 | +15 |
  | 有效命中 ≥ 12 次（每事件最多计 4 帧） | +6 |
  | 平均 OCR 置信度 ≥ 0.85 | +12 |
  | 命中上下文模板 | +20 |
  | 型号词形（字母+数字组合） | +8 |
  | 命中忽略词清单 | −60 |
  | 平均置信度 < 0.6 | −15 |
  | 长度 > 12 字符（疑似整句字幕/UI 文案） | −20 |

  有效命中口径：事件已按时间窗聚合，单事件内的高帧数只反映采样密度或常驻
  时长（常驻 UI 停留再久也只计 4 帧），只有多次独立显示才值得加分。
  模板抽取的伪事件先按来源块（文本+时间）去重，多个模板命中同一行不重复计数。

- **推荐** = score ≥ min-score 且非忽略词且**通过热词硬限制预检**（超限词如非 ASCII > 15 字符无法导出，不进入推荐）。HTML 预勾选推荐项，其余不勾。
- **证据条目**：每事件保留至多 3 条 `{frame, box, rect}`——frame 为证据帧文件名，box 为 OCR 像素框，rect 为报告层按帧图实际尺寸归一化的 0–1 百分比框（确认页据此在缩略图与放大视图上画红框；帧图缺失或 pillow 不可用时降级为无框）。

### 3.5 AI 语义筛选（默认开启，一等环节）

- 复用 `maw/postprocess_llm.py` 的 LlmSettings / 预设 / `llm_complete`（或其最小子集）；设置读取沿用工具箱 AI 处理的约定，worker 实现前先读该模块，选择最小耦合面。
- 输入：每批 ≤ 30 候选（词、变体、top3 上下文样例、类型猜测、分数）；输出**严格 JSON 数组**，每项 `{word, verdict: "keep"|"reject", type: <枚举>, reason: ≤60字}`；type 枚举：人物/地名/技能/道具/型号/缩写/其他专名/非术语。
- 筛选标准（prompt 写明）：保留需要在字幕中准确保留的游戏专名；排除普通形容词、常见 UI、完整对白、语气词、明显 OCR 错字。
- 校验：每个输入词恰好出现一次、字段合法；违规重试一次；仍失败 → 写 `ai-failure-record.md` 并**非零退出**（不静默降级，不产出未经筛选的推荐）。
- 单测用注入的假 LLM 覆盖协议校验与重试路径；真实 LLM 调用由维护者手动验收（README 写明步骤）。

### 3.6 HTML 确认页

- 单文件内联 CSS/JS，`file://` 直接可用；证据帧走 `frames/` 相对路径。
- 顶部：统计（候选数/推荐数/AI 保留数）、过滤（最低分数（默认不限，负分候选进「排除」组而非被过滤）、最多字数（默认 12，疑似整句默认隐藏）、最少出现次数（按独立事件数）、AI 判定、搜索（输入防抖））、导出预览（实时显示勾选词，与导出内容同源）、全选/反选/按推荐勾选；数字输入悬停滚轮步进；筛选重建列表时保留勾选状态。
- **评分分组**：候选按分数相对推荐线分四组——推荐（≥min-score，青）、待定（线下 20 分内，琥珀）、观察（1 分以上，灰蓝）、排除（≤0，灰）；组头显示分数段与数量，点击折叠，「观察」「排除」默认折叠；空组不显示。
- 候选卡片：词、分数、理由列表（折叠）、类型（规则猜测 + AI 判定双徽章）、独立事件数/命中数/置信度、变体、证据缩略图（OCR 文字框画红框标注，点击放大后同样画框；弹层支持 ‹ › 按钮 / 左右方向键循环切换与 Esc 关闭，显示 n / 总数）、时间点（mm:ss，可多个）；卡片左色条跟随所在分组。勾选复选框 24px + label 占满左列，整条左列为点击热区。
- 导出：生成 `hotwords.txt` 下载（Blob）+ 复制清单到剪贴板（含降级方案）；导出前跑热词硬限制预检（非 ASCII ≤ 15 字符、纯 ASCII ≤ 7 个空格分隔词、总量 ≤ 2000），不合规项标灰并注明原因、不进入导出。

### 3.7 测试

- `tests/test_term_extract_*.py`：采样计划、事件聚合、变体分组、模板抽取、忽略词、评分理由、导出预检、CLI 参数、报告数据形状——全部注入 fake OCR/LLM，不依赖真实模型与网络。
- HTML 断言类继承 `tests/compact_assertions.py` 的 `CompactContainerAssertions`。
- 扩展 `tests/test_ocr_runtime.py` 覆盖 scan 协议。
- 冒烟（不入库，产物放 `.artifacts/tmp/`）：ffmpeg drawtext 合成短视频（含「前往星核」「获得 LJ-84」「解锁技能「热情似火」」与 UI 干扰词），`--ocr local`（本 worktree venv 可 `uv sync --group ocr`）跑通全链路并生成 HTML；中文字形依赖系统字体，字体缺失时标记跳过。

## 4. 本期不做（边界）

- 不接 Launcher UI、不进 PyInstaller spec、不改 `docs/user/`、不动 CHANGELOG（合并期统一做）。
- 不做 scene-change 关键帧采样（合并期评估 ffmpeg select）。
- 不做拼音/同音校对与编辑器联动（M4，`candidates.json` 已保留时间点证据为此预留）。
- 热词权重自动映射仅 `--weight-by-score` 一档，不做逐词调权 UI。

## 5. 合并进 MAW 的预留点（整合清单）

1. `provider.py` runtime 模式直接可用（A 部分已让 OCR runtime 成为通用模块）；合并时把 `term_extract` 包迁入 `maw/`（建议 `maw/terms/`），`run.py` 引导换成模块命令 `python -m maw.terms`。
2. 工具箱「媒体工具」新增入口；运行时缺失时引导安装（复用 OCR runtime 安装 UI 契约）。
3. 「应用到热词」：确认结果一键填回 Launcher 热词输入（GUI 桥接，届时做）。
4. `ignore-extra.txt` 与模板清单外置为用户可编辑文件。
5. `candidates.json` → 编辑器「术语可疑点」校对（同音匹配 + 跳转证据时间点）单独立项。

## 6. 验收证据（worker_done 必附）

- 新增/扩展测试经 `scripts/run_tests.py` 的执行命令与结果摘要（含环境说明）。
- 冒烟合成视频的命令、退出码、产物路径（`.artifacts/tmp/` 下）与 HTML 关键内容摘录。
- `git status --short` 变更清单；`git diff --check` 干净。
- 已知限制与未验证项如实列出（如真实 LLM 未跑、runtime 环境未装等）。
