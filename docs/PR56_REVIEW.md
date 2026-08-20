# PR #56 审核报告

审查对象：`feat(editor): Premiere FCP7 XML 交接导出`

审查时间：2026-08-20

审查结论：**暂不合并**。

PR #56 当前还处于 `CONFLICTING / DIRTY` 状态，不能直接合并到最新 `main`。除了解决分支冲突外，代码本身还有两个高优先级行为问题需要先修复；其余问题按中低优先级处理。

## 一、必须修复

### 1. FCP7 XML 的源素材帧范围与时间线帧范围取整不一致

严重程度：**高**

涉及位置：

- `web/editor-utils.js`：`serializeFcp7Xml()`
- `web/editor-utils.js`：`fcpTimeRange()`
- `web/editor-utils.js`：`boundaries` 构建逻辑

当前实现对同一个时间区间使用了两套不同的帧计算规则：

- `<in>/<out>`：起点 floor，终点 ceil；
- `<start>/<end>`：通过每个区间的 duration floor 累加，最后再把总末端强制改成整体 duration 的 ceil。

对于不是整帧边界的常见 ASR 毫秒时间码，这会导致：

```text
out - in != end - start
```

这在 FCP7 XML 中不是单纯的显示误差，Premiere 可能将其解释为素材重定时，造成片段播放速度或边界漂移。

审查时使用 PR 自带的序列化逻辑、30000/1001 fps、去除两个静音区间的样例，观察到源帧范围和时间线范围出现 ±1 至 ±2 帧差异；整体 sequence duration 为 147 帧，但各片段源范围合计为 149 帧。

#### 修复要求

统一同一片段的帧区间来源。推荐做法之一：

1. 先为每个保留区间计算唯一的 `{ sourceStartFrame, sourceEndFrame, duration }`；
2. `<in>/<out>` 与 `<start>/<end>` 都使用这个结构；
3. 对每个 clip 加入不变量检查：`out - in === end - start`。

不要仅修改测试中的期望值，而要保证任意非整帧毫秒区间都满足该不变量。

#### 验收标准

- 覆盖整数帧和非整数帧时间边界；
- 覆盖 `30` 与 `30000/1001` fps；
- 覆盖 source timeline 和 gap-removed timeline；
- 单测验证每个视频、音频、贴图 clip 的 `out - in === end - start`；
- 生成的 XML 可被 XML parser 解析。

### 2. 多段字幕贴图导出回归：OTIO / Resolve JSON 只导出首段

严重程度：**高**

涉及位置：

- `web/editor.js`：`assignSticker()`
- `web/editor.js`：`collectStickerOtioEntries()`
- `web/editor.js`：`buildResolveJson()`

PR #56 将多选字幕分配贴图时，head 的贴图时间范围从“首条字幕起点到末条字幕终点”改成了 head 自己的 `start/end`。这个改动对 FCP7 XML 的逐段导出意图是合理的，但现有 OTIO / Resolve 导出仍假设只有 head 带有完整贴图时间范围，并且跳过 `sticker_ref` 后续字幕。

结果是：对 N 段字幕执行一次多选贴图分配后，旧的 OTIO / Resolve 导出只会输出第一段，后续引用段会静默丢失。

#### 修复要求

统一贴图分组在各导出器中的语义：

- head 负责提供素材身份；
- 每个启用的字幕段负责提供自己的时间范围；
- `sticker_ref` 必须解析回 head 的素材信息，但使用当前 segment 的 `start/end`；
- 禁用字幕、悬空引用、自引用要有明确的跳过或 warning 规则。

可以选择：

1. 更新 `collectStickerOtioEntries()` 和 `buildResolveJson()`，逐段解析 `sticker_ref`；或
2. 在进入导出器前，将分组展开成每段一个独立导出条目。

#### 验收标准

- 选择 3 段字幕并分配同一贴图；
- OTIO 输出包含 3 个时间段，分别对应 3 段字幕；
- Resolve JSON 输出同样包含 3 个时间段；
- 不再把中间间隔压成连续长片段；
- 禁用其中一段后只输出剩余两段；
- 增加至少一个端到端或集成回归测试。

## 二、应一并修复

### 3. CHANGELOG 缺少 PR #56 汇总条目

严重程度：**中**

`CHANGELOG.md` 的 `[Unreleased]` 没有 Premiere FCP7 XML 交接导出记录。请按 PR 粒度增加一条汇总，不要把每个内部 commit 拆成多条。

建议内容：

```markdown
- PR #56：新增实验性的 Premiere FCP 7 XML 交接导出，支持去空隙 / 原始时间线、可选原生 GraphicAndType 字幕文本、贴图素材路径和扩展字幕轨导出。
```

同时保留“尚未在 Premiere 实机确认图片自动重链和字体显示”的限制说明。

### 4. 贴图宽高字段没有同步写入 JSON_SCHEMA.md

严重程度：**低**

PR #56 将图片 `width` / `height` 写入贴图 payload，并会随工程持久化；但 `JSON_SCHEMA.md` 的贴图 head 定义仍未说明这两个字段。

请在贴图 schema 中补充：

- `width`：可选正整数，原始图片宽度；
- `height`：可选正整数，原始图片高度；
- 旧工程缺失时，导出器使用现有默认值或明确的兼容规则。

如果 schema 被视为正式契约，还应补对应测试和 changelog 说明。

### 5. scan_stickers 对无法读取尺寸的图片静默跳过

严重程度：**低至中**

`edit.py` 的 `scan_stickers()` 对 `image_dimensions()` 的 `OSError / ValueError` 直接 `continue`。这会让损坏、截断或暂时无法解析的图片从贴图库中消失，用户没有任何提示。

请二选一：

- 保留图片并省略尺寸，前端 / 导出器使用兼容默认值；或
- 继续跳过，但输出可理解的 warning 和跳过数量。

需要增加一个损坏图片或不可解析图片的测试，锁定预期行为。

## 三、可选清理

### 6. XML + SRT 顺序保存链路目前没有接入实际 UI

严重程度：**低**

`saveSequentialExportArtifacts()` 和 `buildFcp7ExportArtifacts()` 已实现并有单测，但 `exportFcp7Xml()` 只取第一个 XML artifact 并下载，SRT artifact 没有实际保存。

请明确产品契约：

- 如果 PR #56 只承诺 XML 导出：删除未接入的 XML + SRT 保存死代码和误导性文案；
- 如果要同时导出：接入完整的 XML-first / SRT-second 保存流程，并处理取消、失败和部分成功状态。

不要让测试覆盖一个用户界面永远不会调用的流程而不加说明。

### 7. Premiere 专有结构仍需实机验证

严重程度：**信息项，不阻塞代码合并，但必须保留限制说明**

以下内容不能仅凭 XML parser 验证：

- 贴图 clip 使用的 `masterclipid` 是否需要对应 `<masterclip>` 定义；
- 贴图 still 的 `<in>/<out>` 使用完整素材长度是否符合 Premiere 预期；
- GraphicAndType payload 的固定字节头和字体 payload 是否被目标版本 Premiere 接受；
- Windows / POSIX / UNC 路径在 Premiere 中的自动重链行为；
- 目标机器缺少字体时的显示和回退行为。

PR 描述中已经承认 Premiere 实机验证未完成，这些限制应继续显示在 UI 或文档中，不要把 parser 通过等同于 Premiere 导入通过。

## 四、安全与服务器检查

审查中暂未发现新的高风险安全问题：

- `/api/prproj` 当前只返回 501 capability 响应，不解析用户提交的 output 路径，也不写文件；
- `/api/prproj-capability` 返回静态能力信息；
- Server 仍只监听 `127.0.0.1`；
- 文件 URL 转换逻辑在浏览器端运行，不新增服务端任意路径写入接口。

## 五、合并前清单

- [ ] PR 分支更新到最新 `main`，解决 `CONFLICTING / DIRTY`；
- [ ] 修复 FCP7 clip 的帧范围不变量；
- [ ] 修复多段贴图的 OTIO / Resolve JSON 导出；
- [ ] 增加对应回归测试；
- [ ] 更新 `CHANGELOG.md`，按 PR #56 增加一条汇总；
- [ ] 更新 `JSON_SCHEMA.md` 的贴图宽高字段；
- [ ] 明确 `scan_stickers` 尺寸解析失败策略并补测试；
- [ ] 运行 JavaScript 单测、Python 单测、FCP7 e2e 和 `git diff --check`；
- [ ] 在至少一个真实 Premiere 版本中确认导入结果，单独记录实机验证边界。

## 六、当前审查结论

PR #56 的核心方向可以继续，但目前不是可合并状态。建议对方 agents 按“帧范围一致性 → 多段贴图导出 → schema / changelog → 实机验证”的顺序修复，完成后重新请求 review。
