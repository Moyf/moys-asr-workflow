# refactor-tools：编辑器模块化拆分的阶段一工具（历史参考实现）

这些脚本服务于拆分第一阶段——把平铺的 `web/editor.js`（17,790 行、1272 个顶层
声明）拆为 77 个特征模块。对应提交区间 `a28ad73..a98cbc2`（分支
`refactor/editor-module-split`）。当前源码已迁入 `web/editor/` 与 `web/shared/`。只读审计工具从 `editor-scripts.txt` 枚举源码，支持领域子目录；`rebuild-contract.py` 更新显式清单元组，payload 测试直接核对源码内容。

`split-cluster.mjs`、`ns-rewrite-editor.mjs`、`fix-e2e-globals.mjs` 及 `tools/merge-flow.mjs` 仍是历史单体迁移工具，依赖未切段的 `web/editor.js`。它们在当前布局上会拒绝运行，不写文件；如需复现历史迁移，应使用对应旧 checkout。导出的纯作用域处理函数继续由单元测试覆盖。历史 specs 保留原路径作为输入记录。

| 脚本 | 作用 | 依赖 |
| --- | --- | --- |
| `analyze-editor-deps-demo.mjs` | 依赖图分析：顶层符号清单、扇入/扇出、可变状态写入榜、依赖闭包 | ts-morph |
| `split-cluster.mjs` | 核心 codemod：按 `from/to` 符号锚点把声明簇从 editor.js 迁入 IIFE 模块，语言服务级引用改写为 `NS.name`，可变状态生成访问器导出，支持 `append` 追加进既有模块 | ts-morph |
| `rebuild-contract.py` | 从当前清单 + 模块内容重建契约测试的显式清单元组（payload 按实际源码检查） | - |
| `fix-e2e-globals.mjs` | 把 e2e spec 里 `page.evaluate` 引用的已私有化全局改写为命名空间限定 | acorn |
| `scan-implicit-globals.mjs` | 扫描模块中「赋值给未声明标识符」的隐式全局写（严格模式雷） | acorn |

安装依赖：`npm install --save-dev acorn && npm install --no-save ts-morph`
（ts-morph 仅分析期使用，不进运行时依赖。）

只保留可复用的拆分、审计与冒烟工具；绑定具体 PR、提交、临时目录或某次
冲突块编号的一次性调试脚本不进入仓库。写入目标被占用时工具直接报错，
不会先删除目标文件规避锁定。

机械切段与移动的等价审计：`node scripts/check_editor_equivalence.mjs --base <revision>`，核对原序源码字节及 Python / Tauri 装配 AST。
