# 全量 E2E 基线失败排查记录

2026-09-16 在本机完整跑通全量 Playwright（405 项：365 过 / 42 失败标记，汇总 40 失败）。
排查背景：

- CI（GitHub Actions）只跑 Python 单测与打包契约，**不跑 e2e**，失败不会阻塞合并；
- 已用 `git stash` 在干净 HEAD 上复核：编辑器区 11 个失败逐项复现，launcher 群与
  `web/editor.js`、`web/waveform.js` 改动无关（独立 file:// 页面），确认全部为**既有失败**；
- 本轮修复（C 键合并、行高 cover-mode）引入的失败为零。

## 复现与验证命令

```powershell
# 全量（约 22 分钟，建议后台）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\refactor-tools\run-e2e-bg.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\refactor-tools\poll-e2e.ps1

# 单 spec
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-e2e.ps1 tests/e2e/<spec>.spec.mjs
```

失败详情：`%TEMP%\maw-playwright-results\<test>-chromium\error-context.md`
（注意：该目录每次运行会被 Playwright 清空重建，需要时先备份）。

## 集群 A：界面语言被浏览器 locale 切成英文（24 项）—— 已修复

| 状态 | 项 | 根因 / 处理 |
| --- | --- | --- |
| 已修复 | launcher-interactions ×23、layout-feedback ×1 | 根因：beta.4（00df562c）给 Launcher 加入 `systemLanguage()`（launcher.js:2338），按 `navigator.language` 自动选语言；Playwright 上下文默认 locale 为 `en-US`，界面渲染成英文，中文文案断言全部失配（如 `#provider option` 收到 "OpenAI (and compatible)"）。修复：`playwright.config.mjs` 全局 `use.locale: 'zh-CN'`，与产品主要用户基线一致 |

修复过程中连带发现并处理的三类跟随问题（均为 beta.4 工具箱/语言重构的遗留）：

| 状态 | 项 | 根因 / 处理 |
| --- | --- | --- |
| 已修复 | launcher-interactions 中 5 处 `#langToggle` | 语言切换控件已拆成 `#langZh`/`#langEn`（设置弹窗内，默认不可见），测试引用失效；改用同文件既有的 `page.evaluate(() => …click())` 模式 |
| 已修复 | launcher-interactions:385 | beta.4 重构删除了 `#toolboxUtilitiesTabList` 的 `aria-orientation="vertical"`（ARIA 回归，已补回模板）；tab 条从竖排改横排后测试断言与 DOM 查询未同步（nav 移出 content 容器、类名 `.toolbox-utility-tab-list`→`.toolbox-tab-list`、工具顺序变化），测试按现行设计更新 |
| 已修复 | layout-feedback:101 | `runtimeHintText` 对已知状态一律显示 i18n 文案，把后端 `ready_detail`（"OCR 模型已安装，可以在工具箱中使用。"）整个屏蔽——信息丢失回归；改为优先展示后端 `detail`，缺失才回退 i18n（web/launcher/launcher.js） |

验证：launcher-interactions + layout-feedback 48/48 通过（2026-09-16）。

## 集群 B：其余 18 项（排查进行中，已修复 8 项）

| 状态 | 项 | 现象 / 根因 / 处理 |
| --- | --- | --- |
| 已修复 | otio-export:37 | `otioExportIncludeSrt` 默认 true（OTIO 附带 SRT 是既有特性），测试的桩把两次写都记了；测试内关闭该设置后单断言恢复 |
| 已修复 | fcp7-export:102 | `#fcp7-export-subtitle-tracks` 现为静态 4 选项（#130 新增 overlay/all，editor.js:16986 动态禁用）；测试期望更新为 4 项 + 无轨时逐项禁用断言 |
| 已修复 | timed-text-edit:69 | 帧时间基准下 items 携带成对 `start_frame/end_frame`（JSON_SCHEMA §1.4 允许）；测试期望按 30fps 补帧字段 |
| 已修复 | onboarding:97 | 引导状态已改服务端持久化（SERVER_CONFIG.onboardingStatus，serve.py `/api/settings`），第一个用例完成后不再自动弹出；测试改为按用例本意从 Help（`#help-onboarding`）强制重播再验证跳过持久化。其中 `#help-open-media-settings` 文案断言同步更新为「全局设置」（097cec56 有意变更） |
| 进行中 | editor-i18n-save:33 | 英文模式未翻译串扫描。已补 6 条叠加轨词条 + 7 条 ASS 样式库词条（web/editor-i18n.js EN_TEXT；后者为 PR #135 新增缺口）；当前仍有失败（新报「Split at text position…」相关 `not.toMatch` 断言），需继续对照 EN_TEXT 补齐 |
| 进行中 | editor-i18n-save:242/286 | 已确认与帧吸附有关：帧时间基准下 `syncSegmentTimebase` 用帧号重算 ms（50001→50000），1ms 重叠被抹掉；测试已钉 `DATA.timebase={unit:'milliseconds'}` 但 hint 仍未出现，需继续查（探针显示 Ctrl+S 会产生 2 次 POST 与 2 张错误卡） |
| 待处理 | click-behavior:57/872/388 | seek 精度（20 未移动 / 差 1s）与拆分闪光缺失；待单独复跑定位 |
| 待处理 | cue-scroll-stability:223 ×2 | ENOENT：`_maw/backups/*.mosp-bak` 未按预期落盘；注意备份目录名可能与 UI 语言联动（`_maw/备份` vs `backups`，见 editor-i18n.js EN_TEXT 备份文案） |
| 待处理 | multi-subtitle:2417 | `#extension-overlay-toggle` uncheck 超时（元素 checked 但不可点，疑似遮挡/动画） |
| 待处理 | open-project-attach:65 | 页面 `load` 事件 10s 超时（服务端首启慢？） |
| 待处理 | waveform-deletion:209 / waveform-marquee:237 | waitForFunction 计数 5s 超时 |
| 待处理 | waveform-history:831/1732 | 期望 1390 收到 1414 / ≤618 收到 631（滚动与像素位置差） |

注意：waveform-history 两项已在干净 HEAD 基线复现，与本次行高改动无关。
探针残留：`tests/e2e/_probe-overlap.spec.mjs`（诊断用，提交前删除）。

注意：waveform-history 两项已在干净 HEAD 基线复现，与本次行高改动无关。

## 恢复顺序（新会话接手时）

1. `git status --short` 确认工作区；
2. 重读本记录与 `git log --oneline -10`；
3. 用上文命令重跑对应 spec，把本表状态与实际代码、测试结果重新对齐；
4. 状态只允许：`待处理`、`进行中`、`已修复`、`仅说明`、`阻塞`。
