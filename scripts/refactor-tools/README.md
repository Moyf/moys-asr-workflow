# refactor-tools：编辑器模块化拆分的阶段一工具（历史参考实现）

这些脚本服务于拆分第一阶段——把平铺的 `web/editor.js`（17,790 行、1272 个顶层
声明）拆为 77 个特征模块。对应提交区间 `a28ad73..a98cbc2`（分支
`refactor/editor-module-split`）。**路径与清单假设按当时状态写死**，在目录
结构化之后的树上直接运行会找不到目标；用作方法参考与二次开发的基底，
跑之前先按你自己的树调整路径与锚点。

| 脚本 | 作用 | 依赖 |
| --- | --- | --- |
| `analyze-editor-deps-demo.mjs` | 依赖图分析：顶层符号清单、扇入/扇出、可变状态写入榜、依赖闭包 | ts-morph |
| `split-cluster.mjs` | 核心 codemod：按 `from/to` 符号锚点把声明簇从 editor.js 迁入 IIFE 模块，语言服务级引用改写为 `NS.name`，可变状态生成访问器导出，支持 `append` 追加进既有模块 | ts-morph |
| `rebuild-contract.py` | 从当前清单 + 模块内容重建契约测试的清单元组与 payload marker | - |
| `fix-test-literals.py` | 按模块导出表自动修正单测钉住的实现字面量 | edit.py |
| `fix-e2e-globals.mjs` | 把 e2e spec 里 `page.evaluate` 引用的已私有化全局改写为命名空间限定 | acorn |
| `scan-implicit-globals.mjs` | 扫描模块中「赋值给未声明标识符」的隐式全局写（严格模式雷） | acorn |
| `rebuild-blank.py` | blank-editor.html 被外部句柄锁死时，删旧 inode 再重建 | edit.py |

安装依赖：`npm install --save-dev acorn && npm install --no-save ts-morph`
（ts-morph 仅分析期使用，不进运行时依赖。）
