# 文稿匹配修复与对照工具 · 提交前自审

范围：相对 8538c5a0 的全部 diff（文稿匹配三处修复 + `script-match-review` 完整对照工具 + Launcher 入口与打包）。审查方式：逐文件通读 diff，核对行为、边界、回归与仓库约定；证据来自本工作树实际执行。

## 审查结论

独立审查初轮发现 1 个 blocker、2 个 major，均已修复：

- `scripts/mosp_match_text.py`：纯标点字幕不进入字符流；现在纳入保留或重叠告警。见 `test_punctuation_only_source_segment_is_preserved_or_reported`。
- `maw/postprocess_match.py`：合法零时长词项回退到分段匹配，零时长标点仍可走字符匹配。见 `test_zero_duration_word_routes_to_segment_match`。
- `maw/postprocess_match.py`：含主副轨绑定的工程保留原分段和时间，只更正文字，避免绑定失效。见 `test_bound_tracks_keep_original_segmentation_and_references`。

上述三项在修复前的暂存实现上复现（1 失败、2 异常），修复后相关 Python 测试 419 项，418 通过、1 跳过。另修复时间码 Chromium 断言等待条件、工具列表 Markdown 表格中断与超长 item 逐字符拼接开销。同步后的基线为 `f345a896`。

### 核对过的关键点（证据）

- `run_script_match` 行为不变：`match_script_project` 返回 `(标点说明, *warnings)`，写出警告仍含「文稿来源」与标点配置说明（maw/postprocess_match.py:174-195、运行 470 项 Python 测试通过）。
- Launcher 预览与完整对照共用同一次匹配计算（gui_web `_preview_script_match`），打开对照不写盘（tests/test_script_match_review.py 断言目录内无新文件）。
- 导出以整工程为范围：筛选不影响导出内容（test_script_match_review.py `test_restore_whole_overlap_group_and_export_unfiltered_project`，恢复组 + 隐藏组均出现在产物）；`normalize_project` 校验后原子落盘，Windows rename / POSIX `os.link` 均不覆盖已有文件（maw/script_match_review.py `write`）。
- 恢复按重叠组整组进行，颜色/贴图引用 `headIdx` 重定位（`test_restore_keeps_head_references_and_rebases_indexes`）；混排两份快照时优先保留原 ID，避免与匹配器生成 ID 冲突（`adjusted` 内 `reserved` 逻辑）。
- 时间线视口画布 + 宽度撑滚动条的方案上限 8,000,000px，1 小时工程最细 0.5 秒窗口实测可用；滚轮平移不接管 Shift/触控板/修饰键（tests/test_script_match_review_browser.mjs 第 6 项）。
- 打包契约：`MAW.spec` datas 增加 `web/launcher/script-match-review` 与 `tools/shared` 两文件，`test_packaging_contract.py` 通过。

### nit（不阻塞）

- `gui_web.py` `_preview_script_match` 中 `assert source_path is not None`：该分支由前置 `missing_source` 早退保证不可达，断言仅作防御；`python -O` 下会跳过，但该路径在 packaged 运行中不使用 `-O`。接受。
- `script_match_review.py` `write()` 未显式创建父目录：目标路径来自原生保存对话框（目录必然存在）；手工传入不存在目录时以 OSError 报错给 UI。接受。

### 已接受风险 / 未测边界

- 原生保存窗口的人工选址、非 Windows 平台的 pywebview 子窗口行为未自动化（Windows Edge WebView2 已跑通自动冒烟）；列入人工核对清单 `文稿匹配对照.checklist.md`。
- 滚轮平移在真实触控板/精密鼠标下的手感未实测（Chromium 合成滚轮事件已验证方向与页面零滚动）。
- `samples/` 为用户样本，不参与提交与 CI。

## 验证摘要

- PR 423 的 Greptile 两项 P1：已验证修复前完整替换会丢失无可靠匹配的原字幕、时间收窄会丢失颜色与贴图。修复后原句走保留及重叠告警；可靠一对一对应保留样式与 ID，并重映射引用，已变动的时间不复用旧帧号。独立复核无 blocker / major；已补索引实际变化的断言，亦覆盖拆分不复制样式。
- 后续交互：两个对比工具的行内准星仅在当前可见范围超过 30 秒时缩至 30 秒；文稿对照导出按钮下方新增 Launcher 建议，保持现有导出行为。

- Python：470 项（匹配、GUI、导出、打包、对齐）469 通过、1 跳过；全量套件另跑（见 PR 描述）。
- Node：编辑器脚本 440 项通过；`check:editor` / `check:launcher` / `typecheck` / `check:tool-docs` 新鲜。
- 浏览器：对照页 6 项（筛选保留、长表分页与重排计时、说明浮层、翻页无闪动、无缝块可数、缩放与滚轮）；Launcher e2e 1 项。
- 文档：`check_docs.py` 0 新断链；CHANGELOG / TOOLBOX / catalog / tool-docs 已同步。
- `check_personal_paths.py --diff-ref origin/main` 无命中；`git diff --check` 干净。
