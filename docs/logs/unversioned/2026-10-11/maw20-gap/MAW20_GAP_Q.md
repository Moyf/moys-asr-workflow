# MAW 2.0 缺口开发：机动独立审查

预审基线：`09af19f13bd87fb46d7ea9849ef81ac76ddbe574`。本工作树只用于独立审阅、定向验证和独有材料；不拥有生产文件写租约。预审阶段的设计风险与后续 exact SHA 实证、修复复审分别记录，不能互相替代。

## 预审范围

| 包 | 优先检查 | 验收陷阱 |
| --- | --- | --- |
| A 绑定时序 | 保存器前后当前配置对象与绑定版本；服务端锁内校验并取得 source 快照 | 配置 mutate 和替换都可能失效；同路径重载与跨标签切换不能只靠前端检测；不得接收客户端任意路径 |
| B 普通匹配取消 | 两条匹配路径、耗时循环检查粒度、`begin_commit` 原子边界 | 取消被接受后无新产物；提交开始后拒绝取消，保留成功结果；CLI/pipeline 默认调用兼容 |
| C 媒体任务 | A 契约复用、阶段状态、FFprobe/FFmpeg/传输/写盘取消、任务/结果有界清理 | abort HTTP 不等于进程终止；完成与取消只有一个最终态；清理/锁释放完成才允许重试；原文件不变 |
| D 局部 AI | 可靠 items 引用、局部信息保护、剩余文本通读、保存与去空隙导出、副轨和来源归属 | 仅写 gap 不天然删除 enabled segment 的 text；不能让剪后字幕仍带被删词，亦不能 disable 整段剩余正文；无可靠时间降级复核 |

## 本轮实际观察

- 当前 `_PostprocessOperation.begin_commit()` 以生命周期锁决定取消与提交的胜出方，可供 B 复用；不要求重新设计通用 operation 体系。
- 当前普通 `render_srt()` 直接输出 enabled segment 的原始 `text`，不读取 gap，因此 D 需明确原始 SRT 与去空隙 SRT 的不同语义，并用真实消费者验证局部剪辑结果。
- 当前 `rebuild_gap_removed_video()` 先探测源、运行 FFmpeg、再探测输出；C 的取消不能只加在单一 FFmpeg 调用，验证和下载阶段亦需检查。
- `development-docs` 任务书与协调表位于父工作区，代码工作树不包含这些文件。本轮按父工作区绝对路径读取，没有改旧任务历史。

## 独立候选复核

待作者提供 exact SHA 后追加：候选 SHA、选定源码范围、定向命令与 `result.json`、风险结论、修复后复审 SHA。未验证真实 LLM、真实媒体、原生保存器与完整手工验收时，逐项保留边界。

## 已收到的设计契约与待证实风险

- D 的局部协议使用临时 item IDs；本地校验原始整数时间、连续性、文字对应和信息保护。`cleanup_scope` 记录稳定主轨 ID 与原 items 半开索引，用于导出时文字投影，原始字幕保持 enabled 且不改写。投影必须同时满足仍有效的 `ai_cleanup` 来源和有效 gap 覆盖；旧 AI 来源恢复后，即使其他来源覆盖同区，也不能借此剪除旧词。单组连续 IDs 的同句多处支持边界已请求作者明确。
- C 的初版设计在 ready 阶段仍持槽并使用 30 分钟过期清理、最多 32 个诊断任务、下载期间取消后由 handler 结束文件访问再清理。初版 `run_command` 的 `reader.join()` 无超时，父进程退出但子进程仍持 pipes 时可能卡住；已要求真实继承 pipes 的子树用例和 shutdown 准入边界。这是基于 WIP 的设计风险，尚未绑定候选 SHA 或独立实证。
- C 的临时目录删除失败处理需要报告保留边界，不能在遗留文件情况下将“所有输出清理”写为已验证。

## A 独立候选复核

候选：`08b5fd2c49a957da7771ed10b4662cb3ce8d891a`；经父代理授权在 Q 树 cherry-pick 后为 `e525824b17cd166de4b33a76847f2c98192264f4`，与作者候选全树 diff 为空，独有 Q 报告未提交且不改变候选生产代码。

- 已逐项检查本地 config mutate/替换、canonical/detach epoch、服务端初始化/最近项目/接管/另存为轮换、普通保存身份不变、页面 config 与源的共同快照，以及 settings lock 内 source 校验后锁外 FFmpeg。
- 独立运行 `python scripts/run_tests.py tests.test_gap_removed_binding`：8/8 通过，证据 `.debug-runs/20261011T071251Z-1397e4ec/result.json`。
- 独立运行绑定与传输失败两个 Edge spec：13/13 通过，证据 `.debug-runs/20261011T071304Z-bec86a3e/result.json`。包含生产 canonical reload 与实际 Python 同路径 reopen 后旧身份 HTTP 409；保存器与文件句柄采用可控 fixture。
- 本候选范围内未发现可复现的 P1/P2。没有将 fixture 保存器等同于真实原生对话框、没有验证 FFmpeg 视频切点精度或完整产品回归。
- 原先服务端全局绑定与普通保存的跨标签并发语义没有扩大重设计；已接受导出固定 source/intervals 是本批既定合同。

## B 独立候选复核

候选与 Q 生产 HEAD：`7e8b02e4f9bc6ae995920f5f1234826a9f13b05a`（父代理授权 detach，生产树未改变）。

- 已审可选 keyword-only 回调的旧调用兼容；无取消回调仍走原字符串与 difflib 算法。有回调时使用字符串子类在索引和迭代检查取消，不复制算法或全局 monkeypatch。
- 已审普通与字词两匹配路径、时间重建/字幕循环、admission 与 ID 隔离、提交前检查及既有 `begin_commit` 锁。提交开始后不再误报取消。
- 独立匹配/取消/流水线/打包定向回归：109/109 通过，证据 `.debug-runs/20261011T071847Z-605a5fba/result.json`。
- 独立实际 Edge + 实际 Python Launcher bridge：普通与字词两路径 2/2 通过，证据 `.debug-runs/20261011T071914Z-678246e4/result.json`；真实计算停止后确认零输出，随后成功重启并产生文件。
- 本候选范围内未发现可复现的 P1/P2。没有重复作者全量 Python 结果，也不将这些定向结果描述成完整产品回归。原生 pywebview 未验收；同步文件读取、JSON 编解码、deepcopy、正则与单次内部比较仍在下一检查点响应，不能承诺所有输入固定毫秒级终止。
- Q 测试解释器为本树忽略目录中的无 pip venv，通过本地 `.pth` 只读复用锁定依赖；未更改全局 Python 或共享 site。

## C 第一候选：阻断并返修

生产候选：`ea600b1d6180fb5682d2d111f30355eb863fe004`；后续 Q 的测试提交不修改该生产源码。

- 独立控制器/HTTP/真实进程与 FFmpeg：17/17 通过，证据 `.debug-runs/20261011T072608Z-d65d45aa/result.json`。独立媒体任务 Edge：10/10 通过，证据 `.debug-runs/20261011T072718Z-70b534d9/result.json`，包含实际视频、实际 Python job 与生产页面 bundle。
- **P2：取消响应卡住导致前端无界等待。** `stopBackend` 的 30 秒 deadline 在 fetch/json 返回后才检查；真实 localhost cancel 端点不返回 headers、Edge 虚拟时间推进 31 秒后，仍无无法确认停止的提示且导出控件不能释放。失败证据 `.debug-runs/20261011T072628Z-809d65b8/result.json`。独有回归补 headers 和 json-body 两模式，测试提交 `84cebd8b65cccea59cb1d27328501ef0939b5586`。
- **P2：服务关闭早于下载结果清理。** 真实 32 MiB 慢 HTTP 下载连接保持不读 body，`shutdown()` 与 `server_close()` 返回时 job 仍未 disposed，私有结果和槽仍在；daemon HTTP worker 只能稍后清理，进程立即退出可能遗留结果。失败证据 `.debug-runs/20261011T072926Z-e8f16bf9/result.json`。测试提交 `2616054c88d819171f4a60026c02808a54ada293`；整理夹具为 composition 避免全套发现重复测试，没有重跑旧失败。
- A 独立控制器复查另报 P2：巨型单行没有 byte bound；迟到 ready 过期回调可取消已接受的 downloading 任务。两项由 A 向父代理/作者提供实证，不能当作 Q 自行运行的证据。
- 父代理已授权 C 同轮返修与接入这两个 test-only 提交。C 第一候选尚未通过最终 review；17/10 的通过结果不能覆盖上述两个复现失败。
- 新候选复审重点：取消 fetch/json 同一个有限期限；shutdown 中断 socket、等 handler 关闭文件再 dispose；download 注册与 shutdown/begin_download 的竞态不能漏传输；TTL 回调仅处理 ready，诊断输出真正按字节限额。

## C 返修候选独立复审

生产候选与 Q 测试 HEAD：`9878ffac8e6de55695862684728e1e507487ca3f`。

- 独立控制器/真实 HTTP/真实 FFmpeg/关服回归：23/23 通过，证据 `.debug-runs/20261011T073459Z-7e9f8b14/result.json`。包含此前失败的真实慢下载关服、下载注册与关闭竞态、巨型 stdout/stderr、迟到 ready TTL、真实子树、取消后旧结果不能下载与源文件保持。
- 独立实际 Edge 的媒体任务及挂起取消回归：14/14 通过，证据 `.debug-runs/20261011T073557Z-f9fd98eb/result.json`；headers/json-body 挂起均在共同期限退出并显示无法确认停止，不冒充后端已停止。
- 已审取消请求与 JSON 共用 `Promise.race` 期限并 abort；manager 同锁注册 socket shutdown callback 与 download admission；关闭在锁外等待文件释放后的 disposed event，有界等待失败明确报错；ready expiry 同锁只对 ready 生效；诊断按 UTF-8 字节限额截取/明确拒绝过大 probe JSON。
- 实际页面视频任务测试使用真实 FFmpeg、实际 Python endpoint 和生产 bundle；保存器与 writable 是 fixture。截图已查看；任务提示→进度条、进度条→停止按钮实测均 12 px，margin 均 12 px，panel padding 16 px。
- C 首轮四项 P2 的对应源码与独立定向回归已闭环；本返修候选范围内未发现可复现 P1/P2。没有验证所有媒体/磁盘故障、真实原生文件提交或完整产品回归，也不宣称 close 开始后仍能取消回滚。

## D 第一候选：消费者复核与返修

生产候选：`265468602ebf285c69087acb8eb571705eae982e`。Q 的独有测试与报告提交不修改该生产源码。

- 独立 Node 消费者：7/7 通过，证据 `.debug-runs/20261011T074035Z-2a455909/result.json`。独立 Python 实际 MOSP/SRT：7/7 通过，证据 `.debug-runs/20261011T074036Z-c380dbd4/result.json`。包括可信来源与有效 gap 的交集、原正文和 items 保留、普通/压时 SRT 与 ASS、TXT、动态字幕、OTIO/FCP、主副轨、恢复与失配来源。
- 独立实际 Edge + Python 服务：18/18 通过，证据 `.debug-runs/20261011T074035Z-a822fb94/result.json`，包含局部来源默认标点规整、CSS/Canvas、保存重开、gap 历史和 17 个实际 ASS 帧预览场景。已查看删除和恢复后的实际 Canvas 截图，没有把截图当作真实 LLM 验收。
- **撤回的单步探针结论：** 单独执行 `cleanPunctuation` 时，独立句尾标点 item 变空使投影暂时退回原文，Node 探针 `.debug-runs/20261011T074244Z-94d01e94/result.json` 失败。但实际启动顺序先进行 `normalizeProjectTimings`/`normalizeTimedTextNeutralItems`，已先合并末标点；prefix scope 不受影响。实际 AI 文件产物→整页 Edge 对照通过，因此该单步观察不判为用户 P2，不引入 empty witness schema，也未纳入持久化失败回归。
- **P2：中性标点合并改变局部范围的原 item 索引，媒体与字幕失配。** 实际 `run_ai_cleanup` 输入 items 为 `['我','我这个','，','功能','嗯','很好','呢']`，模型回调选择合法的第一项及第五项，Python 产物正确保留 `我这个，功能很好呢`。整页加载时纯逗号并入前项，原 7 项变 6 项，第二 scope 失效；CSS、Canvas、SRT/ASS/动态字幕重新显示 `嗯`，但其 810–930 ms 的媒体 gap 仍 removed。实际页面证据 `.debug-runs/20261011T074717Z-52cfa158/result.json` 及该测试输出目录的 `produced-project.json`、`consumer-snapshot.json` 和截图。
- 同一问题也发生在合法删除末尾废词和独立标点的组：`['正文','呃','。']` 选后两项，以及两组 `['我','我这个','呃','。']` 选第一项和后两项。安全端实际接受这些选择，Python 产物正确，整页消费回显 `呃`；证据 `.debug-runs/20261011T074820Z-00f6e0a9/result.json`。
- 独有纯测试提交 `1d0b9d17295f6eca16f73cd4713698f9b271bdcb`，仅 `tests/e2e/ai-cleanup-local-punctuation.spec.mjs`。冻结 5 例在原候选运行结果为 2 对照通过、3 实际页面失败，证据 `.debug-runs/20261011T074940Z-7b633811/result.json`；包括真实 AI 文件产物（仅模型响应为合成回调）、默认页面消费者、保存重开、恢复一组后另一组存续和全部恢复。所有测试 finally 关闭自己的服务及临时目录。
- **P2：投影之后未重排合并导出池，首条归零作用于错误的字幕。** 实际 AI 产物主轨原 start 为 0，prefix 删除后正文 start 为 300；独立叠加轨 start 为 100。JS 先按原 start 排序再替换主轨投影，普通 SRT 输出主 300 在前、叠加 100 在后。开启「首条字幕时间从 0 开始」后错误导出主 0–2000、叠加 100–1500；应按投影后的顺序导出叠加 0–1500、主 300–2000。真实 Edge 证据 `.debug-runs/20261011T075459Z-0aa2668c/result.json` 和测试输出的 `aligned-srt.txt`；Python 普通 `render_srt` 已按投影后时间排序。纯测试增量 `4cf631da80d1fb13625363d484f146fee7069be5` 增加第 6 例，未改生产源。
- 追加实际页面负例发现失效 scope 也可能被规整重新授信：原 item 索引错误、但 pure punctuation 合并后索引碰巧正确；原 scope.text 错误、但逗号规整后碰巧与新 item.text 相等。两例旧候选均错误删除文字，未选择 emoji 的保留对照通过；证据 `.debug-runs/20261011T080106Z-b98236cd/result.json`（1 通过、2 失败）。这是归一化准入保护的另一面，需要在最早规整前撤销原失效 scope 的剪字授权，不能只跳过迁移后留下可自愈字段。纯测试增量 `bcf723047c29541c1b46dc3cba40790c1ecdfe73` 后共 9 例；这些负例的截图/JSON 已另存 `.debug-runs/d265-negative-evidence`，避免 Playwright 后续运行覆盖。
- 已将真实 P2 交回 D 作者；父代理批准原任务写域内返修并接入 Q 的纯测试。原候选未通过最终消费者 review；上述常规通过结果不覆盖中性项索引漂移，必须在新的 exact SHA 上独立复审。
- 实际模型质量与 C01 原反馈复核样本仍未验证；独立译文没有可靠词级映射，保留原译文，不能猜删译文并声称语义同步。

## D 返修候选独立复审

生产候选：`f7bcd7524ca1088b5363c1e639994d961c1e2f6f`，由父代理授权在 Q 干净树 detach 后独立审阅与运行。此节的通过结果来自新 exact 候选，不能用上一节旧候选的通过结果替代。

- 源码复核：两个实际时间规整入口先捕捉精确有效的原 scope，原失效 scope 在任何项合并前剥离剪字权限；迁移依据原时间根、中性项归并结果与原文字严格匹配，不按文字猜找、不重新插值。未选 emoji 保留自己的原时间锚；只有空白、中文逗号/句号允许安全归并。候选范围及完整 items 重新精确核验，无法机械证明的 cue 统一转复核。
- 失败 cue 在所有成功 cue 迁移完成后统一替换 AI 来源，避免克隆来源让后续 snapshot 引用失效。只撤本次失败 cue 的可信局部 AI 范围；其他来源、manual overrides 和同范围普通标记保留。运行态 markers 数组保持数组，持久化对象保持 canonical object。合并导出池在文字投影后按实际 start 重排，首条归零据此取第一条。
- 独立 Node 消费者 10/10 通过：`.debug-runs/20261011T082150Z-fa7c1e9f/result.json`，命令 `node --test tests/test_ai_cleanup_local_export.mjs`。覆盖准入、真实 normalizer 迁移、失败→成功混合 cue、保留来源、TXT/SRT/ASS/动态字幕/OTIO/FCP、主副轨与恢复。
- 独立 Python 实际 MOSP/SRT 7/7 通过：`.debug-runs/20261011T082151Z-28d7f015/result.json`，命令 `.debug-runs/qa-venv/Scripts/python.exe scripts/run_tests.py tests.test_postprocess_ai_cleanup_local`。
- 独立实际 Edge 28/28 通过：`.debug-runs/20261011T082151Z-19058f3e/result.json`，三个 spec 为 `ai-cleanup-local-punctuation`、`ai-cleanup-local-export`、`ass-frame-preview`。包含真实 `run_ai_cleanup` 文件产物的 10 个消费者场景、保存重开/局部恢复/gap 历史，以及 17 个实际 ASS 帧预览场景；模型输出为合成回调。原逗号索引漂移、scope 内末标点、多个末组、错索引/错文字偶然自愈和叠加轨首条归零均已在新候选闭环。支持场景实际删词；失效旧 scope 不重新授信，但仍保留原普通音频 gap。
- 追加独有连续两失败回归：真实生产 normalizer 的运行态数组及 canonical object 两形态 2/2 通过，`.debug-runs/20261011T082704Z-880c1038/result.json`；实际 Edge + Python 保存重开 1/1 通过，`.debug-runs/20261011T082817Z-35f57fe8/result.json`。四个原本各自精确的局部 scope 在全项目重叠时码修复后全部撤销，四个 pending marker 不重复；同范围普通 marker、audio_gate、script_alignment 与 manual override 保留。实际 marker 面板显示「待复核」，保存重开后运行态仍为数组、全文保留且 AI 来源为空。该额外 fixture 是运行态维修场景，不将其描述为真实模型验收。
- 两份独有连续失败回归仅测试提交：`105e4e09d1b2cf5fbc48b699657ed57ceb6b5bf8`，没有改变候选生产源码。所有检查经 `scripts/run_check.py` 记录。独立 bundle fresh 检查通过，`.debug-runs/20261011T082148Z-7d301daf/result.json`。
- 已查看新候选逗号多组、末尾范围、恢复后 Canvas 及连续失败待复核的实际截图；截图与消费者 JSON 复制至 `.debug-runs/d-f7-independent-evidence`，避免后续 Playwright 覆盖。没有把撤回的单步空末项探针恢复为缺陷，也没有引入新 empty witness schema。
- 本返修候选范围内未发现剩余可复现 P1/P2。真实 LLM 的 C01 样本质量、真实原生保存器和完整人工产品验收仍未覆盖；独立译文缺乏可靠词级映射，按合同保留原译文，不声称逐词语义同步。

## 四路审查状态

| 包 | 最终独立生产候选 | Q 独立结论与验证 |
| --- | --- | --- |
| A | `08b5fd2c49a957da7771ed10b4662cb3ce8d891a` | 身份单元 8/8、实际 Edge 13/13；本范围未发现可复现 P1/P2 |
| B | `7e8b02e4f9bc6ae995920f5f1234826a9f13b05a` | Python 定向 109/109、实际 Edge/Python bridge 2/2；本范围未发现可复现 P1/P2 |
| C | `9878ffac8e6de55695862684728e1e507487ca3f` | 四项首轮 P2 已闭环；Python/HTTP/FFmpeg 23/23、实际 Edge 14/14 |
| D | `f7bcd7524ca1088b5363c1e639994d961c1e2f6f` | 真实索引漂移、失效 scope 自愈和导出排序已闭环；Node 10+2、Python 7、实际 Edge 28+1 全部通过 |

上述是四个缺口修复候选的独立定向结论，不表示十三包原计划已做完整产品验收。作者全量测试、其他代理独立探针和父代理整合检查各有记录，此报告没有将其计为 Q 的运行结果，也未创建或验证远端 PR。后续合入新上游若触及实际消费者或 markers UI，需要在新 exact SHA 上做受影响的窄复查。

## 新上游整合后的独立窄复查

新生产候选：`5da06f3d35d3981460a741dc9edf1b3e19965f83`，本地已确认包含上游 `8fdf3a7a82113b5539c9806549156a19251213b4`。经父代理授权在 Q 干净树切到该 exact SHA；此前报告 `f4ae0cf0a9878c694c63ba72e9a3eb0c53e5c438` 保留引用。

- 上游改动触及 marker 面板的字面搜索高亮、复核操作容器、共享 CSS 和生成 bundle。已读实际源码，搜索高亮仍以文本节点渲染；本轮 D 的 `editor-json-repair.js`、`editor-export-srt.js` 和 `gap-remove-core.js` 相对已独立复审的 `f7bcd752` 无差异。按照受影响范围窄复查，没有重跑无关协议或将旧全范围测试声称为新候选运行。
- 独立 Node 消费者及连续失败回归 12/12 通过，证据 `.debug-runs/20261011T083158Z-3ce9bfbb/result.json`；运行两个文件 `tests/test_ai_cleanup_local_export.mjs`、`tests/test_ai_cleanup_review_fallback.mjs`。
- 独立实际 Edge 6/6 通过，证据 `.debug-runs/20261011T083153Z-cc13427b/result.json`。定向覆盖：未选 emoji 两例（含独立末标点）、错误 scope 索引/文字两例、逗号多组及第一失败第二成功的实际 marker UI、两个 cue 连续失败的实际 marker UI 和 Python 保存重开。使用两个独有 spec 并按场景筛选，未将它描述为完整页面回归。
- 新候选的四 pending marker、同范围普通 marker、audio_gate/script_alignment/manual override 保留，以及重开后运行态 markers 数组都得到实际断言；失败 scope 未重新授信，支持场景仍实际删词。已查看实际待复核标记截图，输出另存 `.debug-runs/d-5da-independent-evidence`。
- 独立 `node scripts/build-editor.mjs --check` 通过，证据 `.debug-runs/20261011T083200Z-1ca1ba99/result.json`。
- 新整合候选的此次受影响范围内未发现可复现 P1/P2。前节真实 LLM、独立译文词映射、原生保存器及完整人工验收边界继续适用；报告没有声称已发布代码或已创建 PR。
