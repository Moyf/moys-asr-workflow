# 提交前自审记录：main e2e 回归修复分支

任务：`fix/main-e2e-regressions`（基线 main `e6a2fa4b`，首个提交 `8a0e337a`）在提交 PR
前，按 AGENTS「提交前自审」约定执行了一轮 Greptile 式独立审查（2026-10-22）。两个审查
者并行：审查者 A 负责产品代码（`maw/ass_fonts.py`、`maw/lottie_glyphs.py`、
`editor-wiring-ass-frame.js`、CHANGELOG），审查者 B 负责测试与仓库约定；各自通读全量
diff，每条 finding 要求给出文件:行与实际执行过的验证证据。

## Findings 与处置

| # | 来源 | 严重度 | 位置 | 问题 | 处置 |
|---|---|---|---|---|---|
| A1 | 产品 | major | `web/editor/styles/editor-wiring-ass-frame.js` | `greenScreenPreview` 修复未触达目标场景：`player` 在模块求值时一次性快照，媒体加载 `replaceChild` 换新元素后判定仍读旧元素，真实用户流里 blob 媒体的行为与修复前相同；CHANGELOG「整体隐藏」宣称与实测不符（审查者用真实浏览器实验证实：`MaweCoreState.player` 已是 blob VIDEO，ass-frame 仍发出 `greenScreen:true`） | 已修复：`player` 改可变引用；事件监听与 rVFC 帧时钟经 `MaweMediaPlayback.bindPlayerEvents` 换绑（与 `MaweAudioProcessing.bindPlayer` 同款通知模式）；并补 A4 的 e2e |
| A2 | 产品 | minor | `maw/lottie_glyphs.py` | TTC 共享流「close 非选中 face」的安全性是隐式的（依赖 `getGlyphSet` 先于 close 物化字形数据）；AssetsV2 扩大候选集后（Kaiti.ttc、PingFang.ttc 成为常规候选）该路径暴露面变大且无警示 | 已加注释说明顺序约束，不改结构 |
| A3 | 测试 | minor | `tests/test_ass_fonts.py` | `FontRootsTests` 依赖真机 AssetsV2 目录，仓库 CI 只有 Windows Python runner，新增 darwin 逻辑在自动化层零覆盖 | 已补合成用例：patch `MACOS_ASSETS_V2_ROOT` 到临时目录，验证 `com_apple_MobileAsset_Font*` 前缀枚举与 `is_dir` 过滤，任何平台可跑 |
| A4 | 测试 | minor | `tests/e2e/` | 「blob 媒体 + ass-frame」组合无任何自动化覆盖，A1 正是因此漏网 | 已补 e2e：经 `#load-media-file` 加载本地媒体（真实 replaceChild 流），断言 stage 隐藏、状态隐藏且无 `greenScreen:true` 请求；该用例在 `8a0e337a` 上真实失败（见双向验证） |
| A5 | 产品 | nit | `CHANGELOG.md` | 「只扫描第一个字重」措辞不准：实际是「只保留第一个 face（子字体）」，PingFang.ttc 首个 face 是 `PingFang HK`，丢的是其余区域×字重 face | 已改措辞 |
| A6 | 产品 | nit | `maw/ass_fonts.py` | `MACOS_ASSETS_V2_ROOT` 单侧提升为常量，`lottie_glyphs._font_roots` 的内联副本无同步提示 | 常量注释补「需同步」说明 |
| A7 | 产品 | nit | `editor-wiring-ass-frame.js` | `serverMediaSource` 对 null player 无自保护，安全性仅由两个调用点的短路求值隐式保证 | 已加 `player?.` |
| A8 | 测试 | nit | `tests/test_burn_video_export.py` | 样式库 mock 缺 `assignments` 键，实际走「default 回退」而非注释描述的 `srtBurnStyleId` 路径 | mock 补 `assignments`，测试与注释一致 |
| B1 | 测试 | minor | `tests/test_ass_fonts.py` | 同 A3（该用例仅 macOS 本机真实执行，CI 恒 skip） | 测试注释明示 CI 边界；覆盖由 A3 合成用例补齐 |
| B2 | 文档 | nit | `CHANGELOG.md` | 「macOS 系统字体识别」条目内的 TTC 修复是全平台缺陷（Windows `simsun.ttc` 同理），标题限定 macOS 易让其他平台用户误判无关 | 已改「（各平台通用）」并列举例 |
| B3 | 测试 | nit | `tests/test_ass_fonts.py` | TTC 假体抛 `RuntimeError`，真实 fontTools 关闭后读取抛 `ValueError: seek of closed file`；两者都被 `except Exception` 捕获后丢 face，守门行为等价 | 记录在案，不改；后续维护假体时可对齐异常消息 |

## 双向验证（测试真能守住修复）

- `ReadFontFileNamesTests`（TTC 共享流假体）：还原「逐 face close」旧逻辑后 FAILED（第二个 face 读取失败），恢复后通过；两个审查者独立验证。
- `FontRootsTests`：移除 AssetsV2 扫描后 FAILED，恢复后通过（审查者 A）。
- 新 e2e「browser-local media loaded through the editor…」：在 `8a0e337a`（仅有判定收窄、无换绑修复）上 FAILED——`#ass-stage-frame` 暂停叠加仍可见，正是 A1 的缺陷本体；恢复 bindPlayer 修复后同 spec 18/18 通过。
- 绿幕契约 `:309` 用例：临时还原旧 `greenScreenPreview` 表达式并重建 bundle 后 FAILED，新逻辑通过（审查者 B）。
- burn 测试样式库 mock：本机存在用户级 `ass-styles.json` 时移除 mock 立即失败，证明 mock 承重且不掩盖被测的归一化逻辑（审查者 B）。

## 记录在案、待后续处理

- `lottie_glyphs` 的 TTC close 模式目前仅以注释守护「先物化后关闭」的顺序约束；若未来把字形读取改为懒访问，需先重新设计关闭时机。
- 浏览器本地 blob **音频**（AUDIO 元素）仍会走绿幕分支——与 main 行为一致、非本分支回归，但与模块内「blob 不能退回绿幕」的注释表述存在张力；是否收窄留给维护者决策。
- TTC 假体异常类型与真实 fontTools 不一致（见 B3）。

## 验证

| 层 | 命令 | 结果 |
| --- | --- | --- |
| Python 单测 | `uv run --no-sync python scripts/run_tests.py tests/test_ass_fonts.py tests/test_burn_video_export.py` | 78 通过 |
| 语法/装配 | `node --test tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs` | 通过 |
| 构建与类型 | `pnpm run check:editor`、`pnpm run typecheck` | 通过（bundle 新鲜） |
| 浏览器 e2e | `run_check.py -- npx playwright test … ass-frame-preview.spec.mjs`（chromium 单 spec） | 18/18 通过（双向验证另见上节） |
| 冒烟（媒体替换路径） | 同上，`editor-menu-focus.spec.mjs` | 14/14 通过 |
| 文档 | `python scripts/check_docs.py` | 0 新断链、0 结构错误 |
| 卫生 | `ruff check`（改动 py）、`git diff --check`、`check_personal_paths.py --diff-ref main` | 全部通过 |

全量 e2e（904 通过 / 82 失败）与干净基线对照的结论记录在 `8a0e337a` 提交说明：82 项失败
均为本机 macOS 既有的基线问题（canvas 像素对比、headless 剪贴板/焦点类 spec），非本分支
引入；本轮自审改动收敛在 ass-frame 装配与测试，受影响 spec 已全部复跑。

## 2026-10-23 主线集成复核

合入 main `1cd1c9ec`；唯一文本冲突是日志索引，双方有效条目均保留。复核 Greptile 的人工清单意见后，补充同目录 [字体与本地媒体核验清单](字体与本地媒体.checklist.md)，状态保持 pending。

独立审查指出新增发布说明将本地视频修复扩大表述为所有本地媒体；据实际 AUDIO 调用路径将 CHANGELOG 收窄为「浏览器本地视频」，不改已记录的 blob 音频行为。

本轮环境为 Windows、Python 3.11.15、Node 22.23.4，复用锁文件一致的已安装依赖且未同步共享环境。构建、新鲜度、TypeScript、Ruff、文档导航、个人路径检查通过；Node 420 项通过；Python 78 项中 77 通过、1 项真实 AssetsV2 目录检查因平台条件跳过；同次 Chromium 三个受影响 spec 共 58 项全部通过。清单校验并生成 HTML，人工系统字体、TTC 与原生交互验收仍待维护者确认。远端 CI 以最终集成 head 的检查为准。
