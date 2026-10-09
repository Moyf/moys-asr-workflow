# ESM 机械迁移调研结果

日期：2026-10-08。基线：`d4e5dff2`，主工作区分支 `upstream`；试点 HEAD：`0aaf51bd`。

**当前 180 个编辑器文件可以用固定规则机械生成真正的 ESM 源码，并由 esbuild 完整装配，替代 Python 拼接 JS 源文件。这个结论成立于保留注册表、依赖袋及外部门面的兼容阶段。不能据此声称无桥终态也可 100% 自动完成，或现在可以直接合并上线。**

隔离实验的 10 项新装配契约、445 项 Node 测试及选定的 86 项真实浏览器回归全部通过。类型门仍有 235 条诊断；原始 Python 测试仍有 12 个迁移相关的结构 / 源码文本红灯，另有 7 个基线也存在的错误。正式迁移需要接着完成这些工作，不能豁免。

维护者随后明确：本次先提交调研成果，类型诊断与契约红灯暂不阻断提交，待机械转换与整体迁移完成后统一解决。下文保留实际失败记录；后续顺序属于建议，不作为本次提交的前置条件。

本轮只新增并提交调研工具与文档。主工作区 `web/`、Python / Rust 消费端、现有测试、`blank-editor.html` 均未改动。研究开始与完成时产品 tracked diff 均为空；原有未跟踪目录 `.qwen/`、`docs/temp/`、`frontend/`、`local-test/` 保留。此次提交仅包含本任务成果，未推送、发布。

## 进度账本

| 工作项 | 状态 | 结果 / 下一步 |
| --- | --- | --- |
| 注册、resolve、依赖袋、分类盘点 | 仅说明 | 逐文件与逐调用 JSON 完成 |
| 加载顺序、共享绑定、外部桥调查 | 仅说明 | 找到函数提升、可变状态及 8 个外部词法桥问题 |
| 5 文件局部 codemod | 已修复 | 445 Node、23 资产契约、12 三页探针、8 原型测试通过；仅为历史局部证据 |
| 完整 ESM 图及三消费端装配实验 | 已修复 | 180 文件机械转换；Python / Server 读单一产物，Rust 实际渲染路径验证 |
| 新契约红绿实验 | 已修复 | 中间态构建成功但 E2 / E6 失败；最终 E1–E10 全通过 |
| Node 加载器及交互回归 | 已修复 | 行为断言保留；445 Node、86 选定 E2E 通过 |
| 七项结论、人工点、契约分类、风险、回滚 | 仅说明 | 本报告及契约迁移表完成 |
| 正式类型门 | 待处理 | 235 条诊断；按维护者决定，整体迁移后统一适配 |
| 正式 Python 契约迁移 | 待处理 | 12 个旧形态红灯及 7 个基线错误，整体迁移后统一处理 |
| 完整桌面运行、全部 E2E、生产性能 | 仅说明 | 未验证；不以装配或选定回归冒充这些结果 |

“已修复”表示研究原型接通并验证，不表示主分支已迁移。研究交付完成；延期处理项保留为真实红灯，不计为通过。

## 范围与机械化比例

当前 `web/` 有 183 个 JS 文件，其中编辑器清单 **180 个**，另 3 个 Launcher 文件不在本次装配范围。简报中的文件数已过时。

| AST 分类 | 文件数 | 占比 | 转换规则 |
| --- | ---: | ---: | --- |
| 单工厂注册模块 | 59 | 32.8% | 导出原工厂，保留注入，延后注册 |
| 接线文件 | 37 | 20.6% | 显式初始化，保留副作用顺序 |
| 模板注入文件 | 2 | 1.1% | 保留 token，构建后注入 |
| 门面 / 状态 / 其他 | 82 | 45.6% | 保留私有 IIFE，共享绑定改为导入的活访问器 |

180 文件均由同一脚本处理，没有逐文件手写转换。59 个原工厂直接导出，另外 121 个使用分阶段初始化模板；当前语法形态机械覆盖率为 100%，**不等于全部功能已穷尽验证**。

人工判断集中在架构规则，不能按文件数计算自动解决率：285 个依赖袋键的直接 import 来源未证明；注册表退役、桥的公开性、类型适配、产物发布与 Server 开发刷新策略仍需决策。本原型保留这些语义，未声称自动退役它们。

## 七个难点

### 1. 注册表与依赖袋

盘点得到 68 处 register、63 处 resolve，名称均为静态字符串。resolve 参数形态：57 个标识符、5 个对象字面量、1 个成员表达式。JSON 保留调用位置、工厂签名、袋键、返回键及候选提供方。

utils 与波形聚合层逐次扩充同一个 helpers 对象。袋的值可能来自前一工厂、闭包、DOM、宿主或调用方覆盖；相同键名不证明相同来源。285 个候选键均标记为保留注入，直到调用点来源被证明。**工厂导出可机械完成；全部依赖袋改为直接命名 import 尚不能宣称可机械完成。** 依赖覆盖测试继续通过。

### 2. 加载期顺序

简单按清单写 import 不够：依赖图可能提前求值，classic 跨文件函数 / var 提升也会丢失。实验实际捕获过 normalizeAssColorStyleValue 在所有者执行前无法访问的问题。

原型让 ESM 求值只建立声明；每文件导出生成器 initialize。第一轮推进到 yield，为所有文件建立局部声明和共享访问器；第二轮按原清单顺序执行原语句。函数提前可见，var 为 undefined，let / const 在原声明前保持 TDZ。注册、监听器与立即 resolve 保持原顺序，页面实测 180 条初始化轨迹。

E9 独立验证前向函数、var 与 TDZ；E8 验证赋值、后置自增、const 失败及 shadowing。产物显式严格模式，防止 const 写入在 classic IIFE 中静默忽略。算法针对当前形态，不是任意未来 JS 的通用语义证明。

### 3. 跨模块引用

找到 234 个消费文件 / 名称组合，完整转换改写 565 处引用，包含 9 处跨文件写入。用 unresolvedRefs 词法分析，只改写别的文件拥有的自由引用；局部变量不改，简写属性展开。

import 绑定不能直接赋值，因此导出捕获原绑定的活 getter / setter 对象，经真实 ESM import 访问。读写指向同一状态；const 没有 setter。window 门面和浏览器 API 保留。E2 验证产物无旧共享词法名泄漏。

转换器拒绝重复共享名称、顶层解构、顶层 class 与生成名称冲突，当前 180 文件未遇到这些拒绝形态。后续出现新形态应加规则或人工审查，不可静默绕过。

### 4. 分类与模板

分类见上表；模板文件为 editor-boot.js 和 editor-i18n.js。esbuild 后保留已知工程 / i18n token，由 HTML 层替换。file / localhost 探针验证非空工程注入、整数毫秒、未知扩展字段保留、SRT、合并及撤销。

数据注入会改变 bundle 原文，最终 HTML 不能要求原始 bundle 全文原样出现。新契约用内容哈希身份标记核对装配来源，另查实际注入与已知 token。__PURE__ 是构建器注释，不是模板 token；完整实验未靠压缩隐藏旧断言冲突。

### 5. E2E 与外部桥

历史扫描发现 116 个外部全局候选（冻结 inventory 保留当时桌面桥记录；当前扫描仅覆盖 E2E），含浏览器 API、测试变量和产品门面，不能都认作公开 API。明细在 inventory.externalBridges。

8 个原来借 classic 共享词法环境访问的名称需要额外兼容：loadAssStyleLibrary、ASS_STYLE_LIBRARY、assModeToggle、assStyleManagerSetSelection、updateAssStyleManagerLibrary、syncAssStyleForm、convertOverlayCueToMain、openOverlaySplitModal。原型桥接到同一 ESM 绑定。

第一轮 18 项 E2E 中 ASS 颜色测试实际失败：给 ASS_STYLE_LIBRARY 赋值未更新模块状态，classic 对照通过。修正活桥后，原测试不改的 86 项回归通过。仓库外的未知消费者仍需桥退役前确认。

### 6. 消费端终态

采用 **全端读同一 classic bundle**。180 个独立 ESM 源文件由 esbuild 形成依赖图；Python 只读取 editor-bundle.js 并做 HTML / 资源 / 数据注入，Server 走同一渲染路径，Rust 读取同一产物。E3 把 Python 源清单读取函数替换为抛错，正式页面仍生成，证明不再由 Python 拼接 JS。


全端 bundle 只维护一种执行产物，便携 file 页面实测通过。Server 原生模块方案要维护第二种装配 / 注入路径，本轮未实施。明确行为变化是 Server 请求不能直接反映未构建源码，需要开发 watch / 构建流程；纯 Python 最终用户无需 Node，但发布必须携带新鲜产物。正式迁移必须写明此开发与发布约定。

### 7. Node 与模块标识

实验用 web/package.json 显式 type:module，保留 .js 路径，不依赖自动猜测。旧 classic 源码检查改为 ESM 源码解析与 classic 产物解析；VM 测试加载器编译 ESM 夹具，行为测试体保留。

简报称自动语法检测需 Node ≥23 不准确，默认启用版本是 22.7.0，见 [Node 官方文档](https://nodejs.org/download/release/v22.12.0/docs/api/packages.html)。本轮实跑 25.8.0，未实测较旧 Node；最低版本需项目决策与 CI 验证。

## 红绿结果与分层验证

先定义新契约，再跑红灯，随后实施完整实验。最初缺构建器的副本 E1–E8 全红。更有意义的中间态完整构建成功，却因共享作用域未连接使 E2 / E6 失败，真实页面报 MULTI_SUBTITLE_UTILS 未定义。测试随后捕获函数提升、严格模式和 ASS 外部桥问题；修实现后转绿。E9 / E10 后续保护提升 / TDZ 和故意破坏产物时的无副作用检查。

| 验证层 | 最终实际结果 | 边界 |
| --- | --- | --- |
| 目标装配 E1–E10 | 10 pass / 0 fail / 0 skip | 完整图、三消费路径、负例与语义夹具 |
| 三页行为探针 | 13 / 13 | Python 基线、正式 file、真实 localhost |
| Node 基线 | 445 pass / 0 fail / 0 skip | 完整开发依赖环境 |
| 完整实验 Node | 445 pass / 0 fail / 0 skip | 仅适配加载方式和两项旧结构测试，最终复跑 |
| 既有浏览器回归 | 86 pass | 9 个 spec，原测试未改 |
| Python 基线 | 1833 项；7 error、27 skip | 不把错误或 skip 计作成功 |
| 完整实验原始 Python | 1833 项；10 fail、9 error、27 skip | 最终产物复跑；7 error 与基线相同，新增 12 个旧形态红灯 |
| 原始资产契约子集 | 23 项；16 pass、6 fail、1 error | 是上一行的一部分，不额外累加 |
| typecheck 基线 | 1 条诊断 | ViewInvalidation 缺 cueListPatch |
| typecheck 完整图 | 235 条诊断 | 60 条 TS2630 来自生成的函数 setter，其他含全局声明 / 扩大范围暴露的问题 |
| 主工作区 / 试点 | tracked diff 为空 | 产品源码及主便携产物未迁移 |

类型门原来只指定 6 个 JS 文件，ESM import 扩大了依赖检查范围。235 条不能统称基线错误，也不能用 any / ts-ignore / 缩小检查集消除。需调整访问器模板与类型契约。

9 个 E2E spec：editor-transactions、speaker-labels、timed-text-edit、open-project-attach、overlay-track、ass-export、waveform-deletion、keyboard-timing、playback-refresh。覆盖拖动、播放、Seek、撤销、导入导出；waveform-deletion 含 localhost / 便携页。未宣称全部 E2E 运行。

历史 5 文件局部实验的绿灯只证明嵌回旧拼接路径可行；完整实验才验证用户本轮明确的 esbuild 替代 JS 拼接目标。局部实验曾用 minifyWhitespace 避免 __PURE__ 与旧检测冲突；完整实验改为正确的 token 契约，不以这个技巧作为迁移终态。

## 原始 Python 新增红灯

23 项资产契约逐项处置见 [ESM_CONTRACT_MIGRATION.md](ESM_CONTRACT_MIGRATION.md)。下表列完整 Python 的 12 项新增红灯。“已有证据”不意味着每项所有行为意图已经替换验证。

| 测试名（省略 test_） | 原因 | 新证据 / 正式迁移下一步 |
| --- | --- | --- |
| editor_script_payload_follows_manifest_order | 查源码原文位置 | E1/E3/E6；替换为产物与真实初始化顺序 |
| nested_sources_preserve_order_and_comments | 夹具只有源码，没有产物 | 改消费夹具；保留清单校验，补路径 / 重复 / 越界负例 |
| generated_page_contains_registered_modules_in_order | 泛化 token 匹配命中 __PURE__ | E6 已查已知 token、桥及初始化轨迹 |
| server_page_uses_shared_template_and_routes_stickers | 要求原始 bundle 全文进入已注入 HTML | E3/E6 覆盖身份及注入；路由断言仍保留 |
| blank_editor_inlines_modular_assets | 查旧源码原文 | file 页与 E3/E6；资源 / CSS 契约保留 |
| ass_style_library_saves_require_token_and_flush_before_unload | 原文 / 引号改变 | ASS 回归通过；鉴权及卸载 flush 仍需专门运行断言 |
| gap_state_labels_match_in_mawe_and_align | 标签对象源码改变 | 需运行读取标签核对，未用拖动测试替代 |
| waveform_gap_display_type_uses_shared_core_and_subtle_protected_style | classList 原文改变 | 波形回归通过；分类 / 保护样式需对应状态与 DOM 断言 |
| sticker_root_uses_server_validation_without_browser_picker | Escape 等原文改变 | 仍需路径校验、关闭和能力选择运行验证 |
| sticker_otio_exposes_portable_mode_and_relative_metadata | 选项原文改变 | 仍需便携 OTIO 相对元数据输出验证 |
| long_media_waveform_hint_points_to_maw_gui | 提示源码结构改变 | 仍需长媒体状态的实际提示验证 |
| reapeaks_waveform_is_the_default_shape_source | 默认来源源码改变 | 波形回归通过；仍需明确默认来源断言 |

7 个基线错误涉及 GUI / 服务帮助及本地运行入口等 subprocess 测试，日志中 stdout / stderr 为 None 引发错误。未查明完整原因，不笼统归咎于缺依赖，也未修改无关测试。

## 风险、后续顺序与回滚

1. 修类型基线并定义整个图的类型门；适配活访问器生成与环境声明，不能靠不检查文件减少诊断。
2. 迁移 Python 结构契约，逐项补上表行为意图的运行证据。用新契约替代旧拼接断言，后面不恢复过时的拼接要求。
3. 固定产物路径、发布携带规则、开发 watch 与 CI 新鲜度门。构建导入和检查纯读，只有显式 --write 写产物。
4. 逐批落地源码、入口、消费端、加载器及产物；另验正式发布包和剩余 E2E，再考虑退役注册表、依赖袋与桥。

原型未优化大小或性能：产物约 2.41 MB，180 个生成器、565 处访问器引用未做生产性能基准。选定测试未见问题不证明无开销。显式 initialize 调用保证必须执行的副作用保留，相关依赖图 / tree shaking 语义见 [esbuild 官方 API 文档](https://esbuild.github.io/api/)。

每批回滚应原子恢复该批源码 / 入口 / 模块标识、消费端、加载器与对应产物，不能只退回源码留下新 bundle。渐进混合轨须先验批次连续性及桥；完整终态同时切换三消费端。主产品本轮没有迁移，无需产品回滚。

## 复现与证据

复现步骤及工具说明：[scripts/esm-mechanical/README.md](../../scripts/esm-mechanical/README.md)。工具版本：Node 25.8.0、esbuild 0.28.2、acorn 8.18.0、eslint-scope 9.1.2、TypeScript 7.0.2、Playwright 1.62.0。

- AST 明细：docs/temp/ESM_MECHANICAL_INVENTORY.json。
- 汇总证据：docs/temp/ESM_MECHANICAL_VALIDATION.json。
- 隔离目录：.worktrees/esm-mechanical-research-20261008/{baseline,converted,naive,full}；converted 为历史 5 文件实验。
- 最终日志：full 的 target-tests-final.log、node-final.log、python-final.log、typecheck-final.log、e2e-expanded.log、full-browser-verdict.json；红灯：naive 的 intermediate-tests-final.log；基线：baseline 的 node-tests.log、python-all.log、typecheck.log。

隔离目录和大日志不纳入提交。主目录起初开发依赖不完整，原地 Node 为 420 pass / 3 fail / 2 skip；上述对照都使用同一完整依赖目录，不把环境修复算作迁移效果。完整实验没有跳过新的守门测试；既有 Python 的 27 skip 原样记账。
