---
task: editor-esm-followup-manual
pr: 458
date: 2026-11-26
status: pending
---

# Editor 模块清理 · 手动验收

> 使用当前工作树和真实本机 Editor Server。请逐项实测后勾选。

## 实现与审查结论
<!-- id: editor-review -->

- 核验范围覆盖 Editor 的启动、字幕编辑、标记、工程保存和导出。基线是 PR #458 的 `510ce2b9` 加当前工作树改动。
- 本轮移除了 13 个重复的对外门面及 47 个初始化 IIFE 壳。需要在启动时读取 DOM、安装监听器或绑定宿主的逻辑仍在对应的 `init` 里执行。
- 审查复现了相邻合并的选测缺口。单独改动 `editor-merge-adjacent.js` 或快捷键接线文件时，选测结果未包含通过 Ctrl/Cmd+Shift+D 验证叠加轨合并的浏览器用例。手测把三轨合并列为优先项。

## 自动化证据
<!-- id: editor-automation -->

当前候选已通过 Editor 构建和新鲜度检查、类型检查及全局审计。上轮本地复跑通过 1,781 项 Node、88 项 Python 与 43 项 Chromium 用例。本轮独立复查另通过 5 项 Chromium，其中 1 项在没有测试夹具的生产入口确认打开工程、保存、备份与导出。该用例跳过首次引导并关闭原生保存选择器。当前源码的冻结包入口尚未复测。

## 建立临时工程
<!-- id: editor-setup -->

本工作树已生成合成素材 `.artifacts/editor-manual-review/fixtures/`。主工程包含 32 条主字幕、4 条英文副字幕、2 条叠加字幕和 2 个标记或区段。第二工程只有一条以「第二个工程」开头的字幕。两份工程共用一段 72 秒的彩色视频，含合成音轨。

在仓库根执行下列 PowerShell 命令。在服务器终端看到本机地址后，用独立浏览器窗口打开它。默认地址是 `http://127.0.0.1:18765/`。保留运行目录以便回查导出和保存结果。以下路径使用当前源码构建的生产 Editor。若有包含本轮改动的冻结包，可另用该包核验启动项并单独记录版本。

```powershell
pnpm run build:editor
if ($LASTEXITCODE -ne 0) { throw 'Editor 构建失败' }
pnpm run check:editor
if ($LASTEXITCODE -ne 0) { throw 'Editor 产物校验失败' }
$reviewRun = New-Item -ItemType Directory -Path (Join-Path '.artifacts/editor-manual-review' ('run-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff')))
Copy-Item '.artifacts/editor-manual-review/fixtures/*' -Destination $reviewRun.FullName
Copy-Item (Join-Path $reviewRun.FullName 'editor-master.mosp') (Join-Path $reviewRun.FullName 'acceptance.mosp')
$env:MAW_APP_DATA_ROOT = Join-Path $reviewRun.FullName 'settings'
$env:MAW_ENV_FILE = Join-Path $reviewRun.FullName 'empty-config.txt'
New-Item -ItemType File -Path $env:MAW_ENV_FILE | Out-Null
uv run --no-sync python server-editor/serve.py (Join-Path $reviewRun.FullName 'acceptance.mosp') --media (Join-Path $reviewRun.FullName 'acceptance.mp4') --port 18765 --no-open --no-waveform
```

以运行目录里的 `acceptance.mosp` 做所有编辑。需要恢复夹具时，先关闭当前页，在运行目录从 `editor-master.mosp` 另复制一个新文件，再在编辑器打开。导出也写到该运行目录。系统文件选择器取决于浏览器，选不到关联媒体时手动选同目录的 `acceptance.mp4`。

## 启动与字幕编辑
<!-- id: editor-cue-manual -->
<!-- badge: todo 待实测 -->

- [ ] **首次引导、生产启动和命令搜索都可用**
  （操作）用无本站历史的新浏览器配置打开本机 Editor。选中一条字幕，根据「快速上手」提示用 WASD 移动 3 次，确认能进入下一步。完成或跳过后刷新。按 Ctrl+K 打开「搜索命令」，输入「快捷操作」，用 Enter 打开候选，再按 Esc 回到字幕列表。
  （预期）新配置出现引导，提示随操作进展更新；完成或跳过后刷新时不再弹出。首屏可见主轨甲乙和视频，命令能定位到对应帮助，关闭后仍能选择字幕和播放。
  <!-- id: editor-cold-start -->

- [ ] **相邻合并只作用于选中的轨道**
  （操作）点「主轨甲」所在主轨行，退出输入框并确保焦点在字幕列表。按 Ctrl+Shift+D，观察主轨头两条，再按 Ctrl+Z。对 `Secondary cue 2` 按 Ctrl+Shift+A 后撤销。选第一条「叠加轨核验文字」，按 Ctrl+Shift+D 后撤销。最后在主轨首条按 Ctrl+Shift+A 试边界。
  （预期）每次只合并目标轨道的相邻两条，合并后的文本和时间范围涵盖原两条，其余轨道保持原样。撤销恢复两条。主轨首条向前合并会显示没有可粘合字幕的提示，内容保持原样。
  （说明）Mac 使用 Cmd 代替 Ctrl。若浏览器拦截快捷键，记录浏览器动作并保留该项待确认。
  <!-- id: adjacent-merge-tracks -->

- [ ] **面板切换、行内编辑和拆分更新同一条字幕**
  （操作）在「主轨丙」上双击进入行内编辑，添加短字，点另一条提交。再回到该行，在右键菜单选「拆分」，或将指针放到目标切点按 B；若弹出拆分窗，选择一个非首尾切点并确认。用顶部「撤销」两次。
  （预期）添加的文字出现在该主轨行与字幕面板。拆分结果出现在原位置且左右文字完整，其余轨道没有被误编辑。两次撤销依次恢复拆分前和编辑前的状态。
  <!-- id: inline-panel-split -->

- [ ] **输入空格和退出编辑时焦点正确**
  （操作）暂停视频。依次在字幕面板和行内编辑区输入一组带空格的文字，观察播放是否启动。按 Esc 退出编辑，再在字幕列表按一次 Space 启动或暂停播放。
  （预期）输入时空格进入当前文本，视频保持暂停。退出后焦点回到字幕操作范围，在列表里按 Space 可以控制播放。
  <!-- id: editor-keyboard-focus -->

- [ ] **靠近列表末尾编辑时视口保持锚定**
  （操作）暂停视频，在字幕列表滚到第 27 条附近，让它位于视口中部。点第 27 条，再按住 Shift 点第 28 条，按 C 批量合并。连续观察 3 秒，按 Ctrl+Z，再观察 3 秒。
  （预期）合并和撤销都发生在所选两行。第 27 条保留在相近的视口位置，列表不会延迟跳到开头、播放头或其他行。
  <!-- id: near-tail-scroll-anchor -->

- [ ] **纯文本编辑保留搜索焦点并正确应用变更**
  （操作）用「搜索命令」打开「纯文本编辑」。查找「主轨丙」，替换为「主轨丙已验」并应用到当前轨，关闭后回到列表，按 Ctrl+Z。
  （预期）查找能定位到第 3 条，替换预览与列表应用后的文字一致。关闭浮窗后，撤销恢复原文并且只有对应字幕受影响。
  <!-- id: timed-text-search-replace -->

## 标记、工程与预览
<!-- id: editor-state-manual -->
<!-- badge: todo 待实测 -->

- [ ] **标记与区段面板、波形和撤销保持同步**
  （操作）打开「标记与区段」，确认有「已有标记」和「已有区段」。把播放头移到约 5 秒，在面板点击「在播放头添加标记」。记下条目数量和波形位置，按顶部「撤销」再按「重做」，最后用面板搜索「已有区段」。
  （预期）新增标记在面板和波形各出现一次，撤销两处都消失，重做恢复。搜索只过滤面板中的条目，波形上的其他标记仍存在。
  <!-- id: marker-panel-history-sync -->

- [ ] **字幕轨道选项、保存和重新打开正确对应工程**
  （操作）打开「工程设置 → 字幕轨道」，关闭叠加轨的预览和导出，使用撤销或重新勾选恢复预览，保留导出关闭。保存 `acceptance.mosp`，打开 `second-master.mosp`，再打开 `acceptance.mosp`。
  （预期）关闭预览会隐藏叠加字幕，主轨仍可见。第二工程只显示「第二个工程」；重开第一个工程后主、副、叠加轨恢复对应内容，叠加轨的导出开关仍是保存时的关闭状态。
  （说明）切换时如出现媒体选择器，从运行目录选择 `acceptance.mp4`，如出现未保存提示先按实际状态完成保存。
  <!-- id: track-controls-project-reopen -->

- [ ] **原生另存与 SRT 导出均可取消和重试**
  （操作）在第一工程用「保存工程 ▾ → 另存为…」，先取消，再另存为 `manual-copy.mosp` 并重开确认。执行「导出字幕 → SRT」，有保存框时先取消，再重复导出并保存为 `manual-acceptance.srt`。用文本编辑器打开 SRT。
  （预期）取消另存保留原文件，取消字幕导出不生成目标文件。确认另存后副本可打开，第二次 SRT 导出有序号、时间区间及当前主轨文字。副轨内容可由「副字幕 SRT」单独导出。
  （说明）如果浏览器直接下载，验收成功导出并记录「该环境不展示可取消的保存对话」。
  <!-- id: native-srt-cancel-retry -->

- [ ] **ASS 实际画面能在暂停后更新**
  （操作）在第一工程进入「工程设置 → 字幕样式」，开启「ASS 字幕模式」并打开「实际画面预览」。暂停媒体，先定位在约 1.5 秒，再定位到约 3.5 秒。逐次等待实际帧刷新；如关闭了自动渲染，用「渲染当前帧」刷新。
  （预期）预览显示目标时间的视频帧，字幕从「主轨甲」切到「主轨乙」。继续播放再暂停后，可以刷新到新的暂停位置。
  （说明）环境明确缺少 FFmpeg 或 libass 时，记录界面提示并保留该项待确认。
  <!-- id: ass-frame-pause-seek -->

## 回传结果
<!-- id: editor-results -->

- 用 HTML 勾选通过的项目，导出范围选「全部核对项」后导出 Markdown。对未通过或被环境阻塞的项目，备注浏览器、项目副本名、最短复现步骤、实际结果和可见报错。截图仅放本地运行目录。
- 完成后回传结果文件与必要截图。用服务器终端的 Ctrl+C 停止本次本机服务。
