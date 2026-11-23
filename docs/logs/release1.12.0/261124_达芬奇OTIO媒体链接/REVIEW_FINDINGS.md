# 达芬奇 OTIO 媒体链接独立审查

目标分支 `main`，本地与获取后的 `origin/main` 均为 `37c11d1c`。

## 审查发现与处置

- **旧工程路径截断（P2，已修复）**。导出逻辑解析已有 `file://` 地址时，审查者对比工作树与基线，确认原样的 `#`、`?` 会被 URL 解析为片段和查询，旧表情包路径也会经过该逻辑。新增回归先得到错误的 `file:///media/legacy`，再验证两个字符保留在路径及片段名中。相关代码见 [路径转换](../../../../web/editor/io/editor-export-timeline.js#L239) 和 [导出回归](../../../../tests/test_ai_cleanup_local_export.mjs#L327)。
- **旧版外部打包适配器（P2，接受）**。审查者用 Python `urlparse` 验证，Windows 裸盘符会被识别为 scheme `c`，裸路径中的 `#` 会被识别为 fragment。OpenTimelineIO v0.17.0 的外部 OTIOZ/OTIOD 适配器按这些字段解析，某些特殊路径可能无法重新打包。MAW 自带的 OTIOZ 从绑定的原文件打包，并把媒体引用写成包内路径。[旧版适配器](https://github.com/AcademySoftwareFoundation/OpenTimelineIO/blob/v0.17.0/src/py-opentimelineio/opentimelineio/adapters/file_bundle_utils.py#L104) · [旧版路径解析](https://github.com/AcademySoftwareFoundation/OpenTimelineIO/blob/v0.17.0/src/py-opentimelineio/opentimelineio/url_utils.py#L52)

## 验证

- 基线导出的带百分号编码媒体引用在 macOS 达芬奇 Studio 21.1 的独立测试项目中无法链接。对照覆盖中文、空格、`#`、`?` 和字面 `%20`。通过 Chromium 下载使用实际路径的普通 OTIO 后，达芬奇将音频和视频都链接到源媒体。对用户的去空隙时间线只修改媒体路径再次导入，20 段视频及 20 段音频全部链接。
- Node 用例覆盖普通、去空隙与直接引用表情包的路径及片段名，包含 Windows 盘符和 UNC。旧实现按预期在路径断言失败。Chromium 下载用例还验证了同时导出 SRT 时两个文件都能下载，并核对了去空隙的片段范围。
- 相关 Node 31 项、Chromium 7 项、本地服务打包 3 项通过。编辑器构建、新鲜度和 TypeScript 检查通过。

## 验证边界

- Windows 仅验证导出字段，没有在 Windows 达芬奇中导入。其他 OTIO 消费方也未实测。
- OTIOZ 与服务器复制表情包的输出路径规则沿用现有实现。内联副本待发布前统一重生成。
