# 波形字幕/字词快速编辑气泡 — 独立审查与 Greptile 评审记录

PR #352（`feat/cue-bubble-quick-edit`，1c968564 + 1b274ce3 + 5719e7f6）。
审查来源：Greptile（自动评审 3×P1）+ 内部独立 subagent 复核（1 major / 4 nit / info）。
验证基线：单测 15、Node 编辑器套件、e2e 9 条（chromium）、typecheck、check:editor 全绿。

## Greptile P1（均属实，1b274ce3 修复）

1. **Ctrl/Cmd+S 保存遗漏气泡文字**：保存与导出的 `flushInlineEditsForSave()`
   现在先调用 `waveformEditor.commitCueQuickEdit()`（幂等，气泡保持打开）。
   e2e 回归断言磁盘工程文件包含气泡内新文本。
2. **输入法组词误关气泡**：气泡 keydown 跳过 `isComposing / keyCode 229`。
3. **滚动后气泡被裁**：定位布局改为按滚动容器可视视口（内容坐标系
   scrollTop/尺寸）翻转与钳制；单测重写并新增滚动裁剪 e2e。

## 内部复核 findings

- **major「字词码下双击未选中整句块误触播放」— 实证为误报**：
  探针（字词码开启、全新加载、未选中状态下双击整句块）结果
  `popup:true / togglePlayback 未触发 / playing:false`。字幕块拖拽的
  pointer capture 使重建后 click 目标仍落在块上，与字词条带（capture
  在 pane 上、目标退到 pane）机制不同，无需推广 pointerdown 序列识别。
- **nit 另存为下载回退缺 flush**：已修（5719e7f6），`saveProjectAsToFile`
  的下载回退路径同样先提交气泡。
- **nit 视口换算忽略 content 内部偏移**：已修（5719e7f6），用
  `contentRect - scrollRect` 实时差值求可视带在内容坐标系的原点，
  短视口下底部/右缘不再被裁。
- **nit document 级 Esc 缺 isComposing 守卫**：已修（5719e7f6）。
- **nit 偏移映射注释措辞**：已修（5719e7f6），「run 之后」→「run 之前」。
- **info 字词双击窗口 400ms 窄于系统阈值**：已放宽至 500ms（5719e7f6）。
- **info 光标 Range 扫描 O(n)**：仅打开气泡时执行一次，接受现状。
- **info 字词映射失败时输入随关闭丢弃**：有 invalid 提示引导改从字幕
  列表编辑，接受现状。

## 遗留与未验证

- e2e 的 Ctrl+S 落盘断言依赖本地 Server 写回（已覆盖）；浏览器句柄
  保存路径无自动化，属既有覆盖缺口。
- Greptile 复审基于新提交进行中，结论见 PR #352 评论区。
