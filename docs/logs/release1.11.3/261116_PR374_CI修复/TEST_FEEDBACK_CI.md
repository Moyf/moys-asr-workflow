# PR 374 CI 修复账本

- 请求：修复PR 374最新CI失败，不跳过测试或增加全局重试掩盖。
- 开始基线：本地分支 `fix/test-stability-and-ci-layering@dd7e086f`，工作区干净；远端PR head为 `33a0693a`，需先核对新增提交。
- 状态：待处理、进行中、已修复、仅说明、阻塞。

| 条目 | 问题 | 状态 | 结论 / 验证 |
| --- | --- | --- | --- |
| 1 | Ubuntu browser 1/4三项ASS渲染断言失败 | 已修复 | 修正guard裁切属性、逐层band测量与同静态几何的独立原时钟参考；原hash仍作诊断，3px边界要求不变。Windows完整spec40通过、Python30通过，Linux待新CI验证，不能视为远端已通过。 |
| 2 | Windows browser 3/4的JKL停止位置失败 | 已修复 | 原测试在K之前采样，16倍倒放跨1帧可约267ms；改为等待真实reverse/frame/pending完整停止状态后采样，并跨2个RAF保持0.01s原容差。受控旧逻辑失败、新逻辑通过，漏停负对照正确失败；完整spec5通过，不改产品。 |
| 3 | Complete test matrix required失败 | 仅说明 | 直接job日志确认在gate检查子任务结果处报“missing, failed, cancelled, or unexpectedly skipped matrix job”；正确传递失败分片，不放宽聚合门禁。 |
| 4 | 维护者反馈“修完 CI 还是红的呀……”：Windows Python/Preview缩略图测试超时 | 进行中 | head e55a44b1，run43800801608的required-media中跨进程Queue启动等待、worker启动与server状态超时；Preview run43800801688全套也HTTP超时。需查实际锁/子进程/请求路径，不先放宽超时。 |
| 5 | Ubuntu browser2/4缩略图隐藏缓存断言失败 | 已修复 | CI实际864000→921600是解码完成导致缓存增加，不是隐藏清空；改为同步采样/隐藏/采样保持严格等式，随后跨异步边界复核；新增release必须属于本次隐藏。生产controller真实解码gate正负对照验证旧采样与错误clear均被检出，Windows零重试三轮9通过，Linux待CI。 |

## 阶段记录

- 已记录反馈；尚未修改测试或产品代码，未提交或推送。
- 已快进至远端PR `33a0693a`，保留六个新增提交；工作区仅本次新账本。失败run `43637727609`结构化报告已下载至 `.artifacts/pr374-ci-43637727609/ubuntu`、`windows`，原始日志不入库。
- JKL验证：`.artifacts/pr374-jkl-261116/checks/20261116T031733Z-d6ce4dfc/result.json` 5通过；旧采样受控失败031614Z-d69eeec8、同间隔修复通过031657Z-7f9210fe、漏停负对照失败031712Z-f89bf896均在同目录。未认定CI是产品暂停失效。
- Ubuntu本机没有可运行的WSL发行版，不安装/绕过该缺口。以CI图像、ASS、fontselect和实际输出证据核对；Linux远端复验需诚实单列。
- ASS最终验证：`.artifacts/pr374-ass-261116/checks/20261116T033453Z-49c5a5f0/result.json` 为完整40项零重试通过；`20261116T033708Z-a3846dbd/result.json` 为Python30通过；旧helper在新增回归上13个断言失败，证据为 `20261116T033444Z-6f83f2c4/result.json`；CI原图复核为 `20261116T033708Z-0a99aaca/result.json`。以上同属该checks目录。
- 实现者以外复验：播放完整spec5通过（`.artifacts/checks/20261116T033641Z-5f0aa4bf/result.json`），独立审查oracle9通过（`.artifacts/checks/20261116T034314Z-ebde1f9a/result.json`），无明确finding，见同目录 `REVIEW_FINDINGS.md`。
- 文档检查通过（`.artifacts/checks/20261116T033925Z-ebd965b0/result.json`），仅提示历史日志导航遗漏；`git diff --check` 通过。此次只改测试与文档，不改产品或生成便携HTML；用户可感知行为未变，不新增CHANGELOG条目。
- 未完成边界：新提交的跨平台Actions、Linux实际像素渲染与完整矩阵待远端运行；不以本地通过冒充CI通过。原有人工清单仍保留在测试治理记录，未自动勾选。

## 续1：远端失败重新核对

- 远端e55a44b1已完成；上轮ASS/JKL分片通过。新run43800801608的Windows Python普通3173通过，但required-media有1失败4错误；Preview run43800801688也在thumbnail_server切回decode后的POST超时。聚合门禁正确转红。
- 未修改时，本地缩略图两个文件10通过（`.artifacts/checks/20261116T050743Z-142840f2/result.json`）；完整media128无失败但缺numpy产生3个不允许skip，required gate真实失败（`.artifacts/checks/20261116T050938Z-ed8d2e80/result.json`）。随后仅补安装锁文件numpy2.4.6，未改依赖声明或skip策略；后续须重验required gate。
- filmstrip证据：`.artifacts/pr374-filmstrip-round2/checks/20261116T051227Z-9d0c7ab7/result.json` 三轮9通过；`negative-checks/20261116T051138Z-fe6a9245/result.json` 两项负对照按预期失败。与CI报告原864000→921600一致。
- 后端只读调查：worker先独立probe，随后缓存memo仍冷，可在manager锁内再次probe且未传cancel，status/demand争同锁，close取消不能覆盖该重复probe。该机制是确定活性缺口，但未有当轮CI线程栈，不能断言就是所有超时根因。跨进程Queue事件位于预处理后，8秒混入启动/probe/关键帧成本；正在做受控验证与最小修复。
- 后端实现将共享探测移至锁外并传cancel；旧逻辑3项受控负对照失败，证据 `.artifacts/pr374-thumbnail-round2/negative/20261116T051502Z-01e9d5e6/result.json`。相关88项通过（同根 `final-unit/20261116T051850Z-9f616a28/result.json`）、required-media128零跳过通过（`media-pack/20261116T051850Z-98b5db76/result.json`）、诊断及真实后端18通过（`final-diagnostics/20261116T052312Z-55d0c1ce/result.json`）。跨进程原8秒门槛不变，只增加setup/子进程异常诊断；HTTP失败打印线程栈便于确认余下阻塞。
- 父会话独立filmstrip3项通过（`.artifacts/checks/20261116T051529Z-00ced6fa/result.json`）。全Python实际3180项为2错误、23skip（`.artifacts/checks/20261116T052157Z-ea7ae135/result.json`）：两个错误均在WindowsSecurityIntegrationTests的运行时目录ACL检查，本次没有改该代码，不将这轮说成全套通过；对应CI上轮普通全套通过，尚未替代本地差异分析。
- 独立审查发现过期探测异常可能污染新源状态，已登记同目录REVIEW_FINDINGS.md并要求补manager层回归；本轮远端闭环前不宣称CI修复全部完成。
- 该minor已补齐并独立复核32项通过，父会话最终相关74项通过；精确正负证据见REVIEW_FINDINGS.md，无未处置finding。生产修复在CHANGELOG以一条首次缩略图响应说明记录。
- 本机ACL错误隔离执行仍为2错误（`.artifacts/checks/20261116T052914Z-30b9d939/result.json`，该模块只导入runtimes相关代码）；不修改其安全规则来消除本地错误。源清单已补首次加载与隐藏/重启用人工步骤，校验生成成功（`.artifacts/checks/20261116T051716Z-5c04b6a3/result.json`），不代维护者勾选。
