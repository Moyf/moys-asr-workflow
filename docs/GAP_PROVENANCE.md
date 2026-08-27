# Gap 来源与可重建规范

状态：已实现（当前客户端）

本文定义 `gap_remove` 中空隙来源的记录方式，以及“只重新生成静音空隙、保留其他处理结果”的行为。它是 `moy.asr.gap_remove.v1` 的向后兼容扩展，不改变现有 `gaps` 的基本格式。

## 1. 目标

当前 `gap_remove.gaps` 只记录一个区间是否被移除：

```json
{ "start": 1000, "end": 2000, "removed": true }
```

这足以支持播放、导出和时间轴压缩，但无法回答以下问题：

- 这个 gap 是文稿对齐时自动禁用字幕产生的吗？
- 这个 gap 是波形静音检测产生的吗？
- 这个 gap 是用户手动添加、恢复、移动或缩放的吗？
- 重新扫描静音时，哪些 gap 应该被替换，哪些必须保留？

新规范需要同时满足：

1. 保持现有 MAWE 和旧工程的播放、导出行为。
2. 静音扫描只替换静音检测层。
3. 文稿对齐只替换文稿对齐层。
4. 用户的手动操作永远不会被自动重扫覆盖。
5. 重叠来源可以同时保留，不把来源粗暴压成一个字符串。

## 2. 来源命名

来源值使用 `snake_case`：

| 来源值 | 界面名称 | 含义 |
| --- | --- | --- |
| `script_alignment` | 对齐禁用 | 文稿录制对齐根据自动选择结果禁用字幕或 item 后产生的移除范围，例如未采用 take、失败句、重复句和默认禁用的不完整句。 |
| `audio_gate` | 静音检测 | 根据波形音量门限扫描得到的静音范围。现有 `detector: "audio_gate"` 继续表示检测器配置，但不再代表所有 gap 都来自静音检测。 |
| `manual` | 人工修正 | 用户直接添加、恢复、移动、复制、缩放 gap，或手动改变字幕启用状态而造成的 gap。 |
| `legacy` | 兼容输入（旧工程） | 工程没有可靠来源记录时的旧字段。读取时，启用的范围迁移到 `audio_gate`；旧的 `removed: false` 范围迁移为手动恢复覆盖。 |

`legacy` 仅作为兼容读取字段，不是新的持久化来源层。旧工程的 Gap 历史上由 gate 产生，因此迁移后使用普通自动静音的样式和重扫规则；不能用 `default` 作为来源名，以免误以为它是当前的生成方式。

## 3. 兼容性原则

### 3.1 `gaps` 是兼容投影，并可带派生来源

`gap_remove.gaps` 仍然是旧客户端播放、导出和时间轴压缩所需的兼容投影。基础字段保持不变：

```json
{ "start": 1000, "end": 2000, "removed": true }
```

新客户端可以在每个最终区间上附带以下派生字段：

```json
{
  "start": 1500,
  "end": 1800,
  "removed": true,
  "source": null,
  "origins": ["script_alignment", "audio_gate"]
}
```

`source` 和 `origins` 不是额外的来源真源，而是根据当前 `provenance` 与最终区间即时计算的方便字段。旧版编辑器忽略未知字段即可继续工作；新客户端在规范化时也会重新计算它们，因此不会把这两个字段当作唯一来源记录。

字段语义如下：

- `source` 表示这个区间最开始来自哪个来源，也就是初始 lineage。手动编辑一个自动 gap 后，`source` 不会因此变成 `manual`。
- `origins` 表示当前区间实际由哪些来源层共同贡献，按稳定顺序去重排列。
- 只有一个非 `manual` 来源时，`source` 为该来源；多个非 `manual` 来源重叠时，`source` 为 `null`，具体集合看 `origins`。
- 没有自动或旧来源、只有人工覆盖时，`source` 为 `manual`；没有任何来源时为 `null`。

如果旧版编辑器保存工程并丢弃未知字段，新客户端会依据剩下的顶层 `gaps` 迁移：`removed: true` 进入 `audio_gate`，`removed: false` 进入 `manual_overrides`。迁移前后的最终播放、导出范围保持一致；需要保留更细来源时，必须保留 `provenance`。

`gaps` 是由来源层和人工覆盖计算出的、互不重叠的最终视图；它仍然是旧客户端播放和导出的唯一必需数据。`provenance` 则是新客户端重算和分层重扫的真源。

### 3.2 provenance 是可选扩展

在 `gap_remove` 下增加可选的 `provenance`：

```json
{
  "schema": "moy.asr.gap_remove.v1",
  "gaps": [
    { "start": 1000, "end": 2400, "removed": true },
    { "start": 3000, "end": 3400, "removed": true }
  ],
  "provenance": {
    "schema": "moy.asr.gap_provenance.v1",
    "sources": {
      "script_alignment": [
        { "id": "align-001", "start": 1000, "end": 1800 }
      ],
      "audio_gate": [
        { "id": "silence-001", "start": 1500, "end": 2400 }
      ]
    },
    "manual_overrides": [
      { "id": "manual-001", "start": 3000, "end": 3400, "removed": true }
    ],
    "legacy": []
  }
}
```

所有时间仍然是整数毫秒，区间使用半开范围 `[start, end)`。provenance 中的 `id` 只用于稳定识别来源记录，不需要出现在兼容的 `gaps` 中。

字段语义：

- `sources.script_alignment`：对齐层当前贡献的移除范围。数组中的每项都表示 `removed: true`。
- `sources.audio_gate`：静音检测层当前贡献的移除范围。数组中的每项都表示 `removed: true`。
- `manual_overrides`：人工覆盖层。普通记录中，`removed: true` 表示强制移除，`removed: false` 表示强制恢复声音；后面的项覆盖前面的重叠部分。边界调整记录使用 `operation: "boundary_resize"`，保存 `edge`、`base`、`boundary`，以及可选的 `cleared_ranges`；整体移动记录使用 `operation: "move"`，保存 `base_start`/`base_end` 与 `target_start`/`target_end`。如果旧移动的目标被后续操作从中间盖住，记录改用 `target_ranges` 保存剩余的多个目标片段（可以为空，表示 base 仍需保持清除）。这些都是对已有 Gap 的内部控制记录，不是要显示出来的恢复层。整体移动始终按用户看到的整条 Gap 处理：清除原可见范围，再把相同状态放到固定长度的目标范围；同状态的被覆盖 Gap 被完整吸收，异状态的被覆盖部分只裁掉重叠范围。
- `legacy`：兼容读取字段。规范化时不会继续保留该层：`removed: true` 迁入 `sources.audio_gate`，`removed: false` 迁入 `manual_overrides`，因此输出中的 `legacy` 为空数组。

## 4. 最终 gaps 的计算

`gaps` 是派生结果，不是来源记录的替代品。生成最终视图时按下面的优先级处理：

```text
人工覆盖 manual_overrides
    > 自动来源 script_alignment + audio_gate
```

计算规则：

1. 先把兼容的 `legacy` 输入迁移：启用范围归入 `audio_gate`，恢复范围归入 `manual_overrides`。
2. 合并 `script_alignment` 和 `audio_gate` 的移除范围。
3. 按数组顺序应用 `manual_overrides`；普通记录中 `removed: true` 增加移除范围，`removed: false` 在重叠处恢复声音。`operation: "boundary_resize"` 先清除其 `cleared_ranges`，再按 `edge`、`base` 和 `boundary` 调整被拖动 Gap 本身；边界不联动相邻 Gap。无论启用还是未激活 Gap 向内缩小时，被让出的边缘都会从最终投影清除：未激活 Gap 不会因此写入或露出 `removed: true` 空隙。向外拖动时，完整覆盖的可见 Gap 以整段写入 `cleared_ranges`，部分覆盖只写入交集，故回拖时已覆盖部分不会复活。`operation: "move"` 清除原可见范围，再把同一状态放到固定的目标范围。目标覆盖到同状态 Gap 时完整吸收该 Gap，覆盖到异状态 Gap 时只裁掉重叠片段；若异状态 Gap 本身来自旧移动，只裁其 `target_ranges`，不删除整条记录或让旧 base 重新出现。两种操作都不会通过追加旧范围的 `removed: false` 来制造恢复碎片。
4. 将结果切分成互不重叠、按时间排序的 `gaps`。
5. 只把 `removed: true` 的区间用于跳过播放、去空隙字幕和 OTIO 导出；`removed: false` 继续表示用户恢复的区间。

当一个最终区间同时覆盖多个来源时，不需要把它命名为单一的 `mixed`。重新计算时应保留各来源层，并在最终 `gaps` 上派生出：

```json
{
  "start": 1500,
  "end": 1800,
  "removed": true,
  "source": null,
  "origins": ["script_alignment", "audio_gate"]
}
```

这里的 `origins` 会写入当前客户端生成的 `gaps`，但仍然只是派生信息；持久化和重算仍以 `provenance` 为准。

## 5. 三类操作的规则

### 5.1 重新扫描静音

“扫描并移除静音空隙”只替换：

```text
provenance.sources.audio_gate
```

它必须保留：

- `sources.script_alignment`
- `manual_overrides`
- 播放跳过开关、检测参数和其他 gap 配置

扫描完成后重新计算 `gaps`。因此，用户手动添加的 gap 不会被删除，文稿对齐产生的禁用范围也不会被静音扫描覆盖。

「收缩空隙」也属于 `audio_gate` 的批量重建：它直接缩短 `sources.audio_gate` 中的区间，再重新计算最终 `gaps`，不会在原区间两侧追加 `removed: false`，也不会因此新增 `manual_overrides`。已有的人工覆盖仍按原规则保留。

### 5.2 重新运行文稿匹配/对齐

对齐工具只替换：

```text
provenance.sources.script_alignment
```

它必须保留 `audio_gate` 和 `manual_overrides`。兼容 `legacy` 输入会在读取时先迁入这两层；如果媒体时间轴发生变化，导致旧的人工范围无法安全映射，应明确提示用户，而不是静默移动这些范围。

### 5.3 用户手动操作

用户操作不直接修改自动来源层，而是写入 `manual_overrides`：

| 用户操作 | 写入方式 |
| --- | --- |
| 空白处添加 Gap | 增加 `removed: true` 的人工覆盖 |
| 恢复一个自动 Gap | 增加覆盖相同范围的 `removed: false` |
| 整体移动 Gap | 写入一条 `operation: "move"` 记录，保存原范围和固定长度的目标范围；同状态目标 Gap 被吸收，异状态目标 Gap 只裁掉重叠部分；重复移动更新这条记录 |
| 拖动 Gap 边界 | 写入一条 `operation: "boundary_resize"` 记录，保存 `edge`、原边界 `base`、当前边界 `boundary` 与被跨越的 `cleared_ranges`；缩小范围时直接缩短 Gap，不追加 `removed: false`。向外拖到另一 Gap 时，完全覆盖整段清理，部分覆盖只缩减对方的重叠部分 |
| Ctrl/Cmd 复制 Gap | 保留原范围，并增加新范围的 `removed: true` 人工覆盖 |
| 手动禁用字幕 | 将对应时间范围写入 `removed: true` 的人工覆盖 |
| 手动重新启用字幕 | 将对应时间范围写入 `removed: false` 的人工覆盖 |
| 清理 Gap 记录 | 从各来源层删除选中范围内的记录，不增加 `removed: false` 覆盖 |

这样，用户只要恢复或调整过一个自动 gap，它就不会在下一次自动扫描时被当成纯自动结果覆盖。边界调整和整体移动记录会在重建时继续控制同一条 Gap；重复拖动只更新原记录，不会不断追加恢复碎片。边界向外穿过另一个 Gap 时，只移动被点中的边界：完全覆盖的对方整段清理，部分覆盖的对方只保留未覆盖部分；这些覆盖范围会保留在当前边界记录中，因此回拖后不会从旧来源或旧操作记录中露出。移动【已恢复】时原位置会变成普通音频区域，移动到其他 Gap 上时不会改变被拖动 Gap 的长度：同状态目标会被吸收，异状态目标仅缩小被覆盖部分。清理是删除当前来源记录的操作；如果之后重新扫描又检测到同一段静音，它可以重新出现。需要跨重扫保留“这里不应移除”的决定时，应使用人工恢复，而不是清理。

### 5.4 显示投影缓存

来源层重算出的最终 `gaps` 是唯一的时间轴投影。前端把它转换为包含 `removed`、`source` 和 `origins` 的显示投影后，按输入数组身份缓存；编辑器的 Gap getter 在一次状态版本内返回同一数组，多个波形行、Gap 列表、播放和导出都复用它。任何 Gap 改动都必须创建新的状态/数组，不能原地修改缓存输入。

`manual_corrections` 继续保留，作为旧客户端可读的全局摘要；新客户端可以根据 `manual_overrides` 是否为空计算它，但不能用它推断某个具体 gap 的来源。

## 6. 旧工程迁移

打开没有 `gap_remove.provenance` 的工程，或读到早期客户端写出的 `provenance.legacy` 时：

1. 将每个 `removed: true` 范围迁入 `sources.audio_gate`。
2. 将每个 `removed: false` 范围迁入 `manual_overrides`，保持原有的恢复播放结果。
3. 清空兼容字段 `legacy`，并将 detector 规范化为 `audio_gate`。
4. 使用普通静音空隙的样式；「收缩空隙」、清理和重新扫描都按 `audio_gate` 处理启用范围。

这项默认基于 MAWE 旧工程的实际来源：历史 Gap 通常由静音 gate 产生。它让旧的启用 Gap 能在下一次重新扫描时被替换；旧的恢复状态仍然作为人工决定保留。

### 旧版客户端的行为

- 旧版 MAWE 读取新工程时会忽略 `provenance`，仍按 `gaps` 正常播放和导出。
- 旧版 MAWE 保存工程时可能丢弃未知的 `provenance` 字段；再次打开时，新客户端会将启用 Gap 重新归入 `audio_gate`，将恢复 Gap 归入 `manual_overrides`。
- 只有支持本规范的新客户端才能保证来源信息在编辑、撤销、导出和重新扫描之间持续保留。

## 7. 界面行为

`provenance`、`source` 和 `origins` 是内部数据，不应把来源层渲染成多层用户界面。普通时间线和 Gap 列表显示最终投影中的 `removed: true` 和 `removed: false` 区段，但两者仍然各自只显示一个最终块：前者是启用的 Gap，后者是人工恢复、保留可见但不参与播放跳过、去空隙和导出的 Gap。相邻且状态相同的最终区段应合并。

正常编辑交互仍然只有一种 Gap。来源层不会堆叠成多层区块；最终可见区间会保留一份临时的显示类型，用于短标题和轻量样式提示：

| 显示类型 | 判定条件 | 静音重生成时的行为 |
| --- | --- | --- |
| 静音空隙（自动生成） | 只有 `audio_gate` | 静音检测结果会被替换 |
| 静音空隙（自动生成+手动调整） | `audio_gate` + `manual` | 只替换静音部分，手动调整保留 |
| 跳过空隙（手动创建） | 只有 `manual` | 保留 |
| 台本对齐自动移除 | 只有 `script_alignment` | 保留 |

此外还有重叠来源的兜底类型：`自动移除（多来源）`、`台本对齐自动移除（手动调整）` 和 `自动移除（多来源+手动调整）`。它们都使用与普通 Gap 一致的斜纹外观，只通过边框颜色和一圈很淡的内描边提示“这段不是纯静音自动结果”，不把 `source/origins` 暴露成用户需要管理的对象。旧工程迁移后的纯 `audio_gate` 保持原样式。

拖动和缩放应针对这个最终可见投影执行，然后以人工覆盖写回内部来源层。整体移动仍然记录旧范围与新范围；边界拖动则更新同一条 `boundary_resize` 记录，最终投影只保留一个连续的 Gap 或恢复区段，不在边缘插入“已恢复”碎片。相邻的启用和恢复 Gap 是两个独立对象：边界只移动被点中的一侧，向外覆盖对方时按完整覆盖清理、部分覆盖缩减处理。清理则从来源层删除选中范围。这样即使一个可见 Gap 内部跨过多个来源或恢复覆盖，用户看到的仍是单层的启用/恢复状态，而不会看到 provenance 的重叠层；边界把手、整体拖动和边界拖动预览统一使用蓝色，表示当前正在进行人工修改。

重新扫描按钮的说明应明确为：

```text
只重新生成“静音检测”来源；对齐禁用和人工修正会保留。旧工程启用 Gap 已归入该来源，因此会被替换。
```

如果以后提供“清空并全部重扫”，它必须是独立的破坏性操作，并明确说明会删除人工覆盖和未知来源范围。

## 8. 实现验收条件

实现本规范时至少需要覆盖以下行为：

1. 没有 provenance 的旧工程加载后，播放和导出的有效 `gaps` 与原文件一致；启用范围迁入 `audio_gate`，恢复范围迁入 `manual_overrides`。
2. 重新扫描静音只替换 `audio_gate` 层，包含由旧工程迁入的启用范围。
3. 重新运行文稿对齐只替换 `script_alignment` 层。
4. 手动添加、恢复、移动、复制和边界缩放结果在两种自动重扫后仍然存在；同一边界重复拖动只更新一条内部调整记录；清理结果不额外留下恢复覆盖。
5. 对齐范围和静音范围重叠时，两种来源都可以恢复和重新计算。
6. 旧版客户端至少可以正常读取和使用最终 `gaps`；新客户端在旧客户端丢弃 provenance 后能再次完成相同迁移。
7. `gaps`、来源层和人工覆盖都进入同一套撤销/恢复快照，避免撤销只恢复可视结果而丢失来源记录。

本规范落地时，需要同步更新 `JSON_SCHEMA.md`、MAWE 的规范化/导出逻辑、对齐 Server 的输出逻辑，以及静音扫描和人工 Gap 操作的测试。
