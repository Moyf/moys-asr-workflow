---
title: PR3 bootstrap 摘除执行计划
created_at: 2026-10-14
updated_at: 2026-10-14
status: done
---

# PR3 bootstrap 摘除执行计划（批 5 之后）

本计划指导后续 agent 在 PR3 工作树上继续把 `web/editor-modules.json` 的
`bootstrap` 数组摘除到空。执行前先读本文件与
[PR3-STATUS 账本](../logs/unversioned/2026-10-13/esm-migration/PR3-STATUS.md)，
再读 `AGENTS.md` 的命令与日志纪律。

## 现场与角色

- 工作树：`C:\TechProjects\About_MyRepos\moys-asr-workflow\.qwen\worktrees\esm-integration`
  分支 `feat/editor-esm-pr3-explicit-assembly`（基线 = 重写后的 PR2 链 `85ba4260`，
  两分支已强推 cat，**未开上游 PR**）。
- 目标（/goal 原文）：「在 pr3 工作树上继续摘 bootstrap 直到摘完」——
  即 `bootstrap: []`。127 项全部迁入 `deferred`（保留执行语义的过渡段）。
- 终态定位要诚实：bootstrap 清空是目标的字面达成；顺序信息仍以
  「原相对序」形式保存在 deferred 里（不再做人工排序决策，但仍是保序表）。
  「依赖写进源码」的真 ESM 转化（见文末路线）是后续工作，不得在账本里
  把「搬进 deferred」写成「顺序债清偿完毕」。

### 截至 2026-10-14 的进度

| 提交 | 内容 |
| --- | --- |
| `80f126ed` | PR2 账本第 59 行行尾空格修复 |
| `e1b1d661` | 批5：登记表 `deferred` 段 + 构建器驱动序 + C3 契约 |
| （批6a） | 摘首叶 `editor-onboarding.js` |
| `5d6b6c40` | 批6b：摘 `editor-startup` + 11 个尾段 wiring（bootstrap 127→114，deferred=13） |

当前验证基线：契约 C1-C3 7/7、e2e assembly-order 6/6、node 608/608、
typecheck 110 基线 0 新增、check:editor / check:launcher 双新鲜、
真页面探针（bridge/trace 188/cueRows/0 错误）全绿。

## 机制：为什么摘除是安全的

1. **两阶段转换体**：每个 bootstrap/deferred 文件都是
   `export function* initialize() { [phase-1 …] yield; [phase-2 原文件顶层] }`。
   phase-1（提升闭包、legacyBindings 发布）全量先行；phase-2 副作用按序驱动。
2. **立即边图（安全证明的依据）**：用 AST 区分「立即执行」（phase-2 顶层
   语句 + IIFE 体）与「延迟执行」（存储函数体/回调），只有**立即读**构成
   顺序约束。v1 分析器（门面名正则）得 112 条立即边、**零环（DAG）**，
   且原 bootstrap 序满足全部边。叶剥离模拟证明 127 个文件全部可摘
   （迭代摘「无立即消费者的叶」，peel 逆序 == 原 bootstrap 序），
   且任意 peel 前缀合法。
3. **deferred 语义（批5 引入）**：`compileEsmEntry` 驱动序 =
   runtime 先行 → 61 工厂注册 → 8 桥 → **bootstrap phase-2（登记表序）** →
   **deferred phase-2（原 bootstrap 相对序）**。摘出文件「集体移到全部
   bootstrap 之后」——对无立即消费者的叶，行为不变。
4. **C3 契约**（tests/test_assembly_contracts.mjs）以行为面固定该语义：
   摘叶后叶 phase-2 照常执行、仍能读更早门面；非叶被摘（消费者先执行）崩溃。

## 不变量（违反任何一条都会红灯，已有实证）

1. **deferred 必须保持原 bootstrap 相对序**。摘除顺序 ≠ 执行顺序。
   批6b 实证：工具曾按摘除顺序追加，onboarding 被排到 startup 之前，
   解构 `window.MAWE_EDITOR_BRIDGE` 直接崩。原序快照：
   `git show 80f126ed:web/editor-modules.json`（工具已内建该排序）。
2. **只摘叶**（无立即消费者的文件），按 peel 序从 1 到 127 推进，
   不得跳段。peel 序见下表；也可由 v1 边集重新叶剥离计算。
3. **每批构建后跑 v2 tripwire**：`.artifacts/pr3-bootstrap/analyze-immediate2.mjs`
   输出 `violations of current peel` 必须为 0。v2 用 AST 抓全部
   `window/global/globalThis.X =` 发布（含 `MAWE_*`——v1 的
   `Mawe[A-Z]|Asr…` 正则漏掉 `MAWE_EDITOR_BRIDGE` 等，正是批6b 崩点）。
   注意 v2 会**高估**边（把传给 register/addEventListener 的回调实参当成
   IIFE 立即执行），所以：0 违规是必要条件；报出违规需人工核实（对照
   读取点是否真在顶层/IIFE 体内）。
4. **每批真页面行为验证**：e2e assembly-order 6/6 + page-probe 探针
   （bridge 建立、trace 条数、cueRows>0、errors 空）。

## 每批操作手册

工具都在 `.artifacts/pr3-bootstrap/`（git 忽略区，源码见附录可复建；
`orig-modules.json` = 原序快照，`peel-order.json` = 127 项工作队列，
`immediate-edges.json` / `immediate-edges-v2.json` = 两版边集）。

```bash
cd <工作树>
node .artifacts/pr3-bootstrap/peel-batch.mjs <start> <end>   # 按下表批次
node scripts/build-editor.mjs --write                        # 重建（bundle 不进 git）
node .artifacts/pr3-bootstrap/analyze-immediate2.mjs         # violations 必须 0
node .artifacts/pr3-bootstrap/page-probe.mjs                 # 全绿指标见不变量4
node --test tests/test_assembly_contracts.mjs tests/test_editor_bundle.mjs
pnpm exec playwright test tests/e2e/assembly-order.spec.mjs --project chromium
node --test tests/*.mjs                                      # 全量（~105s；抽验可降级）
pnpm run typecheck                                           # 每 2-3 批
git diff --check
git add web/editor-modules.json && git commit                # 每批一提交
```

- 长命令遵守 AGENTS.md 纪律（run_check.py / 显式 timeout / uv --no-sync）。
- builder 脚本变化才会牵连 launcher bundle（builderHash 覆盖共享构建器），
  摘叶批次只改 editor-modules.json，无需动 launcher。
- 账本：每批在 PR3-STATUS.md 追加一段（批次号、摘除区间、验证命令与结果），
  不虚报、失败如实记 `阻塞`。

## 剩余批次表（peel 序，1-13 已摘）

| 批 | peel 序 | 文件特征 |
| --- | --- | --- |
| 批7 | 14-28 | 15 个 wiring（export-context…wiring-markers） |
| 批8 | 29-44 | 16 个（gap-panel…editor.js、timeline、cue-events） |
| 批9 | 45-63 | 19 个（cues 纯逻辑 + io 头段，到 drag-drop 前的 json-repair/otio） |
| 批10 | 64-84 | 21 个（io/媒体/ui 中段） |
| 批11 | 85-104 | 20 个（导出/UI/media 到 split-trim） |
| 批12 | 105-124 | 20 个（state/dom/colors/shared 深层 provider 到 view-updates） |
| 批13 | 125-127 | **终簇：editor-state、editor-boot、editor-runtime**（见下节，需要代码改造） |

里程碑（批8、批10、批12、批13 后）：python 全量
`uv run --no-sync python scripts/run_tests.py`；重点域 e2e
（waveform-history、click-behavior、editor-transactions）；
装配契约 E1-E10 沙盒配方见 PR3-STATUS.md「评审回执」节。
批7 前建议先复跑一次 node 全量确认起点绿。

## 终簇（批13）需要的代码改造——不可机械摘

1. **editor-runtime 是注册表创建者**（`REGISTRY_CREATOR`）：
   `compileEsmEntry` 目前用 `bootstrap.indexOf(REGISTRY_CREATOR)` 特判
   先行驱动。runtime 进 deferred 后该 index 为 -1，且 deferred 循环会
   `continue` 跳过它——工厂注册时 `window.MAWE` 不存在，启动崩溃。
   改法：注册表创建者查找覆盖 bootstrap ∪ deferred（runtime 无论在哪个
   列表都先于工厂注册驱动）；`buildEditor.initializationOrder` 同步。
2. **editor-boot / editor-state 是最深 provider**：摘除后 O2/O5a 契约要动：
   - O5a 红灯目前把 editor-boot 挪到 bootstrap 尾（shuffleBootstrap）；
     boot 不在 bootstrap 后成为 no-op、预期崩溃不再发生——按 spec 自身
     注释「PR 终态改为打乱后行为不变/换轴」。可行终态：把打乱目标改为
     **deferred 反转**（红灯保持：deferred 保序是真实的，反转破坏
     onboarding→startup 等立即边）。
   - O2 期望 trace = [runtime] + 工厂 + bootstrap + deferred，随配置
     自动收缩，无需改逻辑，但要更新断言的边界（trace[0] 与末两位）。
3. **bootstrap: [] 后**：验证矩阵全跑一遍（node/python/e2e 全量/typecheck/
   双 bundle 新鲜/探针/git diff --check）；账本收尾段明确写出
   「bootstrap 清空、deferred=127 保序表、真 ESM 转化留后续」；
   AGENTS.md / DEVELOPMENT.md 中 bootstrap 显式序的表述同步改为
   deferred 语义。CHANGELOG 由维护者在 PR 整体评估时定（内部装配重构）。

## 已知坑（每条都真实踩过）

1. **悬空 else**：`if (c) for (…) if (…) X; else Y;` 的 else 绑**内层** if。
   本任务分析器两次因此全零（v1 首版、v2 首版）。数组/循环分支必须花括号。
2. **Python 写 JSON 行尾**：`open(p,'w')` 文本模式在 Windows 写 CRLF →
   configHash 失配 → serve.py 自动重建死循环。必须 `newline='\n'` 或
   二进制写；改用 `fs.writeFileSync`（node）最稳。手改 JSON 后跑
   `git diff --check`。
3. **heredoc 转义**：bash heredoc 里写含 `\n` 的 JS 字符串，经 python 落盘
   会变成真实换行——用 `chr(92)` 构造反斜杠，或直接写 .mjs 文件。
4. **Node vm 不执行 import 语句**：想在契约里验证 ESM 入口需先经 esbuild；
   C3 因此用「执行语义模拟」（拼接脚本文本）而非真编译。
5. **`node --test tests/`（目录形式）会失败**：用 `node --test tests/*.mjs`。
6. **e2e serve.py 残留进程**：中断后按 AGENTS.md / E2E_SERVER_HANG.md 清理
   再重跑；探针（page-probe）用完自动 stop，异常中断也要查端口。
7. **分析器语义**：v1 边集（112）= 门面名正则 + fnDepth=0（不含 IIFE 体，
   偏保守漏边）；v2（325）= 全名 + 全 window 发布捕获，但把回调实参当
   IIFE（高估）。**排序决策只信「原相对序」，分析器只做报警**——静态
   边集永远不完整，这是批 2b 三连败的教训。

## 后续：deferred 转真 ESM（demo 蓝图）

`bootstrap: []` 之后，顺序债收敛为「deferred 127 项原序保表」。下一步
按簇把 deferred 文件转成普通 ESM，让 import 图接管顺序，退出 deferred：

- 蓝图见 `.artifacts/bootstrap-explicit-demo/`（两文件结构演示）：
  provider 变 `export function createX(...)`，消费者参数接收
  （`createState(boot)`），启动副作用集中 `startEditor({boot,state})`，
  兼容门面在**入口集中发布一次**（解决裸标识符过渡问题）。
- demo 的 boot→state 对正是 peel 序末簇（125/126）的施工图。
- 需要构建器先支持第三种形态（普通 ESM 文件进 import 图 + metafile
  覆盖检查防静默漏装）与工厂注册前移（注册模块在 import 期完成，
  否则 editor-utils 这类顶层 resolve 工厂的文件转不动）。
- 该阶段不在本计划范围内，开工前另行立项。

## 附录：工具源码（.artifacts 丢失时复建）

### peel-batch.mjs（摘叶工具）

```js
import fs from 'node:fs';
const cfg = JSON.parse(fs.readFileSync('web/editor-modules.json','utf8'));
const data = JSON.parse(fs.readFileSync('.artifacts/pr3-bootstrap/immediate-edges.json','utf8'));
const [start, end] = process.argv.slice(2).map(Number);
if (!start || !end || start > end) throw new Error('Usage: peel-batch.mjs <start> <end>');
const boot = cfg.bootstrap;
const alreadyDeferred = new Set(cfg.deferred ?? []);
const peelPath = '.artifacts/pr3-bootstrap/peel-order.json';
let peel;
if (fs.existsSync(peelPath)) {
  peel = JSON.parse(fs.readFileSync(peelPath,'utf8'));
} else {
  const edges = data.edges.slice();
  let orderList = boot.slice();
  const p = [];
  while (true) {
    const prov = new Set(edges.map(e => e[1]));
    let idx = -1;
    for (let i = orderList.length - 1; i >= 0; i--) if (!prov.has(orderList[i])) { idx = i; break; }
    if (idx < 0) break;
    const f = orderList[idx]; p.push(f); orderList.splice(idx, 1);
    for (let i = edges.length - 1; i >= 0; i--) if (edges[i][0] === f) edges.splice(i, 1);
  }
  peel = p;
  fs.writeFileSync(peelPath, JSON.stringify(p, null, 2) + '\n');
}
const batch = peel.slice(start-1, end).filter(f => !alreadyDeferred.has(f));
const newDeferred = [...(cfg.deferred ?? []), ...batch];
const newBootstrap = boot.filter(f => !newDeferred.includes(f));
const violations = data.edges.filter(([c, p]) => newBootstrap.includes(c) && newDeferred.includes(p));
if (violations.length) { console.error('ILLEGAL peel:', violations); process.exit(1); }
// deferred 必须保持原 bootstrap 相对序（摘除顺序 ≠ 执行序）
const original = JSON.parse(fs.readFileSync('.artifacts/pr3-bootstrap/orig-modules.json', 'utf8'));
const originalOrder = new Map(original.bootstrap.map((f, i) => [f, i]));
cfg.deferred = newDeferred.slice().sort((a, b) => originalOrder.get(a) - originalOrder.get(b));
cfg.bootstrap = newBootstrap;
fs.writeFileSync('web/editor-modules.json', JSON.stringify(cfg, null, 2) + '\n');
console.log(`peeled ${batch.length} files (deferred=${cfg.deferred.length}, bootstrap=${cfg.bootstrap.length})`);
```

前置数据：`orig-modules.json` = `git show 80f126ed:web/editor-modules.json`
的副本；`immediate-edges.json`（v1 边集）可由下述分析器语义重算——
phase-2 顶层语句与 IIFE 体内的裸门面名读（门面正则
`Mawe[A-Z]\w*|Asr[A-Z]\w*|MAWE_I18N|MAWEditor\w*|MAWE`），排除本文件
局部声明；发布侧同正则匹配 `window|global|globalThis.X =`。

### page-probe.mjs（真页面探针）

```js
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import { chromium } from '@playwright/test';
const repo = process.cwd();
const helpersUrl = 'file:///' + repo.split('\\').join('/') + '/tests/e2e/helpers.mjs';
const { generateWav, generateWaveformPayload, makeTempDir, startServer, cleanupTempDir, findFreePort, disableOnboarding } = await import(helpersUrl);
const dir = makeTempDir('probe-peel');
const wav = dir + '/synthetic.wav';
generateWav(wav, 4);
const project = { schema: 'moy.asr.project.v1', media: 'synthetic.wav', language: 'en', model: 'synthetic',
  segments: [ { id: 'a-1', start: 0, end: 2000, text: 'First', items: [{ start: 0, end: 2000, text: 'First' }] },
    { id: 'a-2', start: 2100, end: 4000, text: 'Second', items: [{ start: 2100, end: 4000, text: 'Second' }] } ],
  waveform: generateWaveformPayload(4000) };
fs.writeFileSync(dir + '/project.json', JSON.stringify(project, null, 2));
const port = await findFreePort();
const server = await startServer(dir + '/project.json', wav, port);
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
await disableOnboarding(page);
await page.goto(server.url);
await delay(4000);
const state = await page.evaluate(() => ({
  bridge: Boolean(window.MAWE_EDITOR_BRIDGE),
  trace: (window.__mawEsmInitializationTrace ?? []).length,
  boot: Boolean(window.MaweBoot), state: Boolean(window.MaweState),
  cueRows: document.querySelectorAll('.cue').length,
}));
console.log(JSON.stringify(state, null, 2));
console.log('errors:', errors.slice(0, 10));
await browser.close();
await server.stop();
cleanupTempDir(dir);
```

验收线：bridge=true、trace=188、boot/state=true、cueRows=2、errors=[]。

### analyze-immediate2.mjs（v2 tripwire）

语义：发布侧 = AST 抓 phase-2 内全部 `(window|global|globalThis).X =`
与 `defineProperty(window,'X',…)`；读者侧 = phase-2 顶层语句及 IIFE 体内
全部裸标识符（排除本文件局部声明），与发布名求交得边。已知高估源 =
把 CallExpression 实参位置的函数体当 IIFE。输出
`violations of current peel (bootstrap reads deferred)` 与
`deferred internal edges` 的序检查（按原序快照）。完整源码在工作树
`.artifacts/pr3-bootstrap/analyze-immediate2.mjs`（含悬空 else 修复）。
