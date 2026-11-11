# 独立盲审记录：断句与标点设置持久化（issue #355）

- 日期：2026-11-11
- 分支：`feat/persist-segmentation-prefs`（基于 origin/main `57812b02`）
- 审查者：后台独立 subagent（未参与实现），通读 `git diff 57812b02..HEAD` 全部 3 个 commit
- 结论：无 blocker / major；1 minor + 4 nit，全部逐条处置（见下表），处置后复验通过

## Findings 与处置

| # | 级别 | 内容（证据见审查原文） | 处置 |
|---|---|---|---|
| M1 | minor | 环境变量优先文件值的语义（`gui_config.py` segmentation_prefs 的 `env.get(...) or file_values.get(...)`）无回归测试守护；变异 8 改为只读文件值后相关测试未红 | **已修复**：round-trip 测试补 env 优先（999 覆盖文件值 300）与 env 空串回退文件值两断言 |
| N1 | nit | 写入端（save_prefs trim）与读取端（segmentation_prefs 再 strip）重复归一化；变异 1 删写入端 trim 后测试仍绿（读取端兜底） | **接受**：双层防御——写入端保证 `.env` 内容规范化，读取端防御手改 `.env`，行为无缺陷 |
| N2 | nit | `effective_config` 已 `load_env(path)`，`segmentation_prefs(path, env)` 内部再读同一文件 | **接受**：调用频率低（每请求一次），重构 helper 签名的收益不抵churn |
| N3 | nit | mock 按出现键逐个更新、真实后端任一键出现即全量快照重写，部分 payload 下语义分叉（当前不可达：前端唯一发送路径恒为 5 键全量） | **已修复**：mock 改为与真实后端同语义（任一键出现 → 五键全量快照重写，缺键 = 清空） |
| N4 | nit | 源码契约测试只对 gapSplit 断言 init+openSettings 双回填（count==2），其余 4 字段只断言出现 ≥1 | **已修复**：五字段全部 `count == 2` 对称守护 |

## 反向验证（审查者执行，模拟回归 → 确认测试变红 → 恢复）

8 个行为级变异 7 个被抓红：禁用 save_prefs 分支（红）、get_config 删五键（双红）、
删 state.config 同步（红）、删 init 回填（红，count==2 命中）、删预设联动（红）、
mock 删五键（红）、payload 丢 maxLen（Node 红）；仅 env 优先级漏防 → 即 M1，
已补守护。变异 1（写端去 trim）未红属双层防御预期行为。恢复后工作树干净。

另做正向验证：含换行 / `=` / emoji 的值经 `json.dumps` 写入 `.env` 后单行无损，
`load_env` / `segmentation_prefs` round-trip 正常。

## Foreman 补充盲审（PR #364 阶段）

| # | 级别 | 内容 | 处置 |
|---|---|---|---|
| F1 | minor | `applyAsrPreset` 中 `segmentationPrefsPayload()` 必须在五字段赋值之后读取；既有存在性断言只防「删联动」，防不了「快照读取移到赋值之前」的乱序回归 | **已修复**：`test_launcher_segmentation_prefs.mjs` 扩展 VM fixture 装载 `launcher-presets.js`（stub `syncLocalDeviceOptions` / `renderLocalAlignmentModel` / `applyProviderLanguages` / `syncTestRun`），断言持久化快照等于赋值后的字段值。反向验证：把真实快照行移到赋值之前 → 红（payload 全空 deepEqual 命中）；恢复 → 绿 3/3 |
| F2 | — | `state.config` 先同步、`.env` 落盘在防抖后，会话内存在极短的短暂分叉窗口 | **接受**（foreman 已知取舍）：下次启动以 `.env` 为准，正确值已持久化，无用户可见后果 |

## 处置后复验

- `tests/test_gui_web.py` + `tests/test_launcher_contract.py`：OK（skipped=1 既有）
- `tests/test_launcher_segmentation_prefs.mjs`：pass 2 / fail 0
- `pnpm run build:launcher` + `check:launcher`：bundle 新鲜
- 审查者另确认：mock/real 键集合契约通过；`EffectiveConfig` 全仓仅一处构造、新字段纯增量；
  既有调用方不读新字段；「保存预设」路径未改动；提交无 AI 署名；
  `check_personal_paths.py --diff-ref 57812b02` 通过；全部文件 UTF-8 LF。

## 其他已查无发现

后端 save_prefs 分支（含 `.env` 单行格式安全）、解析容错（坏 JSON/非对象/未知键/非字符串/空白值）、
前端接线与脚本装配顺序、openSettings 回填与用户输入交互、预设格式校验兜底（`asr_presets.py`
仅允许 ASCII 数字或空串）、CHANGELOG 格式与归类、文档措辞与实现逐点对应。
