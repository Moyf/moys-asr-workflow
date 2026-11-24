# FCPXML 仅标题 Draft：提交前审查

基线：`main` / `e7889e2f`。范围：共享源字幕投影、仅标题帧计划、Python 序列化与 ZIP、双语验收夹具。没有 Editor UI、服务器入口或源媒体模式，不发布功能。

## 独立审查与处置

独立审查发现 1 项 major、2 项 minor，均已处理；未发现 blocker。

| 问题 | 处置与复验 |
| --- | --- |
| Major：`web/shared/utils/fcpxml.js` 原先每个标题端点重复归并所有 Gap | 保留区间只构建一次，累加输出位置后用二分查找映射端点。`node .artifacts/bench-fcpxml.mjs` 在同一工作树的 2,000 条标题加 2,000 个 Gap 由审查测得约 11.91 秒降至 43 毫秒；另补首尾和重叠 Gap 测试。 |
| Minor：`web/shared/utils/fcpxml.js` 时长回退忽略已知源时长，且已还原的 Gap 会延长时间线 | 接受媒体时长字段但不需要路径；只用仍移除的 Gap 推断时长。`node --test tests/test_fcpxml.mjs` 覆盖原先的 1,000 / 6,000 毫秒偏差。 |
| Minor：`web/shared/utils/fcpxml.js` 冻结计划时可能连带冻结调用方传入的错误名称对象 | 提前拒绝非字符串名称；同一测试验证输入未被冻住。 |

## 验证

- 定向 Node 测试 403 项通过，覆盖现有 FCP 7、OTIO、SRT 和 ASS 相关行为；Python FCPXML 4 项、FCP 7 PNG 19 项通过。FCP 7 PNG 首轮因 `uv --no-sync` 环境缺 Pillow 无法载入，改用已安装 Pillow 的解释器完成复验。
- 编辑器构建与类型检查、文档链接检查及隔离官网检查和构建通过。
- `node tests/helpers/generate-fcpxml-smoke.mjs` 生成原始横屏（360 帧、8 条）和去空隙竖屏（330 帧、7 条）两个 ZIP。抽取的 XML 与离线 DTD 检验所用的 XML 逐字节一致。
- 两包通过离线镜像版 1.13 DTD 校验。镜像来源：[Cutlass `7231a7c`](https://github.com/andrewarrow/cutlass/blob/7231a7c7a56325ee324e4a59c7db366b996106fd/FCPXMLv1_13.dtd)，SHA-256 `5afbc7ca1001bbc2190fb3b21d4d440ce061d94f5a5f583074e982b4745cd04d`。文件标注 Apple 版权；官方开发者下载需登录，原版与再分发条款未独立确认，DTD 不入库。

## 放行边界

目标 Mac 尚未验证。Basic Title UID 取自公开参考，未和目标 Final Cut 1.13 的实机导出核对；时间线 lane 不保证画面避让。仅供 Draft 实测，需按[开发计划](../../../plans/FCPXML_EXPORT.md)核对改字、保存重开、回导和样式。无 UI 改动，未运行浏览器用例。
