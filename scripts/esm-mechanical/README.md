# 隔离 ESM 机械迁移实验

这是调研原型，正式源码和消费端不在此目录内迁移。完整结果见 `docs/temp/ESM_MECHANICAL_RESEARCH_REPORT.md`。

## 建立副本

在仓库根目录执行。需要已安装的 Python 环境、Chromium，以及包含 esbuild / acorn / eslint-scope / TypeScript / Playwright 的开发依赖。本轮复用了现有试点依赖；不把依赖链接当作产品运行依赖。

```powershell
$repo = (Get-Location).Path
$experiment = Join-Path $repo '.worktrees/esm-mechanical-replay'
$dependencies = Join-Path $repo '.qwen/worktrees/esm-pilot/node_modules'
$python = Join-Path $repo '.venv/Scripts/python.exe'
& $python scripts/esm-mechanical/setup.py $experiment --dependencies $dependencies
$baseline = Join-Path $experiment 'baseline'
$naive = Join-Path $experiment 'naive'
$full = Join-Path $experiment 'full'
$env:MAW_ESM_BASELINE_ROOT = $baseline
$env:MAW_ESM_PYTHON = $python
$env:MAW_E2E_PYTHON = $python
$env:PYTHONIOENCODING = 'utf-8'
```

setup 读取 tracked HEAD，排除 `.env`，拒绝覆盖已有目标；只创建 `.worktrees` 中的新目录。副本包含未修改的基线，以及待转换的 naive / full。工具自身从本目录复制，原有工作树不改动。若试点依赖不存在，应提供自己已安装的依赖目录。

## 红灯：构建成功但没有共享作用域连接

```powershell
node "$naive/scripts/esm-mechanical/full-convert.mjs" $naive --naive
node "$naive/scripts/esm-mechanical/full-build.mjs" --write $naive
$env:MAW_ESM_FULL_ROOT = $naive
node --test "$naive/scripts/esm-mechanical/assembly-contract.test.mjs"
```

最后一条预期非零退出：E2 检出旧共享绑定泄漏，E6 检出真实页面启动失败。构建通过不算实验通过。不要在这个副本运行加载器适配来遮盖红灯。

## 绿灯：完整依赖图与两阶段初始化

```powershell
node "$full/scripts/esm-mechanical/full-convert.mjs" $full
node "$full/scripts/esm-mechanical/full-build.mjs" --write $full
$env:MAW_ESM_FULL_ROOT = $full
node --test "$full/scripts/esm-mechanical/assembly-contract.test.mjs"
node "$full/scripts/esm-mechanical/adapt-tests.mjs" $full
Push-Location $full
node --test tests/test_*.mjs
& $python -m unittest discover -s tests -p 'test_*.py'
pnpm run typecheck
node node_modules/@playwright/test/cli.js test --project=chromium tests/e2e/editor-transactions.spec.mjs tests/e2e/speaker-labels.spec.mjs tests/e2e/timed-text-edit.spec.mjs tests/e2e/open-project-attach.spec.mjs tests/e2e/overlay-track.spec.mjs tests/e2e/ass-export.spec.mjs tests/e2e/waveform-deletion.spec.mjs tests/e2e/keyboard-timing.spec.mjs tests/e2e/playback-refresh.spec.mjs
Pop-Location
```

记录每条命令的实际退出码。本轮新装配测试、Node 与上述浏览器集通过；原始 Python 契约及 typecheck **仍非零退出**，不能用后续命令的成功覆盖它们。基线的 Python / typecheck 对比也应从 baseline 目录独立运行。

`--write` 是唯一写产物模式；`--check` 与导入构建器不写产物。转换器只接受 classic 原始副本，一次性输出全部文件；不要对已转换副本再次转换。E4 / E5 / E10 会暂时改变隔离文件并在 finally 中恢复，因此同一副本的测试不要与其他页面 / 测试任务并行运行。

## 文件职责

- `research.mjs`：AST 盘点与历史 5 文件工厂试验。
- `full-convert.mjs`：180 文件转换、跨文件读写访问器、外部词法桥，以及 Python 消费路径适配。
- `full-build.mjs`：真正的 esbuild 依赖图、显式初始化与纯读新鲜度检查。
- `assembly-contract.test.mjs`：E1–E6、E8–E10 目标契约及反例（原 E7 桌面实验已退役）。
- `full-verify.mjs`：实际 Python 渲染的基线 / file 页面、真实 localhost 页面及产品行为探针。
- `adapt-tests.mjs`：只在实验副本迁移 Node 加载器与两项旧 classic 结构测试。
- `test.mjs` / `verify.mjs`：历史小批次反例与三页验证；不能代替完整装配结果。

原型保留 MAWE 注册表、依赖袋与现有 IIFE；它证明兼容阶段的机械 ESM 装配，不证明所有业务依赖都已变成直接命名 import，也不证明发布打包或全部 E2E。

## 上游合并预演

`rehearse-upstream.py` 用固定 PR HEAD 测量直接合并冲突，再把上游变更投影到相同 ESM 表示层，三方合并保护 fork 改动。`probe-projection.py` / `verify-upstream.mjs` 保存“Git 零冲突但功能未打包”的反例；`test-upstream.py` 覆盖冲突、双亲历史、严格新增内容合并和工作区保护。

完整命令与边界见 `docs/temp/ESM_UPSTREAM_MERGE_PLAYBOOK.md`，真实结果见 `docs/temp/ESM_UPSTREAM_MERGE_REHEARSAL.md`。新预演不修改主工作区或远端 PR。

## 正式部分迁移的预演

本批实际采用 59 个 ESM 工厂，不能直接套用上方 full 转换器。`rehearse-production.py` 重用固定审查列表，对真实 fork 做三方投影；`adapt-production-types.mjs` 为固定上游 HEAD 补类型，写入前验证 JavaScript AST 一致；解决 JSON 只接受审查过的完整冲突片段。输入变化则停止。

命令、当前 head、冲突数量、逐片段处理与结果索引见 [生产交接文档](../../docs/dev/ESM_UPSTREAM_PRODUCTION.md)。`test-upstream.py` 另覆盖旧规则拒绝、完整冲突路径匹配和主工作区写入保护。
