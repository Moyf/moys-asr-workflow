# 工具页共用资源

`tool-page.css` / `tool-page.js` 只管理主题、视觉令牌和可选显示偏好，不碰工具业务状态。
静态工具页使用相对路径；离线单 HTML 生成器需内联实际资源。不能因此放宽已有 CSP。

## Markdown 阅读器（本轮仅接工具目录）

目录的“使用说明”默认在页内弹窗阅读，保留“打开源文件”。退休、暂停维护、暂不处理状态不因
阅读器接入而改变。其他工具尚未接入，不应据此认为它们已有说明弹窗。

三个独立接口，均为普通本地脚本，不需要服务器、CDN 或 `file://` fetch：

```js
// 先加载 vendor/marked-18.1.3/marked.umd.js、vendor/dompurify-3.4.17/purify.min.js。
const fragment = MAWMarkdown.render(markdown, {baseUrl: documentUrl}); // 已净化的 DocumentFragment
// 远端 PR 正文等不可信上下文可选择：只保留明确绝对网址，且不提供图片入口。
const strictFragment = MAWMarkdown.render(markdown, {baseUrl:documentUrl, absoluteOnly:true, noImages:true});
const store = MAWToolDocData.create({data: MAWToolDocs, baseUrl: document.baseURI});
const viewer = MAWDocViewer.create({
  render: MAWMarkdown.render, loader: store.load, resolve: store.resolve,
});
await viewer.open(store.resolve('verification-checklist/README.md'), triggerButton);
// 其他工具也可直接给文本，或给自己的异步 loader(request, {signal})。
await viewer.open({title:'说明', path:'自定义说明', markdown:'# 内容', baseUrl:documentUrl});
viewer.close();
```

`render` 没有弹窗依赖；弹窗通过注入的渲染函数工作，不依赖 Marked / DOMPurify 全局。
`resolveUrl(href, baseUrl, {absoluteOnly:true})` 与 `render` 使用同一链接策略；默认允许相对文档链接，
`absoluteOnly` 拒绝相对路径、协议相对网址和锚点，只保留明确 http / https / mailto URL。
`noImages` 进一步删除“打开图片”入口（默认本来就不加载图片）；本轮未接开发看板或 PR 正文。
`loader` 可返回字符串或 `{text, format:'markdown'|'source'}`，取消信号仅为协作取消；
即使 loader 不遵守信号，世代校验也会拒绝关闭或切换前的旧结果。`open` 返回是否实际展示成功。
无源路径的自定义说明不提供源文件动作。打开/关闭不会重建背景页面或清空工具数据。

## 语法与安全边界

- Marked 完整处理 GFM 标题、嵌套列表、表格、任务列表、代码、链接和强调；代码不执行。
  独立 inline tokenizer 扩展 `==高亮==` 为 `<mark>`，内部可嵌套 `==**强调**==`；
  关闭定界先借助 Marked 的标准 inline tokens 跳过代码跨度、链接/图片地址，内部 `==` 不会误截断外层。
  行内代码、代码块、转义 `\==`、空/未闭合标记保留原文，不跨换行消费。
  `{highlight:false}` 可禁用该扩展，供确实只需要标准 GFM 的消费者与负向验证使用。
- 原始 HTML 全部转义为文字。DOMPurify 使用明确标签/属性白名单净化最终 DOM；不允许
  SVG、iframe、style、事件属性、图片元素或可执行标签，净化后不再改写 HTML 字符串。
- 链接用 URL API 基于文档位置解析，仅允许 http / https / mailto，以及本地文档的相对文件链接。
  拒绝危险协议、编码危险协议、控制字符、HTML 实体拼写与凭据；URL 中需要 `&` 时直接写字符，
  不使用 `&amp;` 等实体。新窗口链接带 `nofollow noopener noreferrer`。
  本地文件只允许普通相对路径（包括 `../`）；根路径、盘符、UNC、反斜杠及编码变体一律拒绝。
  `../` 链接可能指向工具目录之外，但只提供显式点击入口，不隐式读取或打包该文件。
  标题 ID 使用 `maw-md-` 前缀（防止命名属性冲突），重复标题追加 `-1` / `-2`；普通 `#标题`
  链接自动映射，跨文档锚点由弹窗定位。标题标点处理接近 GitHub，但不承诺全部历史锚点兼容。
- Markdown 图片只显示占位说明和可显式点击的“打开图片”；不会自动加载本地或远程图片。
  原始 HTML 图片也只能看见源文字，不发网络请求。
- 打包文档里的链接可在弹窗切换；未收录 Markdown 明示“打开源文件”，不承诺所有仓库文档都
  能页内阅读。非 Markdown 的 `merge-flow.mjs` 按安全 `textContent` 显示源代码全文。

加载 `markdown.css`、`doc-viewer.css` 与主题基础 CSS。正文 15px，代码 13px，辅助信息至少 12px；
代码/表格局部横向滚动。原生 `dialog.showModal()` 优先；另有 inert 背景、遮罩与 Tab 约束降级，
支持 Esc、背景点击关闭及焦点返回。所有阅读器实例共用弹窗栈：支持预创建/运行时创建、
native/fallback 混用与乱序关闭，只让顶层获得焦点；最后关闭才恢复最初的 overflow/inert。
为了让 fallback 也能覆盖 native，下层 native 暂时退出浏览器 top layer，仍保持可恢复的只读弹窗。
按钮沿用 OCR 确认页的样式基准，窄屏/触屏将点击高度
提升到 44px。降级模式不等同于全部旧浏览器兼容性承诺。

## 固定本地依赖与可复现生成

1. 开发依赖固定为 `marked@18.1.3`（MIT）、`dompurify@3.4.17`（MPL-2.0 OR Apache-2.0），
   版本已由 npm registry 确认。Marked 18.1.3 发布于 2026-11-02 18:00 UTC，选择已过 24 小时
   冷却期的版本，不降低 pnpm 的 `minimumReleaseAge` 或增加豁免。运行
   `pnpm install --frozen-lockfile` 准备对应包。
2. `node scripts/build-tool-docs.mjs --write` 从已安装包逐字节复制官方 UMD 分发文件与完整许可证
   到 `vendor/`，不重新压缩、不修改上游内容。`--check` 只用标准 Node 与跟踪文件，检查文档
   新鲜度及固定 SHA256，不需要 pnpm / node_modules；未安装包时 `--write` 可保留通过校验的
   本地 vendor 并重生成文档。升级依赖时须同时重新确认版本、官方文件与脚本中的 SHA256。
3. 生成器仅读取 `catalog.js` 中 `docs` 指定的工具文档和固定补充：工具 `README.md`、
   `TOOL_PAGE_GUIDE.md`、`AGENTS.md`、本文件。不会递归爬链接、扫描整个 `docs/` 或读取 `.env`。
   内容作为转义 JSON 文本写入 `../tool-docs-data.js`，不是待执行 HTML。
4. `postinstall` 自动执行 `--write`。文档或依赖变化后重生成，并运行 `pnpm run check:tool-docs`。
   vendor 与文档数据是本仓维护工具的受控生成源资产，需要入库；不加入生产包。

许可证原文：`vendor/marked-18.1.3/LICENSE`、`vendor/dompurify-3.4.17/LICENSE`、
`vendor/dompurify-3.4.17/LICENSE-MPL`。项目 NOTICE 同时登记依赖。
