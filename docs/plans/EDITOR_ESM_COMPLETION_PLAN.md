---
title: 编辑器真 ESM 收口计划
created_at: 2026-10-14
updated_at: 2026-10-16
status: validating
---

> **整合状态（2026-10-16）**：迁移成果已在
> `feat/editor-esm-current-upstream` 上接入改写历史后的上游主线，
> 作为一份 PR 交付。编辑器当前推导 197 个输入；独立翻译核对页
> `web/shared/templates/` 不属于编辑器 bundle。终点 1–4 已全部达成：
> 全部编辑器源码为普通 ESM（0 转换体/0 工厂/0 桥/0 保序表），
> `web/editor-modules.json` 已删除；启动序列收敛为
> `startupEditor` 中的具名操作。Node 729/729、typecheck 0 新增、
> 构建新鲜度与 ESM 静态门禁通过；Chromium 全量 825/847，剩余
> 22 条需逐项核对（其中 `server-align` 5 条对应的源码、测试与
> `origin/main` 完全相同）。Python 全量 2340 项中缩略图时长
> 1 条失败，相关实现与上游相同。验证未完成前不宣称 PR 全绿。
> 下文保留为当时的执行依据。


# 编辑器真 ESM 收口：交给代码 agent 的执行单

本计划接续 [PR3 bootstrap 摘除计划](PR3_BOOTSTRAP_PEEL_PLAN.md)。它针对
`feat/editor-esm-pr3-explicit-assembly` 在 `4b737ee9` 的代码状态；开工时以实际
HEAD 和工作区为准，不能把这里的数量当成未来不变的事实。

## 现状与终点

现状：`web/editor-modules.json` 有 61 个 ESM 工厂、8 个外部活绑定桥、
`bootstrap: []` 和 127 项 `deferred`。构建器从目录发现源码，但对非工厂文件只
接受 `export function* initialize()`；所有转换体先执行 phase-1，再按
`deferred` 的原相对序执行 phase-2。因而清单文件已退役，**运行顺序表尚未退役**。
`web/editor/boot/editor-bundle.js` 是 esbuild 生成的 IIFE，便携页和 localhost
仍要使用这一产物形态。

终点须同时满足：

1. `web/editor/` 与 `web/shared/` 中参与编辑器的文件由普通 ESM import 图
   可达；没有 `export function* initialize()`、`legacyBindings` 或 phase-1/2
   装配器。`bootstrap`、`deferred` 和 8 桥登记从配置/构建器退出。
2. 模块间依赖通过静态 import、构造参数或显式 getter/函数表达；编辑器内部
   不再以 `window.MAWE.register/resolve`、裸全局门面或 `window.MaweX` 传递依赖。
   确有页面/测试/Launcher 外部消费者的 `window` API 可在入口集中保留，
   每项注明消费者并检查同一对象的身份、getter/setter 和调用时机。
3. 生命周期顺序留在一个可读的入口：创建配置/状态、安装 DOM 接线、启动编辑器。
   它列有名字的操作（如 `attachCuePanel(state)`），不列 127 个文件名。
4. 目录发现、bundle 新鲜度、占位符渲染、便携页与 localhost 的既有行为通过
   契约和真实浏览器验证。仍输出 IIFE；真 ESM 指源码和依赖图，不要求页面加载
   `<script type="module">`。

不以“所有 `window` 字符串消失”或“启动操作完全无顺序”作为验收条件。

## 减少工作量的约束

- 不再做逐文件 peel，也不把 `deferred` 复制到另一张表；一批完成一个能独立
  运行的依赖簇。旧转换体在其退出前继续按原序执行。
- 自动化只改能静态证明的绑定。一个名字有多个定义、跨文件写入、动态
  `MAWE.resolve(name)`、顶层读循环依赖、隐式共享 `this` 或 eval 时，工具必须
  拒绝并报告文件/行号；人工只处理报告中的例外。
- 先迁 provider，再迁它的一组消费者。未迁消费者继续读原 `window` 门面；
  已迁消费者改 import 或显式参数。过渡期只能有**一个实例**，不能让 import
  和门面分别调用工厂创建两套状态。
- 不为保留测试绿灯而给新 ESM 模块增加假 DOM；保留针对函数的单元测试，
  启动、接线和时序以真实页面测试验证。
- 工具与必要夹具放进版本库 `scripts/esm-migration/` 和 `tests/`；
  `.artifacts/` 只放报告与试验输出。不要让下一位 agent 依赖被忽略区里的脚本。
- PR3 可以作为“`bootstrap` 清空”的稳定里程碑。真 ESM 收口从它另开后续分支，
  分成构建器/工具、首个迁移簇、后续簇、最终清理几个可审查提交或 PR；
  不把全部 127 文件压进一次巨型 diff。

## 第 0 步：冻结可比较的起点

先读 `AGENTS.md`、本计划、PR3 账本，记录 HEAD、`git status --short`、
`deferred`/工厂/桥数量以及现有失败。不要覆盖其他 agent 的改动。
按仓库规定用 `scripts/run_check.py` 执行当前构建、Node、装配契约、
`assembly-order` e2e、typecheck 与 Python 全量；保存 `result.json` 路径。
已有红灯须记为基线，不能把后来同名失败算成迁移成功或回归。

**交付**：一页基线记录，列出命令、HEAD、通过/失败数和外部环境限制。
若起点无法构建或启动，先修起点；此时不要启动批量 codemod。

## 第 1 步：让构建器接纳普通 ESM（一次性基础设施）

改 `scripts/build-editor.mjs` 的源文件形态校验和入口生成：

1. 用 AST 区分已有工厂、`initialize()` 转换体和普通 ESM，不用匹配
   `export function*` 的正则充当最终形态判断。普通 ESM 可由其他模块静态
   import，或由入口显式 import 后调用其导出；不得只出现在 `sourceFiles`/trace。
2. 仍由目录发现文件；构建后把发现集合与 esbuild metafile 的输入集合比较。
   漏入、重复、路径越界直接构建失败。metafile 只证明 esbuild 读到文件，
   **不能证明导出被调用或副作用发生**，所以要配行为断言。
3. 保持 61 工厂和剩余转换体的原有执行路径。普通 ESM 的引入不得改变尚未
   迁移部分的相对顺序。保留哈希、新鲜度检查及 `--write/--check` 契约。
4. 增加一个沙盒反例：目录发现的新 ESM 文件若未进入 import 图则构建拒绝；
   正例在真页面证明入口调用了该文件的导出。测试不能只断言 trace 增加。

**完成线**：零业务文件迁移时原门禁保持；加入一个独立金丝雀后可检测
“被发现但未执行”。这是后面每个簇都复用的构建能力。

## 第 2 步：先盘点，再按重复模式制作改写器

新增 `scripts/esm-migration/inventory.mjs`，使用仓库已有的 Acorn、
`eslint-scope`、`magic-string`。输出机器可读 JSON 和简短 Markdown 报告，
但报告是派生物，不是第二张人工维护表。至少包含：

| 记录 | 用途 |
| --- | --- |
| 门面/工厂的唯一 owner、声明位置、创建时机 | 找出可机械映射的 provider |
| 每个消费者的裸读、`window.X` 读、直接赋值、属性写入 | 区分可替换读与不可直接改写的写 |
| 文件顶层/IIFE 立即读与函数/回调延迟读 | 判断导入环和初始化时机 |
| 静态 import 边、动态 resolve、强连通分量 | 选迁移簇并定位环 |
| 外部消费（测试、模板、Launcher、页面桥） | 决定兼容门面何时能退役 |

先读盘点结果，手改一个最小簇作为对照样本。只有当同一种安全改写在多个
真实消费者中重复出现，再新增 `transform.mjs --dry-run <簇>`；工具只针对
**唯一 owner、只读消费者、无求值期跨文件读取风险**的引用生成补丁。
执行模式要求改写前后重新盘点，确认目标引用确实减少。跨文件直接赋值要改
为 owner 提供的 setter/方法；`obj.field =` 是对象属性操作，和给导入绑定
重新赋值不是一回事。报告不能只用正则计数，必须用作用域分析排除同名
局部变量、声明位置、对象键和字符串。

盘点工具放少量小夹具：局部同名、字符串/注释、裸读、赋值、函数回调里的
延迟读、循环顶层读。若制作改写器，再为实际支持的变换补相应夹具；不要
为了工具覆盖率先制造大批伪业务测试。

**决策门**：先在几个真实文件上盘点，报告“可机械改的引用/需要人工判断的
引用/无法定位 owner 的引用”，再给出首簇手改 diff。若例外占主导，只对
重复的局部模式写工具；不要为覆盖所有奇形态再开发一套模块系统。

## 第 3 步：做一个完整的小簇，再复制做法

从 inventory 选“一个门面 provider + 两三个消费者”：无跨文件写入、
无顶层反向依赖、无启动期 DOM 副作用。`editor-hint.js` 可作为候选：当前它的
顶层主要是创建冻结门面，DOM 创建发生在 `flashHint()` 调用时；以报告确认后
再定。`shared/tooltip.js` 另有 Launcher classic 消费路径，不作为默认首例。

首例须把 provider 的对象身份保持一致，例如：

```js
// provider：真实代码须按现有 getter/setter 原样迁移
export const MaweHint = Object.freeze({ flashHint, dismissHintCard });
export function installHintFacade() { window.MaweHint = MaweHint; }

// 已迁消费者
import { MaweHint } from '../ui/editor-hint.js';
MaweHint.flashHint('已保存');

// 入口：在旧消费者 phase-2 之前发布同一个对象
installHintFacade();
```

这个例子只说明**同一实例 + 逐步改消费者**；实际 `editor-hint.js` 的可变
访问器必须保留。对依赖项目数据或 DOM 的 provider，不在 import 求值期调用
工厂；导出 `createX()`/`installX()`，在启动入口实例化一次，并把实例传给
消费者，或提供只在初始化后读取的窄 getter。

首例从 `deferred` 移除已转的 provider/消费者，但不要移动未转文件。
同步更新 O2 的预期：trace 只覆盖仍由转换体驱动的文件；新增行为断言覆盖
普通 ESM 的真实使用。现有 O5a 的 deferred 反转红灯只约束剩余转换体，
不能拿它证明已迁 ESM 的顺序安全。

**完成线**：构建/新鲜度、定向 Node、真实页面启动与门面身份、相关交互、
类型基线均通过；`deferred` 实际缩短，import 边实际增加，且未多建实例。
回滚只需撤掉这个簇的源码/登记变更，不依赖全仓同步迁移。

## 第 4 步：批量推进，按风险而非目录名分组

inventory 每轮重新生成，不固定 A–I 九批或文件数量。优先顺序：

1. **纯计算与工具簇**：已有 61 个工厂可以先继续保持工厂形态；把调用点
   的 `MAWE.resolve('name', args)` 逐簇改成对同一个导出工厂的直接 import
   和调用。`web/shared/editor-utils.js` 的几十个连续 resolve 可由同一规则
   批量处理，但它的 `helpers` 增量填充顺序要用行为测试保住。
2. **单例 provider 与状态簇**：把 `editor-boot` 的模板数据、`editor-state`
   的项目实例等创建时机集中在入口。`__DATA_JSON__` 等占位符在 esbuild
   输入与 Python 渲染路径上保持原有契约；不能把每个 import 变成一次新建状态。
3. **UI/DOM 与 wiring 簇**：文件导出 `attachX(context)` 或具名配置函数；
   入口按业务阶段调用。对已有跨文件 `legacyBindings` 环，先把真正需要的
   操作改为函数导出/参数注入，再删除该簇的桥。图中的大环不必强行整体转；
   对导致环的启动副作用抽到入口，剩余纯函数可分别迁。
4. **启动与注册表簇**：当各 provider 已被静态 import 和直接创建，
   `editor-startup` 收敛成短的具名调用序列。最后清除剩余代码内注册、
   61 工厂登记、8 桥和 `editor-runtime` 注册表。

每簇只提交能独立审查的差异。提交说明记录 `deferred` 减少数、静态 import
增加的依赖关系、人工例外及实际验证；不逐个门面机械造几十个空提交。

### 每簇的固定核查

- 构建器发现集合 = 应参与的源码集合；metafile 输入覆盖；`check:editor` 新鲜。
- inventory 对已迁簇报告零内部裸门面读、零 `MAWE.resolve`，跨文件写入已
  归 owner；兼容 `window` 发布只服务于尚未迁移或外部消费者。
- 导入环中不得有顶层跨文件读取导致 TDZ；如果只有延迟函数调用环，记录
  并用真实启动测试证明。禁止用全局 `any` 或提前赋 `undefined` 掩盖时序错误。
- 定向单元/契约、相关 e2e 真页面通过；每 2–3 簇跑一次全量 Node/Python，
  重大启动簇跑完整浏览器矩阵。类型门保持“新增诊断为 0”；旧基线因行号
  改动时逐项对照诊断内容，不能仅用固定 110 条的数量做判断。
- `git diff --check`、UTF-8/LF、bundle 不入 Git，`blank-editor.html` 不生成。

## 第 5 步：终态清理与证据

仅在 `deferred` 为空、所有普通 ESM 均从入口可达、真实页面矩阵通过后：

- 删除 `initialize()`/`legacyBindings` 生成与驱动代码、`bootstrap`/`deferred`
  数组及相应旧契约；O5a 的“反转 deferred 必崩”测试随对象消失而退役。
  以打乱目录发现序行为不变、import 图覆盖和启动行为测试替代。
- 对 8 桥逐一确认是否还有真实消费者；能直接 import 的改 import，仍属
  外部 API 的从入口发布并有身份/写入语义测试。删除内部注册表及不用的
  `editor-modules.json` 字段；若 JSON 已无职责则退役文件。
- 更新 AGENTS/DEVELOPMENT/工程文档为真实装配方式，保留 PR3 历史账本的
  当时事实。运行全量 Node、Python、typecheck、装配契约、相关 e2e、
  file/localhost 探针和双 bundle 新鲜度检查。检查便携页模板占位符，
  发布前才按仓库规则重生成 `blank-editor.html`。

最终报告分别列出“普通 ESM 文件数、转换体数=0、内部 resolve/裸全局读数=0、
保留的外部 window API 与消费者、剩余类型基线和测试结果”；不只写“构建通过”。

## 可直接交给 agent 的第一轮指令

> 在 PR3 工作树上先读本计划、PR3 账本和 AGENTS.md，核对 HEAD/状态。
> 第一轮只完成第 0、1 步及第 2 步的 inventory，不批量迁移 127 文件，
> 也不先造通用 codemod。交付普通 ESM 构建支持、版本化盘点工具和一份真实
> 文件报告；报告列出可机械转换/需人工处理的引用、首簇候选、现有测试基线
> 与新增验证结果。第二轮手改首簇作为样本，再决定哪些重复操作值得写工具。
> 若构建器或盘点工具的假设与源码不符，用具体文件和行号说明后修正假设。
