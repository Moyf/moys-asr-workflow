# 编辑器 ESM 迁移：实施台账与上游交接

本批在 `dfd5971f` 的调研基础上落地部分 ESM：59 个独立工厂迁移，121 个接线、门面和共享状态文件保留原有作用域。JavaScript 装配由 esbuild 完成；Python、localhost 与 Tauri 读取同一份 classic 产物，继续支持单文件 `file://` 编辑器。

## 任务台账

| 工作 | 状态 | 当前证据与下一步 |
|---|---|---|
| 机械性调研与完整 180 文件隔离实验 | 仅说明 | 已提交 `dfd5971f`；这是可行性实验，不是生产迁移 |
| 五个真实上游 PR 的冲突预演与解决脚本 | 已修复 | 真实 SHA、冲突明细、顺序合并与功能验证已留档；见下方索引 |
| 目标契约红灯 | 已修复 | 新增 `test_editor_bundle.mjs` 在旧实现上 4 项失败，缺少生产打包器；随后实现再验证 |
| 较大批次部分 ESM 与三个消费端 | 已修复 | 59 个工厂；449 Node、23 资产契约、13 个基线/file/HTTP 探针通过；Rust 真渲染器与浏览器装配通过 |
| 类型诊断分批修复 | 进行中 | 既有六文件 + 全部 59 个工厂检查：1129 项（波形 1007、utils 121、原有视图契约 1）；迁移提交后分批修复 |
| 最终回归与上游 PR | 待处理 | 源码、行为、浏览器、Rust 装配分层记录，检查后创建 PR |

## 已有证据

- [原始调研简报](../temp/ESM_MECHANICAL_RESEARCH_BRIEF.md)：最初的问题和约束；其中文件数及试点方案是当时状态。
- [机械性研究报告](../temp/ESM_MECHANICAL_RESEARCH_REPORT.md)、[契约迁移清单](../temp/ESM_CONTRACT_MIGRATION.md)：180 文件隔离实验、旧结构断言与新行为契约的区分。
- [真实 PR 冲突预演](../temp/ESM_UPSTREAM_MERGE_REHEARSAL.md)、[合并操作手册](../temp/ESM_UPSTREAM_MERGE_PLAYBOOK.md)：五个真实 PR、叠加 PR 顺序、同构投影与保留 fork 改动的方法。
- [快照](../temp/ESM_UPSTREAM_PR_SNAPSHOT.json)、[预演结果](../temp/ESM_UPSTREAM_MERGE_RESULTS.json)：固定 head/base SHA 与可复查结果。
- [实验和预演脚本](../../scripts/esm-mechanical/README.md)：隔离实验、真实 Git 对象恢复、顺序合并与负例探针。

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
- 9 份浏览器 spec：226 项全部通过（2.6 分钟）；Python 全量仍在执行，完成后回写。
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
