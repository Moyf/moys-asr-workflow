# ASS 默认动画与 1.11.2 发布

日期：2026-11-11。起始分支：`main`，HEAD：`5fb70d88`；工作区干净，与缓存的 `origin/main` 对齐。发布前另行 fetch 核对远端。

维护者授权：追查默认动画改变的首次发布版本，恢复默认不勾选，发布 `1.11.2`；补丁版 Release Notes 附上同系列 `X.Y.0` 特性，分为「修复版本说明」「大版本更新特性」。不覆盖已有工程或用户主动保存的动画选择。

状态仅使用：`待处理`、`进行中`、`已修复`、`仅说明`、`阻塞`。

| 条目 | 问题 / 请求 | 状态 | 核实结论 / 方案 |
| --- | --- | --- | --- |
| 1 | 查明 ASS 输出方案默认勾选 `\fad` 是哪个版本改掉的 | 仅说明 | 首次发布为 **v1.8.0-beta.1（2026-10-02）**，PR 166：该 tag 上提交 `21e4bb5e`，当前 main 等价提交 `5dd56110`。v1.7.0 前后端默认 false，v1.8.0-beta.1 前后端默认 true。历史提交经过重写，因此不能仅按当前 main 提交的 `git tag --contains` 判断首次发布。 |
| 2 | `\fad`、放大出现恢复默认不勾选 | 已修复 | 前端与 Python 后端 fad 同步为 false，pop 保持 false；默认参数不变。357 项 utils、90 项 ASS 专项、Python 样式回归及 5 项浏览器契约通过；存量 true/false 不覆盖。 |
| 3 | 补丁版 Release Notes 附上大版本更新信息 | 已修复 | 沿用 release-base，一级标题「修复版本说明」「大版本更新特性」展示补丁与同系列 X.Y.0；基础正文仅一次且图片 pin 到基础 tag。所有新补丁必须填写 base，历史无 base/主要版/beta/rc 保持结构；已更新生成器、测试及发布约定，真实 1.11.2 预览已检查。 |
| 4 | 发布 `1.11.2` | 进行中 | 发布准备通过，独立审查无 blocker/major；全量 Python 3087 项（31 skips）及 ASS export 整份 spec 21 项通过，修复 reset 测试缺口后定向复验通过。准备提交并触发 tag 发布，以远端附件和官网证据收口。 |

## 阶段汇总

### 起始记录

- 请求已落盘；尚未修改业务代码、创建提交或发布。
- 当前日志基线为 `1.11.0`；成功发布后再更新基线提示。

### 续 1：历史溯源

- `git show v1.7.0:web/editor-utils.js` 与 `git show v1.7.0:maw/ass_styles.py` 均为 false；`git show v1.8.0-beta.1:web/shared/utils/ass-style.js` 与对应 Python 文件均为 true。
- `git log -G 'fad:.*enabled:' v1.8.0-beta.1 -- web/shared/utils/ass-style.js web/editor-utils.js` 定位 `21e4bb5e`；GitHub Release API 核对 v1.8.0-beta.1 实际发布于 2026-10-02。
- 已告知维护者：恢复内置默认不强制清除存量方案勾选；存量 true 需主动取消。

### 续 2：修复与分层验证

验证基线：`main@5fb70d88` + 本任务未提交文件。以下记录 ID 都位于 `.artifacts/checks/<ID>/result.json`，只保留相对路径；原始日志不入库。

| 层 | 命令（统一在 `uv run --no-sync python scripts/run_check.py --timeout <秒> --` 内） | 结果 / 记录 ID |
| --- | --- | --- |
| 旧红新绿：Python | `uv run --no-sync python scripts/run_tests.py tests/test_ass_styles.py tests/test_release_notes.py` | 旧逻辑 38 项 3 失败：`20261111T071116Z-ccf07cba`；修复后 38 项通过：`20261111T071141Z-e7924229`。 |
| 旧红新绿：Node | `node --test --test-name-pattern 'browser and server ASS defaults\|default ASS profile\|explicit ASS fad\|default-off ASS' tests/test_editor_utils.mjs`；修复后完整 utils | 旧逻辑 4 项 3 失败：`20261111T071116Z-716b9463`；修复后 357 项通过：`20261111T071141Z-a299c2ac`。 |
| ASS 专项 | `node --test tests/test_ass_animation.mjs tests/test_ass_canvas_layout.mjs tests/test_ass_cue_position.mjs tests/test_ass_cue_style.mjs tests/test_ass_shake.mjs tests/test_editor_export_srt.mjs` | 90 项通过：`20261111T071237Z-c73d8d5a`。 |
| 构建与类型 | `node scripts/build-editor.mjs --write`、`node scripts/build-launcher.mjs --write`、`pnpm.cmd run check:editor`、`node scripts/build-launcher.mjs --check`、`node node_modules/typescript/bin/tsc -p web/tsconfig.typecheck.json` | 通过：editor `20261111T071219Z-685c88fb`、launcher `20261111T071050Z-693a769b`、editor check `20261111T071251Z-c6d34ee5`、launcher check `20261111T071148Z-633f1197`、类型 `20261111T071102Z-84b78284`。 |
| 脚本与波形 | `node --test tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs tests/test_waveform_js.mjs` | 68 项通过：`20261111T071148Z-34bc0ca0`。 |
| 浏览器 | `node node_modules/@playwright/test/cli.js test --config=tests/config/playwright.config.mjs tests/e2e/ass-export.spec.mjs --project=chromium --reporter=line -g 'English builtin reset\|exports ASS from the default profile style\|exports speaker-only ASS label\|3840\|gap-removed'` | 实际选中 4 项通过：`20261111T071410Z-c151449b`；reset 取消/确认、默认无动画导出、说话人着色、去空隙导出。局部通过不等于整份 spec 通过。 |
| 浏览器三轨 | 同上改 `tests/e2e/multi-subtitle.spec.mjs -g 'ASS export gates extension cues'` | 1 项通过：`20261111T071523Z-e225242a`；此既有用例显式开启 fad，保留跨分片时钟验证意图。 |
| 打包契约 | `uv run --no-sync python scripts/run_tests.py tests/test_packaging_contract.py` | 38 项通过：`20261111T071217Z-33fa9afc`，不等于本地真实打包。 |
| 发布/网站契约 | `uv run --no-sync python scripts/run_tests.py tests/test_release_site.py tests/test_release_publication.py tests/test_diagnostics.py` | 25 项通过：`20261111T071236Z-04941fd4`。 |
| 归档 / 元数据 | `scripts/prepare_release_notes.py --check-all`、`scripts/sync_launcher_version.py --check` | 20 份正式归档通过：`20261111T071523Z-69678ba4`；版本 1.11.2 一致：`20261111T071102Z-e4808cb1`。 |
| 发布内联副本 | `uv run --no-sync python edit.py --blank` | 按明确发布授权生成：`20261111T071410Z-713d6d06`；204 行统计变化，未输出全文 diff。 |
| 文档 / 路径 / diff | `scripts/check_docs.py`、`scripts/check_personal_paths.py`、`git diff --check` | 均通过：`20261111T071358Z-48206259`（6 条既有日志索引 warning）、`20261111T071523Z-ae952993`、`20261111T071523Z-3e2f3fb8`。 |

环境及执行偏差：`pnpm` 经 Python 原生命令启动未找到 shim（主会话 `20261111T071050Z-1a0c7375`、实现代理 `20261111T071237Z-a83e1e2b`），改 `pnpm.cmd` 或直接 Node 入口后通过；Node 本机 22.23.2 低于文档建议 22.23.4，相关检查通过但发布使用 CI 规定版本。主会话两次写错不存在的测试文件名 `test_launcher_version.py` / `test_publish_release.py` 导致 import error（`20261111T071148Z-ce08d667`、`20261111T071217Z-ab50e277`），随后按实际文件名单独重跑对应层通过，未改代码迎合误命令。

锁文件：本机旧 uv 离线 lock 会把 revision 5 降为 3 并产生大量平台 marker 改写；已仅撤回本任务产生的格式噪声，保持原依赖版本、图与格式，只同步项目版本（原锁为 1.11.0，本次改到 1.11.2）。没有同步共享 venv。

浏览器截图：ASS 输出方案表单已实测两个开关均未勾选，截图自查完成；本次不改布局/间距。截图留在本地产物，不入库。

远端先例：v1.11.1 运行 `42966096200` 的 Windows/macOS/Linux 构建和 Publish 均 success，官网步骤 `Verify deployed release index and detail` 因目录未赶上 v1.11.1 失败。本次必须分别报告安装包发布与官网同步，不把总 workflow failure 直接误判为包未发布。

### 续 3：浏览器双向回归与核验页

- 将本任务的前后端 fad 默认临时恢复 true 后，新增的默认复选框断言与既有默认 ASS 导出断言均真实失败（2 项）；try/finally 已恢复两端 false 并重建 bundle。旧红 `20261111T071745Z-80338be8`，外层脚本 `20261111T071744Z-2716428c`；固定逻辑重跑 2 项通过 `20261111T071815Z-17028db5`。这是预期的回归证据，不是遗留失败。
- 人工清单 `1.11.2.checklist.md` 校验通过 `20261111T071735Z-2e182977`，HTML 生成通过 `20261111T071735Z-943c4586`；本地产物 `.artifacts/release1.11.2/verification.html`，源清单入库、HTML 不入库。
- 核验页浏览器打开、桌面 1280px 与窄屏 375px 均无根横向溢出，可见文本最小计算字号 12px；精简后操作行 4→0、核对项 4 保持、首项高度约 152.3→40.8px。浅色桌面/窄屏与深色精简截图自查完成，本次未改工具模板；所有核对项仍待人工确认。
- 第一次全量 Python 串行在 240s 超时（退出 124）且 runner 尚无可用摘要：`20261111T071432Z-c3937ad6`，不能记为通过。run_check 已回收该进程树；按文件并行 4 workers 改用 480s 上限与 JSON 报告，待实际结果，不重复重建环境。

### 续 4：发布前放行

- 按文件并行全量 Python：148 文件、3087 项、0 failure/error、31 skips，95.6s，退出 0；`20261111T071900Z-ce8f1e4b/result.json`，结构化报告 `.artifacts/release1.11.2/python-full.json`。跳过原因包括本机缺 NumPy/soundfile、POSIX/macOS 专属、bash 不支持本机路径及真实对齐素材未提供；不能把这些跳过边界记为通过。
- ASS export 整份 spec **21 项通过**：`20261111T071953Z-046c432b/result.json`，包含全部本次修改的默认输出、颜色、去空隙等用例；不代表全量 e2e。三轨定向 1 项证据保留。
- 独立审查完成，无 blocker/major/实现缺陷；minor 为 reset 测试未先勾选两个开关，已补先勾选→取消保持 true→确认恢复 false，1 项实测通过：`20261111T072146Z-ae8bfe2f/result.json`。nit 为审查时新清单未登记，已补入口；审查报告见 `REVIEW_FINDINGS.md`。
- 对 warning 的历史描述校正：审查时新增清单曾产生一条本次 warning，不能记为既有；补入口后的文档复验 `20261111T072146Z-4ca40fae/result.json` 只剩 6 条旧日志入口 warning，与此前主会话检查一致。本次清单和复核均已登记。
- 清单已同步全量和独立结论并重新生成 HTML：`20261111T072146Z-09f974e6/result.json`；人工打勾项仍 pending。
- 最后编辑器 bundle 新鲜度与发布归档通过：`20261111T072032Z-ff62886b/result.json`、`20261111T072033Z-d5bea609/result.json`。fetch 后 main 与 origin/main 0/0，v1.11.2 远端 tag 尚不存在。
