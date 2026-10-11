# 编辑器与 Launcher 反馈收尾（2026-10-11）

状态：已修复。用户已授权补齐中断任务并创建 PR；此次不合并 PR、不发布版本。

## 基线与整合

- 恢复基线：本地 `main` 的 `20c8ede6`，35 个修改文件、2 个未跟踪文件、暂存区为空。
- PR 分支：`feat/editor-layout-toolbox`，保留本地 `ce187978` / `20c8ede6` 的供应商文案与配置行为。
- 已整合远端 main `14204d39`（含 #212 / #215 / #217）。源码自动合并，Editor 生成物冲突经源码重建解决；未覆盖上游标记门控、设置搜索及双语对比度修复。
- Editor / Launcher bundle 与 `.meta.json` 已重建。仓库 `blank-editor.html` 未重生成，内联副本待发布前统一重生成；便携验证仅生成临时页面。
- 验证针对上述整合 HEAD 与本次待提交文件。最终提交 SHA 由 PR 展示；所有日志位于忽略目录，不纳入提交。

## 原始反馈与结果

| # | 原始需求 | 状态 | 实现与证据 |
|---|---|---|---|
| A | 双语 + 叠加字幕在 192px 添加并恢复后不要重叠 | 已修复 | 双语 overlay 放在主轨上方，实测间距 1px；创建、撤销、重做浏览器回归通过。64px cover 与主轨同位且保持在行内，隐藏 overlay 徽章 |
| B | 高行高字词与句块等高并保留句块全功能；双语/低行高沿用 compact，但加高垫底句块 | 已修复 | full 两层各 35px，句块高亮与整体拖动/撤销通过；双语 compact 句块 44px、字词 31px，顶部露出 11px；compact 无双重描边，选中亮度 0.45，选中后边界手柄可用 |
| C | 字词码每行长度默认 5 秒，启用应用、关闭恢复 | 已修复 | 提供真实 `setSecondsPerRow`，控件同步、持久化和行缓存失效均验证；两个模式共用原始行高，最近启用者优先，关闭后恢复剩余模式或原始值；所有开关顺序与工程模式变化有单测 |
| D1 | 移除设置 section 的 gap 8px 与 group 的 gap 16px | 已修复 | 移除全局 gap；关于页及波形设置标题用局部间距，两个波形标题后实测 ≥8px，中英设置间距回归通过 |
| D2 | 双语显示方式与行高一行显示；管理保留 gap；新增字词预设组 | 已修复 | 两列 grid 在正常设置窗口同一行，窄屏降级；管理按钮间距 10px；字词行高与每行长度可即时生效 |
| E | 独立双语设置标签页与波形双语/重叠开关 | 已修复 | 快捷按钮复用原开关，状态镜像；工程设置将双语显示/联动/管理提取为独立页面 |
| F | 独立「导入 ▾」菜单 | 已修复 | 与打开工程按钮分离，复用既有导出菜单键盘/ARIA 接线；Server 与便携模板契约通过 |
| G1 | 高级编辑中的「播放预览」成为跳转并闪烁的 inline action | 已修复 | 接入共享跳转处理，目标为播放预览页的跳转步长；交互入口保留人工核对 |
| G2 | 跳转闪烁由三次改为两次 | 已修复 | 两次亮起，总长 1.2 秒；视觉节奏保留人工核对 |
| L1 | AI 整理独立选择并记忆供应商，手动/自动使用一致 | 已修复 | `ai_cleanup` 独立记忆，刷新恢复；实际保存计划与手动请求都使用独立选择，专项浏览器回归通过 |
| L2 | 本地模型无需密钥提示与统一模型设置入口、整理说明 | 已修复 | 中英文状态区分已加载密钥/本地免密钥/缺少密钥；供应商 label→select 间距 8px |
| L3 | 删除内部 ID / 时间槽真源说明 | 已修复 | 模板及对应 CSS 删除，契约更新 |
| L4 | 带 AI 标记工程默认启用 marker 轨 | 已修复 | 启动/导入带标记工程自动启用，仅本次内存状态；手动关闭保留数据并取消未完成标记拖动，门控与 AI 复核用例通过 |
| L5 | 切工具标签隐藏结果/流输出，切回保留 | 已修复 | 结果与流输出分别归属原工具，隐藏期间继续按 operation 累积；普通结果不显示空模型输出，新任务与取消事件隔离；实际浏览器切换探针通过 |
| L6 | AI 两入口执行后滚动到工具箱顶部 | 已修复 | 使用共享滚动函数定位输出区，真实入口已执行；主观滚动体验保留人工核对 |
| L7 | 自动后处理与手动执行错误文案分开 | 已修复 | 自动 `postprocess_failed` 换行给出失败原因；手动用 `toolbox_failed`，后端与中英文 UI 契约通过 |
| L8 | 结果名称统一「[文稿匹配 (AI)]」 | 已修复 | 中英文结果标签已同步 |
| L9 | 关于链接、GIF 与署名 | 已修复 | Server 白名单加载 200，便携页内嵌 GIF 并离线解码，宽 338px；源码资源随提交，链接按用户给定内容接入 |
| L10 | 工程设置基础/字幕/功能导航分组 | 已修复 | 三组导航与英译已接入，原设置搜索回归通过 |
| H1 | 波形 ⚙️ 左侧「ASS 字幕模式」，启用时左侧显示 🎨 样式库入口 | 已修复 | 状态与工程设置/撤销同步，实际点击打开样式库，两个按钮间距实测 8px |
| H2 | 字幕样式移到字幕轨道上方；🔤/🔖 改为字词/标记；去掉重做右侧分隔线 | 已修复 | 导航顺序、文字与模板更新，专项浏览器回归通过 |
| Q1–Q5 | 英译、间距、回归、CHANGELOG、上游整合收尾 | 已修复 | 新文案均有英译，全部 bundle 新鲜；以下分层验证通过，CHANGELOG 按整批用户体验汇总 |
| Q6 | 工作区持久化测试 WinError 5 | 仅说明 | 工作区临时目录内全量测试曾在不同原子重命名处偶发 WinError 5；单测正常权限通过，系统标准临时目录下完整套件通过。没有改动持久化/导出生产逻辑；不能确定外部锁来源 |
| N1 | 真实媒体、打包与远端 CI 边界 | 仅说明 | 使用合成媒体及 mock 模型请求；没有调用付费模型，没有构建安装包或发布版本。真实媒体播放/听感和维护者人工确认见仓库外清单；CI 以 PR 当前状态为准 |

没有剩余待处理、进行中或阻塞的开发项。

## 最终验证账本

全部测试经 `scripts/run_check.py` 执行，使用现有 venv；Python 全量使用系统临时目录。跨语言 Node 指定 `MAW_TEST_PYTHON`，e2e 指定 `MAW_E2E_PYTHON` 和已安装的 Chromium。服务均在 finally / afterAll 中关闭。

| 层 | 命令或范围 | 结果 | result.json |
|---|---|---|---|
| Node | `node --test`：editor script syntax/order/utils、waveform、word timing、display presets、launcher feedback | 430 通过 | `.debug-runs/20261011T100206Z-f876f0f3/result.json` |
| Python | `.venv/Scripts/python.exe scripts/run_tests.py` | 1962 项完成，27 跳过，其余通过 | `.debug-runs/20261011T101223Z-75782566/result.json` |
| Chromium 基础回归 | overlay-track、markers-batch、bilingual-label-contrast、launcher-file-errors、launcher-provider-memory | 各文件全部通过（在首次 119 项批次中） | `.debug-runs/20261011T100301Z-d71cd95a/result.json` |
| Chromium 设置 | settings-structure 完整文件 | 31 通过 | `.debug-runs/20261011T101241Z-06545b7f/result.json` |
| Chromium 字词/标记 | word-timing、marker-editing-gate 完整文件，另定向复核新增 overlay 历史 | 41 通过 + 最后 1 项修正焦点后通过；合计全部 42 项通过 | `.debug-runs/20261011T101138Z-2bd78274/result.json`、`.debug-runs/20261011T101404Z-534c9568/result.json` |
| Chromium AI 生命周期 | launcher-interactions 的 AI cleanup / AI llm 用例 | 7 通过 | `.debug-runs/20261011T100515Z-e313e0eb/result.json` |
| UI 实测探针 | 双语几何、预设、英译、流输出、便携 GIF | 全部断言通过，截图自查 | `.debug-runs/20261011T100840Z-174bd8d5/result.json` |
| Ruff | `.venv/Scripts/ruff.exe check` | 通过 | `.debug-runs/20261011T101356Z-25d8c7dc/result.json` |
| 类型 | `tsc -p tsconfig.typecheck.json` | 通过 | `.debug-runs/20261011T101357Z-39744151/result.json` |
| Editor / Launcher | `node scripts/build-editor.mjs --check` / `build-launcher.mjs --check` | fresh | `.debug-runs/20261011T101358Z-99fdea77/result.json`、`.debug-runs/20261011T101359Z-6bca07aa/result.json` |

Chromium 为分批验证，合计覆盖 128 个受影响用例；未以第一次失败批次冒充全绿。原 overlay ASS layer 与 Ctrl+drag 两项在整合 #215 后的完整 overlay 文件中通过。新增 overlay 历史用例第一次失败是新建后焦点仍在输入框、键盘触发原生撤销；改用工具栏工程历史动作后通过。

初次全量 Python 中旧供应商文案、设置页数量、关于占位链接与内联双语区块断言已更新，并在最终全量中通过。Node 初次未指定解释器引发 uv 缓存权限失败，设置现有 Python 后全部通过。暂存前另核对 LF、`git diff --check`、生成物和文件范围；不纳入调试日志、截图、合成媒体或仓库外人工清单。
