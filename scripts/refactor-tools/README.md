# refactor-tools：编辑器模块化拆分的阶段一工具（历史参考实现）

这些脚本服务于拆分第一阶段——把平铺的 `web/editor.js`（17,790 行、1272 个顶层
声明）拆为 77 个特征模块。对应提交区间 `a28ad73..a98cbc2`（分支
`refactor/editor-module-split`）。纯源码分析工具针对旧检出中的经典清单；当前 Editor 的契约以生产入口和依赖图为准。

`split-cluster.mjs`、`ns-rewrite-editor.mjs`、`fix-e2e-globals.mjs` 及 `tools/merge-flow.mjs` 仍是历史单体迁移工具，依赖未切段的 `web/editor.js`。它们在当前布局上会拒绝运行，不写文件；如需复现历史迁移，应使用对应旧 checkout。导出的纯作用域处理函数继续由单元测试覆盖。历史 specs 保留原路径作为输入记录。

| 脚本 | 作用 | 依赖 |
| --- | --- | --- |
| `analyze-editor-deps-demo.mjs` | 依赖图分析：顶层符号清单、扇入/扇出、可变状态写入榜、依赖闭包 | ts-morph |
| `split-cluster.mjs` | 核心 codemod：按 `from/to` 符号锚点把声明簇从 editor.js 迁入 IIFE 模块，语言服务级引用改写为 `NS.name`，可变状态生成访问器导出，支持 `append` 追加进既有模块 | ts-morph |
| `fix-e2e-globals.mjs` | 把 e2e spec 里 `page.evaluate` 引用的已私有化全局改写为命名空间限定 | acorn |
| `scan-implicit-globals.mjs` | 扫描模块中「赋值给未声明标识符」的隐式全局写（严格模式雷） | acorn |

这些一次性 AST 分析脚本共用根目录的 `acorn` / `acorn-walk` 开发依赖。需要运行使用 `ts-morph` 的分析脚本时，在仓库根目录执行 `pnpm add -D ts-morph`；分析完成后用 `pnpm remove ts-morph` 移除临时依赖。它不进入运行时依赖。

只保留可复用的拆分、审计与冒烟工具；绑定具体 PR、提交、临时目录或某次
冲突块编号的一次性调试脚本不进入仓库。写入目标被占用时工具直接报错，
不会先删除目标文件规避锁定。

机械切段与移动的等价审计：`node scripts/check_editor_equivalence.mjs --base <revision> --target <revision>`，两端使用有 classic 清单的历史修订，核对原序源码字节及装配 AST。

旧注册表浏览器探针 `probe-namespace.mjs` 只适用于已有的历史页面夹具。当前 Editor 用 `tests/e2e/editor-bundle.spec.mjs` 验证真实 Server 启动。

## Editor 门面迁移与上游合并

`editor-global-migration.mjs` 面向现有 ESM 源码。它用 Acorn 和 `scope-core.mjs` 解析引用，从唯一的模块级导出定位所有者，保留方法调用的接收者、属性访问器和可选链。

```powershell
node scripts/refactor-tools/editor-global-migration.mjs --json
node scripts/refactor-tools/editor-global-migration.mjs --write
node scripts/refactor-tools/editor-global-migration.mjs --check
node scripts/refactor-tools/editor-global-migration.mjs --audit-tree --json
node scripts/refactor-tools/editor-merge-preview.mjs <迁移分支提交> <上游PR头提交> .artifacts/<新目录>
```

先查看 dry run 的 `changedFiles` 和 `issues`。`--write` 写入 Editor 与 shared 的当前源码。`--remove-aliases` 只识别同名模块绑定发布到全局对象的独立赋值，先迁移外部消费者再启用。`--check` 当识别到待迁移引用、发布别名或未解决位置时返回非零。组合赋值、整块替换、无唯一所有者的引用和动态键要人工核对。发现本地同名绑定时，工具会选择不被遮蔽的 import 名。构建与实际启动是两个独立验证步骤。

`--audit-tree` 只读扫描维护中的 Editor、Launcher、共享页面、对齐页、工具和官网脚本。它检查同一浏览器上下文的引用链、解构、动态键、全局对象写入、裸赋值，以及 HTML 加载的经典脚本中会泄出的顶层声明。Launcher 的清单片段会一起构建，再检查装配后的作用域。第三方库、测试夹具和历史文案工具按其各自入口核对。Python 拼接、宿主回调、浏览器可选能力和初始化次序仍需用实际入口验证。

预演工具使用两个固定提交和唯一共同祖先。它先报告原文件重叠与 Git 实际冲突，再对三边都存在的 Editor／shared 冲突脚本应用同一引用迁移，运行三方合并并重解析结果。通过这步的文件才写进新建的 `.artifacts` 子目录。工具会写 Git 对象供三方合并使用。它保留工作区、索引、分支和远端引用。

### 审阅和应用候选

1. 用目标分支和真实 PR HEAD 先做一遍原始合并预演，区分目标分支已有冲突与迁移带来的冲突。使用相同的 PR HEAD 复跑迁移快照。
2. 在隔离检出启动真实合并。候选只针对内容冲突，使用前对照共同祖先和两侧源码，确认两边新增行为、事件注册顺序及状态写入均保留。删改、改名、构建入口和夹具冲突按具体契约处理。
3. 同一个源文件同时改了门面赋值和业务逻辑时，把上游行为移到现有所有者，保留初始化位置、属性描述符和单例身份。迁移前拿不到的服务应继续保持缺席，提前分配空对象会让原有可选链误判。上游新增模块若只登记在经典清单，要用实际入口或所属领域的静态 import 接入，再查看构建元数据。
4. 用 `git diff --name-only --diff-filter=U` 核对未解决文件。对合并结果重跑两类扫描，审阅新增的全局读写。按合并后的源码重新生成 bundle 和工具页离线资源，运行新鲜度检查、`pnpm run typecheck`、PR 相关单元测试和 Chromium。若涉及编辑启动或写盘，至少保留一个走真实生产入口的用例。

[#437 的实际预演](../../docs/logs/release1.11.2/261125_门面直引迁移/IMPLEMENTATION.md#清理后的合并预演)给出了机械候选、人工决策和分层验证的实例。
