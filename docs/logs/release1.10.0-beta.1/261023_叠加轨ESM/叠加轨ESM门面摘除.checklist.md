---
task: overlay-esm-facade-removal
pr: 300
date: 2026-10-23
status: passed
---

# 叠加轨 ESM 门面摘除核验

> 分支 esm/g07-ui-pilot，提交 e9046b5e。window.MaweOverlayTransfer / MaweOverlayActions 函数转发门面删除，叠加轨领域收敛进纯模块 overlay-track.js，24 个 classic 调用者转 init。自动化层已全绿（含 3 个 main 基线复现的 ffmpeg 环境性失败）；下列人工项待实机确认。

## 实现与审查结论
<!-- id: conclusions -->

领域函数（getOverlayTrack / convertMainCuesToOverlay / addOverlayAtWaveformTime 及迁移、颜色组、合并、波形新增全族）集中到 `web/editor/cues/overlay-track.js` 纯 ESM 模块：模块求值零副作用，共享状态经 window 门面在调用时解析，可变轨选择状态（stickerTargetTrack / previewTrack）经 overlaySticker 访问器读写。

消费分两路：init 模块静态 import（含 editor-display-settings、editor-context-menus 两个 G07 文件改真 import）；仍是 classic 的邻接文件经新增/扩充的领域 window 门面过渡（MaweCuePanelWiring、MaweExportContext、MaweOverlaySplitMerge、MaweAssStorageWiring、MaweKeyboardGuards、MaweStickerPreviewWiring 等）。e2e 数据层直调改走 `window.MAWE.resolve('overlay-track')`，注册在 editor-wiring-overlay-transfer.js 的启动位，`normalizeMultiSubtitleState()` 保持原启动位置。

| 迁移面 | 结果 |
| --- | --- |
| 生产者 | overlay-transfer 变薄 init（归一化 + MAWE 注册）；overlay-actions 只留表情包 modal 绑定 |
| 调用者 | 24 个文件 init 化（20 机械 + split-merge/ass-preview 手术）；classic 侧 8 个文件改门面调用 |
| 桥接 | externalBridges 删 convertOverlayCueToMain、openOverlaySplitModal 两条；editor.js 拆分漂移常量迁入 split-merge |
| 契约 | editor-modules.json 条目按清单序重排满足 trace 序断言；editor-globals.d.ts 补 overlay_track 形状与新门面占位 |

## 修复与提交记录
<!-- id: changes -->

提交 e9046b5e（59 文件，+1303/−938），单原子提交：生产者、消费者、bridges、测试适配互相锁死，拆开任何一片中间提交构建或测试即挂。提交前个人路径检查零命中，git diff --check 干净，无署名尾注。

过程中抓到并修复的三类真实错误：codemod 裸名替换误伤对象属性 key（`toggleOverlaySelection:` 被加前缀导致语法错）；settings-init 的链式替换产出双前缀（`MaweAssStorageWiring.window.MaweAssManagerWiring`，e2e Page error 暴露后以 minify:false 对照 bundle 定位）；modules.json 追加乱序违反 trace 序契约。另测试侧：新增 tests/helpers/init-module-source.mjs（init/纯模块源码还原为 vm 可跑的 classic 文本，纯测试脚手架），11 个 node 测试与 2 个 e2e spec 适配。

## 自动化验证结果
<!-- id: automation -->

- 构建：`node scripts/build-editor.mjs --write`（60 工厂 / 150 源）、`pnpm run check:editor` 新鲜、`pnpm run typecheck` 通过。
- Node 契约：语法 / 顺序 / utils / waveform 420 项全过。
- Python 全量：2729 项，3 失败（burn_video ×2、thumbnails ×1）在干净 HEAD worktree 逐字节数值复现，属 ffmpeg 编码精度抖动的环境性失败；迁移相关全绿。
- e2e（新 bundle）：overlay-track 26/26、split-style-markers 16/16。
- 浏览器实测（serve.py 空白页 + 新 bundle）：启动零 page error、旧门面不存在于 window、MAWE 注册在位；工程加载渲染、右键转叠加（真实菜单点击）、撤销/重做往返、叠加轨开关双向、波形新增（生产入口驱动）全链通过。波形右键菜单整链因实测会话无媒体文件（波形画布不存在）由下方人工项覆盖。

## 人工实机核验
<!-- id: manual -->

- [x] **含叠加轨的工程打开与渲染**
  （操作）`uv run python server-editor\serve.py --blank` 启动，打开一个含 overlay_track 的 .mosp 工程；观察字幕列表、叠加轨行与波形叠加块。
  （预期）主轨与叠加轨各自渲染完整，无控制台报错；叠加轨开关勾选状态与工程数据一致。
  <!-- id: open-project -->

- [x] **叠加轨设置切换**
  （操作）点波形工具栏「重叠」快捷开关关闭再开启；再到设置浮窗切换叠加轨开关；空轨道时勾选。
  （预期）enabled 双向翻转且勾选状态即时同步；空轨勾选不弹回；开启后波形空白右键出现「创建叠加字幕」项。
  <!-- id: overlay-toggle -->

- [x] **波形空白右键创建叠加字幕**
  （操作）右键波形空白处（主轨占用的时间点也试一次），选「创建叠加字幕」；对新字幕直接输入文本。
  （预期）新段落在叠加轨相邻段之间正确夹逼，创建后文本框自动聚焦可直接输入；与已有叠加段重叠时给出行内提示而非静默失败。
  <!-- id: waveform-create -->

- [x] **主字幕右键转叠加字幕（含多选批量）**
  （操作）单选一条主字幕右键 → 高级操作 → 转为叠加字幕；再框选多条批量转。
  （预期）颜色/表情包标记跟随迁移，列表与波形即时刷新，提示条显示迁移数量；多选时按选集整体迁移。
  <!-- id: convert-to-overlay -->

- [x] **叠加字幕转回主字幕与占用置灰**
  （操作）右键叠加字幕块选「转为主字幕」；再对一条与主轨时间重叠的叠加字幕开右键。
  （预期）转回后主轨组引用（颜色/表情）不悬空，保存重开无校验错误；主轨同时间段被占用时「转为主字幕」置灰不可点。
  <!-- id: convert-back -->

- [x] **撤销与重做两条路径**
  （操作）对「转为叠加字幕」和「创建叠加字幕」分别 Ctrl+Z / Ctrl+Y；注意创建后文本框聚焦时先点空白处失焦再按 Ctrl+Z。
  （预期）两条路径的状态精确往返；文本框聚焦时 Ctrl+Z 走文本级撤销（设计内守卫），失焦后恢复全局撤销。
  <!-- id: undo-redo -->

- [x] **叠加轨合并与颜色/表情分配**
  （操作）选中两条连续叠加字幕按 C 合并；对叠加字幕标记颜色、分配表情包、再清除；拆分一条带颜色的叠加字幕。
  （预期）合并继承左句组标记、混合组不继承；分配/清除即时刷新；拆分后颜色组按「单段自持 head」落在新段上，无跨轨引用。
  <!-- id: merge-color-sticker -->

## 后续操作步骤
<!-- id: next -->

1. 人工项全部打勾后把 front-matter status 改为 passed，`build.py --scan docs/logs` 汇总。
2. 推送 esm/g07-ui-pilot 并开 PR 时，描述注明「内联副本待发布前统一重生成」；发布检查时再运行 `uv run python edit.py --blank` 一次性重生成。
3. 后续批次可复用本次模式：领域函数进纯模块 + 静态 import、邻接 classic 经领域门面过渡、e2e 直调走 MAWE.resolve。
