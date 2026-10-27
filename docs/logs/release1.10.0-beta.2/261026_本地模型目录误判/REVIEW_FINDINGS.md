# 本地模型目录误判修复：独立复核

基线 main `5618b9bb`（分支已合入 1.10.0-beta.2 后的 main）。独立审查由未参与实现的后台 subagent 通读 `git diff main` 全量（10 文件，含未提交工作树改动）完成，实现者只回答提问。结论：**代码逻辑无 blocker / major**；1 项 major 属文档位置问题（merge 带位），已修复；2 项 nit 为接受的风险、1 项 nit 已顺手修复，逐条记录如下。

| 级别 | 发现与证据 | 处置 |
| --- | --- | --- |
| major | CHANGELOG 条目被 merge 带进已发布的 `## [1.10.0-beta.2]` 小节（该 tag 已存在、Release notes 不含本修复），下次归档 `[未发布]` 时条目会丢失 | **已修复**：整条移回 `[未发布]` 🐛 修复，并补上仓库根解析的用户可感知描述 |
| nit | 日志目录与索引行写「1.10.0-beta.1 之后」，与 INDEX 头部 `log-release-baseline: 1.10.0-beta.2` 矛盾（分支早于基线切换开工，merge main 后未跟随） | **已修复**：目录移至 `release1.10.0-beta.2/261026_本地模型目录误判/`，索引行同步 |
| 修订校验 | 最新修订缺权重时，结构校验与解析结果可能来自不同修订：既可能误拒绝完整的旧修订，也可能把配置损坏或不匹配的旧修订判为已安装 | **已修复**：先选出有权重的目录，再校验该目录；HF 和 FunASR 回归覆盖这一错位 |
| 启动路径 | resolved 路径此前只靠刷新回填输入框到达引擎；刷新完成前开始转写仍会传仓库根目录 | **已修复**：后端预检将显式路径替换为已校验的修订目录，自动发现仍保留原有路径选择行为 |
| 清除目录 | 保存失败期间若用户切换模型或输入新路径，回滚可能覆盖当前输入 | **已修复**：只回滚尚未被后续编辑改变的条目，并只在仍选中原模型时回填输入框 |
| 预览契约 | 只排除两种完整字符串时，改变表达式空格仍可显式检出 PR head，测试却会通过 | **已修复**：检查 checkout 步骤是否显式设置 ref；改变空格的旧行为在变异验证中被拒绝 |

复核确认无问题的方面：解析与候选顺序（与结构校验共用 `_config_marker_candidates`，顶层优先、修订 mtime 新→旧、候选须「标志 + 权重」同层，全缺权重返回 None 报 `path_invalid`）；symlink 跟随与 OSError 兜底；firered / 未知引擎回归面（不走标志校验）；`_installed_model_size` 改用 resolved 后统计更准；前端串写修复覆盖全部用户 mutation 路径（键入 / 选目录 / 拖放显式派发 input），程序性填充不更新条目，`save_prefs` 后端剥空条目使清除端到端可恢复；`path_invalid` 状态键与 detail 展示。

双向验证均真实：新增 `ExplicitDirectoryStructureTests` 在 main 代码（导出 main 的 `maw/`+`scripts/` 换入分支测试）上 11 项真实失败；mjs 测试在旧 `launcher-local-models.js` 上 3/3 失败。审查者还用真实上游 config.json 核验关键词匹配（MOSS `moss_transcribe_diarize` ✓、Qwen3 `qwen3_asr` ✓、faster-whisper CT2 config 无 model_type/architectures → 保守放行不误拒）。约定检查：`git diff --check` 干净、无 AI 署名、UTF-8/LF、无个人路径、bundle 未入库、schema 无改动。

CI 备注：此前「Preview Windows Release」失败源于 `350c3b02` 改回默认 merge ref 后，打包契约测试仍要求旧的显式 ref。当前 PR 已同步该测试；本地修改仍需对应新提交的 CI 验证。内联副本待发布前统一重生成。
