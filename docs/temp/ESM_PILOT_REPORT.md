# ESM 试点报告：import 语句可以正式进场

日期：2026-09-27。分支：`esm-pilot`（基于 main @ d20529cd，#155 之后）。
试点提交内所有改动均可独立 review；页面级验证产物在 `.esm-pilot-out/`（未入库）。

## 一句话结论

**真 ES Module 可以嵌回现有经典拼接架构，且三类消费端的差异可以被一个受控构建步骤吸收。**
试点在真实仓库上转换了 host 四模块（`shared/host/*` + `editor/boot/editor-host.js`），
与剩余 164 个经典脚本**同页共存**，file:// 双击打开零报错、启动行为与基线逐项等价，
node 全量测试 374/0 与 main 完全一致。

## 嵌合机制（回答「只拆一小部分怎么嵌进史山」）

1. **双轨页面**：`__EDITOR_SCRIPTS_JS__` 这个模板槽位里，经典拼接块照旧；
   已转换子集由 esbuild 打成一个 IIFE，在它们原本的清单位置以独立 `<script>`
   注入。脚本块之间共享全局，与今天的清单拼接语义完全一致。
2. **门面桥**：转换后的模块保持 `window.MaweHost` 门面挂载（副作用归入口），
   未迁移的消费方（`web/editor/io/*` 全家）一行不改。
3. **该机制与规模无关**：esbuild 不在乎图里是 4 个文件还是 173 个。迁移就是
   把经典块逐文件搬进 ESM 块，最后一 complexion 经典块归零，双轨自然变单轨。

## esbuild 的力量（实测数据）

| 项目 | 数值 |
|---|---|
| 4 模块依赖图打包 | **32.3 ms**（2,106 字节） |
| 全部 174 文件经典块最小化 | 2,144,991 → **1,286,079 字节（-40%）**，161 ms |
| 便携页 gzip 体积（可立即兑现） | 518 KB → **332 KB（-36%）** |
| 编译期错误捕获 | 拼错的导出名 `createHostStorag` → **31 ms 内构建失败**，精确到文件:行:符号 |

最后两行值得展开：

- **-36% gzip 是今天就能兑现的**，不需要等 ESM 迁移——`esbuild --minify` 对
  经典拼接块同样有效（已验证语义等价可后续做字符串级比对）。
- **错误捕获是类别性收益**：`import { createHostStorag }` 这种拼写在经典脚本
  世界里要等运行到那行才炸（ns-rewrite 三轮事故的根源就是它），在 ESM 世界
  里构建直接拒绝。试点期间它已经自证了一次：tree-shaking 把「无人使用」的
  纯导出模块整体摇掉，产出 15 字节空壳——缺失的门面挂载当场暴露，而不是
  在运行期的某个深处。

## 测试共存（同样一句话：机制同构）

- `tests/helpers/editor-module-loader.mjs`：对转换集注入**同一个 esbuild 产物**
  （页面的装配机制原样搬进测试加载器），经典文件照旧 vm 求值。
- `tests/test_editor_host.mjs`：vm 拼接加载器退役，改为**直接 `import` 被测模块
  + 参数注入**——测试体零改动，加载器从 5 个文件的求值链变成一行 import。
  这就是全部单测在迁移后的终态。
- `test_editor_script_order / _syntax`：经典世界断言对转换集豁免（它们的守门
  责任移交 esbuild：循环依赖、缺失导出在打包期报错）。
- 豁免名单单一事实来源：`tests/helpers/esm-pilot-converted.mjs`，构建、加载器、
  测试三方共用。

## 过程中确认的事实与约束

1. **file:// 是当初选择经典脚本的根本原因**（ES modules 在 file:// 下被 CORS
   硬禁），也是唯一需要构建步骤的原因。server-editor 走 http 天然支持原生
   ESM；blank-editor 与 Tauri（build.rs 内联装配）走打包，两者本就是生成产物。
2. **门面挂载移出模块本体**是本次试点的规范性动作：副作用归入口，模块保持
   纯导出——否则 tree-shaking 失效、单测无法直接 import。
3. Node ≥23 的模块语法检测可直接 import 项目内 `.js` ESM 文件；正式迁移时
   建议 web 源码目录声明 `"type": "module"` 以消除对 Node 版本的隐式依赖。
4. `npm run typecheck`（我们的类型门）在试点后保持全绿；迁移完成后
   `editor-globals.d.ts` 的 Window 声明合并可由真实 import 类型替代。

## 下一步（若维护者批准正式迁移）

1. 决策点只有一个：接受 esbuild 作为**仅产物层**的构建步骤（devDependency，
   blank/Tauri 装配时调用；日常开发与 server 页零变化）。
2. 迁移顺序：按清单自底向上（`shared/utils` → 各领域模块 → boot），每批一个
   PR，双轨页与 374 项测试守门。
3. `editor-scripts.txt` 的终态是「入口模块 + 静态资源清单」；`window.MAWE`
   注册表随最后一个模块迁移退役，window 桥（MaweHost 等）收编为显式的
   「页面公共 API 清单」，供 e2e 与外部嵌入方使用。
4. ESM 到位后再做企划案阶段三（Store/命令）：依赖显式 + 类型真实，状态收拢
   的改动面才是可控的。
