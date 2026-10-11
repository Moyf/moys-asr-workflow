# MAW20 PR-D：可靠字词局部 AI 移除

基线 `09af19f13bd87fb46d7ea9849ef81ac76ddbe574`，分支 `code/maw20-ai-local-261011`。本任务只处理 G01；C01 那次全部待复核的真实输入、模型和 reason 没有提供，原因保持待确认。本轮没有真实 LLM 请求或费用，合成 items 的安全/协议验证不能冒充真实模型样片验收。

## 冻结协议和行为

- 旧 keep/review/discard 整段协议保持。局部 discard 可带 `removeItemIds` 单组，或 `removeItemRanges` 多组连续临时字词 ID 数组。两字段互斥；组内有序、连续、非空、唯一，组间递增不重叠。模型不返回毫秒、不估算字符时间。请求 `items` 用 JSON 字符串承载临时 `{id,text}`，兼容现有 transport 的 `dict[str,str]`，不发送工程稳定 ID、路径或字词时间。
- 本地只从整数、正时长、单调不重叠、段内、拼接严格对应源文本的 items 建立映射。精确 evidence 覆盖所有选组的原文拼接，不能用 altTakeId 混合局部裁决。所有组删除后的完整正文须有有效时间，字面覆盖对应文稿；数字、比例、否定/限定条件、独有内容保护保持。只机械核验填充词及相邻字面重启片段，任一组不可靠就整 clip 待复核。
- 每组写原有 `ai_cleanup` 来源和同范围 AI marker，新增最小 `cleanup_scope={segment_id,item_start,item_end,text}`（末索引 exclusive）。局部不改 raw 段的原文、items、ID、disabled 或绑定副轨。通读携带 partial、retainedText、removedText；该 clip 被复核时恢复本次全部局部建议。
- 投影只认仍存在且匹配主轨 ID、连续索引、精确原词、真实端点的局部 scope，并仅隐藏被最终有效 gap 完全覆盖的所选 item。带 scope 的来源端点必须原本就是整数且未经规整改变，不能通过四舍五入/字符串转换获得删词授权；普通 gap 仍兼容读取。旧整段 AI、普通静音、人工 review 来源不单独授权剪字。人工恢复或清除自动来源恢复字幕原词；其它来源及 review_marker_id 保留。部分 item 覆盖不猜位置。
- SRT、ASS、TXT、动态字幕、OTIO 字幕 marker、FCP/XML 主轨计划消费保留文字与保留 items。普通导出保留源时轴，去空隙导出再压缩时间。独立副轨译文/叠加轨仍按自身内容导出，局部切除不猜译文字符映射；绑定副轨不被整段禁用。
- 默认内建标点规整会将中文逗号/句号转换为编辑器空格。规整前已精确核验的 scope 在此确定性操作后同步对应 items 的新拼接文字。原失配 scope 不被修复；普通用户编辑导致失配仍保守保留文字。源编辑列表保持完整，实际播放字幕使用投影。
- CSS 播放以单个 raw cue 为输入获取保留内容；ASS Canvas 计划以全主轨投影为输入，缓存仍绑定 raw cue identity，并核验投影文字、时轴、颜色及完整 kept-items 签名。同字串/同起止但选择另一重复字词块仍失效；每帧生成的临时投影对象不会触发无意义重建。原生帧预览的 `buildAss({preview:true})` 入口也消费同一投影；没有改布局/动画算法。
- 复用现有 gap 单事务与派生审核控件，不引入新通用复合 history。新增 postprocess_io→script_alignment 导入的 local/OCR 冻结依赖已追加到 MAW.spec，并以包装契约验证。

## 最终验证账本

- 定向 Python 61 项通过：`.debug-runs/20261011T071028Z-c70e4d29/result.json`。包括原整段兼容、前缀/多局部、安全降级、通读恢复、输出 SRT、绑定副轨、其它来源和持久化。
- 最终完整 Python 在本树独立 `--without-pip` venv、只读 `.pth` 复用固定依赖、允许测试进程树回收的环境运行：1968 项，1938 通过、30 跳过，exit 0；`.debug-runs/20261011T073125Z-1627d9a4/result.json`。包括包装契约与最后精确端点准入。首次系统 Python/sandbox 运行 1974 项失败于子进程移除 PYTHONPATH 后缺 requests 和 taskkill 环境限制，保留 `.debug-runs/20261011T071256Z-f705d5df/result.json`，未修改测试掩盖失败。
- 最终完整 Node 578/578，使用已安装 Edge 和独立测试 Python：`.debug-runs/20261011T073121Z-6c6609b6/result.json`。覆盖实际生产 SRT/ASS/TXT/动态/OTIO/FCP/XML 消费者、默认规整、来源隔离、等字串不同 item 边界缓存与恢复。
- 真正 Server/Edge：局部保存重开/审核静音 history/CSS/Canvas 恢复及现有 ASS 换行、配色、旋转缩放 4/4；`.debug-runs/20261011T073126Z-e44f80ff/result.json`。追加局部实际渲染截图的最终运行 1/1：`.debug-runs/20261011T073224Z-342c26d1/result.json`。亲自核验 `.debug-runs/local-ai-evidence/local-cleanup-canvas.png` 仅显示保留正文，`local-restored-canvas.png` 恢复完整原句。Server 测试结束自动停止。
- 最终 typecheck：`.debug-runs/20261011T073319Z-0e4437bd/result.json`；ruff：`.debug-runs/20261011T073319Z-c806c950/result.json`；check:editor：`.debug-runs/20261011T073319Z-c299232c/result.json`，均 exit 0。生成物已按本树源码重建，便携 blank-editor.html 留到发布前统一生成。
- 真正 Server/Edge 的首次运行发现默认标点规整导致字段失配，已修正并采用默认入口验证；没有以 preserve_punctuation 夹具绕开问题。早期 DOM-free VM 结果未当作真实浏览器保存/播放证据。

## 默认字词归一化与导出顺序返修

默认工程入口先合并纯标点/符号 item，再规整中文标点。局部 scope 原索引会因此漂移；选组末尾的独立标点还会失去原结束边界。`normalizeProjectTimings` 和主轨 `repairTimingGroup` 现在先核验 scope，然后仅对可证明的 neutral 合并建立原索引到唯一真实时间锚的映射，集体核验所有组再提交迁移。选组端点只能恢复入口前精确授权的原整数端点。没有新增 schema 或放宽原始空 item。

未选 emoji/符号与已选字词不能混在同一个删词锚里：保留它的原时间锚，纯空白/中文逗号句号仍可机械归并。例如「正文 / 啊 / 😀 / 。」保留「正文 / 啊 / 😀。」再规整，实际输出「正文😀」，避免纯末尾标点规整成空 item。下一次保存不把这些受保护锚误报成新的时间修复。

入口前已失效的 scope 只剥离剪字权限，保留既有音频 gap，防止错索引/错文字在归一化后偶然正确而重新授信。入口前精确有效、但后续发现未知字词/时间变化而无法机械迁移的建议，撤回该 cue 的本次局部 AI 范围，使用来源替换和 effective-gap 重建 API 保留其它来源/手动覆盖。同范围且 note 可识别为既有 `[AI] 删除：` 的标记转为 pending；普通同范围标记不修改，没有可信 AI 标记则按现有 marker 规范新建复核项。这两种失效处理没有混为同一个裁决。

普通 SRT 的合并导出池在投影后稳定按实际 start 排序；主轨前缀删掉后若独立叠加轨更早，叠加轨先输出，首条归零也作用于正确的第一条。原主轨数组/items/配色索引不重排。

返修定向 Node（安全迁移、错误权限、未知变化撤回、其它来源/手动覆盖/普通 marker 保护、重复保存、跨 cue 一失败一成功）10/10：`.debug-runs/20261011T081742Z-b60e6ddd/result.json`。类型检查 `.debug-runs/20261011T081618Z-fc2d07e0/result.json` 和 bundle freshness `.debug-runs/20261011T081619Z-98e3d55d/result.json` 均通过。失败快照在所有成功 cue 提交后才统一替换来源，避免旧对象引用影响下一 cue；运行态 markers 继续保持数组，serialized 工程仍使用 canonical 字段形态。本轮只改 JS，Python 原完整结果仍有效；父代理合入 C 最终纯测试提交后负责整合完整回归。

实际 Server/Edge 默认入口最终 10/10（`.debug-runs/20261011T081705Z-a642724f/result.json`）：真实 `run_ai_cleanup` 产物到 CSS/Canvas/SRT/去空隙 SRT/ASS/动态、保存重开、只恢复一组及全恢复。跨 cue 附加场景在真实页构造重叠时码触发第一 cue 转 review、第二 cue 成功迁移，核验 runtime 标记数组、普通标记和待复核 UI、保存重开仍一致。Emoji+独立末标点的真实截图已核验仅显示「正文😀」。Q 的纯测试提交 `1d0b9d1`、`4cf631d`、`bcf7230` 已接入；`03f8cbca` 明示 fallback 合同按同文件 WIP 手工接入，并保留新增严格成功案例。

## 未验证边界

真实模型对 items 字符串和多局部协议的遵循程度、真实 ASR 时间质量、真实媒体接点、目标中文输入法、外部字体、原生保存器尚未验收。局部门槛没有根据缺失 C01 样本统一放宽；副轨没有可证实的字词对应时仅保留独立译文，不承诺精确局部翻译删词。

拟 CHANGELOG：AI 口播整理支持同句前缀、句中和多处口吃的保守局部移除；正文与副轨保留，字幕预览及导出按实际保留字词生成，不可靠引用与信息损失风险继续提示复核。
