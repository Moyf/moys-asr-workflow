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

## 集群 B：其余 18 项（本轮排查已收口）

| 状态 | 项 | 现象 / 根因 / 处理 |
| --- | --- | --- |
| 已修复 | otio-export:37 | `otioExportIncludeSrt` 默认 true（OTIO 附带 SRT 是既有特性），测试的桩把两次写都记了；测试内关闭该设置后单断言恢复 |
| 已修复 | fcp7-export:102 | `#fcp7-export-subtitle-tracks` 现为静态 4 选项（#130 新增 overlay/all，editor.js:16986 动态禁用）；测试期望更新为 4 项 + 无轨时逐项禁用断言 |
| 已修复 | timed-text-edit:69 | 帧时间基准下 items 携带成对 `start_frame/end_frame`（JSON_SCHEMA §1.4 允许）；测试期望按 30fps 补帧字段 |
| 已修复 | onboarding:97 | 引导状态已改服务端持久化（SERVER_CONFIG.onboardingStatus，serve.py `/api/settings`），第一个用例完成后不再自动弹出；测试改为按用例本意从 Help（`#help-onboarding`）强制重播再验证跳过持久化。其中 `#help-open-media-settings` 文案断言同步更新为「全局设置」（097cec56 有意变更） |
| 已修复 | editor-i18n-save:33 | 英文模式未翻译串扫描。补齐叠加轨、ASS 样式库和右键菜单「转为叠加字幕」等精确词条（web/editor-i18n.js EN_TEXT），并补 unit 断言；聚焦 spec 11/11 通过（2026-09-16） |
| 已修复 | editor-i18n-save:242/286 | 根因是保存前 `flushInlineEditsForSave` 在没有待提交面板编辑时仍提交旧的 cue-panel 时间值，既抹掉毫秒重叠又触发 debounce 二次 POST；仅在 `cuePanelUndoPushed` 表示确有待提交文本编辑时 flush，并让 E2E helper 同步关闭 Server 模式的内存引导状态。1ms/2000ms hint、修复方向、重试保存均通过；聚焦 spec 11/11 通过（2026-09-16） |
| 已修复 | click-behavior:57/872/388 | 根因：通用 E2E helper 只写 localStorage，未同步 Server 模式的内存引导状态，首个 RAF 仍会弹引导层并吞掉键盘 seek；另有 cue-panel 拆分前提交会把光标位置重置到文本末尾。helper 同步关闭服务端引导状态，`splitCuePanelAtCursor` 在提交前保存 selectionStart；完整 spec 31/31 通过（2026-09-16） |
| 已修复 | cue-scroll-stability:223 ×2 | 根因：测试固定读取 `_maw/backups`，但中文服务端按受支持的界面语言把备份写入 `_maw/备份`；测试改为在两个受支持目录中定位实际生成的备份文件。server backup 聚焦用例 2/2 通过（2026-09-16） |
| 已修复 | multi-subtitle:2417 | 根因：测试切换到「字幕样式」页后仍直接操作只存在于「字幕预览」页的隐藏 toggle；测试改为切回预览页并点击可见标签。定向用例 1/1 通过（2026-09-16） |
| 已修复 | open-project-attach:65 | 根因：浏览器打开旧版毫秒工程时会补写可选 `start_frame/end_frame` 派生字段，而磁盘旧工程没有这些字段，服务器因此误判内容不一致、未触发刷新。接管比较在毫秒时间基准下忽略派生帧字段，帧时间基准仍严格比较；完整 spec 2/2 通过（2026-09-16） |
| 仅说明 | waveform-deletion:209 / waveform-marquee:237 | 首次全量排查中的 `waitForFunction` 计数 5s 超时未能稳定复现；当前两个 spec 均完整通过（各 2/2，2026-09-16），无需代码修改 |
| 已修复 | waveform-history:831/1732 | 根因：断言把虚拟列表的原始 `scrollTop` 和固定像素高度当成用户行为契约；合并后实际可见 cue 的屏幕位置保持不变，设置面板本来就通过 `overflow-y: auto` 承载新增内容。断言改为验证视觉锚点、面板可见高度和滚动契约；定向用例 2/2 通过（2026-09-16） |

说明：waveform-history 两项已在干净 HEAD 基线复现，与本次行高改动无关；本轮临时诊断探针已删除，不进入提交。

## 本轮收尾验证（2026-09-16）

- `node --check web/editor.js`、`node --check web/editor-i18n.js`、`git diff --check`：通过；
  `node --test tests/test_editor_utils.mjs`：254/254 通过；
- 本轮涉及的 Python 定向测试（`test_local_editor_server`、`test_project_contract`、
  `test_project_backups`、`test_project_io`）：134/134 通过；
- 相关 E2E：editor-i18n-save 11/11、click-behavior 31/31、server backup 2/2、
  multi-subtitle 1/1、open-project-attach 2/2、waveform-deletion 2/2、
  waveform-marquee 2/2、waveform-history 定向 2/2 通过；
- 全量 Python 单测 1578 项中有 6 个失败、7 个错误、12 个跳过，失败集中在既有的
  Launcher HTML 基线、运行时根目录环境变量和缓存落盘位置/测试夹具目录问题，未涉及本轮修改；
  因此以定向 134/134 和上述 E2E 结果作为本轮变更验收依据。

## 恢复顺序（新会话接手时）

1. `git status --short` 确认工作区；
2. 重读本记录与 `git log --oneline -10`；
3. 用上文命令重跑对应 spec，把本表状态与实际代码、测试结果重新对齐；
4. 状态只允许：`待处理`、`进行中`、`已修复`、`仅说明`、`阻塞`。
