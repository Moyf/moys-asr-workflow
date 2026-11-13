# 三阶段实施独立自审

基线：`main@ee2fe595` 与逐阶段未提交修改；保留既有浏览器修复WIP。各审查者未参与对应实现，不以自报替代文件与运行结果核验。

## 阶段1：日志等待与缩略图连接

- 范围：`server-editor/serve.py`、`tests/test_gap_removed_media_jobs.py`、`tests/test_thumbnail_http_lifecycle.py`。
- 结论：独立审查无major/minor；early reject不drain、不保持带未读body的连接，完整解析后的业务错误保留复用；新增send_json关键字参数默认值兼容已有调用。
- 测试审查：事件控制日志写入，finally释放并等线程；raw HTTP区分未读body、部分body、完整body及正常流水线。负对照确实命中日志未生成、body被解释为新请求。
- 独立重跑4项通过：`.artifacts/checks/20261113T083056Z-31a0f74d/result.json`。实现阶段的45/95项与两组负对照详见IMPLEMENTATION_PLAN.md。
- 接受边界：历史WinError 10053未重现，不声称其根因已证实或此次完全修复；跨平台执行仍需CI。

## 阶段2：按需编译与等价去重

- 主体审查无major/minor/nit。27个消费者只增加明确prepare顶层await，业务行为断言未改变；缓存仅保存不可变编译文本和inflight Promise，失败清理缓存后允许显式重试，每次load仍运行独立VM。
- 去重对照：保留参数化import用例的metafile/metadata/hash/code四类断言；Python账目合并增加未改源码时已stale的检查；统一smoke遍历118个manifest模块，域专属原位、顺序、桥与静态边约束保留。
- 独立复验Node12项与Python23项通过：`.artifacts/checks/20261113T085351Z-9b1dc887/result.json`、`20261113T085423Z-7783fb92/result.json`；已核对主体JUnit1171叶子无失败/跳过，不把该结果冒充最后新增2个lifecycle测试也已全量跑过。
- 最终env补丁静态复核确认只覆盖server child，不改父环境；后续运行证据：生命周期33项及最小4项通过，默认与合成sticker继承环境HTTP各1pass+2既有skip。移除spec覆盖或helper转发的负对照命中实际内容/环境断言；详情见 `.artifacts/test-optimization-261113/STAGE2_REPORT.md`。
- 接受边界：没有证明整套wall改善；没有因省时间删除真实媒体回归；跨平台CI未执行。

## 后续阶段

阶段3治理代码已完成并复核；以下记录完整处置链。整体浏览器扩展扫描仍按实施账本记录，不将治理审查通过冒充全仓UI全绿。

## 扩大扫描新5项测试修复

- 范围：cue-list-layout、filmstrip-real、gap-removed-audio-export、gap-removed-video-binding、media-controls-layout五份spec。
- 独立审查0major/minor/nit，确认旧契约已对齐、真实初始化与能力/无POST/无输出断言保留、鼠标命中前置不弱化start增长、截图产物隔离并清理Server。
- 已核对原5fail和最终36pass/0skip/0retry JSON及截图；未由审查者独立重跑浏览器，不能据静态跨平台核对宣称实际跨平台通过。

## 阶段3初次独立审查

- 审查者初次未发现finding，独立治理14项及真实浏览器报告小集合复验通过；核对130项、required-media128项报告及1143项分片发现。
- 此结论不覆盖后续主会话实际故障注入发现的两处边界，以下逐项处置，不能用初次审查0finding跳过。

## 阶段3主会话发现：Python成功回执缺少报告校验

- 级别：major；已修复并独立复核。
- 证据：`scripts/ci_matrix.py:93-99,113` 仅依赖子命令退出0，未回读完整Python和media-required JSON就写success receipt。受控模拟“命令退出0但不写报告”时，两个报告均不存在仍生成成功回执：`.artifacts/checks/20261113T093207Z-3b8185a1/result.json`。
- 风险：与本任务“缺报告不能绿”要求不一致；现有runner正常实现会写报告，但治理层未守住该不变量，不能只靠被测runner永不回归。
- 要求：写回执前验证两份报告存在且结构/结果/required语义有效，补缺失、损坏、结果不一致的负例；不放宽普通full与required的不同skip边界。

## 阶段3主会话发现：汇总入口缺少事件边界复核

- 级别：minor（防御性政策守卫）；已修复并独立复核。正常selector已将非PR强制full，不将此当作当前普通main运行已少测的证据。
- 证据：公开gate CLI设置 `GITHUB_EVENT_NAME=push`，提供同SHA、字段及指纹自洽的domain/tools计划、成功job与两份回执，退出0；`.artifacts/checks/20261113T093608Z-e1ed86a2/result.json`。
- 要求：消费计划的CLI再次核对实际事件，非PR拒绝降级计划，防止selector回归或自洽但错误的计划绕过main/schedule/tag/dispatch的full要求。保留本地纯函数测试与PR有效计划，不通过扩宽正常路径来回避守卫。

## 阶段3复审发现：合法重复subtest skip误拒

- 级别：minor；已修复并独立复核。
- 独立审查证据：真实unittest同一case内两次无参数subTest的skip可产生相同skip ID，普通full报告exit0/run1/两个subtest skip合法，但当前校验器按全局ID去重而拒绝；`.artifacts/checks/20261113T095726Z-a1f9751d/result.json`。
- 要求：区别case/fixture重复和合法subtest多次记录，保留required对unsupported skip拒绝，并补真实unittest回归。未证明当前完整项目已有该重复，不将其当作已有全量失败原因。

### 三项处置的最终证据

- Python两份报告必须回读并语义验证后才能发成功回执；required重新计算精确平台豁免、拒绝伪造能力skip，media集合须匹配full的归组子集；旧输出不能冒充新结果，回执含验证摘要和报告哈希。
- 消费计划的CLI按实际事件再次守住非PR/full；同SHA、字段/needs/回执自洽仍不能让push降级，PR同输入保持可用。
- 合法重复subtest skip按记录处理，case/fixture重复仍拒绝；平台白名单不变。
- 主会话复核 `.artifacts/checks/20261113T100918Z-cc968070/result.json`；独立最小4项全部通过 `.artifacts/checks/20261113T100837Z-9bd2bcb3/result.json`；实现者专门38项、Ruff、actionlint与diff检查通过，详情见STAGE3_REPORT.md。
- 无遗留blocker/major/minor；本地治理审查通过不构成远端Actions、跨平台、15分钟预算或发布包已经验证。

## 后段/空轨终审：非空布局前置与官网副本

- Minor（已修复复核）：`settings-structure.spec.mjs:44-47` 在空轨隐藏显示组后，两行矩形top均为0，原同行断言会假通过。现显式准备非空副轨，先断言组/行可见且尺寸非零再同行；实际175×26px、top247，隐藏负对照失败，34标题与数量不变、完整34通过。
- Nit（已修复复核）：ASS官网副本通过字节相同的原sync脚本在隔离镜像生成并单页导回，与真源对应内容一致；其他7页既有漂移不混入本次修改。Node同步5项及文档检查通过。
- 其他已核对的142/96/99组合证据有效，未发现业务断言弱化；最后fixture修订之后仅相关spec需重验，其他未变层证据不重复跑。
- 两项最终独立复核无新增finding；官网check/build原先缺release预览及已锁类型依赖，在本地按原流程准备后通过，未改tsconfig或锁。仍不构成线上部署或GitHub Runner验证。

## 最后5项时序/布局修复

- 独立只读审查无major/minor/nit：真实Undo完整恢复父句与items帧字段，精确验证handle/drag状态；查找回归等待既定初始focus就绪后仍保留find保焦点、命中、caret与导航断言；真实可见相邻组间距16px≥8；menu-aim用真实指针与虚拟159+1ms守住生产160ms窗口。
- 标题与数量保持不变。组合最终116通过、2个browserType.launch 180s超时，均未进入业务断言；保留失败，不宣称组合全绿。4次冷启动探针成功不能证明故障根因，不臆断为机器慢/内存不足。
- 父会话采用更保守并发逐片复核，只有代码和依赖未变且新发现集合一致才复用旧成功片；最终结果以实施账本记录。
- 接受边界：产品弹窗打开后有50ms既定初始聚焦。本PR正常查找用例从该初始焦点就绪后开始；诊断中打开瞬间主动输入可与该timer竞争，产品该窗口行为未改，不作为已修复宣传。后续如需支持该瞬时操作，应另补产品focus守卫及专项验收。

## 提交前最终集成审查与验收

- 新的独立审查者通读精确89文件的全部diff与新增文件，确认39个阶段2源文件与验证哈希一致，包含Python内嵌消费方；没有新增finding或未处置blocker/major/minor/nit。
- 核对原Editor/Windows Preview与根blank-editor.html均无diff，全部89文件UTF-8无BOM/LF，接口、断言、fail-closed门禁与发布政策没有发现新增退化。
- 审查者回读Python3168项0fail/error/12skip、Node1173叶子0fail/skip；其审查时浏览器统一验收尚在运行，未据此给虚假绿。
- 主会话随后完成最后分片验收：`.artifacts/checks/20261113T113438Z-a1f1b558/result.json` exit0，完整1143集合1138通过、5精确弃维护skip，0fail/retry/xfail；源码依赖未变和新发现集合一致的1片复用，其余3片新执行。
- 最终文档、锁文件、新鲜度与whitespace检查均通过（20261113T114957Z三组result.json；文档保留6条历史日志导航warning）。本机浏览器/核心验证与未测远端边界已回填，允许在维护者授权分支提交PR，不直接推main。
