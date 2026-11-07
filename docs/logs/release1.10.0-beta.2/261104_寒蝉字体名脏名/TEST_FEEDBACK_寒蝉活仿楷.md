# 测试反馈：寒蝉活仿楷脏名与预览字体回退

## 反馈记录

| # | 反馈 | 状态 | 涉及 |
|---|---|---|---|
| 1 | 用「寒蝉活仿楷」设置字体时，显示的名字是「寒蝉活仿楷__ Con」（疑似脏名） | 已修复 | `maw/ass_fonts.py` 扫描/聚合 |
| 2 | 选它后 ASS 预览无法显示文本（实测为：实机画面/烧录里字体匹配不到，静默回退成完全不同的黑体；canvas 预览靠别名链仍能渲染正确字形） | 已修复 | 同上 + `web/editor/styles/editor-wiring-ass-font-aliases.js` |

## 取证结论（2026-11-04，本机未装该字体，改用官方源头）

- 字体来源：GitHub `Warren2060/ChillMovableType` release `HuoFangKaiv1.00`（寒蟬活仿楷，OFL），三个 face：Regular / ConRegular / ConBold。
- name 表取证（fontTools dump）：「寒蝉活仿楷__ Con」**是字体文件自带的** nameID 1、Macintosh 平台、enc=25（Mac 简体中文）、langID=33 记录的原值；同槽位 Windows 记录是完好的「寒蝉活仿楷_復 Con」。作者转码工具损坏：中文名「復」丢失（`_復` → `__`），英文 fullName 退化为 `_______ConRegular`。
- CoreText 实测（Swift CTFontDescriptor 匹配）：三个 face 暴露的 family 名全是 Win 平台 en 名；**所有 Mac enc=25 记录完全无法匹配**；Win nameID1/nameID16 可匹配。完好的 Mac Roman 记录（Academy Engraved LET、Diwan Thuluth 实测）CoreText 能匹配——所以规则定为「同 (nameID, 语言) 槽位 Windows 优先」，仅 Mac 有的名字保留。
- libass 实测（本机 brew ffmpeg，fontsdir 加载字体）：脏名全部渲染成回退黑体（PingFang 类），干净 Win 名渲染出寒蝉楷体字形；「文本完全消失」未在本机复现（macOS 有 CJK 回退字体），回退字体缺 CJK 覆盖的环境即表现为无字形。
- 浏览器实测（Playwright Chromium，字体临时装入 ~/Library/Fonts）：`"寒蝉活仿楷__ Con"` 宽度等于 sans 回退（匹配不到），干净名宽度 = Condensed 字形（可匹配）——与 CoreText 行为一致。

## 根因

别名聚合把 Mac/Win 记录一视同仁，canonical 按「zh 优先 + 记录顺序」选中排在前面的 Mac 脏记录；下拉（face 粒度 canonical）给出三个全是脏名的条目，存进样式后所有渲染端都匹配不到：实机画面/烧录静默回退黑体，canvas 预览靠别名链兜底才显示正确字形。

## 修复决定

1. `_extract_font_names`：同 (nameID, 语言) 槽位 Windows 记录优先；被挤掉的 Mac 脏名进 `FontFileNames.legacy`（值与保留值相同的重复 Mac 记录不算脏名）；仅 Mac 有的名字原样保留。
2. `_merge_font_entries`：条目非空时输出 `legacy`（下拉不展示）；`canonicalByName` 映射带优先级——nameID1 本名 > 其它别名 > legacy，「寒蝉活仿楷_復」（Regular 的 nameID1、Con face 的 nameID16）不再随扫描顺序被抢到 Condensed face；`_installed_font_files` 排序让聚合跨运行确定。
3. `_resolve_entry` 接受 legacy 命中：`resolve_font_name`/`normalize_ass_text_fontnames` 把存量脏名改写回可匹配名并出「已按本机字体匹配」提示；payload 新增可选 `legacy` 字段（schema 仍 v1，仅非空输出）。
4. 前端 ingest：legacy 只进 `canonicalByFold` 查询表（导出改写 + 预览别名链自愈），不进 `entries`（下拉不展示）。

## 验证

- `uv run --no-sync python -m unittest tests.test_ass_fonts -v`：33 通过（新增 8 条：提取 3、合并 2、查询/payload 3，夹具按真实 name 表记录合成）。
- `uv run --no-sync python scripts/run_tests.py`：2810 通过（跳过 19，平台相关）。
- `node --test tests/*.mjs`（TMPDIR=.artifacts/tmp）：999 通过 0 失败（新增 legacy ingest 测试 1 条）。
- `node scripts/build-editor.mjs --write` + `pnpm run check:editor`：bundle 新鲜（产物不进 Git）。
- 端到端（serve.py + Playwright，字体临时装入用户字体目录，验证后已移除）：`/api/ass-font-aliases` 下拉只剩可匹配名；`/api/ass-frame` 用存量脏名渲染，告警「已按本机字体匹配为『寒蝉活仿楷_復 Con』」，与干净名渲染逐像素一致（diff=0），字形为寒蝉楷体（修复前为黑体回退）。

## 未验证边界

- 「文本完全消失」的真空白未在本机复现（macOS 必有 CJK 回退）；修复覆盖其成因（名字匹配不到）。
- Windows directwrite/GDI provider 的行为未实测（规则依据 OpenType 惯例与 CoreText 实测推断）；CI Windows runner 只跑单测。
- 旧工程里已选脏名的用户：实机画面/烧录/导出会自愈并提示；ASS 字体下拉需重新选择一次才会把工程存储值换成干净名（存储值在工程里，服务端不能替用户改工程文件）。
