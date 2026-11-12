# 合并后颜色引用修复 · 独立自审

- 审查时分支 / 基线：`fix/双语颜色字幕合并报错` @ `12daf4d2`，针对当时未提交修改。
- 独立审查者未参与实现，只读通读修复 diff 与真实源码；合成探针写在本地 `.artifacts/review-color-refs/`。
- 最终结论：**源码与回归层通过独立复审，无未处置 blocker / major**。首轮 2 项 Major 已修复并双向验证；审查完成后维护者已授权提交并创建 PR，原工程人工验收仍待确认。

## Findings

| 条目 | 级别 | 问题与证据 | 处置 |
| --- | --- | --- | --- |
| F1 | Major | `web/shared/utils/multi-subtitle.js` 的 `remapGroupRefsAfterMergeSplice` 接收合并前下标，却用合并后 `segments.length` 过滤；6 条合并前 4 条后，head@4 实际变为 1，但其成员引用变为 2（自指）。直接副轨、主轨联动及叠加轨均复现；8 条非连续合并 `[0,2,4,5]` 也复现。 | 已修复：显式 `originalLength` 由三个合并入口在 splice 前捕获；新增大窗口 / 非连续 / 尾部 / 整轨永久回归。 |
| F2 | Major | `reconcileExtensionTrack` 新增修改颜色引用 / 物化颜色，而 `editor-bound-drag.js` 的 `snapshotBoundDragTrack` 与 `restoreBoundDragTimelineOriginals` 未保存 / 恢复颜色。绑定挤压预览删除副轨前段后拖回原位，6 条恢复但 ref@5 仍指 3（非 head），旧 core 同操作 ref 为 4。 | 已修复：快照和每次恢复都深拷贝颜色及引用，保持字段缺失 / null / own undefined；临时删 head 和反复往返永久回归通过。 |

## 首轮验证证据

```powershell
python scripts/run_check.py --timeout 180 -- node --test .artifacts/review-color-refs/review.mjs
python scripts/run_check.py --timeout 180 -- python .artifacts/review-color-refs/validate.py
```

- 14 条审查探针：9 通过 / 5 失败，失败对应 F1 的 4 条场景及 F2 的 1 条场景。记录：`.artifacts/checks/20261112T044602Z-c8414e8f/result.json`，`output.log` 第 2–7 行有最小引用布局。
- Python 契约验证：两个合成工程均被拒绝，分别报自指与非 head 引用；记录：`.artifacts/checks/20261112T044626Z-6cb8c4f3/result.json`。探针自身执行 exit 0 表示成功输出缺陷证据，不表示工程验证成功。
- 主会话抽查上述 helper、拖动快照 / 恢复及探针原文，确认两项证据匹配当前代码。

## 独立复审与双向验证

- 永久回归：`tests/test_editor_color_refs.mjs` + `tests/test_editor_utils.mjs` **384/384** 通过（`.artifacts/checks/20261112T045633Z-f5cd1b40/result.json`）。
- 独立补查 7,864 组旧下标集合 / head 位置映射、真实主轨收集非连续副轨集合，以及缺失 / null / own undefined 的 9 种组合恢复；连同领域回归共 20/20 通过（`20261112T045839Z-c2f5260a/result.json`）。
- 仅内存变异，生产文件和 bundle 未回退：F1 恢复错误上界时 3 条失败（`20261112T045839Z-5a31dfc7/result.json`）；F2 去快照 / 去恢复时各 5 条失败（`20261112T045839Z-3b36fa6f/result.json`、`20261112T045839Z-b95de3f8/result.json`）；恢复时直接共享快照对象则 4 条失败（`20261112T045839Z-3488cc55/result.json`）。这些失败均为有效预期红控。
- 独立审查实际核对了显式旧长度三个调用点、深拷贝及字段状态，并通读新增保存测试。首轮 `review.mjs` 中过期 helper 调用不复用为本轮结果，新增本地 `recheck.mjs` 承接。

## localhost 集成与产物检查

- 4 条新增保存回归全通过（`.artifacts/checks/20261112T045712Z-bcb3e814/result.json`）：UI 两句合并 / 关闭双字幕 / 四句合并，以及真实领域函数驱动的绑定挤压预览往返。每条都检查 POST 200、磁盘内容、reload，并停启测试服务器从已保存 `.mosp` 重新解析。
- 保存测试内存变异 9 项对照：旧合并路径的大窗口用例、去颜色拖动快照的往返用例、去空保护的关闭双字幕用例分别失败，其余 6 项通过（`20261112T045743Z-103b242e/result.json`）。另有两句合并的旧逻辑有效红控，见账本续 4。
- 最终源码只补正了副轨合并旧注释，未改行为；再次重建 editor bundle（`20261112T050309Z-909ed94f/result.json`）。根 `blank-editor.html` 未重生成，内联副本待发布前统一重生成。

## 验证边界

新增拖动测试是领域预览 + 真实保存集成，不是新颜色 fixture 的鼠标 pointer e2e；现有不带颜色的 Alt 拖回用例通过，但原工程真实拖动、播放 / Seek 体验仍需人工核验。macOS/Linux、打包和 CI 未测。既有 7 条浏览器基线失败未修复；本轮补跑另发生一次 Chromium 启动超时，单用例复跑通过，详见账本，不能将首次整组写成全绿。

最终 bundle 新鲜度、文档与文本卫生门禁通过（账本续 5）。本机 Node v22.23.2 低于仓库声明的 22.x 下限；未调整依赖 / 环境，实际通过结果不能替代受支持版本及 CI 验证。
