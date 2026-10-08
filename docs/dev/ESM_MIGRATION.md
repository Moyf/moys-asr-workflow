# 编辑器 ESM 迁移：实施台账与上游交接

本批在 `dfd5971f` 的调研基础上落地部分 ESM：59 个独立工厂迁移，121 个接线、门面和共享状态文件保留原有作用域。JavaScript 装配由 esbuild 完成；Python、localhost 与 Tauri 读取同一份 classic 产物，继续支持单文件 `file://` 编辑器。

## 任务台账

| 工作 | 状态 | 当前证据与下一步 |
|---|---|---|
| 机械性调研与完整 180 文件隔离实验 | 仅说明 | 已提交 `dfd5971f`；这是可行性实验，不是生产迁移 |
| 五个真实上游 PR 的冲突预演与解决脚本 | 已修复 | 真实 SHA、冲突明细、顺序合并与功能验证已留档；见下方索引 |
| 目标契约红灯 | 已修复 | 新增 `test_editor_bundle.mjs` 在旧实现上 4 项失败，缺少生产打包器；随后实现再验证 |
| 较大批次部分 ESM 与三个消费端 | 已修复 | 59 个工厂；449 Node、23 资产契约、13 个基线/file/HTTP 探针通过；Rust 真渲染器与浏览器装配通过 |
| 类型诊断分批修复 | 已修复 | 既有六文件 + 全部 59 个工厂检查：1129 → 1128 → 1006 → 110 → 0；迁移提交后四批修复 |
| 最终回归与上游 PR | 已修复 | 本地生产门禁、当前业务 PR 预演与资料归档完成；已提交上游 PR #181。远端 CI 状态单独记录 |

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
- `node scripts/verify-editor-desktop.mjs ROOT PYTHON`：编译并执行实际 Rust 渲染器，产物身份一致、全部模板注入完成、调色板与 Python 相同，页面启动且 180 文件轨迹正确。仅外部 Tauri SDK 构建钩子被替身替代，完整桌面应用与发布包未验证。该检查发现并补齐桌面原有的调色板/加载标记/音效路径注入缺口。
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

首次远端状态：编辑器门禁、Python lint、Windows preview 均已启动，尚未完成；这不是 CI 通过的声明。当前台账没有待处理的本批实现任务。保留的边界是完整桌面/发布包未验证、上游 #177 四项已有交互失败、#157 原架构冲突，以及当前类型检查尚非全仓 strict。
