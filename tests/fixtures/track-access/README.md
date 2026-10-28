# v1 轨道读取 golden fixtures

基线：`feat/track-unification-p0p1@e6a2fa4b`，P0 在生产代码未修改时采集。全部文本、素材名均为合成数据，不附带真实媒体。测试只读 golden，不自动更新期望。

| 输入 | 覆盖 |
| --- | --- |
| three-tracks | 主 + 绑定双语副 + overlay；跨轨同 cue ID；items、speaker、换行、绑定 offset |
| unbound-secondary | 已绑定与未绑定副 cue；disabled；缺省 items 与空 items 的区别 |
| color-sticker-groups | 主/overlay 各自 headIdx=0 的颜色和表情组；关闭 overlay 文字；副轨 sticker 与未知字段探针 |
| frames | 三轨 29.97 FPS、整数毫秒与成对帧字段、词时间码 |
| manual-ass | 主/overlay 手动 pos/scale；副轨同字段保留而不应用 |
| legacy | 无 schema、ID、items 的旧工程；未知顶层扩展字段 |

每份 `.input.json` 对应 `.browser.json` 与 `.python.json`，记录 JSON round-trip 与完整 ASS/SRT 文本。浏览器额外记录副轨、双语、红色 SRT。两条出口是独立基线，不要求彼此相同：Python 基础 ASS 不输出副轨，也不实现浏览器完整排版/MASS/逐句定位。

JS harness 使用当前生产装配器，按 manifest 顺序编译 editor-utils、真实 multi core、timeline、overlay getter、JSON serializer、完整导出池 init 模块，并解析其静态 import；VM 的 window 与全局对象共用实时门面，不截取或剥离 ESM 源码；仅 UI 外围（预览外观、工作区、提示）使用固定依赖。浏览器 ASS 使用固定 Arial、1920×1080 与默认样式；Python 将默认字体函数固定为采集时的 PingFang SC，保留已冻结文本，避免跨平台默认字体造成假失败；不调用平台字体探测，不作为真实像素证据。JSON 比较忽略对象键顺序，ASS/SRT 则逐字节比较。Python 使用 normalize_project → serialize_mosp 与实际 render_project_ass / render_srt。

旧实现的限制也被冻结：JS normalize/保存重建副轨/overlay 轨元数据，副 cue 的未知字段和 sticker 不经保存白名单，主/overlay 保存时补 items/null 等；Python normalize 对旧工程补 schema/ID。P1 的“保留全部字段”指读取 adapter 零写入、旧出口与 P0 完全一致，不能借机修复旧 serializer 或把旧规范化变化说成无损。适配器往返测试另外验证传入 v1 全部字段不变（包含未知嵌套字段）。

更新 golden 必须逐份审阅行为变化，不能为让迁移测试变绿直接重录。复核入口：`tests/helpers/track-golden.mjs:browserOutputs`、`tests/test_track_golden.py:python_outputs`。原始采集脚本为本地临时输出；断言与输入、完整期望都入库，复现无需采集脚本。

## P0 语义冻结

- Z 定位起点、X 定位终点，参考时间由当前 pointer/playhead 设置决定；无主/副选择时按参考轨命中，有选择时仅接受一个逻辑字幕（主与其绑定副可共同选中）。主驱动绑定副，直接改副只改自身；多选、不同绑定组不操作。编辑输入框、模态框、修饰键、repeat 等守卫保持原样。
- 当前 Z/X 上层不枚举 overlay 选择；无主/副选择时 overlay 指针会回退命中主轨。这是已知缺口的基线，不是批准的新产品语义。P1 不补分派；后续命令阶段需维护者决定目标策略。
- overlay.enabled 只控制该文字轨是否进入文字预览/ASS/SRT；sticker 区间仍收集主 + overlay，不收副轨，ref 在原轨解释，跳过 disabled cue/disabled head，同素材去重。
- 表情总开关 stickersEnabled 和“预览表情包”开关共同控制预览与视频烧录；关闭任一个都不显示/烧录。ASS 单帧出口不带 sticker placements，不能据 ASS 单帧判断贴图烧录结果。
- 主与 overlay 已消费逐句 ASS pos/scale，副轨仅保存元数据，换回主轨可恢复；不把调研旧基线“仅主轨应用”的描述当作本分支预期。

上述 P0 文字是采集当时的历史证据，不代表后续版本的所有行为。工程 v1.5 与稳定组整合后，原始 v1 输入、`.browser.json` 和 `.python.json` 均保留；当前浏览器测试对 ASS/SRT 继续比较原快照，并对 `.v1.5.browser.json` 全量比较保存结果及保存重开稳定性，而不再要求编辑器写出旧 v1 JSON。逐 fixture 的差异审阅见组合整合记录；预览几何仍由测试固定外围依赖，不是实际布局或像素基线。`test_track_group_integration.mjs` 显式检查跨轨颜色和表情组、重开后的 CueRef、跨轨重名 ID 与绑定迁移。Python v1 输出继续对照原快照。

编辑器现在排除已关闭叠加轨上的贴纸，重新启用后恢复；表情总开关与预览开关仍共同控制预览和烧录。`test_track_semantics.mjs` 检查新版行为，旧行为的描述和快照保留供审查。完整键盘联动、浏览器拖动、像素及视频烧录仍由现有 e2e/人工层验收。
