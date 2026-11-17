# 忍者拆分反馈测试

## 首败与原因

PR 396 的 `27f91748`，run 44013536759 的 Windows Chromium shard 3（job 133805995681，artifact 14298291883）：289 通过、1 失败。`multi-subtitle.spec.mjs` 的 linked split-modal 用例期待刀光元素带 `show`，但断言开始后读到空 class。

原 trace 的点击后快照 `after@call@4415` 已显示刀光 `class="show"`；随机动画时长约 212 ms、余韵约 114 ms，清理延迟合计约 446 ms。点击结束至 `toHaveClass` 断言启动约 352 ms，首次定位约在点击结束 510 ms 后，已经错过短暂效果。该记录直接证明本次刀光发生过，不需要推测产品未触发。

## 修复与验证

- 保留真实拆分、模态关闭和出现刀光的断言；在确认点击前安装 `MutationObserver`，记录实际出现的 `show`，成功后主动断开，失败路径在 `finally` 断开并释放句柄。没有更改产品代码、效果时长、测试 timeout 或重试。
- 受控负向对照：先等待短暂效果自然结束，再执行旧 `toHaveClass`，真实 Chromium 失败（`20261117T042155Z-d40d01a6`）；观察器版本在同一受控条件下通过（`20261117T042255Z-c2491f07`）。最终测试没有新增要求动画结束的断言。
- 临时关闭刀光特效后，观察器断言按预期失败（`20261117T042339Z-5e2c6701`），设置已恢复；最终定向 Chromium 测试通过（`20261117T042555Z-55cab628`）。
- 含临时“等待效果结束”更强断言的版本跑完整 `multi-subtitle.spec.mjs` 99/99 通过，单个 spec 实际 1 worker（`20261117T042432Z-e4e2b8ee`）；该额外断言在测试开始后撤去，不将本次结果冒充最终 diff 的完整运行。
- 原 CI head `27f917488c8bb03dc6c2adf4f1641765d52cee7b` 和最终候选分别对原失败用例执行 10 次、1 worker、0 retry：原版 10/10（48.98 秒，`20261117T043832Z-dacdb431`），候选 10/10（49.30 秒，`20261117T043934Z-ddcbd276`）。自然重复未重现首败；上述受控旧败新通单独证明观察方式的差异。
- 最终候选按原 browser-list 顺序运行相邻的 `multi-subtitle-metadata.spec.mjs` 和 `multi-subtitle.spec.mjs`，104/104 通过，2 worker、0 retry、Python 3.11.9，用时 202.77 秒（`20261117T044038Z-2c08a643`）。
- 环境：CI 使用 Windows Server 2025 image `20261103.298.1`、Python 3.11.9；本机为 Windows 11 26200、AMD Ryzen 9 9900X（12 核/24 逻辑线程）。前述早期验证使用 Python 3.11.15，两个十次对照使用 Python 3.11.9。两者使用 Node 22.23.4、pnpm 11.28.4、Playwright 1.62、Chromium 151.0.7922.34 和 FFmpeg/FFprobe 9.0.2；CI 的 CPU 型号及实时负载未获证实。本机结果不能视为 GitHub runner 的完整复现。

## 独立审查与边界

独立审查未发现 blocker 或 major；确认观察器安装在点击前、只记录真实 `show`，成功和失败时均清理。受控对照证明测试可错过真实短暂效果，并守住缺失反馈；不能据此推断其他 CI 波动原因。
