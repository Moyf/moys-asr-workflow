# 本地模型目录误判修复：独立复核

基线 main `5618b9bb`（分支已合入 1.10.0-beta.2 后的 main）。独立审查由未参与实现的后台 subagent 通读 `git diff main` 全量（10 文件，含未提交工作树改动）完成，实现者只回答提问。结论：**代码逻辑无 blocker / major**；1 项 major 属文档位置问题（merge 带位），已修复；2 项 nit 为接受的风险、1 项 nit 已顺手修复，逐条记录如下。

| 级别 | 发现与证据 | 处置 |
| --- | --- | --- |
| major | CHANGELOG 条目被 merge 带进已发布的 `## [1.10.0-beta.2]` 小节（该 tag 已存在、Release notes 不含本修复），下次归档 `[未发布]` 时条目会丢失 | **已修复**：整条移回 `[未发布]` 🐛 修复，并补上仓库根解析的用户可感知描述 |
| nit | 日志目录与索引行写「1.10.0-beta.1 之后」，与 INDEX 头部 `log-release-baseline: 1.10.0-beta.2` 矛盾（分支早于基线切换开工，merge main 后未跟随） | **已修复**：目录移至 `release1.10.0-beta.2/261026_本地模型目录误判/`，索引行同步 |
| nit | 「最新修订 config 损坏 + 次新修订完整」时，结构校验按首个含 config 的候选整体拒绝，不像修订解析那样跳过坏修订（maw/local_models.py `_hf_explicit_structure_error` vs `_explicit_model_dir_with_marker`）。后果是保守报错、不会假 installed，仅提示语略不精确，触发条件苛刻 | **接受的风险**：保留保守拒绝方向，不改 |
| nit | resolved 路径只在「刷新回填输入框」一环到达引擎；refresh 响应落地前点开始，引擎仍拿原始输入值（formPayload 直接读输入框）。与 main 完全对等的旧行为，非本次引入，UI 下窗口期可忽略 | **接受的风险**：不改；如将来出现实际误触发再收口 |

复核确认无问题的方面：解析与候选顺序（与结构校验共用 `_config_marker_candidates`，顶层优先、修订 mtime 新→旧、候选须「标志 + 权重」同层，全缺权重返回 None 报 `path_invalid`）；symlink 跟随与 OSError 兜底；firered / 未知引擎回归面（不走标志校验）；`_installed_model_size` 改用 resolved 后统计更准；前端串写修复覆盖全部用户 mutation 路径（键入 / 选目录 / 拖放显式派发 input），程序性填充不更新条目，`save_prefs` 后端剥空条目使清除端到端可恢复；`path_invalid` 状态键与 detail 展示。

双向验证均真实：新增 `ExplicitDirectoryStructureTests` 在 main 代码（导出 main 的 `maw/`+`scripts/` 换入分支测试）上 11 项真实失败；mjs 测试在旧 `launcher-local-models.js` 上 3/3 失败。审查者还用真实上游 config.json 核验关键词匹配（MOSS `moss_transcribe_diarize` ✓、Qwen3 `qwen3_asr` ✓、faster-whisper CT2 config 无 model_type/architectures → 保守放行不误拒）。约定检查：`git diff --check` 干净、无 AI 署名、UTF-8/LF、无个人路径、bundle 未入库、schema 无改动。

CI 备注：PR 的「Preview Windows Release」check 失败为 main 既有问题（`350c3b02` 改 workflow 回默认 merge ref checkout，未同步 `tests/test_packaging_contract.py:779` 断言；在 `350c3b02` 干净 main 工作树上单跑同样失败），与本地模型改动无关，留待 main 侧修正契约测试。内联副本待发布前统一重生成。
