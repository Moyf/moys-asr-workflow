---
task: moss-cloud-provider
date: 2026-11-19
status: pending
---

# MOSS 云端转写供应商人工核验

> 分支 `Moyf/sparkles-支持MOSS-API`（基于 bb0c3367）：新增模思智能开放平台 `moss-transcribe-diarize-pro` 供应商（说话人分离 + keyterms + 段级时间码）。全部自动化验证通过；**未调用真实付费 API**，以下人工项需要维护者用真实 Key 实测。

## 实现与审查结论
<!-- id: moss-impl -->
<!-- badge: todo 待核查 -->

新增 `maw/moss.py`（客户端：异步提交 / 轮询 / 解析）与 `maw/asr/moss.py`（CLI），管线接入 Launcher（供应商注册、keyterms 表单、预设、i18n、mock）、公开 CLI（`--provider moss`）、冻结包分发（`--transcribe-moss`）与打包 spec。API 契约按 2026-11 官方文档核实，端点 `https://api.mosi.cn/v1/audio/transcriptions`。

边界与既定策略：

- 只接 diarize-pro；标准 `moss-transcribe-1.0` 只回纯文本、无时间码，不接。
- 仅段级时间码：不伪造字词 items、不按字数硬切（与本地 MOSS 引擎同策略）；需要字词时间码时用对齐模型补齐。
- 单次任务 ≤60 分钟；超限直接报错提示 `-ll` 或自行分割（分片与跨片说话人一致性不在本版）。
- 接口无语言参数：自动识别语言，Launcher 隐藏语言选择。
- 参考价：促销 ¥1.20/小时（原价 ¥2/小时，40% off），以结算页为准。

- [ ] **通读关键实现与自审记录**
  （操作）阅读 `docs/logs/release1.11.3/261119_MOSS云端供应商/MOSS_API_SUPPORT.md` 与 `REVIEW_FINDINGS.md`，抽查 `maw/moss.py`、`maw/asr/moss.py` 与 `maw/gui_workflow.py` 的 moss 分支
  （预期）实现与文档描述一致；自审发现的 blocker/major（如有）已处置或明确接受
  <!-- id: moss-impl-review -->

## 自动化验证结果
<!-- id: moss-auto -->
<!-- badge: pass 已通过 -->

以下为本 worktree 实际执行的结果（完整输出与 result.json 落 `.artifacts/checks/`，明细见 `MOSS_API_SUPPORT.md`）：

| 层 | 命令 / 内容 | 结果 |
| --- | --- | --- |
| 客户端单测 | `tests.test_moss`（34 项：配置 / keyterms / 提交 / 轮询 / 解析 / 兜底） | 通过 |
| GUI 管线与 Web | `tests.test_gui_config` + `tests.test_gui_workflow` + `tests.test_gui_web` | 163 + 341 项通过 |
| 公开 CLI 与打包 | `tests.test_cli` + `tests.test_packaging_contract` + `tests.test_asr_presets` | 通过 |
| 入口路由 | `tests.test_asr_entrypoints`（源码 `-m maw.asr.moss` 与冻结分发 `--transcribe-moss`） | 通过 |
| Launcher 前端 | bundle 重建 + `--check`、`test_launcher_segmentation_prefs.mjs`、`test_asr_presets_browser.mjs`、typecheck | 通过 |
| e2e（受影响 spec） | `tests/e2e/launcher-interactions.spec.mjs` | 64 项通过 |
| 全量 Python | `scripts/run_tests.py` | 3353 项，除 `test_runtime_winsecurity` 2 项环境性错误外全过（主仓库同样红，与本分支无关） |
| 变异验证 | `MAX_KEYTERMS` 临时改为 99 → 3 项测试失败，恢复后转绿 | 测试有效 |
| 硬扫 | `git diff --check`、`check_personal_paths.py --diff-ref main` | 干净 |

- [ ] **确认环境性失败与本分支无关**
  （操作）在本机跑 `uv run --no-sync python -m unittest tests.test_runtime_winsecurity`（或 CI 上看该文件结果）
  （预期）失败与 MOSS 改动无关联（D:\Codes 目录 ACL 环境问题）；CI 上应全绿
  （说明）worktree 与主仓库本机均红；若 CI 也红需另行立案
  <!-- id: moss-auto-env -->

## 人工核验：Launcher 转写（需真实 MOSS_API_KEY）
<!-- id: moss-manual-launcher -->
<!-- badge: todo 待核查 -->

以下各项需要真实 Key 与真实多人音视频；建议先用 2 分钟片段（快速测试），确认响应形状后再放全片。媒体会上传到模思智能开放平台，注意素材敏感度。

- [ ] **供应商与模型入口可见**
  （操作）Launcher → 设置 → 供应商下拉，查看「MOSS（模思智能 / 说话人分离）」（豆包之后）
  （预期）条目存在；选择后仅显示 MOSS 转写选项（Pro 模型）、Key 输入与平台直达链接；语言选择隐藏
  <!-- id: moss-launcher-entry -->

- [ ] **Key 保存与掩码回显**
  （操作）MOSS 供应商 → 填写 API Key → 保存配置 → 重启 Launcher
  （预期）`.env` 写入 `MOSS_API_KEY=`；重启后 Key 状态显示掩码（`前3…后4`）；Key 输入框下方两行提示可点击：「在 MOSS 控制台 获取或查看 API Key ↗」与「在 MOSS Create 可领取免费积分 ↗」，分别打开控制台与积分页
  <!-- id: moss-launcher-key -->

- [ ] **keyterms 表单与校验**
  （操作）MOSS 供应商 → 高级选项 → 热词（Keyterms）：分别输入 21 个词、一个 31 字词、正常 2–3 个词
  （预期）超 20 个或超 30 字时启动被拦截并红字提示（moss_keyterms_too_many / moss_keyterm_too_long）；编辑输入后错误即时清除
  <!-- id: moss-launcher-keyterms -->

- [ ] **超长句段按断句设置拆分**
  （操作）转写同一段含长句的素材（如开场致辞），检查超长句段的拆分结果
  （预期）超过「最大字数」的句段按标点拆成多条 ≤ 上限的字幕，说话人标签保留；日志出现「正在按标点/字数设置拆分 N 个超长句段」与「吸附到语音能量谷」；段内切点是插值近似，个别不准处可在编辑器微调或用对齐模型补齐
  （说明）2026-11-19 维护者实测发现 94 字长句未拆分（`仙术杯开场.moss-pro.mosp`）后补上该环节
  <!-- id: moss-launcher-split -->

- [ ] **小段多人音频端到端**
  （操作）选一段 2 分钟左右的双人对话视频 → 勾选快速测试（或手动 `-ll 2m`）→ 生成
  （预期）日志出现 `[moss] 任务已提交: task_id=...`、等待心跳与完成耗时；产出 `.mosp` + `.srt`，字幕带说话人（工程设置可见 speaker 列表），时间码与语音对齐
  （说明）输出为段级时间码（无字词块）；需要字词时间码时另跑对齐模型
  <!-- id: moss-launcher-e2e -->

- [ ] **keyterms 提升专名识别（可选）**
  （操作）同一段素材分别在不加 / 加含专有名词的 keyterms 下转写，对比专名处文字
  （预期）keyterms 后专名（人名 / 品牌 / 术语）识别更稳；两次结果差异只在预期词附近
  <!-- id: moss-launcher-keyterms-effect -->

- [ ] **按说话人配色**
  （操作）勾选「按说话人配色」→ 重新生成 → 打开编辑器
  （预期）不同 speaker 的字幕块带不同颜色快照（≤5 色循环）；编辑器中可改色
  <!-- id: moss-launcher-colors -->

- [ ] **长音频超限报错**
  （操作）选一段超过 60 分钟的媒体（或临时构造）→ 生成
  （预期）提交前红字报错「超过 MOSS 单次任务上限（60 分钟）」，提示 `-ll` 或分割，不发起上传
  <!-- id: moss-launcher-limit -->

## 人工核验：公开 CLI
<!-- id: moss-manual-cli -->
<!-- badge: todo 待核查 -->

- [ ] **公开 CLI 基本转写**
  （操作）PowerShell 运行 `.\MAW.exe --provider moss -i "clip.mp4" -o "clip-moss.srt" -ll 2m`（源码用 `uv run --no-sync python maw_gui.py ...`）
  （预期）同 Launcher 路径产出 SRT + `.mosp`；`--hotword` 等价 keyterms 生效
  <!-- id: moss-cli-basic -->

- [ ] **公开 CLI 拒绝不支持参数**
  （操作）运行 `.\MAW.exe --provider moss -i "clip.mp4" --language zh`，再试 `--region beijing`
  （预期）两次均报参数错误退出码 2，提示 MOSS 仅支持 `--model`、`--hotword/--keyterm`、`--speaker-colors` 与通用参数
  <!-- id: moss-cli-validation -->

- [ ] **模块命令调试输出**
  （操作）运行 `uv run --no-sync python -m maw.asr.moss "clip.mp4" --debug-raw -ll 2m`
  （预期）媒体旁生成 `.asr-response.json`（任务查询原始返回），可核对 segments / speaker / duration 与官方文档一致
  （说明）此文件含转写文本，分享前脱敏
  <!-- id: moss-cli-debug -->

## 后续操作
<!-- id: moss-next -->
<!-- badge: todo 待核查 -->

- [ ] **实测后回填勾选与状态**
  （操作）核验完成后把上述各项改为 `- [x]`，front-matter `status` 改为 `partial` / `passed`，随任务提交
  （预期）`build.py --scan docs/logs` 能汇总到最新状态
  <!-- id: moss-next-status -->

- [ ] **实测发现的偏差立案**
  （操作）若真实响应与解析假设不符（segments 字段 / 时间单位 / speaker 格式），在 `docs/logs/release1.11.3/261119_MOSS云端供应商/` 下补记录并修复
  （预期）修复带回归测试（先红后绿）
  <!-- id: moss-next-issues -->
