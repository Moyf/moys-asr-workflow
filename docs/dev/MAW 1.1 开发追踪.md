---
title: MAW 1.1 开发追踪
created_at: 2026-07-27
updated_at: 2026-07-27
status: planning
---

# MAW 1.1 开发追踪

本文件记录维护者与开发代理已经确认、可以进入开发的 MAW 1.1 项目，以及后续实施和验收状态。

状态约定：`已确认` → `开发中` → `待验收` → `已完成`；未达到客观技术门槛的探索项标记为 `未通过门槛`，不伪装成已实现。

## 当前阶段

- 版本目标：`1.1.0`
- 当前状态：编辑器删除回归批次（Batch 1）开发完成，待验收
- 产品代码开发：已开始（波形删除身份修复 + Del 键最小命令面 + 波形 Ctrl/Shift 多选最小命令面 + 浏览器回归测试）
- 正式执行计划：`.omo/plans/maw-1-1-development.md`
- 候选特性来源：`docs/dev/feat：MAW 1.1 待开发特性.md`
- 开发优先级：先完成编辑器体验关键路径，再开始供应商、GUI 与打包工作。
- 证据路径：`.omo/evidence/maw-1-1-batch-1/`（调试日志、测试输出、幂等证明）

Batch 1 已验证场景（localhost 与便携 HTML 均通过真实波形交互）：
- 删除中间段（Delta, idx 3）—— 虚拟滚动卸载/重载后选择并删除，验证剩余身份
- 删除首段（Alpha, idx 0）
- 删除末段（Foxtrot, idx 5）—— 虚拟滚动卸载/重载后选择并删除
- 多选删除（Alpha + Charlie, idx 0+2）—— 波形 Ctrl+click 多选后 Del
- 全删拒绝 —— 波形 Shift+click 全选后 Del，验证无突变

### 第一开发里程碑：编辑体验

1. 建立真实浏览器交互测试，并先复现“波形删除会删到后一条”。
2. 修复删除身份错位，加入 Del、焦点保护、点击行为配置与列表禁用拖动选字。
3. 完成统一撤销/重做、波形多选、即时文本刷新和多行虚拟滚动验证。
4. 完成选择/剃刀工具、右键创建和 Alt 临时拆开共享边界。
5. 完成常驻播放栏、字幕/表情包预览和编辑器侧导出体验。

工程契约会作为 Wave 1 的必要基础与浏览器回归测试并行完成；除此之外，该里程碑全部通过 localhost 与便携 HTML 的真实浏览器 QA 后，才进入 Qwen/Soniox 重构、GUI 和原生打包。

## 已确认开发项目

| 优先级 | 项目 | 已确认范围 | 状态 | 验收重点 |
| --- | --- | --- | --- | --- |
| 高 | 统一工程契约 | 严格校验整数毫秒、时序、items、head/ref，并让 CLI、供应商、GUI 共用生成核心 | 已确认 | Qwen 输出不回归；非法工程有明确错误 |
| 高 | Soniox 接入 | 异步文件转写、token 时间戳、可选说话人；不含实时 WebSocket 与未定义翻译流程 | 开发中 | 模拟完整生命周期；有凭据时做真实 smoke test |
| 低 | 本地 Qwen 示例 | 独立示例和独立依赖说明；不进入基础安装和 GUI | 已确认 | 基础 `uv sync` 不安装 GPU/模型依赖 |
| 高 | GUI 工程生成器 | `tkinter + ttk` 薄控制器，复用统一生成核心；长任务不阻塞界面；不保存或显示完整 Key | 已确认 | 缺媒体、Key、FFmpeg、写入失败和取消均可恢复 |
| 低 | Win + Mac 打包管线 | GitHub Actions 原生矩阵分别构建 Windows x64、macOS Intel、macOS Apple Silicon；CI 只上传工件 | 已确认 | PyInstaller 不跨平台编译；三个工件在对应系统启动 |
| 高 | 多行波形与性能 | 新用户默认多行；保留已有设置；继续使用可见区加 overscan 的动态渲染 | 已确认 | 三小时合成工程滚动时 DOM 数量有界 |
| 高 | 编辑命令与历史 | 列表禁用拖动选字；统一点击行为；Del；完整撤销/重做；焦点和弹窗保护 | 已确认 | 输入框原生编辑不被快捷键破坏；新操作清空 redo |
| 高 | 波形工具 | 波形多选、精确删除、右键创建、默认选择工具、剃刀工具、Alt 临时拆开共享边界 | 待验收 | 先复现“删到后一条”再修复；边界仍满足 100ms 与不重叠。Batch 1 已完成：删除身份错位根因（`clearSelection`→`commitCuePanelEdit` 在 splice 后写回旧面板文本）、最小修复（splice 前提交面板编辑并重置 `currentCuePanelIdx`）、Del 键 + 波形 Ctrl/Shift 多选最小命令面、5 项 Playwright 回归场景（首/中/尾删除后虚拟滚动验证 + 多选删除 + 全删拒绝）在 localhost 与便携 HTML 双模式各通过 3 次重复。证据：`.omo/evidence/maw-1-1-batch-1/` |
| 高 | 播放与预览工作区 | 常驻播放工具栏；字幕与当前表情包可拖动/缩放并持久化 | 已确认 | localhost 与便携 HTML 保存重开后位置一致 |
| 高 | 颜色导出 | 统一 blue 为 `#168cff`；全量及按颜色/未着色导出 SRT、ASS | 已确认 | ASS 实际渲染颜色正确；head/ref 分组一致 |
| 中 | FCPXML | 单媒体 Final Cut FCPXML 1.9 子集；这是独立的 Final Cut 交付项，不生成 PRPROJ，也不宣传 Premiere 兼容 | 已确认 | XML 结构测试加 Final Cut 实机导入 |
| 低 | Premiere 项目交接 | 新增、独立于上述 FCPXML 1.9 项的 FCP 7 XML（XMEML v5）Premiere handoff；`.prproj` 能力门已明确拒绝生成 | 已确认 | FCP 7 XML 与 SRT 的 Premiere 实机导入；`.prproj` 仅返回不支持，不生成字节、不宣称兼容；证据：`docs/dev/PRPROJ_CAPABILITY.md` |
| 低 | 频谱探索 | 只做有明确性能、缓存和内存门槛的技术验证 | 已确认（门槛制） | 不通过门槛时只保留结果文档，不加入正式 UI |

## 跨平台 GUI 打包决策

- GUI 源码保持 Windows/macOS 共用，不为平台复制业务逻辑。
- PyInstaller 不是跨平台编译器，因此不能在一个 Windows job 中同时产出 Mac 应用。
- 后续 GitHub Actions 使用固定原生 runner：
  - `windows-2022` → Windows x64；
  - `macos-15-intel` → macOS x86_64；
  - `macos-15` → macOS arm64。
- 1.1 先提供 Intel 与 Apple Silicon 两个独立 Mac 工件，不承诺 `universal2`。
- 普通 CI 构建为未签名开发工件；Apple Developer ID 签名和 notarization 留作受保护、人工触发的发布流程，不向 PR 暴露凭据。
- 工作流只上传唯一命名的 ZIP 工件，不创建 tag、不推送、不创建 GitHub Release。
- PR 会自动构建 Windows x64 无 FFmpeg 的 `MAW-lite` 预览 ZIP 工件并保留 14 天，构建完成后由独立 workflow 更新 PR 评论并提供 Actions 下载链接；正式 tag release 由发布工作流创建默认带 FFmpeg 的 `MAW` 版和无 FFmpeg 的 `MAW-lite` 版。
- FFmpeg/ffprobe 继续作为外部依赖；Mac GUI 允许选择绝对路径，以兼容 Finder 启动时不含 Homebrew 目录的 PATH。

## FFmpeg 分发决策

- 1.1 不捆绑 FFmpeg/ffprobe，也不在 GUI 内自动下载或执行系统安装命令。
- 当前 Windows 8.1.2 essentials 包约为 104 MB ZIP（7z 约 32 MB），还包含 MAW 不需要的 ffplay。捆绑会显著增加每个平台工件；常用 Windows 静态包为 GPLv3，还需额外固定来源、版本、构建配置、SHA-256、对应源码与安全更新策略。
- GUI 解析顺序：仅测试/开发使用的显式 bundled override → 用户保存的 `ffmpeg` 与 `ffprobe` 绝对路径 → 当前进程 PATH。
- `ffmpeg` 和 `ffprobe` 分别选择并分别运行 `-version` 校验，不能假定两者总在同一目录；机器路径只保存在用户 GUI 设置，不写入工程 JSON。
- 未找到时提供“选择 ffmpeg”“选择 ffprobe”“重新检测”和安装文档。Windows 可展示 `winget install "FFmpeg (Essentials Build)"`，macOS 可展示 `brew install ffmpeg`，但应用不静默执行。
- Finder 启动的 Mac app 常见 PATH 不含 `/opt/homebrew/bin` 与 `/usr/local/bin`，因此绝对路径选择属于正式支持面。

## 说话人字段决策

- `items[*].speaker`：可选非空字符串，保存供应商返回的 opaque speaker ID，不转换为整数或姓名。
- 遇到说话人变化时必须切分字幕，不能把两个 speaker 合入同一 segment。
- `segments[*].speaker`：可选非空字符串；只有该段所有带语音的 items 都是同一 speaker 时才写入。
- 缺少 speaker 的旧工程和供应商输出继续有效。
- 说话人不会自动分配颜色；颜色仍由用户控制，避免供应商 ID 变化破坏人工标注。
- 2026-07-28 修订：Soniox CLI 的 `--speaker-colors` 是用户显式开启的**生成期一次性快照**——把 speaker 按首次出现顺序写入普通 color head/ref 字段（5 色调色板循环），之后用户可自由修改；编辑器仍不做 speaker ↔ 颜色的动态绑定，原决策的精神不变。

## Final Cut 自动验收决策

- FCPXML 实机门运行在受保护的 self-hosted macOS QA runner，不假装 GitHub-hosted runner 自带 Final Cut。
- runner 必须预装并授权 Final Cut、保持已登录的图形会话、使用英文界面，并提前授予 `osascript` Accessibility 权限。
- 自动化脚本导入生成的 XML，任何修复/错误 dialog 都判失败，再从 Final Cut 导出 XML；验证器比较回导后的字幕文本和时间。
- runner 或 Final Cut 不可用时，1.1 发布验收状态为阻塞，不能用 XML 解析成功代替。

## 明确不开发或不承诺

- MIMO、豆包：尚无已确认的模型、鉴权和输出契约。
- Soniox 实时识别与同步翻译：不属于当前本地媒体工作流。
- 原生 `.prproj` 和 Premiere 兼容承诺；能力门只提供明确的不支持结果，不生成 `.prproj` 字节，也不扩大为 FCPXML 1.9 的 Premiere 兼容。
- GUI 内置本地模型、自动下载模型或基础安装中的 GPU 依赖。
- 随应用捆绑 FFmpeg、PyInstaller onefile 主发行版、管理员权限。
- 普通 CI 自动发布、自动签名或向不可信 PR 提供 Apple 凭据。

## 实施记录

| 日期 | 项目 | 状态变化 | 证据/备注 |
| --- | --- | --- | --- |
| 2026-07-27 | MAW 1.1 范围 | 候选 → 已确认 | 已完成源码、测试、供应商、导出和打包契约调研 |
| 2026-07-27 | Win + Mac GUI | 候选 → 已确认（低优先级） | 采用三个原生 GitHub Actions runner；签名与 notarization 延后 |
| 2026-07-27 | FFmpeg 分发 | 候选 → 已确认 | 1.1 采用 PATH 自动检测 + 独立绝对路径选择，不捆绑、不自动安装 |
| 2026-07-27 | 实施顺序 | 已确认 | 编辑器体验优先；删除 bug 的失败回归测试与修复作为首个用户可见交付 |
| 2026-07-27 | 正式计划 | 评审通过 | Metis 缺口分析完成；Momus 与独立 Oracle 最终均无条件 `OKAY` |
| 2026-07-27 | 波形工具（Batch 1） | 已确认 → 开发中 → 待验收 | 删除身份错位根因：`deleteSegments` 在 splice 后调用 `clearSelection()`→`setCurrentCuePanelIndex(-1)`→`commitCuePanelEdit()`，将旧面板文本写入 splice 后新占据该索引的段。最小修复：splice 前提交面板编辑并重置 `currentCuePanelIdx`。Del 键 + 波形 Ctrl/Shift 多选最小命令面。5 项 Playwright 回归场景（首/中/尾删除含虚拟滚动 + 多选删除 + 全删拒绝）在 localhost 与便携 HTML 双模式各通过 3 次重复。便携模式通过真实 file-input/modal 流加载 JSON+WAV 后波形交互可用。证据：`.omo/evidence/maw-1-1-batch-1/` |
| 2026-07-28 | Soniox 接入 | 已确认 → 开发中 | 外部调研确认数据契约（token 级 start_ms/end_ms + token 级 speaker + token 级 language， Files API 直传，5 小时上限，文件不自动删除需清理）。已实现 `maw/soniox.py`（REST 客户端 + tokens→工程映射 + speaker→5 色快照）与 `generate_subtitle_soniox_api.py` CLI（`--speaker`/`--speaker-colors`），24 项合成夹具 unittest 通过（映射/硬切段/颜色快照/validate_project/轮询防御）。待真实凭据 smoke test 验证中文 token 粒度与 speaker 字段实测形态。 |
| 2026-07-28 | GUI 供应商接入（Soniox） | — | pywebview 启动器支持 Soniox：provider 注册表扩展（`supports_speaker`、regions 可为空）、按供应商加载/保存 API Key、无地域供应商隐藏地域/工作空间、SRT 默认名按供应商区分、`--transcribe-soniox` 冻结分发。维护者确认交互：说话人颜色开关仅支持分离的供应商显示、位于「高级选项」、默认选中、提示最多 5 色。13 项新增 unittest 全绿。tkinter 旧版界面保持 Qwen 专用。 |

## 更新规则

- 开始实现一个项目时，把状态改为 `开发中`，并记录对应分支/计划任务。
- 自动化测试和真实界面 QA 均通过后改为 `待验收`。
- 维护者确认后改为 `已完成`，附上测试、浏览器操作、打包或目标应用导入证据。
- 任何范围变化先更新本文件和正式计划，不在实现中静默扩大 MAW 到 MOSE。
