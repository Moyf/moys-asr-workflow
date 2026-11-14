# ASS 实时预览字体回退修复

## 第一阶段历史范围与结果

分支 `fix/ass-preview-system-font-fallback`，基线 `ee2fe595`。
字体别名仍优先匹配；别名之后恢复 `--font-sans` 的原有系统字体顺序。
Canvas 使用展开后的具体字体族，DOM 字号探针使用同一回退链。
不新增全局字体设置，不改变 ASS 导出或 FFmpeg/libass 烧录。

## 独立审查

- P2，已修复：Canvas 无字体边界度量时的 DOM 探针仍使用 generic sans-serif，与绘制不一致。现向探针传相同 fallback，并新增真实别名模块 + DOM 探针测试。
- 复审：36 项 Canvas / layout / alias 测试通过，无未处理 blocker / major。
- 接受的验证边界：未做 Windows / macOS 实机字形对照；恢复的是候选字体顺序，不保证不同机器逐像素一致。实际字体取决于安装情况及字形覆盖。

## 验证

所有测试使用 `python scripts/run_check.py --timeout 180 -- <命令>` 执行。

- `node --test tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs tests/test_editor_utils.mjs tests/test_ass_canvas_raster.mjs tests/test_ass_canvas_layout.mjs tests/test_ass_font_aliases.mjs`：408/408 通过；跨语言测试通过 `MAW_TEST_PYTHON` 指向已安装 Python。
- `node scripts/build-editor.mjs --write`、`--check`：通过。
- `node node_modules/typescript/bin/tsc -p web/tsconfig.typecheck.json`：通过。
- 双向回归：仅恢复基线 Canvas / alias 源码，新测试 2 项按预期失败（别名后系统回退及缓存刷新），恢复修复后通过。DOM 探针新增回归另行验证。
- 初次跨语言测试因默认 uv 缓存目录不可写失败；指定已安装 Python 后整组通过，不是产品断言回归。
- Chromium 独立 Canvas 冒烟未执行成功：环境禁止浏览器进程创建 socket，放宽沙箱重试仍失败。没有把单测模拟 Canvas 作为真实浏览器通过。
- 内联副本待发布前统一重生成。

## 追加：共享显式字体回退（Draft 验收）

- 原 #377 仅恢复 UI CSS 字体链，无法约束 libass 的缺字选择；本次扩展由 MAW 将可覆盖的整字素簇解析成共同字体 runs，Canvas 使用 run 字体，ASS 使用局部 `\fn` 并恢复，不使用会重置其它效果的 `\r`。
- 本机覆盖清单逐 face 记录 family、别名、粗斜、cmap 和 em 比例；cmap 去重、4 MiB 限额、进程快照，不公开字体路径。cmap 是覆盖条件，不等于正确塑形。保留主字体完整覆盖的字形，不对特定眉毛强制替换字体。
- 新 fallback run 用其 face 的 `unitsPerEm / (usWinAscent + usWinDescent)` 归一化，避免继续套主字体的 em；已有主字体仍用既有预览度量，减少无关视觉变化。相同 family 不保证相同文件、合成粗斜与像素形状。
- 独立评审发现并修复：stack bold/italic 探测不得复用旧 face 比例；复杂脚本采用正向脚本范围而非不完整黑名单；位图缓存纳入 run 字体/比例；低版本 letterSpacing 路径与自动折行不拆字素簇。
- 有意保留 renderer-owned 边界：复杂脚本/方向控制、emoji、未读取的主字体、无候选覆盖；不声称通用统一。未来 #378 自定义策略可替换候选顺序，但不能把 CSS 字体链误当跨引擎保证。
- Canvas-only VS15 使用临时显示 runs，原文/共享plan/ASS输出不变；简单单码点 pictograph（可带 VS16）尽力文本显示，复杂 ZWJ/肤色/旗帜/键帽不拆。不是彩色 emoji 烧录实现。
- 验证：相关 JS 421 项、Python 41 项通过；去掉 resolveRuns 后 4 项新测试真实失败，恢复后通过；UI 通知接入也做了反向验证。typecheck/build freshness/diff check 通过。
- Mac 真机：得意黑/苹方、普通/粗体共 4 组共享 runs 经实际 Chromium Canvas 与 FFmpeg/libass 运行；字体选择日志证实 explicit PingFang SC 生效。发现 locale family「蘋方-簡」内联会错选 Helvetica，已改为保留可匹配候选 spelling 并复验。
- 已知未解决：CoreText/libass 的 PingFang SC 700 实际选 Medium，浏览器的 face 匹配仍可能不同。family 策略已共享，但不能验收为 exact face 或像素一致；严格 face 绑定/跨平台验证仍须后续处理，PR 保持 Draft。
- 冷启动字体清单实测约 3.15 秒，热缓存约 25 毫秒；816 faces，共享 388 cmaps，完整响应约 2.89 MB，未触上限。complete=false 来源是不支持/坏字体，不是覆盖完整承诺。
- 新黄色 SVG 提醒在📷左侧；主/副/叠加轨内容及模式变化驱动刷新，不逐帧扫描。真实 Chromium 使用实际模板/CSS/controller 验证 hover、键盘 focus、ASS 关闭和无 emoji 隐藏通过；未冒充整套工程切换 E2E。
- 未验证：Windows 最终实现实机、打包产物、全量 E2E、跨电脑相同字体文件、合成粗斜/复杂脚本/彩色 emoji。Canvas 与实际帧仍应对照人工核验。

- 最终独立复审：未发现新增 blocker；此前脚本范围与变换度量问题已修复。性能建议已落实：普通无 emoji 文本快速返回，复用 Intl.Segmenter，避免每帧每 run 创建分词器。已接受的 exact-face 风险阻止转 Ready/合并，不作为已完成的通用一致性承诺。

### CI follow-up: font-inventory startup race

- Linux editor and Windows display checks exposed synchronous ASS builders being called before the new font inventory completed. The intentional pending guard also escaped native-frame timer/open callbacks, leaving a blank comparison frame.
- Added an awaitable inventory completion signal, native-frame deferral and automatic retry after completion (including failed/legacy endpoints). Synchronous export still rejects a partial inventory; direct-builder integration tests now wait for readiness explicitly.
- Independent review identified that a stalled request or JSON body could otherwise block forever. The full fetch/body operation now has a 30-second deadline, aborts and settles into the legacy path, and remains retryable. Late responses cannot ingest stale data after the deadline.
- Regression coverage includes pending success/failure, never-resolving fetch/body with retry, and delayed-inventory native-frame rendering. No font choice, emoji text, or ASS content policy was relaxed to make CI pass.
- Follow-up validation: 397 targeted JavaScript/assembly tests passed; build freshness, typecheck and diff checks passed. The three affected E2E suites produced 64/65 passes on macOS. The remaining 90-degree/nonuniform-scale boundary test differs by 4 pixels against a 3-pixel threshold; the exact same 4-pixel failure was reproduced on the pre-change `81d4fbaa` baseline, so its tolerance was not changed. A separately rerun deterministic gated-inventory native-frame test passed.
