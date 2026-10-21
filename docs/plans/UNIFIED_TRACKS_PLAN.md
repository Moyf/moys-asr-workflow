# 统一字幕轨道实施方案

状态：Python/JS 核心、编辑器运行态、生产与导出消费链已集成，自动化收尾与人工验收分别追踪。基线为最终 main `e6a2fa4b5ddd46479f7fa1d5c8d8cff1479de938` 创建的 `2.0dev`；独立分支向维护者 fork 提 Draft，不合并。

## 目标与版本边界

主字幕、双语副字幕、叠加字幕统一存入 `tracks[]`，编辑器运行态也只保留这一份轨道数据。角色继续表达现有功能差异，轨道的保存、遍历、稳定 ID、事务与撤销采用同一结构。此次保留现有字幕产品范围，不引入视频剪辑、多素材时序或音频混音。

新格式为 `moy.asr.project.v3`。PR #239 的 `moy.asr.project.v2` 已用于独立颜色/贴纸组，不能再把 v2 改为含义不同的 tracks 格式。导入接受无 schema 的历史 v1、显式 v1、PR #239 定义的 v2 和新 v3；保存只写 v3。未来或未知 schema 在迁移、修复、媒体绑定、文件写入之前拒绝。

PR 基于最终 `2.0dev`，向维护者 fork 提 Draft；不把未合并的 PR #239 整体带入基线。仅单独移植 v2 分组校验、旧引用转换和必要的保存内容契约，注明参考提交 `740953e2093c8a54fe17cabbe1b2d07d44ccd607`。PR #239 仍保持独立 Draft。两个 PR 日后整合时按函数与行为处理重叠，不通过整分支合并解决依赖。开始实现前必须复核最终基线和 PR #239 最新契约。

设计取证基线为 `079c050626e622670d1afd49587dc1856a36707e`：Python `maw/project.py`、JS `web/shared/utils/multi-subtitle.js` 分别处理三种容器；`editor-json-repair.js` 保存三套白名单；`editor-history.js` 与 `editor-state.js` 撤销、指纹也分别读取三套字段。这些位置均属于本次切换范围。

## 唯一数据模型

```json
{
  "schema": "moy.asr.project.v3",
  "media": "../clip.mp4",
  "media_metadata": { "video_fps_ratio": "30000/1001" },
  "timebase": { "unit": "milliseconds", "fps": 30 },
  "tracks": [
    {
      "id": "main",
      "role": "main",
      "name": "主字幕",
      "enabled": true,
      "language": "zh",
      "language_source": "detected",
      "split_mode": "continuous",
      "segments": [
        { "id": "cue-1", "start": 1200, "end": 2300, "text": "你好", "color_group_id": "color-1" }
      ]
    },
    {
      "id": "translation-en",
      "role": "extension",
      "name": "英语",
      "enabled": true,
      "language": "en",
      "split_mode": "word",
      "segments": [
        { "id": "cue-2", "start": 1250, "end": 2350, "text": "Hello", "color_group_id": "color-1" }
      ]
    },
    {
      "id": "overlay",
      "role": "overlay",
      "name": "叠加字幕",
      "enabled": false,
      "segments": []
    }
  ],
  "bilingual": { "display_mode": "both", "active_track_id": "translation-en" },
  "bindings": [
    {
      "id": "binding-1",
      "source_track_id": "main",
      "target_track_id": "translation-en",
      "source_segment_ids": ["cue-1"],
      "target_segment_ids": ["cue-2"],
      "start_offset_ms": 50,
      "end_offset_ms": 50
    }
  ],
  "subtitle_groups": {
    "next_id": 2,
    "color": [{ "id": "color-1", "value": { "name": "暖黄" } }],
    "sticker": []
  }
}
```

示例省略可选字段，实际校验仍检查媒体元数据等已有字段的完整约束。`tracks` 的顺序为稳定展示顺序；角色决定当前产品中的操作语义，不通过数组下标识别主轨。

### 轨道和字段归属

- 工程必须有且只有一个 `role: main`；新建工程也有一个空主轨。当前实现允许零或一个 overlay、任意现有数量的 extension。删除唯一主轨须转为清空内容，不能产生无主轨工程。
- 每轨统一拥有 `id`、`role`、`name`、`enabled`、`segments`；相同可选字段规则适用于三类轨道。`language`、`language_source`、`split_mode`、`timestamp_granularity`、`model`、`preserve_punctuation`、`source_name` 属于具体字幕来源，跟随轨道保存及角色交换。`metadata` 可用于新扩展；历史未知字段原样保留，不强制搬进 metadata。
- 顶层媒体引用、`media_metadata`、`timebase`、`gap_remove`、`markers`、`workspace`、`preview`、`script_alignment` 仍为工程属性。媒体文件里的音轨清单 `media_metadata.audio_tracks` 与字幕 `tracks` 是不同领域，不互相迁移。
- 旧 `multi_subtitle.main_split_mode` 是主字幕编辑覆盖值，映射到主轨 `split_mode_override`；原顶层 `split_mode` 映射到主轨 `split_mode`。不能任选其一覆盖，丢掉来源与用户覆盖之间的差别。
- 主轨 `enabled` 固定为 true；逐句禁用继续用 segment.disabled。overlay.enabled 原值迁入对应轨。旧 multi_subtitle.enabled 映射为各 extension.enabled。`bilingual.display_mode` 仅控制双语显示组合；`active_track_id` 引用一个 extension，不能指向 overlay/main。关闭后重新开启双语不删除轨道或绑定。
- 兼容已有活动副轨：有合法 active_track_id 则保留；缺失且有副轨时选择第一条，副轨为空时省略。显式悬空活动轨 ID 拒绝，不能保存时悄悄切换。
- 现有 preview 的主/副字幕样式槽位保持角色语义，渲染通过角色选取；无需在本次附加任意轨道样式管理功能。角色交换时保留内容来源元数据，按现有产品约定使用角色样式。

### 稳定标识与关系

- track ID 在工程内唯一；cue ID 跨所有轨道唯一；binding ID 在关系表内唯一。ID 长度沿用 160 限制。v3 显式 ID 必须有效，重复、空白和悬空引用均报带路径错误，不在保存时重命名。
- 轨道改名、排序、切换活动副轨不改变 ID。移动字幕保持 cue ID；复制产生新 ID。拆分保留原句 ID 给第一段，其余生成新 ID；合并保留第一段 ID，并在同一事务内更新绑定和组成员关系。
- `bindings` 是跨轨关系，与 tracks 同属工程，不能隐藏在某种轨道容器中。当前 source 必须是 main、target 必须是 extension；端点各一个 cue，保留数组形状支持未来独立演进。每个主句对同一副轨至多一条绑定，每个副句至多绑定一个主句；同一个主句可分别绑定不同语言副轨。
- offset 是目标端点与来源端点的实际整数毫秒差。联动移动时统一更新端点并重算 offset；独立移动副句时重算 offset；严格读取不接受与实际时间矛盾的显式 offset。缺省 legacy offset 在迁移时补齐并记录。
- 主副轨交换必须是单次事务：先依据两者已有一对一关系检查其他副轨的来源端点能否全部重映射；若不能则在改动前阻止交换并说明需先解除哪些关系，不能静默丢弃绑定。检查通过后交换角色，反转原主轨与被提升轨的绑定并交换两端，重映射其他副轨的来源端点；撤销恢复完整原状态。其他副轨绑定不能继续伪称来源为新主轨。
- 角色交换不复制或覆盖另一条轨的颜色 / 表情属性；每条 cue 保留自己的稳定组成员关系，重复交换可恢复同一工程内容。样式槽位仍按当前角色渲染。
- 跨 main/overlay 移动已绑定字幕时须按已有操作语义解除相关双语绑定并可撤销；不能保留指向错误角色的关系。不把双语绑定扩展为任意图结构。
- 普通主轨 / 叠加轨换轨保留 cue ID、group_id、组值和扩展属性；同组成员回到同轨后仍派生整体范围。旧 headIdx 只在轨内引用而强制拆成独立 head 的存储限制不再沿用。显式「移出颜色组」或删除中段仍将前后保留成员拆成独立稳定组；这与普通换轨是不同的用户操作。

### 分组、时间与导出

- `subtitle_groups` 延用 v2 的 `{next_id,color,sticker}`；cue 只保存 `color_group_id`/`sticker_group_id`。组范围由成员时间计算，不保存索引 headIdx 或第二份时间。颜色和贴纸解析统一遍历 tracks，可跨轨引用同一组。
- v1 的直接 color/sticker 与 headIdx 引用在原始轨道和原始数组上解析后迁移，不能先过滤 disabled 或排序再解析。v1 同一组的尾字段和自定义 value 字段保持。显式坏引用拒绝，不能静默降成默认颜色。
- cue 的 start/end 与 items 始终为源媒体整数毫秒；帧字段及 fps 沿用现有语义。三个角色都允许完整 cue 字段（items、speaker、assOverride、disabled、扩展字段）。不得因切成副轨丢掉词级时间或贴纸。
- 轨内保持原有时间有序及非重叠约束；跨轨允许重叠。v2 的零时长标点 item 兼容 PR #239 的语义；不能为统一轨道重新把这种 item 拉成 100ms 或改写 enclosing cue。
- gap_remove 只描述派生导出/播放映射，不修改任何轨源时间；烧录保持 `alignFirstStart: false`，独立字幕导出的首句归零选项另行执行。SRT、ASS、字幕预览和烧录从同一个轨道选择函数取输入；OTIO/其他剪辑导出保留既有产品选择，不无意多输出所有语言。
- 导出时选择主轨、启用 overlay、活动且启用的 extension，继续尊重现有单语/双语选择。未选择轨道保留在工程，不能在序列化时过滤。旧 v2 ASS 导出拒绝策略只有在正确解析 v2→v3 分组后才能替换。
- Resolve 外部协议继续写 `moy.asr_subtitle_editor.resolve.v1`，在导出边界按每条启用字幕展开颜色 / 贴图和自身时间。OTIO 贴图片段保持逐句区间与句间空隙；没有已验证的 Resolve v2 外部消费者，不借内部格式升级切换外部协议。烧录与 FCP 的显式组区间计划继续独立采用唯一组范围。

## 导入与保存边界

处理顺序为：识别版本 → 深拷贝候选 → 按原版本严格验证 → 执行明确迁移 → v3 严格验证 → 一次提交运行态。迁移返回 `{project, changes}`，changes 至少记录路径、类型和 ID 重映射。任何错误都不改输入对象、当前 DATA、撤销栈、dirty checkpoint、媒体绑定和磁盘文件。

| 输入 | 转换规则 |
| --- | --- |
| 无 schema / v1 | 顶层 segments 创建主轨；overlay_track 创建 overlay；multi_subtitle.tracks 逐个创建 extension；绑定换成显式两端；legacy 组转换为组表 |
| v2 | 相同轨道搬迁；保留组表与所有全局 cue IDs；严格拒绝已有跨轨重复 ID、无效组引用和 legacy 分组字段 |
| v3 | 只验证合法结构和引用；不补救显式错误、不回写三套旧容器 |
| 未来版本 / 非工程 JSON | 在任何字段归一化、repair、媒体绑定或写入前拒绝 |

v1 旧 cue ID 仅保证轨内唯一，跨轨重名可以合法存在。迁移先保留全部显式 ID，再按固定轨道遍历顺序为跨轨冲突与缺失 ID 确定性分配新 ID，同时用 `(旧轨,旧ID)` 映射更新绑定。保留既有唯一 ID；同一输入的 Python/JS 结果必须一致。轨内显式重复、错误 ID 类型等原本不合法的情况拒绝。新主轨/overlay 的 ID 必须避开既有副轨 ID。

未知顶层、轨道、cue、item、binding、组值字段保留，包括 false、0、空数组和空对象。旧 overlay 未知字段跟随对应轨，旧 multi 未知容器属性进入 bilingual，旧副轨未知字段跟随原轨。不要让 `...unknown` 覆盖 canonical 字段；有键位冲突时显式报错或采用已记录的迁移存储位，不能静默覆盖。原 schema 和已转换结构字段按映射移除，其余不能靠白名单筛掉。波形等已明确可丢弃缓存继续沿现行规则不落盘。

保存只深拷贝统一 project、剥离既定运行缓存、验证 v3、序列化；不 repair 当前 DATA。`serialize_mosp` 现有无条件 pop(schema) 再盖写版本的做法必须移除。旧生产者若尚在内部构造 v1，必须显式经过同一导入函数，不能伪标成 v3；最终所有项目生产入口直接构造统一轨道。

本地文件采用同目录临时文件、完成写入后原子 replace；验证与 JSON 序列化失败不碰原文件。服务器保存保留既有备份、save_lock、binding epoch / generation、switch intent、请求时内容快照及 ACK 后 checkpoint 比较。晚返回的旧工程保存不能清理新工程 dirty 状态，保存期间继续编辑也不能被 ACK 错标为已保存。

## 模块划分与接口

Python 与 JS 共享 JSON fixtures 和下列行为接口；命名可按语言规范调整，语义不可分叉：

- `importProject(raw)` / `import_project(raw)`：仅输入边界，返回独立的 v3 project 和变更报告；严格错误带 JSON 路径。
- `validateTracksProject(project)` / `validate_tracks_project(project)`：验证 v3，不能替调用者修复数据。
- `getMainTrack(project)`、`getTrack(project,id)`、`getTracksByRole(project,role)`、`iterSegments(project)`：返回统一 tracks 中的实体/迭代结果，无复制出来的第二套状态。
- `snapshotProjectContent(project)`：用于历史与保存 checkpoint，包含 tracks、bindings、subtitle_groups 及全部持久用户设置，排除播放状态、选择状态与派生缓存。
- `selectSubtitleTracks(project, exportOptions)`：显式导出选择；数据保存永不调用这个筛选函数。

| 实施块 | 归属文件与工作 |
| --- | --- |
| Python 格式核心 | `maw/project.py` 与新 `maw/project_tracks.py`：v1/v2/v3识别、迁移、轨道/绑定校验、统一遍历；必要时最小移植 `maw/subtitle_groups.py`；Python 契约测试 |
| JS 纯模型 | 新 `web/shared/utils/project-tracks.js`；`data.js`、`project-validation.js`、`multi-subtitle.js`、`history.js`，必要的组表模块；同一 fixtures 的 Node 测试 |
| 编辑器状态与交互 | `web/editor/state/`、`io/editor-project-load.js`、`editor-json-repair.js`、`editor-project-save.js`；cues/overlay/translation/preview 调用点；历史、dirty、恢复快照与稳定选择；相关 e2e |
| Python/导出消费者 | `maw/project_io.py`、`project_ass_export.py`、`postprocess_io.py`、`postprocess_translation.py` 及其它后处理生产/消费点；ASR 输出入口、`edit.py`、`server-editor`；JS `export-plan.js` 等纯导出消费者按接口联调 |
| 集成 | 脚本/模块清单、类型声明、现行 JSON_SCHEMA 文档、主索引、验证清单；最终 build/typecheck 与 PR |

先由核心与 JS 模型共同冻结最小示例及错误 fixtures，再并行实现。每一块只改自己拥有的路径，共享清单由集成人员统一更新。核心与各消费链先在初始 main 的独立 worker worktree 实施并验证；最终由集成人员将这些可审查提交移植到最终 2.0dev 创建的独立分支与 worktree，复验最终基线后提交 Draft PR。worker 的初始验证不能代替移植后的集成验证。

临时适配只可存在于独立的 legacy 导入模块；交付时 DATA 不得拥有 `segments`、`multi_subtitle` 或 `overlay_track`。不允许 getter/setter 长期伪造旧树，也不允许新增业务消费者读取旧容器。函数名称如 getMainSegments 可保留，但必须直接选择 main track.segments；一个统一 segment 数组允许有短期本地引用，不构成复制状态。

## 验证与最小可交付

| 验证层 | 必须覆盖的实际故障 |
| --- | --- |
| Python/JS 同夹具 | v1三轨与未知字段、v2跨轨组、v1跨轨ID碰撞、缺省ID、v3 round trip、future schema拒绝；输出深相等、输入不变、第二次导入幂等 |
| 无效输入 | 无/多主轨、角色错误、重复轨ID/全局cueID、悬空active/binding/group、offset不符、混合新旧容器、坏item时间；返回失败且不改变正在编辑的工程 |
| 操作事务 | 三类轨增删/编辑/拆分/合并、main-overlay移动、主副交换、活动语言切换；ID/metadata/关系不丢，undo/redo恢复同一project内容 |
| 保存并发 | 保存期间继续编辑、保存后undo回checkpoint、A保存迟到且已切B、绑定CAS冲突、无效导入/保存；旧ACK不能清dirty或覆盖新绑定 |
| 导出 | 有禁用首句的legacy headIdx颜色、跨轨color/sticker组、第二条翻译活动轨、叠加字幕重叠、5秒首句烧录保持5秒、gap-remove时间映射、ASS与SRT路由、媒体尺寸与音轨元数据 |
| 生产链 | ASR项目写出、后处理、翻译追加、CLI字幕/烧录、server打开/另存、浏览器纯本地导入；每条链写出的项目仅v3 tracks结构 |
| 浏览器人工 | 三轨编辑、播放、拖动、语言切换、关闭重开、原生文件选择；自动测试结果不能冒充此层验收 |

所有自动检查从当前 worktree 使用 `python scripts/run_check.py --timeout <秒> -- <命令>`，日志写 `.artifacts/checks/`。先运行目标 Python/Node 测试，编辑器源码变更后构建并检查 freshness，再 typecheck、相关 e2e 和 `git diff --check`。依赖复用遵循根 AGENTS；不生成便携 HTML。文档执行 check_docs 与其测试。

最小可交付是完整纵向切换：打开旧工程 → 统一 DATA 编辑 → 撤销/恢复 → 保存 v3 → 重新打开 → 主要导出/翻译链正常。仅新增迁移 helper、仅更换 JSON 外壳或仅支持新空白工程均不算完成。完成后允许旧字段名仅出现在 legacy 输入边界、历史夹具、迁移说明或其他独立第三方格式中；按作用域检查生产源码的残留读取。

后续可独立考虑多个 overlay、任意轨重排 UI、每轨独立样式、非一对一双语绑定；本次不为这些功能引入通用剪辑图或修改媒体时间轴。Draft PR 描述必须列出已实现范围、实际运行验证、尚待人工验收项目以及与 PR #239 的契约关系。
