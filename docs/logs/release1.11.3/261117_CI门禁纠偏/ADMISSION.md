# 日常检查准入与旧任务迁移

候选分支：fix/ci-gate-correction，相对a1e88d1c；此为可审计的有限准入，不是完整测试覆盖或长期稳定性认证。准确文件、ID、命令以 `scripts/ci_acceptance.py` 为准；Node准确名称另在 `scripts/ci_node_tests.json`。

## 旧任务如何收敛

| 旧任务 | 候选角色 |
| --- | --- |
| Editor/debug-tools双平台、完整Node、广泛Python、编辑器及工具E2E、真实媒体 | Ubuntu有限文档/发布/工具消费者、构建/类型/装配与下表契约；其余完整发现留在辅助巡检 |
| 每个PR/main/tag新增12矩阵单元 | 原每周及手动辅助巡检，保留2 Python、2 Node及8 Chromium分片，不自动跟随常规提交 |
| 每个非light PR的Windows完整测试与打包 | 明确打包/启动/runtime相关或手动预览；保留真实测试/打包/烟测主体，不进入Change acceptance依赖 |
| 所有任务都绿的隐含合并标准 | Change acceptance只核对所选阻塞检查；相关辅助异常仍需审查，辅助凭据不能替代阻塞凭据 |

## 显式准入

| 检查 | 准入范围 | 保护目标与依赖 |
| --- | --- | --- |
| docs | test_docs_check.py及check_docs.py | 导航、索引、链接和本地资源；Python标准库与临时Git/文件，无应用/浏览器依赖 |
| website | test_readme_content_sync.mjs、sync:docs、release-site preview、website build | README/用户指南/真实官网源输入；Node、锁定网站依赖与Python标准库，不发布、不抓远端Release |
| release | test_release_notes.py、test_release_site.py、test_release_publication.py及归档/preview命令 | 版本/归档/发布索引与下载契约；外部API在测试中mock，不执行真实发布 |
| tools | test_tool_markdown.mjs、离线说明新鲜度、变更checklist校验 | Markdown安全处理和实际工具说明消费者；Node标准库/固定本地库，不开浏览器 |
| build | 双bundle构建/新鲜度、typecheck、script syntax/order两文件 | 语法、装配和类型契约；锁定根pnpm依赖/esbuild，不生成blank-editor.html |
| data | test_project_contract.py、test_project_io.py、test_project_ass_export.py | schema、整数ms/frame、源工程不被改写、序列化与导出数据边界；临时文件/mock probe，不调用真实FFmpeg |
| editor | test_editor_recovery_save.mjs、test_editor_export_srt.mjs、test_word_timing.mjs | 迟到/失败保存不把新状态标记已保存、恢复引用、精确时间与不可变输入；VM/DOM/fetch替身及构建helper，不开真实HTTP/浏览器 |
| launcher | test_launcher_local_model_paths.mjs、test_launcher_recent_projects.mjs | 模型路径、就绪与异步读状态；VM和Node标准库，不开GUI/服务 |
| runtime | LocalEditorServerTests的token/payload与绑定目录两个明确ID；PackagingContractTests的runtime路径安全、image editor依赖隔离、静态import闭包三个明确ID | 直接mock handler/opener及静态源检查，不启动监听socket、FFmpeg或实际Windows包；不得整类扩大准入 |
| ci | test_ci_impact.py、test_ci_acceptance.py、test_test_workflow.py、test_ci_summary.py、test_browser_results.py、test_run_check.py；test_pr_preview_comment.mjs及文件角色清单 | 真实临时Git、受控超时、计划/运输丢失/摘要/计数/集合故障注入、评论VM；现有归组fixture导入需要Pillow，不渲染图片，不执行E2E/媒体 |

Python静态AST集合必须与实际运行报告一致，动态load_tests/继承集合若超出静态读法会失败而非猜测通过；零skip/xfail。Node静态名称清单与一次JUnit执行严格比较，不再使用无效的pattern过滤重复执行。

每个回执绑定报告文件、SHA256与集合/结果摘要；下载后gate重新读取实际报告和消费者命令记录，再核对来源与集合。丢文件、改字节、改计数/集合、假成功命令及receipt-only均必须失败，而不只在产出阶段验证。

## 分类边界

PR使用可信整个差异；push验证before/after、实际HEAD、祖先关系和历史。未知/坏/空/缺历史差异扩大至准入全集并告警，不变为docs，也不自动启动完整Windows预览。

普通工程/计划/日志Markdown先匹配精确真实消费者，再匹配普通文档豁免。当前官网例外为docs/INDEX.md、JSON_SCHEMA、LLM_POSTPROCESS_PROTOCOL、MOSE、DEVELOPMENT及历史ASR_PROVIDER_RESEARCH正文，准确路径与漂移测试见选择器；不是整个engineering目录都构建网站。FAQ离线正文属于打包/runtime输入，不是普通说明。

观察文件清单 `scripts/ci_observation.txt` 是角色账目，不是“这些测试都是flaky”的名单，也不再是所有PR必须先登记的全局门槛。未登记测试默认保留可见的未审查观察角色；stale/重复观察元数据提示但不因继承main新测试而拖红无关PR。晋级阻塞仍需明确审计，已准入源/静态名单缺失及报告错误仍失败；完整巡检做标准完整发现，不依赖观察名单过滤。所有日常任务在Ubuntu执行，不新增双平台稳定矩阵。

## 证据与接受边界

实现审计核对了导入、测试体、夹具、外部命令及skip guard；已有真实本地执行与运输正反例，详见实施账本与独立审查。准入缺乏长期逐ID首次失败统计，不承诺永不波动，不用一次绿证明稳定。

本机实际Node22.23.2低于锁定CI22.23.4；远端待实际候选确认。12分钟job预算是上限而非耗时承诺，不宣称全仓墙钟或runner分钟已经下降。

未由这些mock/静态测试证明的范围：真实HTTP Origin/Host路由、磁盘级原子保存失败恢复、浏览器播放/拖动/Seek/布局、FFmpeg编码/像素与Windows包启动。相关变更仍需针对性人工验证或明确请求的辅助检查。正式release工作流与原发布政策不变。
