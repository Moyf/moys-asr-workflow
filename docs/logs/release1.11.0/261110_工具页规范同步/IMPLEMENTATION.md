# 工具页规范通用化与同步

分支：`feat/ocr-extract-hotwords`；起始 HEAD：`789866fe`。最初仅授权修改、不提交；维护者在最终精简样式反馈后明确要求全部完成再提交并创建 PR。仍不生成便携编辑器，不接入 Launcher 工具箱。

## 范围与原则

- 沿用 Launcher 的视觉基线，参考 OCR 确认页的信息层次与操作反馈；不复制 OCR 的业务布局。
- 保留既有数据格式、存储键、文件授权和导出行为；只按工具实际任务补交互。
- 生成页仍可离线使用，更新模板不批量改写历史产物。

## 逐项进度

| 工具 / 正文 | 状态 | 核查依据与本次处理 |
| --- | --- | --- |
| 通用规范与共用主题 | 已修复 | 268 行收敛为 130 行，移除 OCR 业务布局的强制要求，采用场景表；主题有统一资源与 Launcher 令牌对拍，失败存储不阻断启动。 |
| 人工核对清单 | 已修复 | 生成页内联主题，24px 框与整行空白点击；保留 label/按钮独立行为。精简降低密度、不隐藏操作/预期；窄屏操作收纳随断点调整，原存储键与导出契约不变。 |
| 文案评审 | 仅说明 | 本轮早期界面改动与测试已完成；维护者随后明确「已过期，不再维护」。现有页面/数据留存，介绍页退役标记，不再继续开发或列为人工验收目标。 |
| 转写对比 | 已修复 | 双主题与分组系列色、筛选重置和空态入口，基准跨重置保留；窄屏表格自身滚动，不加选择/导出面板。 |
| 时间码对比 | 已修复 | 双主题、精简、搜索防抖、行选区保护和展开后焦点回归；既有测试抓到标签光晕被移除，已恢复主题适配光晕与相邻色块区分。 |
| 开发看板 | 已修复 | 双主题/精简、数字统计、筛选重置和空态；保留看板与拖拽、状态选择。共用资源走精确白名单路由，CSP 不放宽；浏览器采用本地 mock 数据，不请求 GitHub。 |
| CHANGELOG 编辑器 | 已修复 | 双主题、窄屏版本栏上移与上下分屏、弹窗焦点/Tab/Esc/取消回归；原写盘、备份和冲突三选一保持。未对真实仓库执行浏览器写盘。 |
| 波形对比实验台 | 仅说明 | 前半轮已完成基础主题同步；维护者随后明确暂停维护，保留已完成改动，不再投入新功能或人工验收。 |
| Filmstrip Lab | 仅说明 | `docs/engineering/FILMSTRIP_EXPLORATION.md` 标明阶段 0 历史原型；不为统一风格重新维护历史方案。 |
| merge-flow | 仅说明 | CLI 工具，无浏览器界面。 |
| OCR 确认页 | 已修复 | 本次参考实现；按新下限仅将分组箭头字号 10→11px，不改数据链路。 |
| 工具功能介绍页 | 已修复 | `tools/index.html` 读取 `catalog.js`：列出 10 个工具的用途、能力、输入输出、入口和维护状态；新增/状态改变强制同步。波形暂停、Filmstrip 暂不处理。 |

## 验证记录

### 已通过

| 层次 | 命令与结果 | result.json |
| --- | --- | --- |
| Node | `node --test tests/test_tool_pages.mjs tests/test_verification_checklist.mjs tools/dev-dashboard/serve.test.mjs`，43 通过 | `.artifacts/checks/20261110T105319Z-3b5e5667/result.json` |
| Python / 文档契约 | `uv run --no-sync python scripts/run_tests.py tests/test_verification_checklist.py tests/test_verification_checklist_build.py tests/test_docs_check.py`，52 通过 | `.artifacts/checks/20261110T105633Z-96ae703a/result.json` |
| 浏览器 | `node node_modules/@playwright/test/cli.js test --config=tests/config/playwright.config.mjs tests/e2e/tool-pages.spec.mjs tests/e2e/timestamp-compare.spec.mjs tests/e2e/verification-checklist.spec.mjs --project=chromium`，20 通过（含主题/精简偏好记忆） | `.artifacts/checks/20261110T110902Z-6e085322/result.json` |
| CHANGELOG 对拍 | `node tools/changelog-editor/selfcheck.js`，51 个小节无损往返、18 份正式归档一致 | `.artifacts/checks/20261110T105319Z-81149775/result.json` |
| CHANGELOG 既有 UI 冒烟 | 原 `smoke-ui.js` 仅将入口改为 file URL 后执行：分屏编辑、图片/卡片排序、侧栏和假句柄重连；页面错误 0 | `.artifacts/checks/20261110T110127Z-81309f78/result.json`，本地 wrapper `.artifacts/tool-page-sync/changelog-smoke.cjs` |
| 文档与静态 | `scripts/check_docs.py` 无新断链/结构错误；Ruff、个人路径检查与 `git diff --check` 通过 | `.artifacts/checks/20261110T105319Z-c0889b2d/result.json`、`20261110T104839Z-4b2b43e6`、`20261110T105507Z-ca3079ed` |
| 长列表 | 600 个核对项 4.7ms、400 行文案 4.7ms、400 行时间码 3.1ms 最大同步重排；测试宽度无页面溢出 | `.artifacts/checks/20261110T105507Z-99059e6a/result.json`，原始 `.artifacts/tool-page-sync/stress-results.json` |
| 主题记忆 | 主题/精简控制使用真实按钮切换后刷新，偏好及可访问名称保留，新增单项通过 | `.artifacts/checks/20261110T110500Z-e019703a/result.json`（独立补测，不替代整组） |
| 基础对比度 | 正文/面板最小 13.36:1，次要文字/升起底 5.43:1，主按钮前景/强调底 4.78:1；仅检查基础令牌，不声称覆盖全部业务徽章 | `.artifacts/checks/20261110T110332Z-f27629e6/result.json`，原始 `.artifacts/tool-page-sync/contrast.json` |
| 生成物与编码 | 两份真实生成页的 4 个脚本通过 `node --check`；全部 30 个变更文件 UTF-8、无 BOM、LF | `.artifacts/checks/20261110T110712Z-dd4ac390/result.json`、`.artifacts/checks/20261110T110831Z-79ff2991/result.json` |

全部测试通过 `uv run --no-sync python scripts/run_check.py --timeout <限时> -- <命令>` 包装。截图在 `test-results/tool-pages-*`（各工具深/浅/375px），压力截图在 `.artifacts/tool-page-sync/`；HTML 人工验收页 `.artifacts/tool-page-sync/verification.html`，源见 [工具页同步.checklist.md](工具页同步.checklist.md)。

### 失败与修正

- 第一轮用 `pnpm` 直接作为 Python 子进程参数，Windows 找不到原生命令（127）；改为调用已有 Node 的 Playwright CLI，无需安装/重建环境。
- 首轮浏览器 17 通过、1 失败：时间码字词标签去掉光晕违背原有可读性保护。恢复随主题变化的光晕后，包含新波形案例的整组 19 通过。
- 基线源码冻结到本地临时区，静态负向检查在旧 HEAD 上失败；其中资源缺失和旧页无控件的差异只证明结构守门，不充当旧行为对照。
- 真实浏览器负向对照：冻结的旧 `timestamp-compare.html` 在「有文字选区不展开」「展开后焦点归新行」两项上均失败（`.artifacts/checks/20261110T105830Z-b4bf39c6/result.json`）；新页对应行为已在整组 19 项中通过。未修改/回退当前源码，因工具页直接载入源 HTML，也无需重建 bundle。

### 未验证与后续

- 前台滚动帧率、触屏、维护者真实数据的观感尚未人工验收；后台同步重排不能冒充这些层。
- 看板真实 GitHub 请求、CHANGELOG 真实授权写盘未执行；原保存/归档逻辑仅做单元对拍和模拟取消路径。
- 历史 HTML 不自动更新；静态页需保留相对资源目录，生成页已检查资源内联。无 `web/` 源码或便携编辑器改动。
- 独立自审首次发现 2 major / 2 minor，已修并复验，最终独立复核通过，见 REVIEW_FINDINGS.md；没有创建 commit 或 push。

## 追加：字号与工具介绍（维护者要求）

- 工具文字绝对下限 11px，正文建议 13–16px；包括徽章、时间码、伪元素和精简模式，旧 8/9/10px 已在活跃页面修正。静态字号守门与浏览器计算字号一起检查。
- 独立复核发现的存储警告、全局粘贴、标题裁切和横幅焦点问题已处理。22 个浏览器定向项通过；6 项基础单测通过（含字号与目录状态检查）。日志分别为 `.artifacts/checks/20261110T111834Z-895ea226/result.json` 和 `20261110T111834Z-de0f38d2`。
- 用户要求实际打开工具供确认：使用 Orca 浏览器新建本轮工具标签，不改/关闭已有用户页面；波形与 Filmstrip 不打开。生成型工具使用本地例子或已有 OCR 结果，不重复扫描或调用收费 AI。

### 追加验证与打开结果

- 最后浏览器三 spec 23 通过：`.artifacts/checks/20261110T112532Z-2b061756/result.json`；伪元素字号补查后工具 spec 11 通过：`20261110T112746Z-9c1662dc`。不是将局部重跑冒充整组。
- Node 45 通过：`20261110T112532Z-f9146ef6`；Python OCR 报告/清单/文档契约 71 通过：`20261110T112202Z-2e554b26`；文档、Ruff 与个人路径检查通过，仍有 6 条历史日志未登记提示。
- 已有 OCR HTML 仅重新渲染，未扫描或调用 API；320/375/768/1440px 与精简开关的计算字号均 ≥11px（`20261110T112714Z-f53eb582`）。
- Orca 已打开 8 个本轮标签：工具介绍、转写对比、时间码对比、文案评审、CHANGELOG、人工核验、OCR、开发看板合成预览。看板预览内存数据明确标注，不连接 GitHub，不写仓库。临时预览服务已关闭，并检查没有残留；最终用独立静态预览保留可查看页面。
- Orca 标签加载均成功；部分辅助 eval 返回 EOF/owner unavailable，未循环重试或重启应用。计算字号与主流程验收采用已经通过的 Playwright 层，不以 Orca 辅助探针失败改写通过事实。
- 最终独立复核通过，未处置 major/blocker 为 0；长标题的内部范围（而非仅根 scrollWidth）在 320px 补测通过。全部 35 个变更文本 UTF-8 无 BOM/LF，diff 检查通过。

### 文案重写工具退役

维护者明确要求文案重写已过期、不再维护。`catalog.js` 新增 retired 状态，介绍页可按退役筛选，入口改称「查看历史页面」；目录与工具 README 同步，既有页面/数据和已完成改动保留，不删除或回退。

退役标记定向验证：基础 Node 6 项通过（`.artifacts/checks/20261110T120200Z-eb7398b7/result.json`），目录筛选浏览器 1 项通过（`20261110T120200Z-869ebad2`），文档检查通过（`20261110T120200Z-2e284cde`，仅既有日志登记提示）；无新业务功能改动。

## 追加：页内说明与 Markdown 复用（进行中）

维护者反馈「使用说明不应打开 md，应该页内弹窗并保留源文件入口」，并要求复用成熟库与 `==高亮==` 扩展。决定采用固定版本本地 Marked + DOMPurify，项目只封装安全策略、说明装载和弹窗；README 仍为真源，离线资源由生成脚本装配，不依赖 file fetch/CDN。实现状态与验证按 [工具目录反馈](TEST_FEEDBACK_工具目录.md) 逐项回填。

本轮共享能力先接工具目录，不扩到已退役文案、暂停波形或历史 Filmstrip，也不顺手迁移 CHANGELOG 的专用业务预览。新模块与说明弹窗的安全/语义/浏览器层尚待验证，不沿用上面的已通过统计。

Markdown说明阅读新增5项审查问题已修并独立复验，当前本范围0major/blocker：本地成熟库、根路径策略、代码中的高亮定界、GFM对齐、跨实例锁栈与异步下层均通过。后续最终集成仍重跑，不将旧7项结果覆盖新增10项语义/栈测试。

## 最终精简纠正与 PR 范围

- 维护者确认 OCR 是 style 基准：开关结构、轨道与圆点、尺寸和状态必须复刻，不能用按钮/阴影假造。共享同类开关按原页对拍。
- 核对清单精简只保留每项标题与勾选，操作/预期/说明/辅助入口隐藏；看板精简只保留标题、忽略/状态。备注与数据/导出不变，打印恢复完整字段。
- 最终精简实现已返回：OCR八条规则与32×32 ghost主题按钮对拍、19浏览器/52上游看板与契约通过，负向基线真实失败。清单原测试计数整页checkbox与新增偏好冲突，父已改为区分业务分区与偏好，不削弱实际核对项ID断言。独立复核仍进行中。
- 更新后的核验页和静态看板合成预览已重新生成；此前 Orca 标签已不存在，确认后只新建这两页，未关闭/覆盖其他标签。辅助 snapshot 偶发 EOF，未重启 Orca 或循环重复，仍以实际 Playwright 证据验收。
- 主分支新增日志已按精确 Git 文件内容保留，目录索引/CHANGELOG 与两版 Marked 许可证说明暂时并存；集成后会明确共享迁移边界，不静默删除上游资源或业务能力。
- 当前分支 `origin/main..HEAD` 已有 OCR 工具的 3 个提交，本次 PR 覆盖它们与当前 WIP；不只描述最后一次精简修复。CLI/实验形态仍不进 Launcher 或打包，文案退役、波形暂停、Filmstrip 暂不处理。
- 提交前须完成当前新增 Markdown/高亮与精简层验证、完整分支的独立审查，明确真实 AI、模型扫描、写盘与人工交互的边界。
- 2026-11-10 最后 fetch 发现 origin/main 新增 PR 看板正文 Markdown 预览/刷新进度（d88dbe21）与 ESM 接线（ff8881ea），和本轮看板文件重叠。已要求实现侧保留新能力；最终提交后合并最新主分支再复验，不能用旧 UI 覆盖上游。
- CI 增加离线说明新鲜度检查（标准 Node，不依赖 pnpm）和独立工具页的 Markdown/精简/目录/核对浏览器回归；本地生成新鲜度与测试将作为提交门槛，不能只靠 postinstall 重写产物掩盖过期提交。

## OCR 链路新增阻断（修复中）

完整分支独立审查虽然旧 111 项通过，仍用真实合成链路复现 9 major 与 7 minor（详见 REVIEW_FINDINGS.md）。范围分成两个互不编辑共享文件的实现者：扫描/精确重复复用/事件连续性/临时文件/子进程回收；CLI 缓存身份/扫描参数/AI 推荐/失败产物/热词权重与数量。父任务维护文档与统一集成，修复后必须负向回归与再审查，阻断处理前不提交或创建 PR。

扫描侧已交付并抽查：全像素一致性缓存、每成功采样点输出/变体事件合并、单临时文件和owned进程异常回收；180项组合测试通过，旧实现冻结负向14项全部失败。CLI侧仍在收尾，两侧参数摘要固定。详细证据见 REVIEW_FINDINGS.md，旧同图hash只保留兼容函数、不用于跳过OCR。

第一轮完整组合验证：81 Node/274 Python/Ruff通过（`.artifacts/checks/20261110T130059Z-535bbccb` / `20261110T130059Z-15d2332d` / `20261110T130059Z-9d8f639e`）。61项浏览器中58通过、3失败（`20261110T130139Z-f5dfc5e9`）：2项旧测试点击OCR样式隐藏input被轨道拦截，已改实际label点击后3项整文件通过（`20261110T130749Z-ebdbe10b`）；1项Chromium启动超时未进入用例。尚未算整组通过，最终重跑前不反复循环。

OCR二次独立复核保留4major：模板变体、POSIX组回收、扫描取消证据一致性、摘要NaN/关系；已按两个实现者原scope补修，见REVIEW_FINDINGS，处理前不创建PR。

四项补修交付后的完整组合（合并主分支前）：工具/看板81Node通过（`.artifacts/checks/20261110T132019Z-028df3ed/result.json`），Python OCR/发布事务/运行环境/GUI/清单/文档共758执行、755通过3跳过（`20261110T132019Z-fd7993ca`）；62项独立工具浏览器整组通过（`20261110T132059Z-f03b2019`），Ruff通过（`20261110T132019Z-a8568dbf`）。该轮使用1worker避开前次Chromium启动竞争，未反复循环两次失败。

最终独立OCR自审已放行，原9major/7minor及追加R1–R5代码闭环，当前所有已审范围未处置blocker/major为0。平台/媒体/历史磁盘与多文件非瞬时原子边界见REVIEW_FINDINGS。主分支合并后仍需组合检查，随后执行已授权提交/推送/PR。

## 最终主分支集成与验证

已提交当前改动为 `af435efb`，随后合并 `origin/main` 的 `f22df99b`（包含 PR正文/刷新进度与字幕域ESM接线）。冲突在CHANGELOG、NOTICE、日志索引、看板README/index/app.test逐项解决：保留双方入口/说明，测试仅将Tab起点移到新增末尾按钮，所有原功能断言保留；`git diff origin/main -- web`为空。

合并后验证（命令仍经run_check）：

| 层次 | 实际结果 | result.json |
| --- | --- | --- |
| 独立工具浏览器 | 7份spec共62项全部通过，1worker，含精简style/Markdown/热词报告/写盘锁 | `.artifacts/checks/20261110T133002Z-f8d6ee2b/result.json` |
| 工具/看板Node | 81项通过（包含上游正文/刷新契约） | `20261110T132902Z-0ecaffb1` |
| Python组合 | 758执行，755通过/3跳过，含OCR/发布恢复/运行环境/GUI/文档 | `20261110T133121Z-3d5dce02` |
| 上游接线与相邻JS | 68项通过，新增ESM import契约与ASS/编辑行为单测 | `20261110T133121Z-6ed558ad` |
| 构建/类型 | editor重建92工厂；typecheck/editor/launcher新鲜度通过 | `20261110T132902Z-93025029`、`20261110T132902Z-07df5e6e`、`20261110T133220Z-16c4a4f7`、`20261110T133220Z-dab80901` |
| 文档/资源/静态 | check_docs、6项离线说明新鲜度、Ruff、cached diff空白检查通过 | `20261110T132902Z-983369dc`、`20261110T133121Z-2416bc78`、`20261110T133220Z-838cce7f` |

新鲜度检查无nodeModules要求，vendor/license保持官方hash；MPL许可证原文尾空格仅在精确路径给gitattributes例外。历史6条日志索引提示保留，无新断链/结构错误。POSIX2项真实组回收本机跳过与1项既有平台跳过不能冒充通过；未跑全仓/远端CI、真实AI/模型/文件授权写盘、前台触屏和长片耗时/磁盘峰值，PR如实说明。

## 提交与 PR

- `af435efb`：工具页/说明/精简及OCR链路补齐；`9163dc73`：合并最新main并记录组合验证。
- 已普通推送到origin `feat/ocr-extract-hotwords`，未force；[PR 359](https://github.com/Moyf/moys-asr-workflow/pull/359)创建，base main，回读title/body/head确认正确且无损，创建时OPEN/MERGEABLE。
- 没有tag/Release/合并PR。CI尚未形成最终结论，人工清单pending。后续CI或人工反馈按真实新证据更新，不把创建PR称发布或验收完成。

## 首轮 CI 反馈（修复中）

PR创建后Ruff、ubuntu/windows调试文档、CLA通过；editor和Windows预览构建在安装阶段失败，均为pnpm minimumReleaseAge策略拒绝marked18.2.0（发布时间2026-11-09、未过24小时）。这不是测试业务失败，也不能忽略：回落固定已过冷却期的marked18.1.3，保持供应链策略不放宽，vendor/hash/说明同步后复验与推送。CI原失败见PR检查，不冒充远端通过。

失败CI对应head明确为`9163dc73`，原run已结束failure；新修复提交将触发新run，不能把旧head结果混为当前代码验证。

Marked18.1.3回落已实现并确认官方发布于2026-11-02。package/lock/vendor/源入口/测试路径/NOTICE已同步，两份旧文件经字节核对后回收，不删除其他资源。冻结安装通过（`.artifacts/checks/20261110T134310Z-a18803dd/result.json`），11MarkdownNode/10Markdown浏览器和10工具源码契约通过（`20261110T134331Z-055ef285` / `20261110T134359Z-273b5ad7` / `20261110T134502Z-37786da0`）。官方UMD哈希与许可证校验通过，渲染器API无需修改；独立复核和推送后的新CI待确认。

父合并文档最终更新后，21项Node契约/Markdown通过，6资源新鲜度与文档通过（`20261110T134927Z-36af4bd2` / `20261110T134927Z-42ae461d` / `20261110T134927Z-9e55c4f3`）；路径/diff检查通过，等待独立版本修正复核后提交，不复跑源码未变的OCR/精简层。

独立版本修正放行，11Node/最终6资源自行复验，完整tarball及license hash确认；未改变pnpm安全门槛。frozen安装是本机已有缓存且ignore-scripts，只证明锁可接受，不声称冷安装/postinstall或新CI完成。现状账本同步18.1.3，两份新vendor将纳入提交。

提交准备的构建检查发现本地editor/launcher产物过期，已只重建ignored bundle，typecheck通过（`20261110T131128Z-2847b9f5`）；源码 `web/` 无改动，也未生成 blank-editor。最终合并最新main后还会重新构建/检查，不把此轮作为合并后证据。

当前HEAD装配/共享编辑器utils/waveform定向420项通过（`.artifacts/checks/20261110T131239Z-d080dad4/result.json`），editor/launcher新鲜度与18份发布正文检查通过。此为公共层回归，不替代当前OCR与主分支合并后的组合验证。
