# PR-3（显式装配，消除人工维护的装配信息）执行账本

分支：feat/editor-esm-pr3-explicit-assembly（基线 PR-2 = 5ddf45b5）。
目标：清单顺序被显式依赖/启动流程取代前不删 `editor-scripts.txt`；
最终构建、源码运行、测试加载器、新鲜度检查全部不再读取清单。

## 现场清点（证据）

- 终态装配 compileEsmEntry：两阶段生成器（全量 phase-1 提升 → 清单序
  phase-2 交错 register），188 输入 / 61 工厂 / 8 桥。
- import 图 110 条 manifest 内边中 72 条前向边——两phase 才能承载；
  图本身有环（wiring 文件互相引用），拓扑序不存在。
- 38 个文件的 phase-2 含直接 DOM 接线；editor-startup 的 phase-2 是
  真正的启动序列（时间码修复/渲染/桥接/服务器监视）。
- 打乱实测（.worktrees/replay/shuffle-probe，不入库）：全清单反转
  与「首 10 固定+其余反转」都启动崩溃（Cannot destructure /
  reading 'DATA'）——清单位次被真实消费，红灯事实成立。

## 批 1：红灯测试（已完成）

- tests/test_assembly_contracts.mjs（node，行为面）：
  - C1 桥：活访问器——getter 读到实现、mutable 桥写回源绑定、
    const 桥 TypeError；真实登记表 8 桥名称/文件存在性。
  - C2 顺序：boot 置于消费者之后 → vm 启动崩溃；正常序 → 数据可见。
  - 注册表契约原计划 vm 断言 61 注册名，实测真实 bundle phase-2 在
    vm 里 DOM 面持续加深（documentElement.lang、URLSearchParams、
    …），假桩不可信（PR-2 教训重演）→ 移到 e2e。
- tests/e2e/assembly-order.spec.mjs（真页面，5 条）：
  - O1 启动行为全链（渲染/波形/导出/合并撤销）；
  - O2 初始化 trace 与清单全等、首 editor-boot、末 onboarding；
  - O3 注册名覆盖登记表 61 项且无重复（运行时另有 6 个代码内注册
    门面：editor-host/waveform/editor-commands/editor-state/
    editor-view-updates/editor-utils——登记表收缩时要一并处置）；
  - O4 8 桥真页面活访问器；写语义实测：ASS_STYLE_LIBRARY（let）
    写回，7 个函数名桥只读（转换器 getter-only）——登记表
    mutable 标记对函数名是假的，批 3 修；
  - O5 顺序红灯：PR1 classic 树打乱（boot 后置）→ 真页面启动崩溃
    （bridge=false、trace 停在 1、pageerror reading 'DATA'）。
- 验证：node 2/2、e2e 5/5、check:editor 新鲜。

## 批 2a：入口显式化（已完成）

入口不再按清单位次消费初始化：`compileEsmEntry` 重构为
注册表创建 → 61 工厂统一注册 → 桥 → **显式 bootstrap 序** →
其余 classic phase-2 清单序。登记表新增 `bootstrap` 数组（14 文件，
注册表创建者 editor-runtime 固定头部先行）。

### 顺序敏感面实测（分析工具见 .worktrees/replay/analyze-order*.mjs，不入库）

- 直接跨文件门面边 112 条（IIFE 立即执行体计为顶层）；
- 发布者子图内部仅 1 条边（editor-state 读 MaweBoot）；
- utils/waveform phase-2 在顶层 resolve 工厂 → 注册先行的前提；
- utils-ass-canvas-layout 等 7 个 phase-2 自注册门面不在 61 工厂表内；
- editor-dom 等 40+ 发布者由消费者延迟读取（存储型函数体）。

### 契约（O2 更新为显式序）

trace = [runtime] + 61 工厂（登记表序）+ bootstrap（登记表序）+
其余清单序；`buildEditor` 返回 `initializationOrder` 作为权威，
E6（full-verify）与 e2e O2 都与它比对；E6 bootShape 的注册名
比较改为集合语义（次序归 initializationOrder 管）。

### 红灯与绿灯

- O5a（红）：bootstrap 序内把 editor-boot 挪到消费者之后 →
  真页面启动崩溃（bridge=false、trace 停 62、pageerror reading DATA）。
- O5b（绿）：bootstrap 内无耦合相邻对（i18n↔tooltip）互换次序 →
  行为完全一致。
- 全量打乱在当前代码下必然红（wiring 层 109 条跨文件边仍依赖
  位次，接线的读写大多在事件回调里延迟执行，静态分析无法证明
  「叶」），故全量打乱绿灯是批 4 终态目标，不提前伪造。

### 验证

| 层 | 结果 |
| --- | --- |
| node 全量 | 608/608（+2 契约） |
| 装配契约 E1-E10 | 9/9 |
| e2e assembly-order | 6/6（O1-O4、O5a 红、O5b 绿） |
| e2e waveform-history | 53/2*（*两失败与 PR-2 账本记录的 main 既有失败同名同数） |
| e2e click-behavior | 36/36 |
| typecheck | 110 基线 / 新增 0 |
| check:editor / check:launcher | 新鲜（launcher bundle 因构建器哈希联动重建） |

## 批 2b：全量 classic 显式序（已完成）

- 尝试 1：用静态分析（IIFE 感知的顶层执行扫描）算 146 条直接边的
  Kahn 拓扑序替换 bootstrap——真页面验证崩溃（MaweCueElements
  undefined）：存储型函数体内的延迟读取无法静态判别执行时点，
  保守口径下切片为 0。结论：静态重排不可靠，放弃。
- 尝试 2（采纳）：**bootstrap = 当前清单的 classic 全序**。生产
  清单序已被证明满足全部直接约束，把它整体搬进登记表 bootstrap
  数组后，入口不再消费清单位次——清单只剩「打包文件集」职责。
- O5b 升级为**整份清单反转**绿灯：phase-2 执行序完全由显式
  bootstrap 序决定，打乱清单后 188 文件初始化、注册、波形、
  桥接全部一致。
- 试错教训（静态启发式三连败：遗漏 IIFE 体、漏 IIFE 内嵌声明的
  函数调用、Map.values().flat() 对 Set 无效）记入账本防复发。

### 验证

| 层 | 结果 |
| --- | --- |
| node 全量 | 608/608（2 个 process-lifecycle 用例首轮超时、复跑 22/0，并行负载抖动，与本批无关） |
| 装配契约 E1-E10 | 9/9 |
| e2e assembly-order | 6/6（O5b=全量清单反转绿灯） |
| e2e 全量复跑 | waveform-history 53/2*（*与 main 既有同名同数）、click-behavior 36/36、ai-cleanup+multi-subtitle 90/90、i18n/drop/new-project/keyboard/ass-export 88/88 |
| typecheck | 110 基线 / 新增 0 |

## 批 3：登记表收缩（已完成）

- 构建期校验 `validateRegistry`：①工厂注册名必须有消费来源
  （某源码存在 `MAWE.resolve('<name>')` 字面量，61/61 全命中）；
  ②注册名查重；③externalBridges 的 mutable 标记与 owner 绑定
  种类强校验——函数名声明（转换器 getter-only）与 const 绑定
  不得声明 mutable。
- mutable 假标记修正：6 个函数名桥（loadAssStyleLibrary 等）
  mutable true→false；ASS_STYLE_LIBRARY（let）保持 true。
  O4 桥写语义契约与登记表现已一致。
- modules 列表保留为显式登记（注册名↔文件配对无可靠推导信号，
  「单 export create*」约定仅覆盖导出名推导）；来源存在性+查重
  由构建期强制，人工维护面收缩为「新增工厂时同步 resolve 消费」。
- 代码内自注册门面（editor-host/waveform/editor-commands/
  editor-state/editor-view-updates/editor-utils/utils-ass-canvas-layout）
  清点入账本，O3 契约按「登记表工厂必须全部在列」断言。

### 验证：node 契约 2/2、装配契约 9/9（复跑）、e2e assembly-order 6/6、check:editor 新鲜。

## 批 4：编辑器清单退役（已完成）

editor-scripts.txt 已删除（移入回收站）。文件集与次序的
职责拆分落地：

- **文件集 = 目录推导**：`build-editor.deriveSources` 遍历
  `web/editor` + `web/shared` 全部 `.js`（排除 `*.bundle.js`
  产物与 `.meta.json`，排序后 `validateSources` 逐文件校验
  realpath 不逃逸 web）。派生消费者全部同口径改写：
  edit.py `_editor_source_files`、maw/web_build.py、
  tests/helpers/editor-module-loader.mjs、
  tests/test_editor_script_syntax.mjs、
  scripts/refactor-tools/editor-sources.mjs、
  replay-verify（提交侧文件列表改为推导）。
- **次序 = 登记表 bootstrap 显式序**（批 2b 已承接），入口/
  加载器不再读清单任何字段。
- **新鲜度**：web_build.bundle_status 对 editor 走
  「推导集合 vs meta.sourceFiles」比对（集合差异报新增/移除
  明细），launcher 清单路径不变；stray-file 场景由
  test_stale_when_source_set_gains_file 守护。
- **行为独立于发现顺序**：e2e O5b 从「清单反转」升级为
  **仓库级 stray-file 金丝雀**——向 web/editor/boot 新增
  zz-derived-canary.js → 重建 → 页面正常启动且 trace 含
  金丝雀（189 条）→ 清理恢复。文件集由目录推导不再
  依赖任何人工列表。
- 排序口径陷阱（已修 + 注释）：python `sorted(Path)` 按
  分段比较（`waveform` < `waveform.js`），与 node 全串
  排序（`.` < `/`，`waveform.js` 在前）不一致——
  `_editor_source_files` 改为对完整相对路径字符串排序，
  与 deriveSources 逐元素一致（188/188 全等验证）。
- 删除 `tests/test_editor_manifest.py`（清单契约随清单退役）；
  test_editor_assets 门面序断言从 index 序放宽为成员序
  （bundle 文本序≠执行序，执行序由 O2 契约覆盖）。

### 消费者清点（editor-scripts.txt → 0）

| 消费者 | 改造后 |
| --- | --- |
| build-editor | deriveSources 目录推导 |
| edit.py | _editor_source_files 推导（保留 read_editor_script_manifest 兼容名） |
| maw/web_build | editor 推导集合比对；launcher 清单未动 |
| editor-module-loader.mjs | 推导 walk + bootstrap 序 |
| replay-verify | 推导集合 |
| refactor-tools | editor-sources.mjs / rebuild-contract.py 推导 |

### 验证

| 层 | 结果 |
| --- | --- |
| python 全量 | 2134 通过（skip 21） |
| node 全量 | 607/607 |
| 装配契约 E1-E10 | 9/9 |
| e2e assembly-order | 6/6（含 O5b 金丝雀） |
| check:editor / check:launcher | 双新鲜 |
| typecheck | 110 基线 / 新增 0 |

### 遗留边界

- launcher classic 清单（launcher-scripts.txt）按 /goal 明确
  另开一批，本 PR 未动。
- modules 登记表仍是显式人工列表（批 3 结论：注册名↔文件
  配对无可靠推导信号），由构建期校验兜底。

## 评审回执（10-14，第二轮意见全部采纳）

评审定位修正接受：本 PR = **清单文件退役、旧顺序集中承接**，
不是「脱离手工维护顺序」完成态。bootstrap 127 项与 PR2 旧清单
逐项等价（仅 runtime 规范化），手工顺序只是从 txt 搬进登记表
JSON——这是刻意的过渡步（静态重排三连败后保全序语义，见批 2b），
真正的「脱离手工表」需要后续逐组把源码依赖显式化、逐组缩短
bootstrap，本 PR 不宣称完成。

### 评审点 2：目录发现静默漏装 —— 已修（形态门）

- 构建期 `validateShapes`：文件集中每个文件必须是登记工厂或
  `export function* initialize` 转换体，四不像文件**构建失败**
  （报错给出三条出路：登记 / 转换 / 移出 web/editor|shared）。
- `compileEsmEntry` 的 classicPredicate 影子路径（不 import、
  只进 trace 的「纯成员」分支）整体移除——非工厂文件无条件
  import + 驱动，漏装不再可能伪装成已装配。
- E5 新增反例断言：注释金丝雀加入推导集合的同时 `buildEditor`
  必须拒绝；O5b 重写为**沙盒副本 + 真实执行**：金丝雀自带
  initialize（预转换形态，不进任何清单），转换构建后页面启动
  且副作用真实发生、trace 含它——不再在共享工作树写文件/重建
  产物（评审可安全复跑）。

### 评审点 3：残留 —— 已清

- AGENTS.md / docs/engineering/DEVELOPMENT.md：清单指引改为
  目录推导 + bootstrap 显式序 + 登记表口径。
- scripts/migrate-editor-factories.mjs：readSources（已删）→
  deriveSources 别名导入，工具恢复可加载。
- e2e spec EOF 多余空行：已修，`git diff --check` 干净。
- 契约沙盒配方修正（账本记录，便于复跑）：full 根 = PR1 档案
  + **当前** editor-modules.json / maw/web_build.py /
  scripts/build-editor.mjs + sandbox 标记 → full-convert →
  full-build；baseline 根用其自带 PR1 构建器出 bundle。
  旧配方在批 4 后会因 PR1 版 web_build 按清单比对新鲜度而误报。

### 验证

| 层 | 结果 |
| --- | --- |
| node 全量 | 607/607 |
| 装配契约 E1-E10 | 9/9（含新形态门反例） |
| e2e assembly-order | 6/6（O5b 沙盒化 + 真实执行断言） |
| python 全量 | 2134 通过（skip 21） |
| typecheck | 110 基线 / 新增 0 |
| check:editor / check:launcher | 双新鲜（launcher builderHash 覆盖共享构建器，重建后一致） |
| git diff --check | 干净 |

## 评审回执补充（10-14 晚，O5 沙盒可复现性修复）

评审在 run_check 环境复跑：O1–O4 过，O5a/O5b 在解包 PR1 档案时
`tar -xf base.tar` 报 `Invalid empty pathname`——其进程 PATH 解析
到的 tar 对档案里 48 个中文路径（docs/logs 等）解出空路径名。
本机 git-bash 的 GNU tar 能解，属 PATH/代码页相关的环境脆弱点，
「6/6」在评审环境不可复现——接受。

**修复：沙盒基线提取从 `git archive | tar` 改为 `git worktree add
--detach`**——git 原生检出对 Unicode 路径与终端代码页不敏感，
彻底不依赖 PATH 里的解包工具。清理配套：discardSandbox = 先
rmSync（Node 对 junction 拆链接不递归进目标，node_modules 安全）
再 `git worktree prune` 清主仓管理项；O5a/O5b 的 finally 统一走它
（O5b 此前断言失败会跳过清理，一并补上）。

复跑（评审同款命令经 run_check：`pnpm exec playwright test
tests/e2e/assembly-order.spec.mjs --project chromium`）：
6/6 通过（29.4s，O5a 12.5s / O5b 11.2s，均真实执行到行为断言）。
事后核验：worktree list 无沙盒残留、node_modules 完好、
check:editor 新鲜、git diff --check 干净。

运行日志：.artifacts/checks/20261013T191156Z-3f8f85b8/。
评审未复跑的装配契约 9/9 沙盒配方见上节（三环境变量 +
full/baseline 根制备步骤）。

## PR-2/PR-3 提交链重写（10-14，维护者指令）

应维护者要求整理 PR-2 链：剔除两条红灯 WIP 提交（6aa3eed4、
6a3ead04，其内容已由落地提交 fb4beec9 完整覆盖），并从历史中
彻底移除赃物 blob——根 package-lock.json（WIP1 引入）、
web/launcher/boot/tooltip-bundle.js（落地提交误入库、3b13dee6
删除）、E6 探针三件（full-baseline/current-probe.html、
full-browser-verdict.json）、E8/E9 夹具目录（hoisting-probe/、
live-binding-probe/）、full-probe-settings/（E6 服务器设置目录
误捕的 fnm 临时命令文件）。website/、desktop/ 的 lockfile 与
probe-projection.py、probe-namespace.mjs 是 PR1 之前的既有跟踪
文件，不在清理范围。

方法：commit-tree 逐棵重建保留链六提交（fb4beec9→3b13dee6→
17fa4082→2d2aa9d4→fcf840aa→5ddf45b5），临时索引过滤赃物路径，
保留原作者/日期；PR-3 七提交 rebase --onto 新链，零冲突。
仅两条消息因探针 diff 消失而失准，微调措辞（2d2aa9d4、
5ddf45b5）。重写前建本地备份分支 backup/pr2-pre-rewrite、
backup/pr3-pre-rewrite。

### SHA 映射（旧 → 新）

| PR-2 | 旧 | 新 |
| --- | --- | --- |
| 落地 | fb4beec9 | f28cee36 |
| tooltip-bundle 忽略 | 3b13dee6 | ef6485ae |
| 类型门基线 | 17fa4082 | abd5a18f |
| probe-settings 清理 | 2d2aa9d4 | 0af7971f |
| 终态账本 | fcf840aa | 48aa7103 |
| getter 规则+重放 | 5ddf45b5 | 85ba4260 |

| PR-3 | 旧 | 新 |
| --- | --- | --- |
| 批1 | 7c418fce | 46925ba4 |
| 批2a | dd9653c1 | 54484fab |
| 批2b | 93d6b46e | c339f604 |
| 批3 | ff797db2 | 24e8beb5 |
| 批4 | 5ba310f9 | d16653e9 |
| 形态门 | 5d106208 | 0bfc4cfd |
| O5 worktree 修复 | 048be3ce | 8d1d77ea |

### 验证

| 项 | 结果 |
| --- | --- |
| 新 PR-2 终树 vs 旧 5ddf45b5 | 逐字节一致（git diff 空） |
| 新 PR-3 终树 vs 旧 048be3ce | 逐字节一致（git diff 空） |
| 赃物 blob 可达性（WIP lock/tooltip-bundle/探针） | 新 PR-2/PR-3 链均 0 可达 |
| check:editor / check:launcher | 双新鲜 |
| node 抽验（bundle+syntax） | 5/5 |
| e2e O5 沙盒基线 | feat/editor-esm-pr1-foundation 未参与重写，不受影响 |

两分支强推 cat（--force-with-lease）。旧对象在远端 GC 前仍可能
暂存，本地备份分支确认后可删。

## 批5 及摘除通道（10-14，/goal：摘 bootstrap 到空）

目标升级为把 127 项 bootstrap 全部摘除。先做安全证明与机制：

- **立即边图**：AST 区分 phase-2 立即执行（顶层语句 + IIFE 体）与延迟
  执行（存储函数体），v1 分析器得 112 条立即读边、**零环**；原
  bootstrap 序满足全部边；叶剥离模拟证明 127 文件全部可摘（peel 逆序
  == 原序），任意前缀合法。早先 973 边/135 环为正则全文扫描噪声。
- **批5（e1b1d661）**：登记表新增 `deferred` 数组——摘出的转换体在
  全部 bootstrap 之后按**原 bootstrap 相对序**执行。构建器
  `compileEsmEntry` 驱动序 = runtime → 工厂注册 → 桥 → bootstrap →
  deferred；`initializationOrder`/metadata/e2e O2/Node 夹具加载器同步；
  装配契约新增 C3（摘叶行为面：叶照常执行且仍读更早门面；非叶被摘崩）。
- **批6a**：摘首叶 `editor-onboarding.js`（127→126）。
- **批6b（5d6b6c40）**：摘 `editor-startup` + 11 个尾段 wiring 叶
  （127→114，deferred=13）。首次构建真页面崩：工具按摘除顺序追加
  deferred，onboarding 被排到 startup 之前、解构 MAWE_EDITOR_BRIDGE
  undefined——**摘除顺序 ≠ 执行顺序，deferred 必须保持原相对序**。
  同时发现 v1 门面正则漏 `MAWE_*`（MAWE_EDITOR_BRIDGE 正是漏网边）。
  修复：deferred 按原序快照（git show 80f126ed）归位 + 工具内建该
  不变量。另修 Python 文本模式写 JSON 产生 CRLF 导致 configHash 失配。
- **v2 tripwire**：`analyze-immediate2.mjs` 用 AST 抓全部 window 发布
  （325 边，含 MAWE_*；会高估——回调实参被当 IIFE——只做报警不做
  排序依据），当前摘除 0 违规。

验证（批6b 后）：契约 7/7、e2e assembly-order 6/6、node 608/608、
typecheck 110 基线 0 新增、双 bundle 新鲜、真页面探针
（bridge=true/trace=188/cueRows=2/errors=[]）全绿。

剩余批次与终簇（runtime/boot/state 摘除需改 REGISTRY_CREATOR 特判与
O5a 契约）的执行手册见
[PR3 bootstrap 摘除执行计划](../../../../plans/PR3_BOOTSTRAP_PEEL_PLAN.md)。

### 批7/批8 执行记录（10-14）

| 批 | peel | 摘除 | 状态 | 验证 |
| --- | --- | --- | --- | --- |
| 批7（364771a1） | 14-28 | 15 wiring（99 剩 / d28） | 已修复 | 探针+契约 7/7+e2e 6/6 |
| 批8（9988e029） | 29-44 | 16（83 剩 / d44，editor.js/timeline 等） | 已修复 | 同上 + node 608/608 + python 2134 全绿（复跑） |

批7 曾被 v2 tripwire 报 1 条 deferred 内部序违规
（ass-preview→ass-canvas），人工核实 3 处读取全在存储
函数体内（延迟），属 v2 isIIFE 高估；修复 isIIFE（回调实参
非 IIFE）后 0 违规。批8 python 全量首轮 1 例计时类抖动
（gap-removed-media-jobs clean_partial_output），单例与
整模块复跑 OK、HEAD 无改动对照 OK、第二次全量 2134 全绿——
并行负载抖动（与批 2b 记录同款），非本批引入。

v2 tripwire 高估源已修：CallExpression 普通实参（回调）不再
判为 IIFE；仅 callee 直调与括号包 unary 两种形态算立即。

### 批9-批13 终态（10-14）

| 批 | peel | 摘除 | 提交 | 验证 |
| --- | --- | --- | --- | --- |
| 批9 | 45-63 | 19 cues/io（64 剩 / d63） | ae8ac28d | 探针+契约 7/7+e2e 6/6 |
| 批10 | 64-84 | 21 io/媒体中段（43 剩 / d84） | bfc9d681 | 同上 + node 608/608 |
| 批11 | 85-104 | 20 导出/UI（23 剩 / d104） | 47568a51 | 探针+契约+e2e |
| 批12 | 105-124 | 20 state/shared 深层（3 剩 / d124） | 670b3932 | 同上 + node + python 全绿 |
| 批13 | 125-127 | **bootstrap 摘空（deferred=127）** | d80245cd | 见下 |

**批13 代码改造**（不可机械摘的三点，均按计划落地）：

- REGISTRY_CREATOR 特判覆盖 bootstrap ∪ deferred：runtime
  在 deferred 头部时仍先于工厂注册驱动。
- O2 契约：runtime 可在两列表之一；期望 trace 序不变。
- O5a 换轴：bootstrap 已空，红灯迁到「反转 deferred」
  （runtime 落后工厂注册 + onboarding 先于 startup → 崩），
  保序约束仍被真实消费；buildShuffledCopy 增加 shuffleDeferred。

**批13c 全量矩阵**：node 608/608（首轮 2 失败 = launcher bundle
builderHash 因 build-editor.mjs 变更过期，重建后绿）、python
2134 全绿、typecheck 110 基线 0 新增、双 bundle 新鲜、
check:editor/check:launcher、git diff --check 干净、
三域 e2e assembly-order 6/6 + click-behavior 36/36 +
waveform-history 53 过 2 失败。

**waveform-history 2 失败实证为既有**：contextual help links /
grouped icon controls 两条在**分支基点 e107c636**（PR3 全部
提交之前的起点）同样失败、错误一致（gap-remove-panel 未收起
/ aria-selected 断言），与摘除无关。PR2 账本「waveform-history
53/2 与 main 既有失败同名同数」即此二条。

**终态定位**：bootstrap=[]，deferred=127（原启动相对序）。
手工排序面从「txt 清单 + bootstrap 数组」收缩为「单一保序表」；
真 ESM 转化（依赖写进源码）留后续，见
docs/plans/PR3_BOOTSTRAP_PEEL_PLAN.md 的 demo 蓝图节。
