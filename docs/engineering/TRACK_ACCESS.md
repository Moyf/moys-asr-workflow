# v1 轨道只读访问协议（P1）

这是内部读取层，不是新工程格式。`segments`、`multi_subtitle.tracks[*].segments`、`overlay_track.segments` 仍是唯一真源；不新增顶层 tracks、不写 CueRef、不变更 enabled/绑定/导出/选择/历史语义。

JS 工厂 `web/shared/utils/tracks.js:createTrackModule` 经 `editor-scripts.txt` / `editor-modules.json` 注册为 `project-tracks`，由 `editor-utils.js` 通过 `MAWE.resolve('project-tracks')` 取得并暴露到兼容门面。Python 对应 `maw.tracks`。运行不依赖 Node、外部 registry 或工程提供的代码。

| 协议 | JS | Python |
| --- | --- | --- |
| 创建访问器 | new LegacyProjectAdapter(project 或 getProject) | LegacyProjectAdapter(project 或 get_project) |
| 取当前工程原对象 | store.project | store.project |
| 全部轨道（含关闭/空轨） | tracks() | tracks() |
| 按运行时轨道 ID | getTrack(id) | get_track(id) |
| 原 segments 数组 | getSegments(id) | get_segments(id) |
| 当前 cue 与下标 | resolve({track_id, segment_id}) | resolve(dict(track_id=…, segment_id=…)) |
| 旧副轨 getter 原对象 | getLegacyExtensionTrack(原 ID 或 null) | get_legacy_extension_track(原 ID 或 None) |
| 旧 overlay getter 原对象 | getLegacyOverlayTrack() | get_legacy_overlay_track() |

TrackView 是冻结的临时描述，字段为 `id`、`role`、`legacyId`（Python `legacy_id`）、`enabled`、`source`、`segments`。`source`、`segments` 和 resolver 的 `segment` 均是输入原对象，绝不复制或冻结字幕树；主轨 source 是整个旧工程。enabled 只反映旧开关：main=true，secondary=multi_subtitle.enabled，overlay=overlay_track.enabled；disabled cue 仍可解析。无轨道对象/segments 的缺省轨不凭空创建。枚举不按 UI 首副轨筛选，也不表示开放多副轨 UI。

运行时轨道 ID：main=`main`，overlay=`overlay`，secondary=`secondary:` + 原副轨 ID（两个语言都有 secondaryTrackId / secondary_track_id）。副轨原 ID 可合法叫 main 或 overlay，因此必须命名隔离。原值仍在 legacyId 和 source.id，绑定继续用旧 ID，不写新 ID 到工程。role 仅在视图中将 extension 命名为 secondary，不增加 variant、样式策略或绑定模型。

CueRef 用 `{track_id, segment_id}`；resolve 返回 `{track, index, segment}`，未知/缺失/重复轨 ID 或 cue ID 返回 null / None，不选择第一个碰巧匹配的对象、不补 ID。旧无 ID 工程仍由既有加载/normalize 边界补稳定 ID。原始未规范化旧工程可枚举，但没有 ID 的 cue 无法用 CueRef 解析。输入校验继续归 `normalize_project` / 原浏览器加载层，不将读取器当 validator。

编辑器 `MaweMultiSubtitleCore.getTrackStore()` 返回绑定 `() => MaweBoot.DATA` 的同一个访问器，本身无规范化副作用。原 getExtensionTrack / getActiveExtensionTrack / getOverlayTrack 保留原来的懒规范化边界，再代理原对象。Python 尚无对应现存 getter 需要替换，不迁移任何生产者。

调用者在重排、删除、转轨、历史恢复或切工程后重新 resolve，不缓存旧 index 或 ResolvedCue。getProject 回调确保访问器不持有旧工程；TrackView 描述只代表当次源容器，保留旧 view 不会跨工程重定向。未采用 cue 索引缓存，避免给 P1 引入 revision/失效协议：枚举仅 O(轨数)，resolve 只扫描目标轨；不接入每帧渲染，不宣称已完成 TrackIndex 性能优化。

所有字段（含未知嵌套元数据、items、帧字段、speaker、颜色/表情、绑定）由原树保留。P0 golden 另锁定旧 normalize/serializer 的既有白名单损失与输出差异；本层不是 serializer，`store.project` 可交回原 v1 出口。详见 [golden 说明](../../tests/fixtures/track-access/README.md) 与 [P0/P1 交付报告](../logs/release1.10.0-beta.1/261027_轨道统一读取/交付报告.md)。
