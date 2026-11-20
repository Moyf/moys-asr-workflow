# MOSS 云端供应商独立审查

- 基线：`Moyf/sparkles-支持MOSS-API`，HEAD `bb0c3367` 加未提交的 MOSS 全部改动（3 个新文件 + 25 个修改文件）。
- 范围：MOSS 云端供应商全链路（客户端 `maw/moss.py`、CLI `maw/asr/moss.py`、GUI 管线、Launcher 前端、公开 CLI、打包、预设、文档）。
- 审查方式：未参与实现的独立 agent 只读审查（含定向测试运行与文件编码/换行探针）；主会话对 finding 逐条复核并处置。
- 结论：1 major、1 minor、2 nit；major 与 minor 已修复并双向验证，N1 顺手修复，N2 接受现状。无未处置 blocker / major。

## Findings 与处置

### R1（major）：`parse_result` 在「有 text、无 segments」时静默产出 0 条字幕（已修复）

- 位置：`maw/moss.py` `parse_result` 兜底门槛；CLI 后果链：text 非空跳过「未识别」退出 → `segments = []` → 写出 0 条字幕的 SRT 与 0 段工程（`validate_project` 放行）→ 退出码 0，转写文本整体丢失且无告警。
- 证据（审查者实测复现）：`parse_result({'status': 'SUCCESS', 'duration': 120.0, 'text': '整段文本，没有任何分段'})` → `segments == []`；对照「段缺时间码」路径却能正确兜底单条。
- 触发面：官方文档明确「segments 可为空（短音频或无有效分段）」，或服务端形状偏差、`--model moss-transcribe-1.0` 覆盖（该模型只回纯文本，文档声明未接入但客户端无守卫）。
- 处置：`maw/moss.py` 把兜底条件从 `has_unranged` 扩为 `has_unranged or not segments`——text 完整而分段不可用时，用 `duration`（以及已有段最大结束点）兜底整段单条；既无时间戳又无时长时抛 RuntimeError，绝不静默产出空字幕。与豆包 CLI「无时间戳整段兜底」、OpenAI 适配器「text-only 拒绝」同一策略家族。
- 双向验证：临时还原旧行为后，新增 3 项测试真实失败（`FAILED (failures=3)`）；恢复修复后 `tests.test_moss` 34 项全过。旧行为里把该场景钉死为 `segments == []` 的既有用例同步改写为断言兜底单条。
- 注：`--model` 旋钮保留（快照模型 / 未来模型仍可用），风险由本兜底消化。

### R2（minor）：`test_poll_task_prefers_retry_after_over_interval` 名不副实（已修复）

- 原测试首个响应即 SUCCESS，`assertFalse(sleep.called)` 与 `wait_seconds = max(retry_after, interval, 1)` 的计算无关——删掉 retry_after 参与取值测试照样绿。
- 处置：改为首个响应 PROCESSING、断言 `sleep.assert_called_once_with(8)`（retry_after=8 > interval=3）；把等待间隔取值行为真正钉住。

### R3（nit）：`parse_result` 中 duration 重复计算（已修复）

- 兜底内外各调一次 `_seconds_milliseconds(body.get("duration"))`；修复 R1 时合并为一次计算复用。

### R4（nit）：前端 keyterms 阈值硬编码（接受）

- `launcher-media-form.js` 的 20/30 与 `maw/moss.py` 常量重复（前端无法共享 Python 常量）；与 openai keywords 前端硬编码 `/[<>]/` 的既有模式一致。接受现状；官方调整限额时需同步三处（`maw/moss.py`、`gui_web.py`（已导入常量）、`launcher-media-form.js`）。

## 审查者已核实、无需处置的维度

1. 正确性：秒→毫秒换算（NaN/inf/bool 防护 + round）与 `normalize_timestamp_range` 双层校验正确；轮询状态机、心跳节流、网络错误计数与豆包同构；`--model/--keyterm/--speaker-colors/--length-limit` 管线接法正确。
2. 一致性：`gui_workflow`（命令构建/集合/标签/Key 注入）、`maw_gui` frozen 分发、`maw/cli.py` 校验、`MAW.spec` 双模块、`asr_presets` 前后端 schema、Launcher 字段显隐/payload/presets/i18n/mock 全部就位，无漏接。
3. 回归风险：PROVIDERS 新顺序有显式测试；`mossKeyterms` 走 `setdefault("")` 迁移旧预设并有专项测试。
4. 仓库约定：8 个关键文件实测 UTF-8 无 BOM、LF；个人路径零命中；`.env.example` 全空值；CHANGELOG 条目格式合规。
5. 审查者运行记录：`tests/test_moss.py + test_cli + test_gui_config + test_gui_workflow + test_asr_presets + test_asr_entrypoints + test_packaging_contract` 274 项 OK；`tests/test_gui_web.py` 341 项 OK；`node --check` 7 个改动 JS 全过。

## 遗留提醒

- 本分支 HEAD（bb0c3367）是 main 的祖先：main 侧已有 1.11.4 提交，提 PR 前需 fetch 并同步目标分支、解决冲突（docs/releases、blank-editor.html、uv.lock 等）。
- 付费 API 未实测（见 [MOSS_API_SUPPORT.md](MOSS_API_SUPPORT.md#未验证边界) 与人工清单）。

## 修复后复验（主会话）

- `tests.test_moss`：34 项通过（含 R1 新增 3 项兜底用例与 R2 改写用例）。
- R1 双向验证与 R2 断言证据：`.artifacts/checks/` 下对应 run-id 的 result.json 与 output.log（时间戳 2026-11-19 09:5x 前后）。
