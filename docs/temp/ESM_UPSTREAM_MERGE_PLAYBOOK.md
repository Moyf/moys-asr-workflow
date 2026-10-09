# 上游 PR → ESM fork：复现与处理手册

结果及边界见 [预演报告](ESM_UPSTREAM_MERGE_REHEARSAL.md)。所有命令从仓库根目录运行。使用独立 clone，拒绝覆盖已有目录或复用共享 Git 状态的 worktree；主工作区不会被 merge / reset / clean。

## 1. 固定输入，先做独立预演

本轮输入已保存在 `docs/temp/ESM_UPSTREAM_PR_SNAPSHOT.json`。它包括 #177–#180 与 #157 的固定原始 HEAD。新一轮查询可另存快照：

```powershell
$repo = (Get-Location).Path
$lab = Join-Path $repo '.worktrees/esm-upstream-replay'
$deps = Join-Path $repo '.qwen/worktrees/esm-pilot/node_modules'
$python = Join-Path $repo '.venv/Scripts/python.exe'
$snapshot = Join-Path $lab 'prs.json'
& $python scripts/esm-mechanical/snapshot-upstream.py --output $snapshot
```

需要 Git ≥2.46 的 merge-tree、gh、Node、Rust、已安装 Chromium，以及 esbuild / acorn / eslint-scope / TypeScript / Playwright 开发依赖。`$deps` 可以换为自己安装好的目录；产品用户不需要这些调研依赖。本轮 Node 25.8.0、esbuild 0.28.2。不读取 `.env`。

复现本轮，使用已保存的快照及 classic 基线：

```powershell
$snapshot = Join-Path $repo 'docs/temp/ESM_UPSTREAM_PR_SNAPSHOT.json'
$individual = Join-Path $lab 'individual'
& $python scripts/esm-mechanical/rehearse-upstream.py --destination $individual --snapshot $snapshot --dependencies $deps --python $python --base dfd5971f
```

包含 #157 时最终退出码为 1，因为它的旧架构合并被明确阻塞；其他 PR 仍逐项完成并保存结果。仅选普通业务 PR 可传 `--prs 177,178,179,180`。这属于选择研究对象，不是跳过所选对象的失败测试。

`results.json` 记录 classic / 直接 ESM 冲突、漏输入、投影候选和实际测试退出码。每个 PR 保存完整 patch 与 projected.patch；patch 供审查，生成 bundle 的 diff 不应手改。`--no-validation` 只用于明确的构建层研究，结果标记没有运行验证，不能当作通过。

## 2. Git 网络失败时恢复

如果 fetch 失败，已创建的隔离 objects 仓库可以保留。备用脚本通过 GitHub API 校验并写入原始 Git 对象，不用近似 patch 替代真实提交：

```powershell
$objects = Join-Path $individual 'objects'
& $python scripts/esm-mechanical/fetch-github-objects.py --object-repo $objects --snapshot $snapshot
$retry = Join-Path $lab 'individual-retry'
& $python scripts/esm-mechanical/rehearse-upstream.py --destination $retry --snapshot $snapshot --dependencies $deps --python $python --base dfd5971f --object-repo $objects --no-fetch
```

只在原始对象哈希全部匹配时继续。缺历史、API 截断、特殊提交头无法恢复、链接 / 敏感路径、已有输出目录或 Git 目录共享都会停止。unsigned commit 的时区仅在 SHA 完全匹配时接受；不能恢复时需要正常 Git 传输。缓存位于隔离 `.git/esm-api-cache`。

## 3. 组合预演

用同一个对象仓库，但新输出目录；保留 PR 的双方父提交，避免产生虚假的叠加冲突：

```powershell
$objects = Join-Path $individual 'objects'
$combined = Join-Path $lab 'combined'
& $python scripts/esm-mechanical/rehearse-upstream.py --destination $combined --snapshot $snapshot --dependencies $deps --python $python --base dfd5971f --object-repo $objects --no-fetch --prs 177,178,179,180 --sequence 177,179,178,180 --sequence-only --additive-paths CHANGELOG.md,tests/test_project_contract.py
```

`--additive-paths` 必须明确列出允许处理的文件。规则只接受相对共同基线的纯插入；Python 原函数必须完整不变，新函数无重名，合并结果等于两侧函数并集。任何替换、删除、同名不同逻辑或 JS / CSS 冲突均停止。取消该选项可以重现原始的两处 classic 冲突。

组合的装配 / Node 门禁在主脚本中运行。下面继续验证新增测试、交互和三项新功能接线：

```powershell
$env:MAW_E2E_PYTHON = $python
$env:PYTHONIOENCODING = 'utf-8'
Push-Location (Join-Path $combined 'combined-projected')
& $python -m unittest discover -s tests -p 'test_project_contract.py'
node node_modules/@playwright/test/cli.js test --project=chromium tests/e2e/word-timing.spec.mjs tests/e2e/settings-structure.spec.mjs tests/e2e/script-alignment-editor-roundtrip.spec.mjs tests/e2e/script-timestamp-alignment.spec.mjs
node scripts/esm-mechanical/verify-upstream.mjs . $python
Pop-Location
```

记录每条命令的退出码；后一个成功不能覆盖前一个失败。已有类型 / 旧资产字符串契约按维护者决定延期处理，不能称它们已通过。

## 4. fork 改动与零冲突漏功能反例

```powershell
$proof = Join-Path $lab 'proof'
& $python scripts/esm-mechanical/probe-projection.py --destination $proof --object-repo $objects --results (Join-Path $individual 'results.json') --dependencies $deps --python $python
& $python scripts/esm-mechanical/test-upstream.py
```

如果独立结果来自重试目录，将 `$individual` 换为 `$retry`。proof.json 中验证：fork 非重叠改动和新 Canvas 同时运行；fork 对旧 ASS 字号逻辑的修改被 #180 删除时仍有冲突；直接合并 #177 / #178 后旧产物过期，#177 的字词 API 在 file / HTTP 均缺失。负例返回非零，外层反例脚本只有确认这些红灯真的出现才通过。

## 5. 用于未来实际 ESM 分支

传 `--base` 指向 classic 集成历史，传 `--fork-ref` 指向实际已迁移的 fork 提交；默认不传 fork-ref 只是模拟刚完成迁移。两者必须对应同一转换器规则，不能把任意 ESM 工程当作该原型的产物。

先审查生成的差量和冲突，修复源逻辑，重新构建并验证。候选位于隔离仓库的 `refNamespace` 下；需要实际集成时，应取候选完整历史进行合并，保留上游父关系。不要只 apply patch 后做单亲提交，导致后续重复导入同一 PR。主分支存在新改动时重新预演，不能把旧候选覆盖过去。

每次保存 classic 集成结果、对应 ESM 对照和转换器 SHA，并推进下次基线。classic 影子历史仅用于合并暂存，不进入运行 / 发布。fork 新模块、路径迁移、注册桥退役和测试基线变化需要另外验证；当前脚本不会自动认可这些架构差异。

分批迁移时维持文件路径和函数正文，避免同时重排目录 / 全量格式化；生成产物始终重新构建。旧 `tools/merge-flow.mjs` 针对单体 → IIFE 拆分，不适用于本次 classic → ESM 图，勿直接套用。

本轮只是隔离预演，没有将候选合入主工作区或修改 GitHub PR。
