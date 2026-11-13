# 测试稳定性、去重与分层实施账本

- 授权：逐项完成报告建议的前三阶段；不追求减少测试总数，不用全局重试掩盖失败。
- 后续授权：维护者下班前明确要求完成后提交PR供远程审查。已创建独立分支 `fix/test-stability-and-ci-layering`，不直接推main；提交PR前仍合并最新origin/main并验证，不手动发布/tag/改分支保护。
- 基线：`main@ee2fe595`；开始时已有分析文档及4份浏览器spec未提交修改，保留全部工作。
- 顺序：稳定性 → 确定的浪费 → 分层与保守选测；每阶段验证并落盘，最终独立审查。
- 状态：待处理、进行中、已修复、仅说明、阻塞。

| 条目 | 阶段与验收 | 状态 | 结果 / 后续 |
| --- | --- | --- | --- |
| 1 | 核对工具页、烧录、颜色、焦点已完成部分 | 仅说明 | 工具页由其他Agent处理；其余5失败的测试修复和94项验证见BROWSER_FIXES.md，不重做。 |
| 2 | 媒体日志等待及缩略图连接关闭独立回归 | 已修复 | 保留HEAD日志join修复，补Event控制的延迟写入回归；提前拒绝未消费body时明确关闭连接，不drain。新增独立无FFmpeg的真实loopback HTTP测试；10053未重现，不把此协议修复冒充根因。45项目标测试、95项服务器契约通过，负对照真实失败。 |
| 3 | 清掉无消费者portable准备，loader按需编译 | 已修复 | 27消费者真实编译54→29，新增inflight/失败/VM隔离回归，Node全量1171叶子通过。HTTP spec自行使用临时空配置与child-env覆盖，不依赖本机表情包；生命周期33项通过，合成继承配置正/负对照有效。 |
| 4 | 合并明确重复的构建/import smoke | 已修复 | 保留editor/launcher参数化传递依赖测试，合并Python实际重复的账目测试；3个域inert smoke合并到118模块manifest统一入口，独有接线/顺序/桥检查保留。相关Node45项、Python23项通过，变异负对照有效，独立审查无major/minor/nit。 |
| 5 | 修正FCP7真实渲染分组、保守PR领域选测及完整跨平台门禁 | 已修复 | 新增补充矩阵，原Editor/Windows Preview不缩水；6条精确领域白名单，非PR full；双平台完整Python/Node及4浏览器分片，周定时/tag/dispatch同样full；报告/回执/skip严格校验，Release三平台完整PY报告保留。3处主/复审finding已修复复核，远端/打包未执行。 |
| 6 | 扩大浏览器扫描新增5项失败 | 已修复 | 原5/5失败，修复后5/5及5份spec36/36通过。只改测试：toolbar/no-wrap和音量面板现行契约、audio/video真实ESM初始化、filmstrip真实鼠标命中保障；仍要求字词start增加。独立审查0major/minor/nit，未改产品代码。 |
| 7 | 最后一轮完整浏览器超时及尾部9项失败 | 已修复 | 对齐设置页/气泡/帮助与主题语义；ASS用独立固定样式fixture检验预览导出一致性，不改默认值骗过。9/9及4文件142/142通过，保留交换元数据/空轨undo/save重开。 |
| 8 | 超时尾部4份spec补测 | 已修复 | 10/10修复；两文件96/96分别在1/2 workers通过。创建气泡/非模态帮助/tooltip/菜单与相对媒体路径对齐现行契约；字词拖动用真实命中与独立手势保障，保留边界/时长/redo断言及有效负对照。 |
| 9 | 最终core测试暴露的Python4项失败 | 已修复 | 补Python内嵌prepare消费方、3项默认路径隔离继承MAW_ENV_FILE，并加显式override正例；53项定向通过、独立复核无finding。最终Python全量3168项0fail/error、12skip，Node全量1173叶子0fail/skip。 |
| 10 | 双语空轨显示组hidden被CSS覆盖及样式指南默认值失真 | 已修复 | 局部CSS[hidden]守卫与真实none→grid→none回归；旧CSS真实失败。定向4/4及multi完整99/99通过，显示组四向间距8px截图自查；ASS指南按源码修正，CL一条修复。 |
| 11 | 全部浏览器四分片统一验收 | 已修复 | 最终完整集合1143：1138pass、5精确弃维护skip、0fail/retry/xfail。仅复用源依赖未变且fresh集合匹配的1片，2/3/4片新执行；逐片严格校验、互斥并集等于完整发现。首轮1133/5fail/5skip原结果保留，不改写历史。 |
| 12 | 四分片后5项时序/布局失败 | 已修复 | 真实Undo恢复完整items/帧并命中实际handle；等modal既定初始焦点就绪后测试find保焦点；间距测真实可见相邻组16px；虚拟159+1ms验证生产160ms corridor。保留结果断言，独立审查无finding，最终受影响分片通过。 |
| 13 | 官网验证缺生成数据/已锁依赖 | 仅说明 | 按原管线离线生成release预览数据，并一次冻结锁准备缺失@types/node后，check/build实际通过，未改源码/tsconfig/锁/全局Node；238个产物均ignored。不是线上部署证据。 |
| 14 | Chromium间歇启动超时 | 仅说明 | 最后118组合116pass、2 launch超时且未入业务断言；cold probe成功不能证明根因。最终更保守单片2workers、零retry验收通过；不称修复环境根因，原失败保留，远端Runner待核对。 |

## 过程证据

- 实施阶段未主动commit/push；后续按维护者明确授权在独立分支提交并创建PR。不更新根便携HTML。实现共享日志由主会话维护，子任务只修改指定代码并报告结果。
- 阶段3设计边界：保留现有Windows Preview完整Python、cache报告门槛、专项浏览器和打包烟测，不将其悄悄替换成子集；PR领域白名单仅控制新增补充门禁。未知/混合/共享变更full，非PR full。补main/定时完整发现与跨平台验证时使用有限分片和有界超时；发布现有Windows阻断、辅助平台警告政策不擅改。任何新增CI结构只能报告本地契约已测，不能冒充远端已经运行。
- 阶段1证据：`.artifacts/test-stability-261113/final-targeted/20261113T082523Z-c7672814/result.json` 45通过；`local-editor-contracts/20261113T082523Z-fd39dd19/result.json` 95通过。日志负对照 `diagnostic-negative/20261113T082240Z-5684cc4a/result.json`；HTTP负对照 `thumbnail-negative/20261113T082240Z-f2dc46c1/result.json`；临时注入已恢复。
- CI校验工具准备：只在忽略目录下载官方actionlint v1.7.7 Windows包并核对官方SHA256，没有系统安装。修改前editor/preview/release三份workflow均通过actionlint（禁用外部shellcheck/pyflakes），结果 `.artifacts/checks/20261113T083751Z-0201ecff/result.json`；后续不能将已有YAML错误当本次新增或将静态检查当远端运行。
- 阶段2主体证据：完整本地报告 `.artifacts/test-optimization-261113/STAGE2_REPORT.md`；Node全量 `final-node/20261113T083942Z-197858d6/result.json`；定向Node `final-targeted-node/20261113T084603Z-269995a2/result.json`；Python `final-python/20261113T084607Z-95374f79/result.json`，均相对此证据目录。新增回归后叶子数1170→1171；未为减少数字删除有效行为。可证明消费者编译调用数减少25次，不能宣称整体墙钟已改善。
- 阶段2收口：HTTP夹具内部隔离配置，非由维护者手动改环境；33项生命周期及4项最小复验通过，默认/合成sticker继承环境各1pass+2既有skip，移除spec覆盖或helper转发均真实失败。最终补丁及哈希见同一STAGE2_REPORT.md。独立主体审查无major/minor/nit，另行核验最终env边界。
- 扩大浏览器结果 `.artifacts/checks/20261113T090402Z-c919b4f3/result.json`；摘要 `.artifacts/test-governance-261113/e2e-expanded-summary.json`。这次仍不是完整跑完，统计skipped=561含556未运行和1中断，不能当561项正常豁免。第三阶段子任务已实际修改selector/policy/workflow，状态查询及实际进程核对未另启重复任务。
- 新5项修复最终36项通过（53.91秒、1 worker、0 retries），`.artifacts/test-expanded-fixes-261113/expanded-final-checks/20261113T092514Z-a4a3c138/result.json`；原失败对照及截图见同目录REPORT.md。当前进行最后完整浏览器执行；第三阶段治理主体已验证130项和required-media128项零skip，但成功回执缺报告和非PR入口复核两处主会话发现仍待处置，不提前放行。
- 最后完整浏览器执行超时：`.artifacts/checks/20261113T093138Z-889fb9cf/result.json`，exit124，901.27秒，cleanup_error为空；没有可用完整JSON结果。日志提取9项明确断言失败见 `.artifacts/test-governance-261113/e2e-timeout-failures.json`。已核对另两个serve进程属于其他worktree，未终止或误认成本任务残留。当前不能报告完整浏览器全绿。
- 尾部4份spec完整补测 `.artifacts/checks/20261113T095710Z-2d4d6b1a/result.json`；90pass/10fail，0skip/0retry，摘要 `.artifacts/test-governance-261113/e2e-tail-summary.json`。新增失败继续逐项调查，原重型或失败用例不删除。
- 最终core首轮 `.artifacts/checks/20261113T095543Z-4f4207a3/result.json`：Node1173叶子0fail/skip；Python3165项3fail+1error，完整日志 `.artifacts/test-governance-261113/python-final.log`。此轮普通全量缺陷真实保留，不把退出0的其他层冒充全部通过；隔离依赖在本地目标目录，不同步共享venv。
- 阶段3收口：初版130项契约、128 required-media零skip；回执/事件守卫补丁117项及subtest兼容38项通过。主会话真实复核缺报告拒绝且无回执、同计划push拒绝/PR通过 `.artifacts/checks/20261113T100918Z-cc968070/result.json`；独立最后4项复验 `.artifacts/checks/20261113T100837Z-9bd2bcb3/result.json`，三处finding均关闭。详见STAGE3_REPORT和REVIEW_FINDINGS_三阶段.md；远端未跑不宣称跨平台绿。
- 最终Python完整复验 `.artifacts/checks/20261113T101441Z-5d59ad02/result.json`：3168项、0failure/error/expected-failure/unexpected-success，12skip，264.58秒runner wall（外层265.25秒）；skip不是通过。新报告校验器实际回读该完整报告及128项required-media报告并验证同一归组集合，结果 `.artifacts/checks/20261113T103015Z-7b5e0f37/result.json`，媒体子集在最终完整运行中亦无skip。
- 后段9项最终142通过 `.artifacts/test-late-fixes-261113/expanded-handoff-checks/20261113T101130Z-d52cb851/result.json`；尾部10项两个完整文件96通过 `.artifacts/test-tail-fixes-261113/checks/20261113T101448Z-6ceba07a/result.json` 与单worker `20261113T101620Z-0b0d20b1/result.json`；CSS实际修复99通过 `.artifacts/test-empty-track-261113/expanded-checks/20261113T102206Z-683efbf1/result.json`。所有旧行为与负对照详见各REPORT.md。
- 四分片实际结果 `.artifacts/checks/20261113T102728Z-9198cf89/result.json`，746.45秒、全部执行但非全绿；每片469.26/252.65/335.96/269.25秒。集合覆盖及5个失败逐案见 `.artifacts/test-governance-261113/browser-sharded-outcomes.json`；慢文件/用例见browser-cost-profile.json。文件用例耗时和不是墙钟，当前失败含等待时间，不能据此宣称严格提速。后续优先针对浏览器组织/准备/诊断成本做受控测量，不按数量裁毫秒单测。
- 官网后续环境核对：`.artifacts/test-website-final-261113/REPORT.md`；check `website-check-after-install/20261113T105700Z-fb9dddaa/result.json`、build `website-build-final/20261113T105757Z-3a34a3c2/result.json`均通过（相对该证据目录）。先前失败原因已按同源前后对照确认，不靠改源码掩盖；本机Node22.23.2低于声明22.23.4的警告仍如实保留，CI使用钉住版本待远端核验。
- 最终浏览器统一验收 `.artifacts/checks/20261113T113438Z-a1f1b558/result.json` exit0，565.88秒外层；摘要 `.artifacts/test-governance-261113/browser-final-verified/summary.json` complete_and_validated=true，1143集合1138pass/5skip/0fail。1片源依赖mtime与fresh case集合匹配后复用；2/3/4片真实新执行并逐案验证，不能把此565秒当四片全新重跑的墙钟。每个跳过均匹配5条弃维护文件/完整标题/原因白名单。
- last5独立审查无major/minor/nit；保留初始50ms主动输入竞争未覆盖的风险，不宣称产品该窗口已修。对应非模态/手势/时钟负对照及启动失败原始记录见 `.artifacts/test-last-five-261113/REPORT.md`。
- 最终独立集成审查通读89个拟提交文件，0未处置blocker/major/minor/nit；39个阶段2文件哈希匹配，原Editor/Windows Preview/root blank无diff，UTF8无BOM/LF检查通过。随后浏览器统一验收实际通过并回填；文档/lock/freshness/whitespace终检均通过，历史6条日志索引warning如实保留。
