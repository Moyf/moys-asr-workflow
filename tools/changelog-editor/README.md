# CHANGELOG 编辑器

维护者本地工具页：按版本拆开 CHANGELOG 逐条编辑、逐条对比、粘贴配图，并把图片写进版本 assets、生成附图后的 CHANGELOG 与 `docs/releases/<版本>.md` 归档。

## 打开方式

直接双击 `index.html`（file:// 即可），或在仓库根目录起任意静态服务后访问。
生成归档依赖 Web Crypto 与文件写权限，请用 **Chrome / Edge** 打开；「仅加载 CL 文件」是只读降级模式（不能写盘，完成编辑改为下载文件）。

## 使用流程

1. **打开仓库目录**：选择仓库根目录（读写模式）。页面读取 `CHANGELOG.md` 与 `docs/releases/`，侧栏列出全部版本并标注归档状态（绿=一致，黄=需重生成，红=缺失）。
2. **逐条编辑**：选择版本后每条更新是一个卡片，直接改文本；「对比」显示与原文的逐词差异，「还原」恢复原文；支持新增、删除、上下移动条目。
3. **粘贴配图**：点击某个条目（选中态）后直接 `Ctrl+V` 粘贴截图，或把图片文件拖到条目卡片上。每张图可改 alt 描述与文件名；粘贴位图会转 WebP（最长边 1600px、质量 0.9），超过 300 KiB 会有软提醒。删除条目会一并移除其新图片。
4. **预览 / 对照**：「预览」按渲染效果查看当前版本；「对照」列出同系列 beta 小节的全部条目，可逐条勾选"已核对"，用于确认合并稿没有漏掉内容。
5. **完成编辑**（对当前选择的版本）：
   - 备份被覆盖文件到 `.artifacts/changelog-editor/backup/<时间戳>/`（目录已被 Git 忽略）；
   - 检测磁盘冲突：CL 在打开后被其他程序改过则中止；
   - 新图片写入 `docs/assets/<版本>/<文件名>`（同内容自动去重）；
   - 重写 `CHANGELOG.md`，把 `![alt](docs/assets/<版本>/<文件名>)` 插到对应条目后面；
   - 正式版默认同步重新生成 `docs/releases/<版本>.md`。
6. **归档生成**（侧栏，按版本勾选、仅正式版）：对勾选版本按当前 CL 生成归档；生成前会先保存 CL 并备份被覆盖的归档。测试版与未发布区不参与，与 `--check-all` 的规则一致。

## 契约与保证

- 归档生成逻辑是 `scripts/prepare_release_notes.py` 中 `extract_release_section` / `build_release_document` 的逐字节等价实现；`selfcheck.js` 用当前仓库对拍（47 个小节往返无损、全部正式版归档与 Python 产物一致）。改动 `cl-lib.js` 后运行：

  ```powershell
  node tools/changelog-editor/selfcheck.js
  ```

- 版本归档仍以 Python 侧 `--check-all` 为准；页面生成只是省一步，CI 检查不因此豁免。
- 归档中的相对图片链接会被固定为 raw.githubusercontent.com 的 tag 地址，所以**引用的图片必须在 tag 可达**（本仓库把图片放在 `docs/assets/<版本>/` 并随版本文档一起提交，即满足该条件）。

## 开发与自检

- 逻辑对拍（无需浏览器）：`node tools/changelog-editor/selfcheck.js` —— 解析往返无损 + 全部正式版归档与 `prepare_release_notes.py` 产物逐字节一致。
- UI 冒烟（需先起静态服务）：`python -m http.server 8791 --bind 127.0.0.1` 后运行 `node tools/changelog-editor/smoke-ui.js`，脚本会载入真实 CL 走一遍编辑 / 对比 / 预览 / 对照 / 归档 / 图片附加，并检查页面无报错。

## 已知边界

- 浏览器只支持 Chromium 系（File System Access API + WebP 编码）。
- 自动保存：文本与图片二进制分别存 localStorage / IndexedDB（按 CL 哈希隔离）。恢复的是"文本 + 新图片"，尚未写盘的图片仅在打开过该工具的浏览器里有效。
- 只读降级模式不产生备份；「对照」面板只覆盖同系列 beta，未发布区的旧条目已被合并进正式版时不会出现（历史在 Git 与 beta 小节里）。
- 磁盘冲突检测只在写回前比对 CHANGELOG.md；编辑期间外部改动不会被实时发现。
