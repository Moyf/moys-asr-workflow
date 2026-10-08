# 编辑器 ESM 迁移：实施台账与上游交接

本批在 `dfd5971f` 的调研基础上落地部分 ESM：59 个独立工厂迁移，121 个接线、门面和共享状态文件保留原有作用域。JavaScript 装配由 esbuild 完成；便携 HTML 与 localhost 读取同一份 classic 产物，继续支持单文件 `file://` 编辑器。

## 桌面实验清理

维护者决定停止维护桌面实验工程；正式编辑入口保留 localhost Server 和便携 HTML，MOSE 产品方向与 `.mosp` 契约不变。

| 清理项 | 状态 | 处理范围与验证 |
| --- | --- | --- |
| 实验目录及专用测试/脚本 | 已修复 | `desktop/` 和专用验证脚本已移入回收站；删除 Rust 装配探针及目录专用测试，定向资产 22、打包 26 项通过 |
| Launcher 旧集成 | 已修复 | 移除旧 open_mose、可执行文件探测、关联注册及提示；旧 API/实验目录缺席断言通过。Launcher Python 302 项通过（1 skip），浏览器交互 51 项通过 |
| 活跃开发说明与研究脚本 | 已修复 | 当前文档和官网移除废弃入口；研究脚本不再读取已删目录，classic inventory 夹具定向 1 项通过。历史发布记录、既有反馈及冻结研究 JSON 保留，不作为当前构建说明 |
| 构建与回归 | 阻塞 | build、新鲜度、类型、Python 1823 项（21 skip）、浏览器 64 项、官网检查/构建、Ruff 与 diff/LF 通过。Node 全量 450/451：现有 OTIO 夹具缺 MaweSpeakerLabels，定向重跑同样 12/13；相关源码/测试相对 HEAD 无 diff，不修改无关逻辑。下一步由该功能任务补齐夹具后重跑全量；不宣称门禁全绿 |

### 清理验证事实

- `npm ci --no-audit --no-fund`、`npm run build:editor`、`npm run check:editor`、`npm run typecheck`：通过。当前 main 合并后 bundle 原已落后于说话人导出等源码；按当前源码重建并保留 `.meta.json`，没有手改产物或重新生成 `blank-editor.html`。
- `PYTHONUTF8=1 MAW_TEST_PYTHON=已安装解释器 python -m unittest discover -s tests -p 'test_*.py'`：1823 项通过，21 项按既有环境条件跳过。定向资产、打包、Launcher 分别 22、26、302 项通过。
- `node --test tests/*.mjs`：450 通过、1 失败；`node --test tests/test_editor_markers.mjs` 重跑为 12 通过、1 失败，均为 OTIO 标记测试的 `MaweSpeakerLabels is not defined`。失败文件及 `editor-export-timeline.js` 不含本次 diff。保留该阻塞，不顺带修改其他功能。
- `MAW_ESM_TEST_ROOT=临时隔离夹具 node --test --test-name-pattern='inventory detects dynamic names' scripts/esm-mechanical/test.mjs`：1 项通过，验证无桌面目录时的 inventory；首次未设实验目录的全实验命令被入口拒绝，随后对当前 ESM 树误用 classic-only inventory 也被解析器拒绝，均非产品失败，不将它们算作完整实验通过。
- `MAW_ENV_FILE=不存在的临时配置 MAW_E2E_PYTHON=已安装解释器 playwright test --project=chromium tests/e2e/editor-bundle.spec.mjs tests/e2e/editor-transactions.spec.mjs tests/e2e/launcher-interactions.spec.mjs`：64 项通过，含实际启动 localhost Server 与 file 页面。首次未隔离本机配置的 13 项运行有 1 项因非空贴图目录失败；隔离后全部通过，不读取或修改本机 Key 配置。
- 官网 `sync:docs`、`check`、`build`：同步完成，0 诊断，22 页构建成功。只保留 development、documentation-index、mose 三页的本任务生成 diff；两个无关旧文档同步差异未纳入清理。
- 修改的 Python 文件 Ruff、`git diff --check` 与 UTF-8/LF 扫描：通过。当前未验证正式打包、线上部署与远端 CI；已删除的桌面实验无需继续构建。原有 `docs/TEST_FEEDBACK_PR180.md` 未修改。

## 任务台账

| 工作 | 状态 | 当前证据与下一步 |
|---|---|---|
| 机械性调研与完整 180 文件隔离实验 | 仅说明 | 已提交 `dfd5971f`；这是可行性实验，不是生产迁移 |
| 五个真实上游 PR 的冲突预演与解决脚本 | 已修复 | 真实 SHA、冲突明细、顺序合并与功能验证已留档；见下方索引 |
| 目标契约红灯 | 已修复 | 新增 `test_editor_bundle.mjs` 在旧实现上 4 项失败，缺少生产打包器；随后实现再验证 |
| 较大批次部分 ESM 与三个消费端 | 已修复 | 59 个工厂；449 Node、23 资产契约、13 个基线/file/HTTP 探针通过；Rust 真渲染器与浏览器装配通过 |
| 类型诊断分批修复 | 已修复 | 既有六文件 + 全部 59 个工厂检查：1129 → 1128 → 1006 → 110 → 0；迁移提交后四批修复 |
| 最终回归与上游 PR | 已修复 | 已提交上游 PR #181；修正环境顺序后，Linux 编辑器全门禁与远端 Ruff 均通过。Windows preview 独立记录 |

## 已有证据

- [原始调研简报](../temp/ESM_MECHANICAL_RESEARCH_BRIEF.md)：最初的问题和约束；其中文件数及试点方案是当时状态。
- [机械性研究报告](../temp/ESM_MECHANICAL_RESEARCH_REPORT.md)、[契约迁移清单](../temp/ESM_CONTRACT_MIGRATION.md)：180 文件隔离实验、旧结构断言与新行为契约的区分。
- [真实 PR 冲突预演](../temp/ESM_UPSTREAM_MERGE_REHEARSAL.md)、[合并操作手册](../temp/ESM_UPSTREAM_MERGE_PLAYBOOK.md)：五个真实 PR、叠加 PR 顺序、同构投影与保留 fork 改动的方法。
- [快照](../temp/ESM_UPSTREAM_PR_SNAPSHOT.json)、[预演结果](../temp/ESM_UPSTREAM_MERGE_RESULTS.json)：固定 head/base SHA 与可复查结果。
- [实验和预演脚本](../../scripts/esm-mechanical/README.md)：隔离实验、真实 Git 对象恢复、顺序合并与负例探针。
- [当前部分迁移交接](ESM_UPSTREAM_PRODUCTION.md)：59 工厂真实 fork、最新上游 HEAD、具体冲突解决与类型后续脚本。

## 不可丢失的经验

1. 原试点只替换一个清单条目，Python 仍在拼接其余源码。生产目标是三个消费端只读取完整产物。
2. 依赖袋表示调用方注入的值，名字相同不证明可以改成静态 import。保留每次工厂构造与调用点语义。
3. import 求值会提前执行依赖模块。工厂模块只导出函数，注册仍在原清单位置执行。
4. esbuild 会改写模块顶层声明。剩余 classic 文件在同一函数作用域中执行，保留函数/var 提升、let/const TDZ、跨文件赋值和局部遮蔽；用专门负例验证。
5. 打包入口的 import 和 `--check` 都不能重写产物，否则新鲜度测试会自行修复错误，成为哑弹。
6. 历史契约中的源码引号、注释和拼接格式不是最终行为契约。保留行为断言，重新检验输入覆盖、注册顺序、模板注入及三端产物一致性。
7. Git 干净合并和页面启动都不足以证明功能完整。真实 #177 负例中页面正常打开，但新词级功能没有进入旧 bundle。
8. 上游合并先在 classic 影子分支合并业务变更，再投影到同构 ESM 版本，三方合并保留 fork 改动；生成产物在源码解决后重建。
9. 影子合并必须保留两个父提交，否则叠加 PR 的共同祖先会丢失，后续预演产生假冲突。
10. 类型红灯可以作为迁移中间提交的事实记录；最终检查必须修复真实类型问题，不能用跳过、缩小范围或整体 `any` 掩盖。

实施与最终验证结果随进度在本文件回写。仓库根目录的 `blank-editor.html` 内联副本待发布前统一重生成。

## 生产迁移提交的验证事实

- `node --test tests/*.mjs`：449 通过，0 失败/跳过。保留行为测试体；混合源码 fixture 使用正式构建器，宿主工厂直接 ESM import。
- `uv run --no-sync python -m unittest discover -s tests -p test_editor_assets.py`：23 通过。旧源码字符串断言移到源码层；完整产物、执行位置和模板注入另行检查。
- `node scripts/verify-editor.mjs CLASSIC_BASELINE ROOT PYTHON`：13 项通过，file/HTTP 初始化轨迹均覆盖 180 文件，项目注入、未知扩展保存、整数毫秒、SRT、合并撤销与经典基线一致，0 页面错误。
- 类型诊断 1129 是扩展检查范围后的中间结果，不是把旧全量实验的 235 项误报为退化。旧实验的 TypeScript import 图未覆盖全部波形工厂；本批显式覆盖全部 59 文件。
- 迁移后的 9 份浏览器 spec：226 项全部通过（2.6 分钟）；类型修复后再跑 4 份 spec，61 项全部通过，包括新增 file/HTTP 装配、波形拖动/历史/框选。
- esbuild 提前拒绝源码中直接对 const 赋值；外部 const 桥写入仍在运行时抛 TypeError。既有源码不存在前者；专门测试覆盖两种边界。

## 类型修复批次 1：既有视图契约

`ViewInvalidation` 补入已有的 `cueListPatch` 形状（主轨/叠加轨索引数组），对应 `patchCueRows` 的真实参数。不修改运行代码。原有 1 项 TS2339 消失；下一步处理 utils 121 项与波形 1007 项。`node --test tests/test_editor_commands.mjs` 验证事务与视图失效行为。

## Python 全量契约跟进

首次全量 1833 项发现另外 4 项旧装配断言（3 失败/1 报错）；已迁移到完整产物 fixture、源码形状层和真实页面检查，保留原行为/标记断言。另 7 项原有 subprocess 报错来自 Windows GBK 解码；使用 `PYTHONUTF8=1` 重验，不修改产品逻辑或跳过测试。定向结果：5 个清单、22 个波形、80 个 Server 测试全部通过。波形长测试中的动态源码字符串及模板检查已补齐；模板占位符按真实源码/模板集合检查，避免误把 esbuild 的 PURE 注释当成占位符。

## 类型修复批次 2：共享工具边界

保存设置与导出选项以 `unknown` 接入，验证对象后按 `Record<string, unknown>` 读取；字符串选项使用真实成员校验收窄。冻结 ASS 预设的字面量经保留属性形状的泛型扩宽，兼容自定义样式；FCP XML 参数明确可缺省字段（缺省值仍为 undefined）。补齐可选调色板挂载类型。

`npm run typecheck`：1128 → 1006，只剩波形范围；utils 121 项和波形调色板 1 项消失。`node --test tests/test_editor_utils.mjs tests/test_editor_bundle.mjs`：310 通过，0 失败/跳过。未使用 ts-ignore、ts-nocheck 或新增整体 any；既有非 strict 的注入参数仍是后续更严格建模的边界。

## 类型修复批次 3：波形组合实例

为安装到同一 `WaveformEditor.prototype` 的 199 个方法声明共同接收者。状态、拖动记录、时间轴、设置和回调另行声明；方法签名从真实导出描述符推导，避免动态安装丢失信息或循环推断成 any。getter 无法声明 this 参数，局部声明其实际接收者。还补齐布局模块二元组、数字滚动目标及只携带 clientX 的合成指针事件。

`npm run typecheck`：1006 → 110；剩余集中在 HTML 查询结果、事件目标与两个浏览器挂载。`node --test tests/test_waveform_js.mjs tests/test_editor_bundle.mjs`：66 通过。下一批单独明确 DOM 边界，不关闭检查。

## 类型修复批次 4：HTML 与浏览器边界

按渲染器实际创建的 HTML 节点和模板按钮声明查询结果，不全局覆盖 querySelector 或把任意 Element 声明成 HTMLElement。事件冒泡目标、波形行缓存的播放头、指针标记定时器均有明确类型。绑定标记目标按实际返回的 Set 收窄；补入浏览器 AudioContext 兼容挂载与已有静音核心调用。

`npm run typecheck`：110 → 0；`node --test tests/*.mjs`：449 通过，0 失败/跳过。没有 ts-ignore、ts-nocheck、排除工厂或新增整体 any。当前非 strict 契约检查不等于全仓 strict 类型化；121 个 classic 文件的大部分仍未进入类型检查，依赖袋及部分通知回调参数也仍有进一步精细建模空间。

## 最终门禁与验证

- `npm run check:editor`：只读检查通过；`npm run typecheck`：0 诊断。
- `node --test tests/*.mjs`：450 通过，0 失败/跳过；新增固定迁移批次的负例，要求新上游工厂不自动扩大 ESM 范围。acorn 缺失时顺序检查失败，不再静默跳过。
- `PYTHONUTF8=1 uv run --no-sync python -m unittest discover -s tests -p "test_*.py"`：1833 项、0 失败/报错，27 项按既有环境/依赖条件跳过。UTF-8 下原 GBK subprocess 报错消失。
- tracked Python 文件的 Ruff 检查通过；另修正两处既有测试的未使用导入，对应两组各 4 项测试通过。工作区无参数 Ruff 会包含未跟踪的个人实验 WIP；这些文件保留，不提交或覆盖。
- 最终基线/file/HTTP 的 13 个探针和实际 Rust 渲染器浏览器检查再次通过；每页初始化 180 个输入且无页面错误。Rust 有 2 项既有兼容清单函数未使用警告；完整桌面应用与发布包未验证。
- `scripts/esm-mechanical/test-upstream.py`：17 个真实冲突/保留/拒绝/工作区保护 fixture 全部通过。
- 新增 GitHub Actions 编辑器门禁：npm ci 后先检查已提交产物，再类型/Node/Python 装配及真实 file/HTTP/事务测试；不会先重建来消除过期产物。远端 CI 创建 PR 后检查，不能以本地结果代称 CI 通过。
- CI 中 file/HTTP 与事务两份浏览器 spec 的本地同命令验证：12 项全部通过。
- 当前部分迁移的四个业务 PR 逐项投影后，构建、Node 与类型均通过；#179 的 12 项设置 E2E、22 项波形契约通过。最新 #177 的 4 项浏览器失败在未迁移 classic 基线同样复现，归为上游功能/测试待修边界；#157 的竞争装配架构明确阻塞，未强行合并。详见生产交接文档与结果 JSON。

生产迁移后，类型修复分别提交为 `7c36c88`（视图契约）、`aa433ce`（utils）、`963b15d`（波形组合实例）、`096ca1ad`（HTML/浏览器边界）；旧装配测试另有独立提交。历史实验的红灯与中间诊断保留，最终实现不靠跳过测试收尾。

## 上游 PR 与交付

已创建并附加 [PR #181](https://github.com/Moyf/moys-asr-workflow/pull/181)，base 为 main，head 为 fork 的 `codex/esm-factory-migration`；GitHub 初次检查显示可合并。生产迁移、四批类型修复、契约迁移与交接门禁分开提交。

首次远端编辑器门禁的产物与类型检查通过，Node 为 443 通过/7 失败：CI 在安装 uv/Python/Chromium 前就执行了包含浏览器和 Python 对比的 Node 集；新 fixture 还假定 .worktrees 已存在。已调整准备顺序、明确 Python 解释器，并让 fixture 自建父目录。

生产代码提交 `10943876` 的 [Linux 编辑器门禁](https://github.com/Moyf/moys-asr-workflow/actions/runs/37780175510) 已全部通过，包括从 Windows 提交的产物只读检查、0 类型诊断、450 Node、28 Python 装配契约以及 12 项真实 file/HTTP/事务测试；[Ruff](https://github.com/Moyf/moys-asr-workflow/actions/runs/37780175488) 和 [Windows MAW-lite preview](https://github.com/Moyf/moys-asr-workflow/actions/runs/37780175485) 也通过。后者覆盖打包契约、Python 回归、可执行程序构建与 smoke、资源检查和预览归档。此后文档提交的检查状态以 PR 为准。

当前没有待处理的原迁移实现任务。桌面实验工程已退役，保留的边界是正式发布包未验证、上游 #177 四项已有交互失败、#157 原架构冲突，以及当前类型检查尚非全仓 strict。

## 合并审阅（压缩提交后）

早期绿灯不代表最终压缩提交通过：`0f121d59` 的 Windows preview 失败；独立工作树复跑 1833 项 Python 测试，7 项旧源码形状断言失败（21 项按本地环境跳过）。产物新鲜度、类型检查、450 项 Node、12 项 file/HTTP/事务与另 149 项浏览器交互回归通过。

| 审阅项 | 状态 | 处理决定与证据 |
| --- | --- | --- |
| 压缩后的 Python 契约 | 已修复 | `tests/test_waveform.py`、`test_local_editor_server.py`、`test_gui_workflow.py` 分离源码形状和页面注入；全量 1833 项通过（21 skip）。新增 bundle E2E 验证非默认工程/路径/语言及空白运行态，13 项通过。Windows 跨盘便携音效 URL 也按实际解析地址检查 |
| Server 开发说明与 CHANGELOG | 已修复 | `server-editor/README.md` 区分 JS 重建和 CSS/模板刷新；CHANGELOG 合并为一条 JS 体积收益，开发流程留在 DEVELOPMENT/AGENTS |
| 最终本地验证 | 已修复 | 本地 Python、450 Node、类型、新鲜度、162 浏览器项通过；实际 Rust 渲染器 + 浏览器检查通过（SDK hook stub，2 项旧清单函数未使用警告）；3 个修改的 Python 测试文件 Ruff 与 diff/LF 检查通过 |
| 最终远端 CI | 仅说明 | 最终提交的外部证据与合并决定在 PR #181 的 checks 和审阅反馈中记录，不以本地测试或旧提交绿灯代替；最终 CI 未绿不得合并 |

实现审阅：59 个工厂未捕获 classic 共享绑定，注册位置和依赖袋保留；其余文件保留单一作用域，提升/TDZ/写入有负例。类型适配没有关闭检查；当前两类入口共享已提交产物，产品用户无需 Node。正式安装包不在该次迁移审阅的验证范围；已删除的桌面实验不再要求验收。实测 bundle 从 2,284,490 B 减至 1,299,577 B（43.1%），不宣称整包同幅缩小或已测得运行加速。内联副本待发布前统一重生成。
