---
task: gap-playback-audio
pr: 327
date: 2026-11-03
status: pending
---

# Gap 播放漏音修复核验

> 正常跳过、区段原声试听与播放控制；自动化采样通过，原片人工听审待确认。

## 实现与审查结论
<!-- id: implementation -->

播放在音频时钟上安排 Gap 门控，边界定时器在实际进入区间后跳转。独立审查结论与处置见同目录 REVIEW_FINDINGS.md。

## 修复与提交记录
<!-- id: delivery -->

播放修复独立提交 PR；标记恢复入口由后续独立 PR 处理。便携 HTML 内联副本待发布前统一重生成。

## 自动化验证结果
<!-- id: automated -->

领域单测与脚本语法 / 顺序、编辑器工具、波形回归合计 452/452；TypeScript 通过；浏览器三种真实解码与音频采样场景各重复两次，6/6。旧代码在同一声音输出断言上失败。初次跨语言检查遇到 uv 缓存权限失败，指定已有 Python 后整组通过。原片实听不包含在自动化结果内；直接引用相对地址或 file 地址的便携页面未接入门控。

PR 327 审查回修复验通过：目标 Node 套件 488/488、Python 资产契约 25/25、Chromium 音频 6/6。新增手动定位、连续定位与末尾停止回归。

```text
node --test tests/test_gap_playback.mjs tests/test_audio_processing.mjs tests/test_editor_audition.mjs
node node_modules/@playwright/test/cli.js test --config tests/config/playwright.config.mjs tests/e2e/gap-playback-audio.spec.mjs --workers=1
```

## 人工核验
<!-- id: manual -->

- [ ] **已移除的口播没有漏出音头**
  （操作）打开反馈对应的工程与媒体，开启播放跳过空隙，从该 Gap 前约半秒开始正常播放。
  （预期）被移除内容不发声，跳转后的保留内容正常播放。
  <!-- id: no-syllable-leak -->

- [ ] **从 Gap 内起播与连续 Gap 不会卡住**
  （操作）暂停后把播放头放进已移除区段，开始播放；再播放一组相邻移除区段。
  （预期）直接跳至保留内容，持续播放；不会反复 seek、持续静音或僵持。
  <!-- id: start-and-adjacent -->

- [ ] **原声试听和人工控制正常恢复**
  （操作）对已移除区段执行标记「定位试听」，随后暂停并恢复正常播放；再切换跳过开关和播放速度。
  （预期）定位试听能听到原声；正常播放恢复跳过；暂停与切换设置不会留下静音。
  <!-- id: audition-controls -->

- [ ] **跳过 Gap 期间手动定位保留播放状态**
  （操作）正常播放跨过 Gap 时，用播放条或步进按钮快速定位到保留区间；再试一次并立即按暂停。
  （预期）第一次从最后落点继续播放；第二次停在最后落点，等待下一次播放操作。
  <!-- id: seek-during-gap -->

- [ ] **监听音量和工程增益不被改写**
  （操作）设定监听音量、工程增益与静音状态，播放经过 Gap，再检查这些值。
  （预期）设定值保持原样，Gap 外声音按原设置输出。
  <!-- id: gain-preserved -->

## 后续操作
<!-- id: next -->

核验后更新本清单勾选状态；原片声音若仍有残留，记录 Gap 边界、媒体格式、播放速度和触发入口，按播放层继续排查。
