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

## 评审修复（2026-09-28，回应 PR #157 评审）

上游评审确认方向有价值但阻断合并，三条批评全部成立、全部修复：

1. **正式装配未接通（已修复，结构性方案）**：清单中原四条目替换为单个
   `editor/boot/esm-bundle.js`（转换集的 esbuild IIFE 产物，已提交入库）。
   edit.py / serve.py / Tauri build.rs 三个消费端**零改动**——它们只是读到
   清单里多了一个普通 classic 脚本。产物过期由新增的
   `tests/test_esm_bundle_fresh.mjs` 门禁拦截；此前为适配转换而加的顺序/
   语法测试豁免全部撤销（清单自洽后守门测试恢复原语义）。复现闭环：本分支
   上正式 `edit.py build_blank_html()` 产物已无裸 export，file:// 打开正常。
2. **基线不可复现（已修复）**：verify 改为 `--baseline <ref>` 显式指定改造前
   提交（默认 origin/main），并对基线源码预检（含 export 即拒绝、exit 2），
   不再依赖「HEAD 恰好是改造前」的会话期巧合。
3. **verify 非门禁（已修复）**：八项探针检查任一失败即非零退出（探针失败
   exit 1，基线 ref 非法 exit 2）；负向验证演示：`--baseline HEAD` 得 exit 2。

三页验证（基线 replica 页 / 正式 edit.py 页 file:// / 正式 serve.py 页 http）
八项检查全绿：三页零 pageerror、启动契约与基线一致、MaweHost 形状与读写
一致、host 模块从注册表退役且仅经 bundle 存活。node 全量 375 pass / 0 fail
（含新增新鲜度门禁），python 契约测试（test_editor_assets 22 项）同步通过，
typecheck 通过。方法论教训记录在案：豁免守门测试来让套件变绿，等于把集成
缺口的红灯调暗——守门测试的红灯只能用接通缺口来消灭。

## 产物归宿（显式决策点，2026-09-28 补）

**当前形态是过渡脚手架：已提交入库的 `esm-bundle.js` 不应成为终点。**
一般而言构建产物不进 Git 是行业共识，本仓库全量迁移后若继续提交 bundle，
将带来评审噪声（大文件 diff 淹没人类改动）、历史 blob 膨胀、双份真相三类成本。

终态按消费端拆解：

- **server-editor**：http 下原生 ES modules 天然工作——classic 文件出 classic
  标签、已转换文件出 `<script type="module">` + 入口模块，零产物零构建；
- **Tauri**：待验证 v2 自定义协议能否以正确 MIME 提供模块文件；可行则同样
  零产物，不可行再退打包；
- **blank-editor.html**：唯一被迫打包的消费端（单文件 + file:// 产品约束），
  但它的 bundle 与 blank-editor 同批在**发布流程**中出生，同批消费——不进
  开发路径，更不进 Git。

「bundle 怎么进清单」的机制说明：清单是仓库里的纯文本文件，加入 = 在
`web/editor-scripts.txt` 删 4 行加 1 行（指向产物的固定路径），消费端按普通
条目解析，无任何注入机制。终态里这个条目的物化时机从「Git 里的文件」变为
「装配/发布时生成」，即决策的第②半。

因此「接受 esbuild」实际是两个子决策：① 接受工具；② 产物住在哪——
住在 Git（试点现状，零流水线改动）还是住在发布流程（符合规范，要求装配层
一次真改动 + 开发流程接受 watch/按需构建）。试点明确倾向②为终态，
①+②一起构成提请维护者决策的完整清单。

## 下一步（若维护者批准正式迁移）

1. 决策点只有一个：接受 esbuild 作为**仅产物层**的构建步骤（devDependency，
   blank/Tauri 装配时调用；日常开发与 server 页零变化）。
2. 迁移顺序：按清单自底向上（`shared/utils` → 各领域模块 → boot），每批一个
   PR，双轨页与 375 项测试守门；edit.py 装配路径已接通，每批的验证即真实
   页面验证。
3. `editor-scripts.txt` 的终态是「入口模块 + 静态资源清单」；`window.MAWE`
   注册表随最后一个模块迁移退役，window 桥（MaweHost 等）收编为显式的
   「页面公共 API 清单」，供 e2e 与外部嵌入方使用。
4. ESM 到位后再做企划案阶段三（Store/命令）：依赖显式 + 类型真实，状态收拢
   的改动面才是可控的。
