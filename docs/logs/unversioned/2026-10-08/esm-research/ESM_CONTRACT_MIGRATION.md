# ESM 契约迁移与红绿实验

日期：2026-10-08；基线 `d4e5dff2`。目标是 **ESM 源码 → esbuild 完整装配 → Python / Server 嵌入同一产物**。Python 只负责 HTML、资源和工程数据注入，不再装配 JS 源文件。所有实验在隔离副本运行，主工作区现有测试及产品源码保留。

## 判定规则

- 产品行为契约保留；只迁移加载器或用等价的运行断言取代源码文本断言。
- 旧装配结构的断言由新结构契约替换，不在重构完成后恢复旧的逐文件拼接断言。
- 旧测试仍运行并记录结果。预先列明的旧结构红灯不等于新架构回归；不能将全部旧测试跳过或称作全部通过。
- 基线已有失败单独记录；最终合并门禁仍应修复，不能以调研的比较基线替代发布门禁。
- 新测试先针对未改造副本运行，记录预期红灯；之后才实施完整 esbuild 装配实验。

## 资产契约逐项迁移

| 当前 `tests/test_editor_assets.py` 测试 | 处置 | 新架构要保护的事实 |
| --- | --- | --- |
| `test_editor_script_manifest_is_ordered_and_complete` | 替换 | 源码清单作为迁移输入；构建依赖图包含必需输入，消费端只读 bundle |
| `test_editor_script_payload_follows_manifest_order` | 替换 | 产物新鲜度、ESM 依赖闭合、显式初始化顺序；不查源文件原文出现次序 |
| `test_ass_frame_preview_wires_template_module_and_styles` | 保留意图、迁移实现 | 模板 / CSS / 实际预览初始化仍齐全；源码字符串检测不充当功能验收 |
| `test_waveform_gap_display_type_uses_shared_core_and_subtle_protected_style` | 保留意图、迁移实现 | 空隙分类结果和保护样式仍正确 |
| `test_gap_state_labels_match_in_mawe_and_align` | 保留意图、迁移实现 | 两编辑器用户标签一致；JS 压缩不改变此要求 |
| `test_gap_manual_drag_uses_blue_handles_and_preview_in_both_editors` | 保留 | 模板 / CSS 契约，并由交互回归验证拖动 |
| `test_gap_core_exposes_restore_and_clear_semantics` | 保留意图、迁移加载器 | restore / clear 操作的结果，不以函数源码文本为验收 |
| `test_editor_overall_gap_move_uses_shared_provenance_operation` | 保留意图、迁移实现 | 移动后的 provenance 正确，底层代码可重排 |
| `test_shrink_gaps_replaces_audio_source_without_manual_override` | 保留意图、迁移实现 | 收缩后的来源记录和人工覆盖语义正确 |
| `test_template_uses_one_script_token` | 保留 | 页面嵌入一个完整 classic bundle；模板注入边界仍明确 |
| `test_server_connection_warning_uses_shared_editor_contract` | 保留意图、迁移实现 | 连接警告的 DOM / 展示行为正确 |
| `test_server_startup_labels_distinguish_waveform_cache_and_generation` | 保留意图、迁移实现 | 用户仍能区分读取缓存与生成波形 |
| `test_hint_stack_stays_above_floating_surfaces` | 保留 | CSS 层级约束与布局运行证据 |
| `test_server_onboarding_uses_user_settings_across_random_ports` | 保留意图、迁移实现 | 服务端 onboarding 状态跨端口保留 |
| `test_new_project_action_precedes_open_project` | 保留 | DOM 中新建 / 打开顺序 |
| `test_editor_sources_expose_checkpointed_import_contract` | 保留意图、迁移实现 | 工程导入的 checkpoint 和失败恢复；用真实操作验证 |
| `test_ass_style_library_saves_require_token_and_flush_before_unload` | 保留意图、迁移实现 | 保存鉴权与卸载前 flush 行为 |
| `test_sticker_root_uses_server_validation_without_browser_picker` | 保留意图、迁移实现 | 服务端路径校验仍执行，用户流程不改变 |
| `test_sticker_otio_exposes_portable_mode_and_relative_metadata` | 保留意图、迁移实现 | 导出模式及相对元数据正确 |
| `test_portable_sticker_export_capability_syncs_after_project_binding` | 保留意图、迁移实现 | 工程绑定后导出能力同步 |
| `test_generated_page_contains_registered_modules_in_order` | 拆分 / 替换 | 保留版本号、生成时间约束；已知模板 token 全部替换；注册 / 启动顺序改为运行断言 |
| `test_scan_stickers_keeps_images_when_dimensions_are_unreadable` | 保留 | Python 图片扫描行为，与 ESM 无关 |

`__PURE__` 是构建器注释，不是工程模板 token。新契约检查已知 token 集及注入结果；不能把所有双下划线字符串都判为未替换模板，也不能仅靠压缩选项隐藏旧断言冲突。

## 其余测试集

| 测试 / 支撑代码 | 处置 |
| --- | --- |
| `test_editor_script_syntax.mjs` | ESM 源码按 module 解析，发布 bundle 按 classic 解析；不要求源码仍是 classic |
| `test_editor_script_order.mjs` | 源码清单顺序审计作为基线证据保留；新门禁检查依赖闭合与显式初始化的真实顺序 |
| `tests/helpers/editor-module-loader.mjs` | 迁移 VM 加载器；保留原有工具 / 波形 / 领域测试断言，不以换加载方式削弱功能覆盖 |
| `test_editor_utils / waveform_js / editor_domains / editor_markers / multi_subtitle_metadata` | 保留行为断言；迁移加载器或直接 import 工厂并注入依赖 |
| `test_editor_host / editor_state / editor_commands / editor_runtime` | 保留当前兼容阶段的状态、事务、宿主、注册表行为；源码加载改为支持 ESM |
| `test_inline_caret / asr_presets_browser` | 保留；不属于本次 editor 装配结构替换 |
| `test_ns_rewrite_scope / refactor_layout_tools / merge_flow_qualify / type_gate` | 保留工具 / canary 测试；新 codemod 另加负例 |
| `test_editor_manifest.py` | 新输入清单验证仍保留路径、重复、越界保护；消费端不再用清单拼接 JS |
| `test_gui_web.py`、`test_waveform.py` 中的 JS 原文装配断言 | 精确标记并替换为运行 / 输出契约；其他 Launcher、Python、媒体行为继续保留 |
| `tests/e2e/*.spec.mjs` | 保留已有交互、保存、导出、拖动 / Seek 回归；保留它们使用的产品桥，测试私有全局不视为产品 API |
| `npm run typecheck` | 保留；基线缺 `ViewInvalidation.cueListPatch` 单独记录。当前仅检查 6 个 JS 文件，不能代表完整 ESM 图 |

## 新门禁（先红后实验）

| ID | 契约 | 红灯应揭示什么 |
| --- | --- | --- |
| E1 | 全部必需源文件经 esbuild 依赖图装配为 classic bundle | 没有完整构建器或遗漏源模块 |
| E2 | bundle 无旧共享词法绑定泄漏 | 仅加 import/export 并不能保留 classic 全局作用域 |
| E3 | Python 正式页面读取已构建产物 | 仍在 Python 中读取 / 拼接多个 JS 源文件 |
| E4 | 构建检查纯读、字节稳定；源码语义变化使旧产物失效 | 导入 / 检查偷偷重写产物或门禁是哑弹 |
| E5 | 错误的 ESM 导出、丢失输入导致构建失败 | 构建器没有真正解析 ESM 依赖 |
| E6 | file:// / localhost 页面启动、注入、产品桥与基线一致 | 模板 token、加载副作用或浏览器运行断裂 |
| E8 | 跨文件可变状态保持读写和返回值语义 | 将共享变量直接替换成只读 import，或状态被复制成快照 |
| E9 | 跨文件前向函数 / var 提升、let TDZ 仍正确 | 将原脚本声明实例化推迟到各文件的初始化调用 |
| E10 | 产物故意破坏后，导入构建器不修复产物，检查非零退出 | 构建脚本导入副作用让新鲜度负例变成哑弹 |

本表是调研验收标准，不代表现有测试已经被正式迁移。实验、红绿记录及未覆盖边界回写 `ESM_MECHANICAL_RESEARCH_REPORT.md`。

## 本轮完成情况

E1–E10 最终 10/10 通过；隔离加载器适配后 Node 445/445，选定的原 E2E 86 项通过。主工作区现有测试未修改。原始 Python 全量仍有 12 个新增结构 / 原文红灯，及 7 个与基线相同的错误；类型门 235 条诊断。对应红灯、已有新证据和待补行为断言逐项记录在研究报告，未把分类为旧契约等同于已完成行为验收。

下一阶段应按本表正式迁移测试与类型契约，保留产品行为意图；无需恢复原来的 JS 拼接要求。新装配测试不能替代保存鉴权、卸载 flush、贴纸路径 / OTIO、空隙标签 / 样式等专门行为验证。

维护者已决定先提交本轮调研与工具，类型诊断和旧契约红灯不阻断此次提交，待机械转换与整体迁移完成后统一解决。本表保留实际结果和待办，不通过修改断言或跳过测试将它们记为绿灯。
