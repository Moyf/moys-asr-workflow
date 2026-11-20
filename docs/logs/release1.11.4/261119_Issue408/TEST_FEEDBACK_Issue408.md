# Issue 408 核对

基线：`Moyf/bug-maw-launcher-1.11.4-requirements-hash` @ `ba0a9847`，开始时工作树干净。
先记录后调查。状态：`待处理` / `进行中` / `已修复` / `仅说明` / `阻塞`。

| # | 问题 | 状态 | 核实结论/方案 |
| --- | --- | --- | --- |
| 1 | [Issue 408](https://github.com/Moyf/moys-asr-workflow/issues/408)：「看下这个什么问题？我们有吗，需要修吗」「要修的话你修掉」；Windows 1.11.4 CPU ASR 安装报镜像缺版本／SHA-256 不匹配。 | 已修复 | `maw/runtimes/base.py` 保留锁和哈希；缺候选或哈希错误会回退已允许的官方源一次，未经 `MAW_PIP_INDEX` 配置不会将显式源换成官方。安装日志记录实际清单路径、修改时间和来源。 |
| 2 | 在设置里点击安装，但失败提示在主界面，用户找不到。 | 已修复 | 设置打开时在其中展示既有错误卡，可直接复制报告；关闭设置后错误卡回到主界面。取消只更新状态和日志。 |
| 3 | [PR 409 外部审查](https://github.com/Moyf/moys-asr-workflow/pull/409#issuecomment-7027148046)：官方源失败后丢失候选。 | 已修复 | 官方源只试一次，因网络失败时继续原限额内的候选；重用同一份清单及哈希。 |
| 4 | PR 409 外部审查：重开设置看不到仍有效的安装错误。 | 已修复 | 重开设置会移入现有本地安装错误卡并保持复制状态；不重建报告、不影响其他错误。 |
| 5 | PR 409 外部审查：共享安装器与取消显示的范围。 | 仅说明 | ASR、OCR、MOSS 共用安装换源；仅本地 ASR 的取消不显示失败卡。这两项不是额外缺陷，更新 PR 时注明。 |
| 6 | 「继续查看和修复 CI 失败以及评论的审核，然后评论并解释原因和修复的内容。」PR 409 的 Blocking / website 与 Change acceptance 失败。 | 已修复 | 官网 `local-asr.md` 生成副本滞后；使用同步脚本更新。本地官网检查同步前失败、同步后通过；远端门禁待新提交验证。 |
| 7 | [PR 409 新审查](https://github.com/Moyf/moys-asr-workflow/pull/409#issuecomment-7029201288)：pip 超时输出仍能提前中断候补。 | 已修复 | 以同源同包的访问结果区分超时与缺包；extra 提供旧版本不覆盖主源网络错误。真正缺候选与哈希失败规则不变。 |

## 阶段汇总

- 续 1：确认本分支有同样的换源缺口和错误展示缺口，实施前两个入口文件与 `v1.11.4` 相同。起初只有反馈摘要，尚无法确认锁定版本。
- 续 2：下载官方 1.11.4 Windows Lite ZIP，只读 `_internal/local-runtime/requirements-local-cpu.txt`（Windows 发布流水线从同一构建复制 Lite，完整版再加入 FFmpeg）。确认确实锁定 `cloudpickle==3.1.3`、`filelock==4.2.12`、`regex==2026.11.18`；前两组预期哈希也与 Issue 摘录一致。后续降级的版本和原版哈希并非同一批文件，校验失败不能证明镜像篡改，也没有证据显示启动器重写了清单。
- 续 3：逐个查官方 PyPI 版本元数据并下载对应 wheel（未执行）。三个锁定版本均存在，三个 Windows CPython 3.11 兼容 wheel 的实测 SHA-256 全部命中发布包 CPU 清单。核对时，反馈提到的阿里云、清华 simple 索引也已列出三个版本；当前快照不能追溯用户安装时的镜像响应，也不等于整个运行环境安装验收。
- 续 4：将两个有包名的 `Got` 值与官方 PyPI 元数据比对，分别精确匹配旧版 `cloudpickle-3.1.2-py3-none-any.whl` 和 `filelock-3.32.3-py3-none-any.whl`。这两处是旧版本与原版哈希配对造成的，不是镜像改包；第三个未标包名的哈希不下结论。
- 1.11.4 临时处理：若手工改过清单，先恢复原版；在能访问官方 PyPI 的终端给启动器进程设置 `MAW_PIP_INDEX=https://pypi.org/simple`，重启后重试，保留 SHA-256 校验。
- 续 5：`uv run --no-sync python scripts/run_tests.py tests/test_runtime_mirror_retry.py tests/test_runtime_mirror_picker.py tests/test_runtimes.py tests/test_freezer.py tests/test_packaging_contract.py`：145 通过、1 跳过；旧逻辑在官方源未入测速前三、显式源测速全失败两项新增用例上失败。未用修复版 Windows 安装包进行完整首次安装。
- Launcher Python / 素材契约：本 worktree 环境缺 `send2trash` 和 `requests`；核对 `uv.lock` 一致后只读复用主仓库解释器。调齐安装按钮的静态断言后，`scripts/run_tests.py tests/test_gui_web.py`：339 通过、1 跳过。另跑 local / OCR / MOSS 和进程清理四个 test 文件，47 通过。TypeScript 类型检查通过。
- 续 6：`tests/e2e/launcher-interactions.spec.mjs` 定向 Chromium 9/9，Launcher Node 63/63；新用例在旧版因设置内没有错误卡而失败。完整 76 项 Launcher e2e 达到 160 秒上限，未验证整组。Launcher bundle 重建与 `pnpm run check:launcher` 通过。已检查 480×560 设置截图，卡片上下间距分别为 24 / 12 px，长详情未挡住动作按钮。没有实跑打包版安装或 Windows WebView2。
- 续 7：[提交前审查](REVIEW_FINDINGS.md) 两项已修并补回归：PyTorch 警告不阻断换源，安装成功只清本次安装类错误。最终运行时及打包定向检查 147 通过、1 跳过，定向 Chromium 12/12，Launcher Node 63/63。
- 续 8（2026-11-20，`a63b287d`）：模拟 A 缺包、官方 PyPI 403、B 可成功，实际只调用 A 和官方即报候选耗尽（检查 ID `20261120T013308Z-05a02441`）。源码确认 `closeSettings()` 把错误移回主窗口，而 `openSettings()` 不移回；未实测原生 WebView2。本轮仅核对，产品代码未改。下一步修条目 3、4 并分别加入回归。
- 续 9：同一模拟现在依次尝试 A、官方 PyPI、B，B 能成功（检查 ID `20261120T014043Z-a9583435`）。重开设置的新回归只触发一次失败，旧版找不到卡片，修后可再次访问同一报告；定向 Chromium 9/9、Launcher Node 63/63。480×560 截图确认卡片上下间距为 24 / 12 px。未跑真实联网首装或原生 WebView2。
- 续 10：独立审查复现 B 也缺包时 C 未被尝试；已补齐并验证 A 缺包 → 官方 403 → B 缺包 → C 成功。同一轮最终 Python 定向检查 488 通过、2 跳过。
- 续 11（`acf72825`）：CI `44655807049` 的官网任务报 `src/pages/docs/local-asr.md` 过期，导致总门禁连带失败。用 `pnpm --dir website run check:docs` 本地复现，再运行 `pnpm --dir website run sync:docs`；重跑检查通过，生成副本仅此一处有变更；发布站预览和官网构建也通过（输出 46 页）。
- 续 12：完整 pip 输出的超时回归旧版失败、修复后通过；提交前复核另捕捉了 extra 提供旧版本的场景，现已修复并通过独立复验。真实 pip 26.2.1 的 loopback 记录覆盖超时、403/429、主源恢复与 404。真实外网首装未验证。
