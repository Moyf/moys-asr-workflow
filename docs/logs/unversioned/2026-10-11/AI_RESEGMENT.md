# AI 重新断句改进记录

## 范围与基线

用户授权改进语义断句并新增可选最大字数。开始时工作区已有口播整理改动，本次只追加断句功能。主线程随后将口播整理提交为 `ff70eb2e`，质量复测基于该 HEAD 加断句改动；保留主线程实现。用户在复测后授权提交并创建 PR，便携 HTML 待发布前统一重生成。

## 进度

| 项目 | 状态 | 决定 |
|---|---|---|
| 简化模型边界协议与语义指令 | 已修复 | 模型每行只标末尾单元 ID，脚本重建原文、标点与词级时间；尾部完整覆盖、禁止改写；旧 callback 分组精确校验后兼容 |
| 最大字数与异常处理 | 已修复 | 动态规划在合法边界补拆，中文/标点/英文按字符计、空白不计；完整词项、数字单位与缺时间段超长时保留并提示 |
| 混合时间码与批次上下文 | 已修复 | 有时间与无时间区间独立处理；上下文只读；不跨禁用段、明确的说话人变化或长停顿合并 |
| Launcher、自动处理与文档 | 已修复 | 可选上限在单次与自动计划中保存，使用现有对比页；中英文、打包依赖、协议与使用文档已同步 |
| 验证和人工核验页 | 已修复 | 补测后核心225项、GUI323项（1 skipped）、Node15项与真实Chromium验证通过；库外示例与人工核验页已生成 |
| 二次审查数字边界 | 已修复 | 补测复现并修复比例、分数和千位分隔符作为独立词项时被拆开的情况；模型断点与本地补拆共用双侧数字校验；不同上限下的合并原文、标点、词项与停顿时间均保留 |
| 合成文本的模型语义效果 | 已修复 | 主线程两轮子代理独立选择复杂用例断点，并执行真实 MAW 后处理；自然、24字、14字三组逐条对比。另以同一旧响应隔离脚本影响，数字单位拆分及已知悬尾减少 |
| 真实素材、供应商与回听 | 仅说明 | 模型响应通过 complete callback 交给后处理，未调用供应商 API；合成时间用例没有音频，仍需真实素材回听；不能以单测或文字评估替代播放验收 |
| 全量套件既有失败 | 仅说明 | OpenAI供应商说明的旧断言要求含“时间戳”，HEAD 同样不含；不扩展本功能去修改供应商文案 |
| 工程内备注与提醒 | 仅说明 | 重新断句保留已有工程标记，不生成新的 region 或待核查标记；超长词项、无词级时间和网络失败通过运行结果 warnings 返回。AI口播整理的待确认内容另走工程标记机制 |
| 复杂用例质量复测与边界优化 | 已修复 | 补单位保护、局部重平衡与连读提示；同一响应控制实验修复14字“1,000帧”拆分和24字“前提是”悬尾。复查收窄量词惩罚，避免把“容易被误解”切开。新版独立响应执行后12个保护表达全部完整；严格14字仍有主谓/动宾拆分，不能宣称通用语义质量保证 |

## 验证证据

测试均通过 `scripts/run_check.py` 限时执行。基线 `ff70eb2e`，代码为工作区未提交改动。

| 层 | 命令与实际结果 | result.json |
|---|---|---|
| 定向 Python | `scripts/run_tests.py` resegment/postprocess/pipeline/packaging/cleanup-timeline，补测后共225项通过 | `.debug-runs/20261011T165006Z-aefb5e50/result.json` |
| GUI 后端 | `scripts/run_tests.py tests/test_gui_web.py`，323项通过、1 skipped | `.debug-runs/20261011T163057Z-692e678e/result.json` |
| Launcher逻辑 | `node --test` feedback/syntax/bundle，15项通过 | `.debug-runs/20261011T163108Z-0bc0a696/result.json` |
| 浏览器 | `launcher-resegment.spec.mjs --project=chromium --workers=1`，1项通过；中文/英文/720px窄屏截图自查 | `.debug-runs/20261011T163526Z-a4cb7946/result.json` |
| 间距 | 上方26px、标签→输入9px、输入→提示8px、下方26px；均≥8px | 库外 `resegment/ui-spacing.json` |
| 全量 Python | 1991项：1963通过、27 skipped、1既有文案断言失败 | `.debug-runs/20261011T163416Z-68fbedce/result.json` |
| Ruff | 二次审查修改的模块与测试通过；此前其他Python修改已通过 | `.debug-runs/20261011T165006Z-e6c3f196/result.json` |
| 构建 | `node scripts/build-launcher.mjs --check` 通过 | `.debug-runs/20261011T163923Z-0dfcd65e/result.json` |
| TypeScript | `tsc -p tsconfig.typecheck.json` 通过 | `.debug-runs/20261011T163924Z-b2649065/result.json` |

GUI最初的三个回环连接失败属于沙箱限制，正常权限下复跑通过。浏览器首次查找沙箱缓存失败，指向已有Playwright缓存后通过；未重复安装环境。没有起长期服务器。

### 主线程复杂用例复测

库外 `resegment-improvement/` 保存两轮响应、新版实际请求、同响应控制结果、新响应最终结果及 HTML 对比。源用例23条启用、1条禁用，共664字符；自然/24字/14字各7批。三阶段共9个工程验证全文、原始items所有字段、禁用段、分块边界、SRT一致性和超限例外。自然组同响应结果不变；24字控制组移动1处断点，14字控制组保住“1,000帧”，不再单列“第二，”。新响应最终条数40/43/64；模型断点40/42/55，本地新增0/1/9。字幕数只描述结构，不作为质量分数。

新版最终结果没有上述连接词悬尾模式，但14字会出现“所以后来关闭 / 播放器的字幕开关，”“因为‘以后还能改’的前提 / 是时间码、”，24字完整名称前仍会断在“使用”之后。中途曾因对量词惩罚过强，产生“一个容易 / 被误解”；最终收窄规则并用同一响应重跑，恢复“今天我们只讲一个 / 容易被误解的问题：”，追加量词与修饰短语回归测试。规则减少已知问题仍不等于理解完整语法；本例优先建议自然或24字。52字无时间段和14字下的23字完整名称保留并提示，属于安全例外。

本轮最终核心230项通过（重新断句21项）：`scripts/run_tests.py tests/test_postprocess_resegment.py tests/test_postprocess.py tests/test_postprocess_pipeline.py tests/test_ai_cleanup_timeline.py tests/test_packaging_contract.py`，证据 `.debug-runs/20261011T172404Z-c5a1b33e/result.json`。最初误传两个不存在的测试文件导致2个导入错误，纠正文件名后完整复跑通过，未视为环境或代码故障。最终Ruff通过：`.debug-runs/20261011T172501Z-3ad2cbfa/result.json`。本轮未修改界面，不重复先前GUI/浏览器/构建验证，也不生成便携HTML。库外对比页通过JS语法及静态链接校验；浏览器工具禁止file协议，未作页面截图或点击验收。

库外固定断点示例验证最大10字：拆成「先介绍这个工具，」「然后演示常用功能，」「最后保存处理结果。」；全文与词级时间保持。该页明确标注未调用真实模型。人工验收页使用仓库标准模板生成，包含实际证据与真实素材、回听、自动流程及取消操作核对项。

## PR 整合跟踪（2026-10-12）

| 项目 | 状态 | 处理与证据 |
| --- | --- | --- |
| 保存功能提交 | 已修复 | `4fef3df4` 保存重新断句；此前口播整理为 `ff70eb2e`。用户授权提交及 PR，建立 `feat/ai-cleanup-resegment` |
| 整合主分支 | 已修复 | 远端 `d2d12b42` 带文档重组、局部删减和供应商记忆。保留新编辑稿与旧局部范围协议，补 scoped 范围映射，重建两个 bundle；文档进入新目录 |
| GitHub PR | 进行中 | gh 凭据失效，准备使用已连接的 GitHub 工具创建；推送和最终远端验证待完成 |
| 其他 AI 处理建议 | 仅说明 | 形成 [核对与备注方案](../../../plans/AI_PROCESSING_REVIEW.md)；翻译已有只读对比，编辑译文写回和通用备注未实施 |

整合初轮测试漏设临时目录出现沙箱写入错误，修正 TMP/TEMP 后复跑；Node 跨语言检查需显式复用现有 Python。初轮兼容测试定位旧 readthrough 字段与新漏清工序的差异，已保留旧局部范围的成品复查并适配测试。

真实供应商的断点选择质量、实际桌面桥全流程与素材播放/Seek未完成。本次浏览器验证使用Launcher演示桥，后端接线由单元/契约测试验证。后续用真实素材并填写核验页；本任务确认合成文本中列出的具体问题改善，不以此宣称真实听感或所有素材的语义质量已提升。

### 整合后的验证证据

最终代码整合 `origin/main=d2d12b42`；下面证据基于合并待提交工作区。全部通过统一运行器限时执行，便携 HTML 没有生成。

| 层 | 命令与结果 | result.json |
| --- | --- | --- |
| 全量 Python | `scripts/run_tests.py`，2155 项通过（27 skipped），113.83s | `.artifacts/checks/20261011T174555Z-3d31c82d/result.json` |
| 追加范围回归 | `scripts/run_tests.py tests/test_ai_cleanup_timeline.py tests/test_postprocess_ai_cleanup_local.py tests/test_postprocess_resegment.py`，44 项通过；新增编辑稿 scoped 范围、重叠字幕与陈旧文字保护 | `.artifacts/checks/20261011T174947Z-b6d76426/result.json` |
| Node 领域与 Launcher | `node --test` local-export/editor-utils/launcher-feedback/script-syntax/bundle，358 项通过 | `.artifacts/checks/20261011T175048Z-a02f19f8/result.json` |
| 编辑器语法、顺序及波形 | `node --test` editor-script-syntax/editor-script-order/waveform-js，64 项通过 | `.artifacts/checks/20261011T174408Z-3fd326ec/result.json` |
| Chromium | `launcher-resegment.spec.mjs` 与 `launcher-provider-memory.spec.mjs`，5 项通过；实际请求被夹具截住，不调用模型 API | `.artifacts/checks/20261011T175048Z-f9ee4710/result.json` |
| TypeScript | `tsc -p tsconfig.typecheck.json` 通过 | `.artifacts/checks/20261011T174321Z-f826ab44/result.json` |
| 文档 | `scripts/check_docs.py`，0 新增断链、0 结构错误 | `.artifacts/checks/20261011T174322Z-a6797df3/result.json` |
| 构建 | editor 与 launcher bundle 新鲜度检查通过 | `.artifacts/checks/20261011T174409Z-4a0b4139/result.json`、`.artifacts/checks/20261011T175051Z-f483f443/result.json` |

整合时保留已有局部删减兼容流程，并将类 Markdown 编辑稿删减绑定原始 segment ID 与完整词项范围，保护重叠段和失效范围。旧计划迁移不得覆盖当前任务供应商记忆，隐藏槽位回落到可见供应商。真实页面执行发现 busy 列表残留已移除下拉框，已修正并增加 DOM 存在检查；执行失败后按钮恢复、页面无未捕获异常均已验证。截图检查后去掉输出区的 JSON 限定文案，修正可选文稿按钮翻译。

全量初轮被沙箱禁止回环 socket 中断；正常权限复跑通过。部分 FFmpeg 假媒体及子进程解码在日志中产生预期或环境警告，unittest 最终无失败。前述 1991 项套件的旧文案断言失败是旧基线历史结果，整合后已全量通过。断句间距复测为 26/9/8/26px，中文、英文与窄屏截图均已自查。

## 当前未验证边界

真实供应商质量与素材回听仍需维护者实测。交互式译文编辑及通用备注仅有方案，未作为本次实现交付。
