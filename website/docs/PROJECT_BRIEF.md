# MAW 官网项目简报

## 项目定位

MAW（Moy's ASR Workflow）是一条刻意收窄、可公开分发的 Qwen ASR API 工作流：

```text
本地媒体 → Qwen / Soniox API → SRT + JSON 工程 → 本地浏览器编辑 → 导出
```

它不是完整的 ASR 平台，也不是把媒体上传到 MAW 服务器的在线 SaaS。未来更完整的产品是 MOSE；MAW 保持小而可用，并作为 JSON 工程、波形编辑和导出流程的稳定参考。

## 官网要让访客记住的三件事

1. 不需要 GPU：用户自己的电脑运行脚本和编辑器，识别调用云端 API。
2. 不止生成 SRT：JSON 是工程真源，保留字/词级时间戳、布局、波形和编辑决策。
3. 边界清楚：用户自己提供 API Key；媒体只在转写时直接发给用户选择的 ASR 服务，MAW 没有自己的媒体服务器。

## 内容来源

- 产品事实：主仓库 README 和 `docs/WORKFLOW.md`
- 数据契约：主仓库 `JSON_SCHEMA.md`
- 编辑器能力：主仓库 `docs/EDITOR_GUIDE.md` 与官网使用的编辑器截图
- 未来方向：主仓库 `docs/MOSE.md`
- 许可证：主仓库 `AGPL-3.0-only`

## 首页内容架构

1. Hero：从本地媒体到可继续编辑的字幕工程；下载与 GitHub CTA。
2. 三步工作流：选择媒体、调用 ASR API、本地编辑与导出。
3. MAWE 编辑器：波形、字级时间戳、拆分合并、可逆空隙、便携 HTML。
4. 隐私边界：本地电脑与用户选择的 API 之间的单向转写路径。
5. 两分钟上手：Windows 下载与 `uv run ... -ll 2m --json` 命令。
6. FAQ：GPU、在线 SaaS、JSON 与供应商范围。

## 视觉语言

- 深色编辑器底色，薄荷绿波形，琥珀色静音区间，蓝色辅助信息。
- 使用真实编辑器截图；不伪造产品截图。
- 不使用通用 AI SaaS 渐变、无人机图、抽象 3D 插画或外链字体。
- 关键动作是“在线编辑器”、“下载 Windows 版”和“查看 GitHub”。

## 不能在官网承诺的内容

- 不承诺免费 API：费用取决于用户选择的供应商和账户。
- 不承诺所有地区都能稳定访问 Vercel、GitHub Pages 或 API。
- 不把实验性的本地模型入口说成正式稳定路径，也不把 MAW 说成全套剪辑软件脚本或在线多供应商平台。
- 不收集 API Key，不在网站中加入在线上传媒体的演示表单。

## 后续可分派任务

- 补齐中文文案并确认术语（MAW / MAWE / MOSE）。
- 增加英文版本与语言切换。
- 设计 Open Graph 社交分享图和 favicon 变体。
- 加入下载平台卡片，并从 GitHub Release 动态读取版本信息。
- 继续维护 `npm --prefix website run sync:docs`，让主仓库文档变化可重复同步到 `/docs/`。
- 按需要接入 Vercel 自定义域名；GitHub Pages workflow 已发布官网、文档和 `/editor/`。
- 做大陆、海外移动端网络和 Lighthouse 实测。
