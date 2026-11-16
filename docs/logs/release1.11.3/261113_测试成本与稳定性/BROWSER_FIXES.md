# 浏览器测试失败修复（不含 CHANGELOG 工具页）

- 授权：修复分析报告中的其余5项浏览器失败，可以按实际根因修改产品或测试；不处理 `tests/e2e/tool-pages.spec.mjs`，由同工作树另一 Agent 负责。
- 基线：`main@ee2fe595`；开始时工作区已有日志索引、分析文档和工具页测试改动，全部保留。
- 原失败证据：`.artifacts/checks/20261113T073754Z-f705879a/result.json`，1 worker、0 retries，5项全部失败。
- 状态：待处理、进行中、已修复、仅说明、阻塞。

| 条目 | 现象 | 状态 | 根因 / 修改 / 验证 |
| --- | --- | --- | --- |
| 1 | 烧录 detach 的 admission-body / write-pending 两个场景调用缺失方法 | 已修复 | `burn-video-jobs.spec.mjs` 通过生产编译器执行真实project-load初始化器，不再把ESM源码直接当自执行脚本。保留并增强epoch递增、撤销导出能力、取消请求、abort及不提交输出的断言。 |
| 2 | 波形双击、Enter 两个场景未聚焦字幕编辑区 | 已修复 | 仅更新 `click-behavior.spec.mjs`：验证气泡焦点、所选字幕、提交、Enter句尾光标及空白双击播放；新增真实波形视口外字幕的面板回退/提交回归。定向9项通过，光标置首及丢弃回退回调的负对照均按预期失败并撤除注入；产品UX不变。 |
| 3 | 彩色字幕索引的固定色值与当前主题不符 | 已修复 | `cue-color-filter.spec.mjs` 使用当前动态text-secondary令牌，覆盖明暗主题，并合成实际透明祖先背景计算文字对比度，要求≥4.5:1；不是仅换一个固定颜色。 |

## 阶段记录

- 已分离本任务记录，避免与工具页 Agent 同时改同一账本。当前不提交或推送。
- 焦点产品契约的独立只读调查核对用户指南、发布说明、生产接线与快速编辑专属回归，一致确认旧面板焦点预期已退役；不能将既有失败时未记录的实际 activeElement 当作已证实。现行快速编辑的15项Node契约/逻辑测试通过：`.artifacts/checks/20261113T080959Z-a6d2051a/result.json`。
- 焦点修复定向9项通过 `.artifacts/checks/20261113T081046Z-8c8cc72a/result.json`，负对照 `.artifacts/checks/20261113T081004Z-a54a291f/result.json`；当前只验证Chromium定向集，未冒充全部spec或跨平台通过。
- 烧录/颜色原始3失败 `.artifacts/checks/20261113T080600Z-c1e13c90/result.json`；移除requestStop的负对照 `.artifacts/checks/20261113T080843Z-07d8b96e/result.json`，禁止epoch递增/降低对比度负对照 `.artifacts/checks/20261113T081153Z-2802ee1b/result.json`，均按预期报错并撤除注入。两份spec33项通过 `.artifacts/checks/20261113T081013Z-abc4e5e4/result.json`，撤除负对照后的定向4项通过 `.artifacts/checks/20261113T081229Z-e93446c9/result.json`。
- 主会话合跑4份spec：`burn-video-jobs.spec.mjs`、`click-behavior.spec.mjs`、`cue-color-filter.spec.mjs`、`waveform-cue-quick-edit.spec.mjs`，Chromium / 2 workers / 0 retries，**94通过、0失败、0跳过**，48.27秒。结果 `.artifacts/checks/20261113T081524Z-3d1cf2b5/result.json`；JSON `.artifacts/test-audit-261113/browser-fixes-final.json`。另外焦点2份spec在1 worker下61项通过 `.artifacts/checks/20261113T081329Z-61d55c3c/result.json`。
- 产品代码、样式、实际CHANGELOG和工具页测试未由本任务修改；不生成根便携HTML，不新增用户功能Changelog条目。未执行完整1140项集合、其他浏览器或跨平台CI，不以本轮94项代替全量。独立复核0blocker/major/minor，详见[独立审查](REVIEW_FINDINGS_浏览器回归.md)。
