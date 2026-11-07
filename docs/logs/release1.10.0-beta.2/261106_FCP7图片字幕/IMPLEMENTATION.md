# FCP 7 图片字幕实施与验证

分支：`feat/fcp7-png-subtitles`；基线：`29bc204b`。独立工作树，保留原工作区 WIP。
范围与已确定行为见[方案](../../../plans/FCP7_PNG_SUBTITLES.md)。工程实现、自动验证与 VEGAS 14.0 Build 211 核心导入验证已完成；原生导入、342 张快照、保存重开证据见 2026-11-07 记录。文件选择窗口处理丢失素材仍未验证，不以原生 API 的素材替换结果代替该交互。

| 工作项 | 状态 | 证据与下一步 |
| --- | --- | --- |
| 透明 PNG 渲染与像素对照 | 已修复 | 1080p 三轨 XML 重合成、4K / 竖屏四轨重叠对照通过，最大通道误差 3；两小时静止字幕仅一张图。长工程多字幕资源占用仍未测。 |
| 后端批量渲染、任务管理与素材发布 | 已修复 | 真实渲染、重复导出、鉴权、取消、绑定切换、非法 XML、写入失败均有通过证据；缺字形中止，全透明输出拒绝发布。 |
| 前端计划、PNG 模式和多轨 XML | 已修复 | 沿用完整 ASS 计划，动态/静止区间、多轨、两种范围、进度/停止和英文界面已接入并通过浏览器验证。 |
| 自动化与浏览器验证 | 仅说明 | 验证已完成：Node 429 项、Chromium 12 项通过；全量 Python 2777 项中 2771 通过、3 跳过、3 个基线既有失败。明细见最新收尾记录。 |
| VEGAS 主程序安装与实际导入 | 已修复 | 14.0 Build 211 原生导入六组工程并保存重开，342 张实际快照对照通过；界面播放和逐帧定位已确认。 |
| 丢失素材后的文件选择窗口重新链接 | 仅说明 | 原生 API 路径替换及重开已通过；文件选择窗口未覆盖，保留人工核验项。不是导入或透明合成阻塞。 |
| 独立自审与核验清单 | 已修复 | 原有两项 finding 与 VEGAS 路径兼容修复均独立复核；原生 API 证据只读记录，界面确认 4 项，去空隙界面、鼠标移动和缺图文件选择窗口 3 项保留人工勾选。 |

## 2026-11-07：整理上游 PR

### PR 348 复核反馈账本

维护者初轮复核提出前四项，按 `cb697a29` 与实际 CI 结果建立基线；条目 5 为 `87c873cb` 后补充的英文提示反馈。逐项修复并更新同一上游 PR。

| 条目 | 状态 | 证据与下一步 |
| --- | --- | --- |
| 1 主程序包缺少 Pillow | 已修复 | PIL 移出排除表、Pillow 加入主依赖及锁文件；新增契约旧规则下真实失败（`20261107T101436Z-86b4f416`），修复后打包契约 35 项通过（`20261107T101454Z-0811398e`）。发布包启动仍待本轮收尾验证，不据契约推断通过。 |
| 2 Node 测试辅助器错误解析相对导入 | 已修复 | 按导入模块自身目录解析 ./ 依赖，补齐工具提示测试的字幕形式 DOM；原用例复现 ENOENT（`20261107T101636Z-724c7b54`），修复后同用例与其他依赖该辅助器的回归 43 项通过（`20261107T101737Z-e16d2766`）。 |
| 3 英文停止导出按钮未翻译 | 已修复 | 补「停止导出」翻译并断言隐藏时按钮文本；新增断言旧实现失败（`20261107T101803Z-4006c557`），修复重建后 PNG 英文导出与全界面漏译扫描两项通过（`20261107T101845Z-6505c624`）。 |
| 4 Ruff E731 | 已修复 | lambda 改为局部命名函数，帧换算公式不变；旧实现 Ruff 失败（`20261107T101913Z-1b1aa010`），修复后全仓 Ruff 通过（`20261107T102147Z-ae91364c`）。 |
| 5 空轨道导出失败原因漏译 | 已修复 | 新增「所选轨道没有可导出的字幕」→ `The selected tracks have no subtitles to export`。实际 Server 返回原中文原因的 400 响应，英文浏览器失败提示完整翻译且按钮恢复可用；旧实现未满足英文断言（`20261107T144920Z-fe1e148a`），补译重建后通过（`20261107T145108Z-5be117be`），bundle 新鲜度通过（`20261107T145112Z-7494dfb1`）。 |

条目 5 仅新增一条翻译映射。临时浏览器验证 `.artifacts/fcp7-png/check_empty_tracks_en.mjs` 经 `scripts/run_check.py --timeout 90 -- node ...` 执行，使用真实空叠加轨与 Server，不替换 HTTP 响应；夹具、截图和脚本不入库。无需新增持久化测试或变更导出行为；内联副本待发布前统一重生成。

发布包验证：使用已准备环境中的 PyInstaller 6.16.0，直接执行正式 `scripts/packaging/MAW.spec`，仅把 dist/work 输出改到忽略的 `.artifacts/fcp7-png/release-smoke/`。完整 onedir/windowed `MAW.exe` 构建成功（`20261107T101933Z-6b0e21c0`），不是只冻结导入的小探针。独立目录启动实际 EXE 的 `--server`，清除 PYTHONPATH/PYTHONHOME，使用隔离用户数据与空配置路径；编辑器 HTTP、包含 bundle 的页面与正常停止全部通过（`20261107T102259Z-d887bed8`），没有从源码解释器启动 Server。

新增 `scripts/packaging/smoke_editor.py` 并接入 Windows 预览 CI，替换只运行 --help 且超时也放行的旧检查；超时或提前退出均失败，finally 清理仅本次创建的进程。首轮辅助程序错误假设页面必有外部 script，实际页面内联 bundle，因此在成功取得页面后拒绝该次结果；按现行页面检查内联 bundle 后复跑通过（首轮 `20261107T102223Z-f39c9567`，不是产品启动失败）。

Pillow 已在锁文件中解析，只新增主包依赖边及对应 metadata，保留现有版本与哈希；`uv lock --check --offline` 通过。最初离线重新解析因其他可选组的 torch 索引缓存缺失失败，未同步环境或改动可选依赖。

独立复审补齐 Pillow >=10.3.0 的实际 API 下限和 smoke 失败证据上传，两项均关闭，无剩余 blocker/major；`THIRD_PARTY_NOTICES.md` 同步 Pillow 的透明 PNG 合成用途。隔离安装最低声明版本 Pillow 10.3.0（不改共享 venv），实际渲染 14 项通过（`20261107T102926Z-22bf31bd`）。两项新增打包契约对 `cb697a29` 的原 spec/依赖/工作流文本真实失败（`20261107T103038Z-395536dd`），当前完整 36 项通过（`20261107T102854Z-9fdf9679`）。

本轮最终相关验证：

| 层级 | 结果 | `.artifacts/checks/` 下的检查目录 |
| --- | --- | --- |
| 全部 Node 单测 | 1053 项通过，无失败/跳过 | `20261107T102223Z-b122c55c` |
| Python 功能、打包与编辑器装配 | 89 项通过；追加 CI 契约后打包 36 项复跑通过 | `20261107T102223Z-89cbf78f`、`20261107T102854Z-9fdf9679` |
| Chromium | 原生文字 8 项、PNG 4 项、英文全界面扫描 1 项，共 13 项通过 | `20261107T102456Z-36bc8315` |
| Ruff / typecheck / bundle | 全仓 Ruff、类型、编辑器新鲜度均通过 | `20261107T102147Z-ae91364c`、`20261107T102456Z-658616ef`、`20261107T102458Z-101b5345` |
| 文档与路径 | 无新增断链/结构错误，四条历史日志索引警告；个人路径检查通过 | `20261107T102458Z-745dc487`、`20261107T102506Z-92b2c524` |

本轮未重复全量 Python、VEGAS 导入或官网构建；这些层的历史结果与未测边界保留。当前本地证据不能代替随后上游 Linux editor / Windows 预览 CI 的远端结论。

维护者明确授权提交并向 `Moyf/moys-asr-workflow` 创建 PR。功能原提交 `28d72076` 已更新到上游 `main` / `101b5967`，形成 `13c09999`；后续整理只修正文档记录与官网生成副本。此前各轮数据仍对应其原始基线，不将旧全量或 VEGAS 实测改称为当前上游基线的重新执行结果。

独立复核发现官网编辑器指南含 rebase 引入的重复旧段落，已重新运行既有官网同步器修复，同时按文档约定保留同批已有正文漂移的同步；源码不增加临时测试端点或 VEGAS 脚本。三项未测界面操作如实保留，不阻止本次按维护者要求提交 PR。

当前上游基线的最小复验：

| 检查 | 结果 | result.json 所在检查目录 |
| --- | --- | --- |
| Python 渲染、HTTP、路径 | 23 项通过 | `20261107T020446Z-aeeaf219` |
| Node 功能与编辑器回归 | 363 项通过 | `20261107T020446Z-fe2169e5` |
| Chromium 原生文字与 PNG | 12 项通过 | `20261107T020528Z-7a31c7f4` |
| 构建与类型 | bundle 重建、typecheck 通过 | `20261107T020509Z-3aa6a36e`、`20261107T020528Z-fe1b9db6` |
| 个人路径 | 相对 origin/main 检查通过 | `20261107T020446Z-374194fc` |
| 官网 | check 无错误/警告/提示，build 成功生成 40 页 | `20261107T020742Z-acc166ad`、`20261107T020805Z-64807f25` |
| 文档与清单 | 无新增断链/结构错误，保留四条历史日志索引警告；清单契约通过 | `20261107T020805Z-1344c9db`、`20261107T020807Z-72b4013f` |

检查目录均为 `.artifacts/checks/<目录>/`。整理前几次 Python 复跑误用了系统解释器、未准备的独立环境或不存在的本地 venv，因模块/依赖缺失未执行实际用例；改用已准备的共享环境只读解释器后取得上表 23 项通过结果，没有修改共享依赖。此前全量的三个基线失败与三项跳过保持原记录，本轮不重复全量。原工作区 WIP 保留，内联副本待发布前统一重生成。

## 第二轮集成与异常验证

验证对应基线仍为 `29bc204b`，本任务改动尚未提交；以工作树当前源码及后续记录为准。

- Python 渲染与 HTTP 共 18 项通过（`.artifacts/checks/20261106T110543Z-b8a74701/result.json`）：25 / 30000/1001 fps、黑白彩色背景、重叠动画边界像素对照；无效 XML 可重试；复制失败无半成品；发布中切换绑定被拒绝；取消运行中的任务会释放槽位。之后新增缺字形和全透明输出测试，待全量结果。
- Node 363 项通过（`.artifacts/checks/20261106T110800Z-df42aaa4/result.json`）：包含原有编辑器工具、i18n、装配和新 XML/客户端生命周期。取消后等待 `cleanupComplete`，连接失败不会误报已停止。
- Chromium 10 项通过（`.artifacts/checks/20261106T110818Z-9e4f2a54/result.json`）：8 项旧 FCP 7 导出回归、2 项真实服务 PNG 导出/源媒体范围/取消。PNG 模式原生文字复选框已隐藏；新增区块实际间距 ≥8px。已查看选项与完成截图，没有遮挡、贴边或路径溢出。
- 构建、typecheck 通过；最近构建 `.artifacts/checks/20261106T110717Z-61a57644/result.json`，typecheck `.artifacts/checks/20261106T110904Z-56e9223d/result.json`。本机只有 Node 25.8.0、20.16.0 等不满足本分支 engine 范围的版本，因此合规版本复验仍未完成。
- 合成 12 秒、1080p、三轨小样：25 fps 为 38 个采样 / 27 张 PNG / 31 个片段；30000/1001 fps 为 44 个采样 / 39 张 PNG / 39 个片段。生产渲染器与 JS 序列化器已生成仅字幕及包含源媒体两种 XML，留在 `.artifacts/fcp7-png/vegas-25/`、`vegas-30000-1001/`。按实际 XML 路径及片段时间重合成、对照完整 ASS：每种帧率 78 个参考帧，最大通道误差均为 3；证据 `.artifacts/checks/20261106T111247Z-3a313e5f/result.json`。此处仍不是 VEGAS 导入证据。
- 官方独立 VEGAS Pro 安装包的 HEAD 与普通 GET 均返回 403；官方试用流程需要 Boris FX 账号。Computer Use 因无法可靠识别当前浏览器 URL 而停止，本轮未继续 UI 操作；已向维护者说明并等待可用安装包或自行安装。没有安装附加套件。
- 已按 AGENTS 要求启动独立审查。未提交、推送或建立 PR，内联副本待发布前统一重生成。

## 审查后验证与未通过边界

- [独立审查](REVIEW_FINDINGS.md)两项均关闭；瞬时动画回归已完成旧红新绿验证，总帧数超限的峰值内存由约 95.8 MB 降至 35.8 MB。资源数字仅针对该合成压力输入。
- 最新定向 Python：`scripts/run_tests.py tests.test_fcp7_png tests.test_fcp7_png_api tests.test_gap_removed_media_jobs tests.test_ass_fonts tests.test_docs_check tests.test_compact_assertions_usage`，运行 105 项，通过 104 项、跳过 1 项（Windows 无 macOS MobileAsset 字体目录）。证据 `.artifacts/checks/20261106T112130Z-cc8eddd4/result.json`。
- 本地服务回归：`scripts/run_tests.py tests.test_local_editor_server`，95 项通过；`.artifacts/checks/20261106T111841Z-bf7efb6c/result.json`。
- 全量 Python 命令在 240 秒时被通用运行器终止，日志为空，没有完成结果；`.artifacts/checks/20261106T111158Z-cc6a5846/result.json`。已核对工作树归属，无残留服务进程；没有循环重跑全量。
- 扩展烧录回归首次命令误写不存在的 `tests.test_media_jobs`，产生 1 个导入错误；已更正为上方 `tests.test_gap_removed_media_jobs` 并通过。该轮另有两项原有 `BurnVideoPrecisionTests` 失败：长 GOP 切割帧数偏差 2 帧、无音轨片段时长 0.94 秒而预期 1 秒。证据 `.artifacts/checks/20261106T111830Z-96c7f01d/result.json`。在原 `esm/g08-cues-b` / `29bc204b` 工作树（功能源码未变）真实复跑同两项，得到相同失败；基线证据 `.artifacts/checks/20261106T112052Z-89779dea/result.json`。本任务未修改烧录函数，也未修复该既有兼容性问题。
- Chromium 最终 PNG 回归 4 项通过：真实导出、源媒体与取消、英文界面、去空隙 PNG / 源媒体共享时钟；`.artifacts/checks/20261106T112444Z-16929012/result.json`。旧模式 8 项通过证据仍为第二轮记录。去空隙用例验证 3 秒源媒体删去 400ms 后输出 65 帧（25 fps），字幕结束映射到第 50 帧、源媒体切点引用第 35–75 帧。
- 最新构建 `.artifacts/checks/20261106T111826Z-5851257c/result.json`，新鲜度 `.artifacts/checks/20261106T112238Z-0d1ec73d/result.json`、typecheck `.artifacts/checks/20261106T112340Z-d7d5aab3/result.json` 均通过。
- 文档检查无新增断链或结构错误，4 个既有日志索引警告；`.artifacts/checks/20261106T112340Z-59a86a13/result.json`。本任务全部 24 个已修改/新增文件通过 UTF-8、LF、无 BOM 和个人路径检查，`.artifacts/checks/20261106T112340Z-63aafb53/result.json`。
- [人工清单](FCP7图片字幕.checklist.md)通过契约校验，生成 `.artifacts/fcp7-png/verification.html`，已浏览器渲染并检查截图；`.artifacts/checks/20261106T112151Z-20c64791/result.json`。7 项人工检查全部保留未勾选。

剩余必须完成的验收为 VEGAS Pro 本体获取、实际导入与时间线操作；安装阻塞期间保留本工作树与合成素材包。全量 Python、合规 Node 版本、长工程/4K 性能分别记为未验证边界，不能由局部通过推断。

## 继续验证：画布与长静止段

上一目标轮属于实际进展：完成实现修复、独立审查及前后端验证。本轮重新核对当前工作树、HEAD 与账本，功能源码未变；Windows 已安装程序记录仍无 VEGAS / Boris FX，本体获取与实际导入的阻塞持续，尚未满足完成条件。此为第二次连续目标轮确认相同安装阻塞，仍保留活动目标。

新增本地合成夹具使用真实 `buildAssPayload`：三句主轨交叉重叠，加一条副字幕；生产渲染器把同层重叠分到稳定轨道。两个画布各对照 12 个时间点、白色和彩色背景。另验证两小时静止字幕首帧及末帧。命令经通用入口执行：`node .artifacts/fcp7-png/boundary_fixtures.mjs`、项目 Python 执行 `.artifacts/fcp7-png/check_boundaries.py`。

| 样例 | 采样 / 图片 / 轨道 | 渲染耗时 | 参考帧 / 最大通道差 | PNG 总字节 |
| --- | --- | --- | --- | --- |
| 3840×2160，25 fps | 24 / 19 / 4 | 10.766 秒 | 24 / 3 | 1,727,263 |
| 1080×1920，25 fps | 24 / 20 / 4 | 3.578 秒 | 24 / 3 | 1,167,014 |
| 320×180，两小时静止，30 fps | 1 / 1 / 1 | 0.204 秒 | 4 / 1 | 409 |

证据：`.artifacts/checks/20261106T112900Z-e8b56529/result.json` 与 `.artifacts/fcp7-png/boundary-results.json`。静止段结束帧为 216000；没有按两小时时长逐帧渲染。上述耗时仅为本机合成小样，不代表大型工程导入性能，未测峰值进程内存，也不能代替 VEGAS 验收。

## 阻塞审计与恢复入口

第三次连续目标轮确认同一安装阻塞：重新读取 Windows 的机器级、用户级卸载记录，未发现 VEGAS / Boris FX；运行进程亦无对应程序。没有收到可用安装包位置或已完成安装的通知。上一轮属于实际进展，补齐了 4K、竖屏重叠与长静止段证据；本轮属于阻塞复核，不把重复检查记为新功能完成。

当前工作树和两套 VEGAS XML 素材包均在，生产源码未继续改动。官方获取失败与先前 Computer Use 停止之后，没有可用于实际导入的 VEGAS 环境，也没有可轮询的安装任务。目标标为 `blocked`，不是 `complete`；不继续通过重复内部测试替代目标软件验收。

恢复条件：维护者安装并启动 VEGAS Pro 本体，或提供可用官方安装包及所需账号操作条件。恢复后先确认版本，再按人工清单导入 `vegas-25` / `vegas-30000-1001` 的两种范围 XML，验证透明叠加、帧边界、保存重开及重新链接。此前记录的全量 Python 超时、基线烧录精度失败与 Node 版本边界仍保留，不因目标受阻而视为已通过。

## 官方旧版本安装包获取

维护者同意使用旧版后，从 [Boris FX 论坛的 VEGAS 22 下载索引](https://forum.borisfx.com/t/where-can-i-download-vegas-pro-including-old-versions/24247/27) 定位到 MAGIX 服务器上的独立本体安装包。该索引为用户整理；下载实际来自 `dl04.magix.net`，正常重定向到其 CDN，GET 返回 200，不再遇到此前新版本链接的 403。

- 版本：VEGAS Pro `22.0.0.250`，64 位国际版。
- 文件：`VEGAS_Pro_22.0.0.250_x64_DLV_DE-EN-FR-ES-BR_250429_17-55_1F81AB44.exe`，617,788,824 字节，保存在 `.artifacts/fcp7-png/downloads/`。
- SHA-256：`d3391c186bad0c73b8374152ebf49f38bf5dfa9237483bd0dc1cd6bb6014601c`。
- `Get-AuthenticodeSignature` 结果：`Valid`；签署方 `MAGIX Software GmbH`，时间戳签署方 `DigiCert Timestamp 2024`。
- 只下载了本体；Deep Learning Models、Mocha、Sound Forge 等附加组件未下载或安装。下载来源、大小、哈希及耗时保存在本地 `vegas22-download.json`。

按已授权范围使用 Computer Use 启动安装器，`launch_app` 超时；随后重新枚举窗口并检查实际进程，只发现 Windows `consent.exe`，未发现可操作的 VEGAS 安装窗口。没有盲目重复启动。Computer Use 操作规则禁止代点系统安全权限请求，已提示维护者手动处理 UAC 后继续。此为新的恢复阻塞点；安装与实际导入仍未完成。

维护者反馈没有看到权限弹窗后，重新检查进程与已安装程序，确认上次 `consent.exe` 已退出，没有残留安装器或已安装 VEGAS。尝试通过现有资源管理器窗口打开安装目录，但辅助功能未获得地址栏焦点，因此没有输入路径或复用不可靠坐标。随后仅重新发起一次已验证安装文件的正常启动；`launch_app` 再次超时，而实际进程出现新的 `consent.exe`。已提示在运行工程的 Windows 主机上查看权限窗口，并提供手动运行安装包的恢复方式。没有更改 UAC 或系统安全设置，也没有进入安装选项界面。

## 安装完成与首次启动

维护者手动启动安装后，实际观察到安装器完成界面显示 “The installation has been completed successfully”，并勾选启动 VEGAS。系统已安装程序记录为 `VEGAS Pro 22.0` / `22.0.250.0`；安装目录中的主程序为 `vegas220.exe`。本次使用独立本体安装包，未运行附加组件安装器。

安装器的完成按钮对自动输入没有响应，重新激活窗口并观察后仅重试一次，仍保持完成页。因此直接通过已确认的主程序入口正常启动，不终止安装器或篡改系统状态。VEGAS 成功显示首次启动 Welcome 界面，存在序列号激活、购买和试用三个入口。

选择试用后，界面明确要求注册：`Register now` 可用，`Test program` 灰显。没有进入编辑器或导入 XML。已请维护者完成试用注册或自行输入已有授权序列号；Computer Use 不代操作用户认证界面。当前阻塞从系统权限转为账号/授权，安装本身已完成。

维护者随后明确选择「暂时不激活」。停止推进注册或激活，保留当前安装、独立工作树与所有本地测试素材。VEGAS 导入、透明合成、保存重开等人工验收保持未验证；在维护者恢复激活或提供已可用环境后继续，不将本目标标为完成。

## 维护者调整验收顺序后的收尾

维护者明确要求先跳过 VEGAS 部分，等装上可用版本后再做，当前先完成其余工作。本轮范围为实现、前后端验证、独立审查及文档收尾；VEGAS 实际导入作为维护者指定的延期验收，不能记为通过，也不再阻止本轮其余部分交付。

恢复时已核对当前 HEAD `29bc204b`、全部修改/新增文件及已有验证账本，功能源码未发生其他变更。已补齐此前两个验证尾项：使用工作树内独立 Node 版本复核前端；在保留仓库通用运行器与完整报告的前提下取得全量 Python 完成结果。原系统 Node 默认值和共享 Python 环境均未修改。

### 本轮最终验证

本轮没有继续修改功能源码；独立审查关闭的两项修复仍在当前文件中。前后端实现、分层验证、文档及人工核验入口收尾；目标应用导入按维护者要求延期。

| 层级 | 实际结果 | 证据 |
| --- | --- | --- |
| Node 26.13.0 | 429 项通过，无失败或跳过；包含 PNG XML、客户端任务、编辑器工具、波形、i18n 与装配回归 | `.artifacts/checks/20261106T132504Z-85e2c2f6/result.json` |
| 构建与类型 | bundle 新鲜度、TypeScript 均通过 | `.artifacts/checks/20261106T132504Z-1f7bcc45/result.json`、`20261106T132504Z-11ae66b1/result.json` |
| Chromium / Node 26.13.0 | 12 项全部通过：旧文字模式 8 项，PNG 模式 4 项 | `.artifacts/checks/20261106T132530Z-364b1864/result.json` |
| 全量 Python | 133 个文件、2777 项；2771 通过、3 失败、3 跳过、0 错误，约 83 秒 | `.artifacts/checks/20261106T133117Z-ae1f9f95/result.json`；完整结构化报告 `.artifacts/fcp7-png/full-python-ready.json` |
| 新功能 Python | 上述全量中，渲染/像素 14 项与 HTTP 8 项全部通过，无跳过 | 同一全量报告的 `test_fcp7_png.py`、`test_fcp7_png_api.py` |
| 官网文档 | `pnpm --dir website run check` 无错误、警告或提示；`pnpm --dir website run build` 成功生成 39 页 | `.artifacts/checks/20261106T134351Z-474f8742/result.json`、`20261106T134358Z-e452bec1/result.json` |

Node 26.13.0 仅解压到工作树 `.artifacts/tools/`，归档经官方 `SHASUMS256.txt` 核验，SHA-256 为 `dcc60d59a0746999f99064a01c020445d54d84228c691cdbf25b49ac3b59150a`；准备证据 `.artifacts/checks/20261106T132232Z-99f7b059/result.json`。系统默认 Node 仍是 25.8.0。全量测试将锁文件中的 NumPy 2.4.6、soundfile 0.14.0、cffi 2.1.1 与 pycparser 3.0 安装到工作树隔离目录，仅对子进程设置 PYTHONPATH；没有同步或修改共享 venv。使用已有 Git Bash 运行校验脚本测试，因此前两轮因依赖或 WSL 路径不兼容跳过的用例得以执行。

全量采用仓库已有按文件并行入口，避免此前串行运行超时且结束前没有摘要的问题；没有改变测试内容。准备隔离依赖后重新取得同范围完整结果，未用局部重跑冒充全量通过。可复跑的核心命令如下，前提为符合本分支 engine 的 Node 与已准备的 Python 测试依赖：

```powershell
python scripts/run_check.py --timeout 600 -- uv run --no-sync python scripts/run_tests.py --parallel 4 --report .artifacts/full-python.json
python scripts/run_check.py --timeout 180 -- node --test tests/test_fcp7_png.mjs tests/test_fcp7_png_client.mjs tests/test_editor_utils.mjs tests/test_waveform_js.mjs tests/test_editor_i18n.mjs tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs
python scripts/run_check.py --timeout 480 -- node node_modules/@playwright/test/cli.js test --config=tests/config/playwright.config.mjs --project=chromium tests/e2e/fcp7-png.spec.mjs tests/e2e/fcp7-export.spec.mjs --workers=1
```

### 全量的既有失败与跳过

以下三个失败均在功能源码未修改的 `esm/g08-cues-b` / `29bc204b` 工作树真实复现；本任务对烧录、缩略图模块及其原有测试没有 diff。不将全量描述为通过，也不在本功能中顺带修改这些既有问题。

| 测试 | 当前与基线一致的失败 | 基线证据 |
| --- | --- | --- |
| `BurnVideoPrecisionTests.test_long_gop_cuts_exclude_removed_frames_and_keep_audio_clock` | 起点 1250ms 的切段帧数偏差为 2，断言上限 1 | `.artifacts/checks/20261106T112052Z-89779dea/result.json`（原工作树） |
| `BurnVideoPrecisionTests.test_video_only_precise_cuts_do_not_require_audio` | 时长 0.94 秒，预期 1 秒 ±0.041 | 同上 |
| `ThumbnailIntegrationTests.test_nonzero_start_pts_is_normalized` | duration_ms 为 3500，预期 4000 | `.artifacts/checks/20261106T132605Z-e9fb8d7d/result.json`（原工作树） |

3 项跳过分别为：本机没有 macOS MobileAsset 字体目录、Windows 不适用的外部打开器路径、未提供个人真实对齐工程夹具。其原因逐项保存在完整报告，未按通过计数。FFmpeg 版本仍为本机 7.0.2；上述旧模块的精度兼容性未在本任务中修复。

### 本轮交付边界

按文档约定运行现有同步器，更新 8 篇官网文档并补齐 18 个已有图片源文件的发布副本（共 1,182,099 字节）；其中 6 篇是已有正文与官网副本的同步差异。图片均与 Git 跟踪的源文件哈希一致，没有引入本机新截图。官网使用本地预览索引验证，未发布；同步范围经独立复核保留，详见审查记录。

最终文档检查为 0 新增断链、0 结构错误，保留 4 个既有日志索引警告（`.artifacts/checks/20261106T134636Z-33e702df/result.json`）。全部 32 个变更文本文件通过 UTF-8 / LF / 无 BOM / 个人路径检查，18 个图片副本与来源哈希一致（`20261106T134636Z-bd257e9a/result.json`）；人工清单契约通过（`20261106T134636Z-d81bb102/result.json`）。`git diff --check` 通过，没有本工作树残留的 Node/Python 服务；便携 HTML 与依赖锁文件均无修改。

保留分支 `feat/fcp7-png-subtitles`、源码、合成 XML/PNG 包和人工核验清单；未提交、推送或创建 PR。VEGAS 的导入、Alpha 解释、轨道顺序、保存重开和重新链接由维护者提供可用版本后继续。该延期由维护者明确指定，未把自动像素对照作为替代验收。

## 2026-11-07：恢复 VEGAS 14 验收

维护者安装 VEGAS 14 并要求恢复验收。已核对 `feat/fcp7-png-subtitles` / `29bc204b` 的工作树状态和相关源码 diff，保留原工作区 WIP；新增验证只使用本地合成素材。实际主程序为 VEGAS Pro 14.0 Build 211，能够进入空工程。此前 VEGAS 22 注册阻塞不再作为本轮结论。

Computer Use 的文件名输入多次粘贴出旧剪贴板内容，控件设值又返回 `element ... is not available in cached app state`；重新绑定及重置会话后仍存在。未确认保存，也没有覆盖文件。另开空白测试实例，使用 VEGAS 已安装的 `ProjectInterchange.dll` 中同一 `VegasScripts.Fcp7Importer.Import` 入口进行实际导入，并计划读取工程结构及原生快照；临时脚本仅留在 `.artifacts/fcp7-png/`，不作为产品能力或仓库资产。命令行脚本入口依据 [VEGAS 官方文档](https://help.magix-hub.com/video/vegas/en/content/topics/scripting_in_vegas.htm)。

| 验收项 | 状态 | 当前事实与下一步 |
| --- | --- | --- |
| 环境与导入入口 | 仅说明 | 14.0 Build 211 已进入编辑界面；菜单提供 Final Cut Pro 7/DaVinci Resolve XML。 |
| PNG 素材定位 | 已修复 | 原始文件 URL 缺图，已增加同包本地路径兼容副本，原生导入器和中文/%20 路径均通过；保留标准 XML。 |
| 帧率、事件边界、透明与多轨 | 已修复 | 六组原生工程结构一致，342 张真实快照最大通道差 1；界面播放及单帧定位已确认。 |
| 源媒体、去空隙、保存重开与路径替换 | 已修复 | 源入点/切点一致；整句移动和路径替换均经原生 API 保存重开验证。 |
| 丢失素材的文件选择窗口 | 仅说明 | 自动输入路径不可靠，本轮未覆盖该交互；源清单保留未勾选，后续人工确认。 |

### 素材定位修复与首批实际结果

已增加同包的 `subtitles-vegas.xml`：服务器在标准 XML 通过素材白名单校验后，仅将兼容副本的 pathurl 改为经过百分号转义的本地路径；原 `subtitles.xml` 保留标准文件 URL。两份 XML 在同一暂存目录内写入后原子发布，响应及中英文完成提示提供兼容文件路径。新增实际 HTTP 发布断言和 Unicode / 空格 / `%20` 字面值 / `#` / `&` 路径往返测试，未放宽标准 XML 输入的白名单。

- 渲染与 HTTP 23 项通过：`.artifacts/checks/20261106T173406Z-15cb9704/result.json`。
- Node 363 项、typecheck 通过：`20261106T173626Z-029570ed`、`20261106T173626Z-6d15e951`。
- 真实 Server 的 Chromium 12 项通过，包括兼容副本落盘与英文完成提示：`20261106T173626Z-8c3ad4e9`。
- 去掉兼容文件写入及响应字段的隔离模块副本使新增 HTTP 断言真实失败（`KeyError: vegasXmlPath`）：`20261106T174354Z-f8f3fd4a`；生产源码同一用例包含在上方通过组中，未回滚生产文件。
- 独立复核未发现新的 blocker/major；补充实际文件名定位探针通过，见 `20261106T173854Z-1681cc05`。

通过本机 VEGAS 14 的原生导入器验证 25 fps、30000/1001 fps 与两种范围的四个组合，另验证中文 / 空格 / `%20` / `&` 路径工程；每组均保存为 VEG 工程再重新打开，所有素材在线，事件的开始帧、长度帧、源入点和轨道顺序与生产 XML 一致。仅字幕分别为三轨 31 / 39 个事件，包含源媒体分别为四视频轨、一音频轨、33 / 41 个事件。仅字幕最后一条在 11 秒结束；XML 的 12 秒 duration 不会在 VEGAS 中自动创建末尾空白事件；包含源媒体时工程长度为 12 秒。

补充 342 张 VEGAS 原生 1920×1080 快照：25 fps 的 53 个边界/静止/动画位置、30000/1001 fps 的 61 个位置，各用黑、白、蓝三种底色。与 XML 定义的 PNG 多轨重合成比较，最大通道差均为 1。证据 `.artifacts/checks/20261106T174211Z-63e77b03/result.json`、`.artifacts/fcp7-png/vegas14-validation/validation-results.json`。已在真实界面观察到三轨共同显示，PNG 被识别为 Straight Alpha。该证据是目标应用的实际输出，不是此前内部重合成结果。

验证辅助程序的首次快照批次把背景插到最上层，输出被遮挡，检查真实失败后已拒绝该批次；随后使用明确的底部轨道索引重新捕获，上述 342 张来自修正后的批次。原始 URI 缺图取消后的一次快照调用未完成，已终止仅属于本任务的测试实例。两次辅助程序问题均未当作产品通过证据。

去空隙小样使用生产 ASS、渲染器和序列化器生成：3 秒源媒体删去 1000–1400ms，输出 65 帧；VEGAS 实际导入两视频轨、一音频轨、5 个事件，25 帧处切换到源第 35 帧，字幕在第 50 帧结束；保存重开保持一致。证据 `.artifacts/checks/20261106T174357Z-2c15e7b0/result.json`。

### 编辑、重新指定素材与界面检查

用 VEGAS 原生 API 将同一句的 10 个动画/静止图片事件编组并后移 25 帧，保存重开后逐项读取，内部时序和其他事件均保持。再把另一个包含源媒体工程的 31 个 PNG 事件重新指定到带中文、空格、`%20` 和 `&` 的素材副本目录；保存重开后路径、帧位置、源入点一致且素材在线，源视频/音频引用不变。证据 `.artifacts/checks/20261106T174701Z-72dfc643/result.json`、`.artifacts/fcp7-png/vegas14-edit-relink/results.json`。这部分是实际 VEGAS API 操作，不声称执行过鼠标拖动或丢失文件后的选择窗口。

Computer Use 已在重新打开的源媒体工程中观察到视频上三轨透明字幕，点击播放后视频帧前进、字幕切换、音频电平活动；暂停后内容末尾以外为黑场，无旧图片残留。重新定位到 25 fps 的第 122 帧，执行下一帧后显示第 123 帧，画面相应更新。图片重新指定后的原生画面保存在本地 `vegas14-edit-relink/relinked-source.png`。

另在 30000/1001 fps 蓝底工程界面确认合成与帧率显示；第 146 帧执行下一帧后为 147 帧，淡出透明度相应变化。仅保留一个已保存的源媒体测试工程供维护者查看，其余辅助实例结束。

当前实现、前后端回归、原生导入/像素/编辑验证和独立复核均已完成。明确保留：丢失素材文件选择窗口、UNC 真实共享、长路径/大小写敏感目录、跨系统迁移、其他软件版本和大型工程峰值性能。没有以自动化代替这些未测项；未提交、推送、创建 PR 或重新生成便携 HTML。

本轮收尾：文档 0 新增断链/结构错误（`20261106T175256Z-39b91648`，4 条既有日志索引警告）；官网 check 无错误/警告/提示（`20261106T175321Z-de57421c`）、build 39 页成功（`20261106T175329Z-1e650305`）；编辑器 bundle 新鲜（`20261106T175321Z-50f542c3`）。完成提示按行区分两份 XML 路径后，PNG Chromium 4 项复跑通过（`20261106T175709Z-e1026f09`），已查看截图。核验源清单为 4/7、status partial，三项界面操作保留未勾选；模板按约定在新浏览器中从未勾选状态开始，源文件追踪状态不由页面首次进度替代（页面渲染检查 `20261106T175720Z-f6538e2e`）。

## 初始实验

实验文件及图片位于本地 `.artifacts/fcp7-png/`，不入 Git。`probe.mjs` 使用项目 `buildAssPayload` 生成静态、淡入、放大和三层字幕，未手写替代项目排版。

- `alpha_probe.py`：直接 `ass:alpha=1` 的 PNG 与不透明直接渲染比较，存在大幅误差，单纯 unpremultiply 也不解决。本次仅证明当前 FFmpeg 构建的此条管线不可直接采用，不推断所有版本。
- `matte_probe.py`：黑白 RGB 背景分别渲染，依据差值恢复 alpha，再转换为 straight RGBA；黑、白、彩色背景重合成最大通道误差为 2。证据：`.artifacts/checks/20261106T103510Z-707f5c92/result.json`；仅为一个淡入时间点，未代表全功能通过。
- Node 依赖已按锁文件在工作树安装；Python 只读复用锁文件一致的原工作区环境，不同步共享环境。

## 第一轮前后端验证

- 渲染与时间计划：9 项通过，包含真实 FFmpeg 淡入、静止保持、去重和透明帧跳过。`.artifacts/checks/20261106T104504Z-d4f5eb65/result.json`。
- HTTP：14 项通过（其中 11 项是导入测试夹具带入的原有测试，已调整后续只发现本模块测试）；新增用例覆盖实际渲染/发布与重复导出、请求令牌/绑定、预取消。`.artifacts/checks/20261106T104700Z-72a07327/result.json`。
- Node：24 项通过（新序列化、句标识、既有动画、脚本语法和顺序）。`.artifacts/checks/20261106T105128Z-0caa9ecd/result.json`。
- Chromium：2 项通过，真实后端导出、源媒体范围和停止；局部布局距离断言 ≥8px。`.artifacts/checks/20261106T104839Z-fb95c198/result.json`。截图位于 `.artifacts/fcp7-png/`；截图检查发现的隐藏问题已修改，尚待新一轮确认。
- 编辑器构建和 typecheck 通过；Node v25.8.0 不在项目声明版本范围内，工具有 engine 警告，尚需符合版本范围的环境复核。
- Computer Use 的 Windows 浏览器网址识别触发安全停止，本轮 UI 安装已停止；没有安装软件。winget 官方源搜索未找到 VEGAS Pro，不能替代实际安装/导入证据。
