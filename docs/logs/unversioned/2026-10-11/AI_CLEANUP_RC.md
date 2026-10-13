# AI 口播整理：RC 工作流调整记录

## 范围与基线

- 用户确认「AI 处理」新增独立口播整理任务，参考文稿可选；普通文稿匹配保持本地确定性对齐。
- 模型返回原文编辑稿：逐行原文、完整词项划删、待确认注释。固定解析器转换成可恢复 MOSP 数据。
- 删除写入 `gap_remove.provenance.sources.ai_cleanup`；待确认写入 `markers.items[*].review.status=pending`。
- 基线 HEAD：`20c8ede69dc88f023539bfa7487b3e5b7e0e5392`，开始时工作区和暂存区干净。
- 维护者于 2026-10-12 确认新版整理效果并批准本地提交；未推送或生成便携 HTML，内联副本待发布前统一重生成。个人素材、模型实验和验收页在仓库外。

## 进度账本

| 项目 | 状态 | 处理结果 |
|---|---|---|
| 无参考文稿与完整表达比较 | 已修复 | 文稿可空；跨短字幕比较完整表达与多 take，保护独有信息和承接 |
| 类 Markdown 协议与固定转换 | 已修复 | 完整 ID、顺序、源文、item 边界校验；漏行不视为删除；不由模型生成时间 |
| 漏清扫描与剪后审计 | 已修复 | 首轮零删除也扫描；最后稀疏 reviews 审计只恢复危险删除，不新增删除 |
| 句内删除、待核查与导出 | 已修复 | 原 segments/items 保留；SRT/ASS/动态字幕按生效 AI gaps 派生文字；恢复 gap 即恢复文字 |
| 重复运行已有决定 | 已修复 | 新请求使用当前生效文字，转换回源 item 索引，保留旧 AI 删除和手动恢复 |
| 独立入口与旧自动计划 | 已修复 | 旧 AI match 迁移到 cleanup，显式新任务优先；批量维持单文件限制；保留取消与实时输出 |
| HTML 处理前后对比 | 已修复 | 本地结构化快照 + 固定模板；搜索、筛选、划删、疑点；关闭保留中间产物仍保留对比页 |
| 同素材 Luna 无文稿复测 | 已修复 | 独立三阶段，11 整段 + 1 词项删除，240→164 字；删除 item 位置逐项等于此前 RC 最终版；新版未标原声疑点，仍需人工回听 |
| 文档与打包 | 已修复 | README、工具箱、协议、schema、自动流程、CHANGELOG、Runtime 依赖更新；bundle/meta 重建 |
| 浏览器交互、截图与间距 | 阻塞 | Chrome 调试连接不可用；此前文件页面拒绝，不规避限制。需按库外验收页实测新增区域间距≥8px及试听/Seek/恢复 |
| 全量 Python 既有文案断言 | 仅说明 | `test_gui_config.py:400` 仍要求 OpenAI provider.note 包含“时间戳”；基线 HEAD 同样不含该文字，本任务未修改该供应商文案 |

## 最终验证

所有测试由 `scripts/run_check.py` 限时运行。验证对应上述基线后的本次改动，提交前未再修改业务代码。

| 层 | 命令 / 结果 | 证据 |
|---|---|---|
| Python 定向 | `scripts/run_tests.py` cleanup/timeline/readthrough/pipeline/LLM JSON/packaging 6 组，162 项通过 | `.debug-runs/20261011T153839Z-8eadd71f/result.json` |
| GUI 后端 | GUI 等定向 453 项通过，1 skipped；之后未改 GUI 源码 | `.debug-runs/20261011T151709Z-2e268f80/result.json` |
| 全量 Python | 编辑稿重试提示微调前，1976 项：1948 通过、27 skipped、1 既有断言失败 | `.debug-runs/20261011T153123Z-5dff9ec1/result.json` |
| Node 逻辑 | editor utils/waveform/script syntax/order/launcher feedback 398 项通过 | `.debug-runs/20261011T153449Z-7e0c4a01/result.json` |
| Editor 构建 | `node scripts/build-editor.mjs --check` 通过 | `.debug-runs/20261011T153237Z-56d5c091/result.json` |
| Launcher 构建 | `node scripts/build-launcher.mjs --check` 通过 | `.debug-runs/20261011T153237Z-e579a727/result.json` |
| TypeScript | `tsc -p tsconfig.typecheck.json` 通过 | `.debug-runs/20261011T153102Z-fa49b20c/result.json` |
| Ruff | 本次 Python 领域模块与测试通过 | `.debug-runs/20261011T153853Z-6edfbc6e/result.json` |
| 同素材产物 | 源 text/items 不变，删除位置与 RC 一致，SRT 和 HTML 与 MOSP 一致 | 仓库外复测目录的 `validation.json` |

阶段失败已处理：Runtime 缺文件补齐并通过打包测试；自动 AI 步骤未传对比开关已修复并通过中间目录清理测试；Node Python 桥误走 uv 缓存改用 `MAW_TEST_PYTHON` 后通过；TypeScript 参数错误改用项目配置后通过。没有同步或修改共享 venv。

## 交付与下一步

库外提供新版素材对比页与模板生成的人工验收页。维护者需要确认 AI 任务选择/可选文稿/对比页入口、实际布局距离、导出、取消、恢复和原声质量；自动化与文本删除一致性不代表音频剪辑质量已验收。全量测试既有断言需后续供应商文案任务统一修正；此任务不扩大修改范围。

最后协议审查发现编辑稿重试仍误用旧 JSON 指令，已拆分编辑稿与审计重试格式，并新增失败后成功重试验证；最终162项定向测试和Ruff通过。HTML脚本静态语法与Git/LF检查通过；没有将此类检查冒充浏览器验收。
