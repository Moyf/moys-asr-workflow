# MOSS 云端供应商接入（sparkles-支持MOSS-API）

- 日期：2026-11-18 ～ 2026-11-19
- 分支：`Moyf/sparkles-支持MOSS-API`（基于 `bb0c3367`）
- 状态：开发与本地验证完成，未调用付费 API 实测

## 目标与范围

接入模思智能开放平台（MOSS）云端转写，首版按维护者评估收窄：

- 只接 `moss-transcribe-diarize-pro`（标准 `moss-transcribe-1.0` 只回纯文本、无时间码，对字幕工程无用）。
- 说话人分离 + 段级时间码 + keyterms 热词，输出标准 MAW 工程。
- 字词时间码不伪造：沿用本地 MOSS 引擎的既定策略（无 items、不按字数硬切），交给现有对齐器补齐。
- 超长音频分片与跨片说话人一致性不在本版（>60 分钟直接报错，提示 `-ll` 或自行分割）。

## API 契约（2026-11 官方文档核实）

来源：`https://platform.moss.cn/en/docs/reference/transcriptions` 与 `/en/docs/reference/audio-task`。

- `POST https://api.mosi.cn/v1/audio/transcriptions`，`Authorization: Bearer $MOSS_API_KEY`，multipart `file` 直传。
- diarize 响应：`{task, duration(秒), text, segments[{type,id,start,end(秒),text,speaker}]}`。
- `async=true` → 任务对象（`task_id`、`retry_after` 秒）；`GET /v1/audio/tasks/{task_id}` 轮询 `PENDING/PROCESSING/SUCCESS/FAILED`。
- keyterms：≤20 个、每个 ≤30 字符；multipart 下传 JSON 编码字符串。
- 上限：单文件 512MB、diarize-pro 单次 60 分钟、每用户并发 2。
- 定价（写入 UI 的参考价）：说话人分离促销 ¥1.20/小时（原价 ¥2/小时，40% off）。

## 实现

| 文件 | 内容 |
| --- | --- |
| `maw/moss.py` | 客户端：配置（MOSS_API_KEY/MODEL/POLL_*）、keyterms 清洗与校验、异步提交、轮询（retry_after 优先、心跳、连续 5 次网络错误放弃）、结果解析（秒→ms、speaker、无时间码段整单退化全文单条） |
| `maw/asr/moss.py` | CLI：ogg+opus 24kbps 提取（同豆包通道）、60 分钟上限、`--keyterm`（别名 `--hotword`）、`--speaker`（兼容 no-op，分离为固有输出）、`--speaker-colors`、`--debug-raw`、SRT + `.mosp` 输出 |
| `maw/gui_config.py` | `MOSS_MODELS` + 供应商注册（豆包之后）；`supports_language=False`（接口无语言参数）；`supports_keywords=True`（keyterms） |
| `maw/gui_workflow.py` | 请求字段 `moss_keyterms`、SRT 标签 `.moss-pro`、命令构建（`--model/--keyterm/--speaker-colors`）、`MOSS_API_KEY` 注入、冻结包 `--transcribe-moss` |
| `maw/gui_web.py` | payload 解析 moss 分支：按行拆分 + 20/30 限制预检（`moss_keyterms_too_many` / `moss_keyterm_too_long`） |
| `maw_gui.py` / `maw/cli.py` | 内部分发 flag、公开 CLI `--provider moss`（校验：拒绝 language/地域/词表等 Qwen 专用参数） |
| `maw/asr_presets.py` | `TEXT_FIELDS` 增 `mossKeyterms` + 旧预设 `setdefault` 迁移 |
| Launcher 前端 | `mossAdvancedOptions` 热词 textarea（index.html）、显隐/校验/payload/presets/i18n（zh+en）/mock api/输出命名标签 |
| `scripts/packaging/MAW.spec` | hiddenimports 增 `maw.asr.moss`、`maw.moss` |
| `.env.example` | MOSS_API_KEY / MOSS_MODEL / MOSS_POLL_* 段 |

文档：`docs/user/PROVIDERS.md`（速查表 + MOSS 小节 + 定价与密钥链接）、`docs/user/CLI.md`（provider 列表 / hotword 适用范围 / 示例）、`docs/user/LOCAL_ASR.md`（云端入口互链）。CHANGELOG 未发布段新增 🚀 全新特性条目。

## 验证记录

命令经 `python scripts/run_check.py --timeout N -- <cmd>` 执行（result.json 与完整输出落 `.artifacts/checks/<run-id>/`）；Python 用主仓库 venv（`D:\Codes\moys-asr-workflow\.venv`，本 worktree venv 缺依赖）。

| 层 | 命令 / 内容 | 结果 |
| --- | --- | --- |
| 客户端单测 | `python -m unittest tests.test_moss` | 34 通过（含自审后新增的空 segments 兜底用例） |
| GUI 管线 | `tests.test_gui_config` + `tests.test_gui_workflow` | 163 通过 |
| GUI Web | `tests.test_gui_web`（含新增 moss keyterms 转发/校验用例） | 341 通过（1 skip 既有） |
| 公开 CLI | `tests.test_cli` + `tests.test_packaging_contract` | 60 通过 |
| 预设 | `tests.test_asr_presets`（含旧预设 mossKeyterms 迁移用例） | 通过 |
| Launcher bundle | `node scripts/build-launcher.mjs --write` / `--check` | 构建成功、fresh |
| Launcher Node 测试 | `node --test tests/test_launcher_segmentation_prefs.mjs tests/test_asr_presets_browser.mjs tests/test_console_mirror.mjs` | 通过 |
| typecheck | `tsc -p web/tsconfig.typecheck.json` | 无错误 |
| 编辑器契约 | `node --test tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs`；`node scripts/build-editor.mjs --check` | 通过、fresh |
| e2e（受影响单 spec） | `npx playwright test ... tests/e2e/launcher-interactions.spec.mjs` | 64 通过（1.1m） |
| 全量 Python | `python scripts/run_tests.py` | 3353 项：除 `test_runtime_winsecurity` 2 个错误外全过（该 2 项在主仓库同样红，为本机 `D:\Codes` ACL 环境问题，与本分支无关） |
| 无 Key 路径 | 真实 1s wav + 空 `MOSS_API_KEY` 跑 `-m maw.asr.moss` | 友好中文报错退出，音频提取正常 |
| 硬扫 | `git diff --check`；`python scripts/check_personal_paths.py --diff-ref main` | 干净 |

关键 result.json：`.artifacts/checks/20261119T092046*`（全量）、`20261119T012353Z` 前后（e2e / 构建）。

## 未验证边界

- **未调用真实付费 API**：所有网络路径均为 mock 单测；首次实测需维护者提供 MOSS_API_KEY，建议先 `--debug-raw` 跑 2 分钟多人音频（快速测试 `-ll 2m`），核对 segments/speaker 形状与官方示例一致后再放全片。
- 60 分钟上限、512MB 上限、并发 2 限制均为提交前静态校验或文档说明，未实测触发。
- 冻结包（MAW.exe）路径只验证了 spec/测试与命令构建，未实际打包。
- 跨片说话人一致性与超长音频分片：后续版本。
- **分支落后 main**：本分支基线 `bb0c3367` 是 main 的祖先（main 已含 1.11.4 提交）；提 PR 前需 fetch 并同步目标分支、解决 docs/releases、blank-editor.html、uv.lock 等冲突。

## 独立自审与处置（2026-11-19）

未参与实现的独立 agent 审查全部 diff（记录见 [REVIEW_FINDINGS.md](REVIEW_FINDINGS.md)）：1 major、1 minor、2 nit，全部处置——

- **R1（major，已修复）**：`parse_result` 在「有 text、无 segments」时静默产出 0 条字幕。官方文档明确 segments 可为空（短音频），触发面真实。修复：兜底条件扩为 `has_unranged or not segments`，用 duration 兜底整段单条；无时长时抛错。双向验证：还原旧行为 3 项新测试失败，恢复后 34 项全过。
- **R2（minor，已修复）**：`test_poll_task_prefers_retry_after_over_interval` 原断言与 retry_after 取值无关；改为 PROCESSING 首响应 + `sleep.assert_called_once_with(8)`。
- **R3（nit，已修复）**：`parse_result` duration 重复计算，合并复用。
- **R4（nit，接受）**：前端 keyterms 20/30 阈值硬编码，与 openai keywords 前端先例一致；官方调额时三处同步。

## 维护者实测反馈与修复（2026-11-19）

维护者用真实素材实测（`仙术杯开场`，产出 `.moss-pro.mosp`）：**断句拆分未生效**——9 段里两段 94 字 / 87 字（14 秒级）长句原样输出。

- **根因**：云端适配器漏接了 coarse-segment 二次拆分环节。仓库既有约定是句级兜底段同样遵循断句设置——Qwen 句级兜底（`maw/asr/qwen.py`）与本地 MOSS 引擎（`maw/local_asr.py`，注释明确点名 MOSS）都调用 `split_coarse_segments`（超长段按标点/词边界拆分、时间按文本占比插值、不携带 items、speaker 透传）+ `snap_cue_boundaries`（插值切点吸附语音能量谷）；本分支初版只保留了模型段原样输出。
- **修复**：`maw/asr/moss.py` 新增 `build_subtitle_segments`（修复零时长 → coarse 拆分 → 返回插值切点序号），main() 在临时音频清理前完成拆分与能量谷吸附；`--max-len/--min-len/--max-words/--min-words/--gap-split` 从「保留但不生效」转为真实参数（含合法性校验）。
- **验证**：新增 `MossSegmentationTests` 3 项（94 字实测形状拆分 ≤18 字且保 speaker、短段原样透传、西文按词数拆分）；变异回「不拆分」行为 2 项失败、恢复后全绿。
- 相关注释 / 模型说明 / PROVIDERS.md / CHANGELOG / 人工清单同步改写「不硬切」表述。

## 后续待办（建议）

1. 维护者实测一段多人音频（含 keyterms 与 speaker-colors）。
2. 实测后如 Pro 分段过长影响观感，再评估按标点做段内保守切分的方案（需要维护者拍板是否接受估算边界）。
3. 超长音频分片与跨片说话人映射。
