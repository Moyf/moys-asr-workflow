---
layout: "../../layouts/DocLayout.astro"
title: "开始使用 MAW"
description: "MAW 的产品简介、安装方式和第一次转写的完整入口。"
source: "README.md"
---

<!-- Generated from README.md. Run pnpm run sync:docs to refresh. -->

[![English README](https://img.shields.io/badge/README-English-2563eb?style=flat-square)](https://github.com/Moyf/moys-asr-workflow/blob/main/README-en.md)
[![GitHub Release](https://img.shields.io/github/v/release/Moyf/moys-asr-workflow?display_name=tag&sort=semver)](https://github.com/Moyf/moys-asr-workflow/releases/latest)
[![GitHub Downloads](https://img.shields.io/github/downloads/Moyf/moys-asr-workflow/total?label=downloads)](https://github.com/Moyf/moys-asr-workflow/releases)
[![GitHub Stars](https://img.shields.io/github/stars/Moyf/moys-asr-workflow)](https://github.com/Moyf/moys-asr-workflow/stargazers)
[![License](https://img.shields.io/github/license/Moyf/moys-asr-workflow)](https://github.com/Moyf/moys-asr-workflow/blob/main/LICENSE)

> 为口播、访谈和游戏实况等各类视频生成并精修字幕。

## 什么是 MAW？
MAW 即 Moy's ASR Workflow，也可以叫做「阿墨的字幕工作台」。
它是我为了解决「给视频添加字幕」这个需求而创造的一整套完整的工作流。

它包含两个部分：
- **启动器**：用于转写字幕，生成 srt 文件和工程
- **编辑器**：用于编辑和导出字幕，以及更多支持的文件格式

<img src="../../docs-assets/docs/assets/readme/overview.webp" alt="overview" loading="lazy" decoding="async" />

你可以在启动器中选择媒体并生成字幕，再到编辑器 MAWE 中精修文本、调整时间、预览效果，最后烧录成字幕，或者导出剪辑软件可用的工程。

> [⬇️ 下载](https://github.com/Moyf/moys-asr-workflow/releases/latest) · [🎬 在线编辑器](https://moyf.github.io/moys-asr-workflow/editor/) · [📺 3 分钟视频速览](https://www.bilibili.com/video/BV1hXum6yELT)

## 为什么用 MAW？
因为！它！超好用！
<img src="../../docs-assets/docs/assets/stickers/%E9%AA%84%E5%82%B2.png" alt="骄傲" loading="lazy" decoding="async" />

MAW 基于我自己的使用和朋友们的反馈，提供了非常完善的字幕生成与编辑体验。

以下是一些它的特性介绍——

### 多行波形与字词时间码
用**多行波形**来同时查看前后的波形与字幕，轻轻一滚即可快速定位。
<img src="../../docs-assets/docs/assets/readme/feat-multiline.webp" alt="feat-multiline" loading="lazy" decoding="async" />

并且，MAW 生成的字幕附带**字幕时间码**，拆分时自动定位到对应的位置进行拆分。

### 精心打磨的编辑体验
两条相连的字幕可以拖动中缝直接调整边界：
<img src="../../docs-assets/docs/assets/readme/mid-drag.webp" alt="mid-drag" loading="lazy" decoding="async" />

双语字幕自动绑定关系，同时拖动和拆分：
<img src="../../docs-assets/docs/assets/readme/binding-editing.webp" alt="binding-editing" loading="lazy" decoding="async" />

对于没有时间码的字幕，也提供一键拆分面板：
<img src="../../docs-assets/docs/assets/readme/split-panel.webp" alt="split-panel" loading="lazy" decoding="async" />

*基于字幕语言，英文类的会自动定位在空格处拆分*

在字幕列表中查看字数，并一键筛选过长字幕：
<img src="../../docs-assets/docs/assets/readme/words-count.webp" alt="words-count" loading="lazy" decoding="async" />

甚至——像记事本一样直接**纯文本编辑**，改字、拆句，轻轻松松：

<img src="../../docs-assets/docs/assets/readme/pure-text-editing.webp" alt="pure-text-editing" loading="lazy" decoding="async" />
（别担心，所有的时间码都会自动处理好！）

### 静音空隙一键跳过
编辑器内可以一键生成**静音空隙**，跳过空白片段：

<img src="../../docs-assets/docs/assets/readme/feat-gaps.webp" alt="feat-gaps" loading="lazy" decoding="async" />

你也可以手动编辑空隙，来跳过原片中无聊的片段。
在字幕软件里剪辑？是的，了解一下！特别爽！

### 文稿匹配与 AI 校对
在启动器中，可以选择写好的文稿匹配：
<img src="../../docs-assets/docs/assets/readme/text-match.webp" alt="text-match" loading="lazy" decoding="async" />

也支持启用「AI 处理」，调用 LLM 模型对字幕进行校正或翻译：

<img src="../../docs-assets/docs/assets/readme/ai-process.webp" alt="ai-process" loading="lazy" decoding="async" />

### 多种格式的支持
不像*某些*封闭式的软件，MAW 完全开放！

除了最基本的 `srt` 和 `ass` 格式的字幕导出，你还可以导出 [OpenTimelineIO](https://github.com/AcademySoftwareFoundation/OpenTimelineIO) 开放时间线工程格式（达芬奇和 beta 版 Premiere 均支持）。

并且也支持导出 PR 可用的 `fcpxml7` 格式。

<img src="../../docs-assets/docs/assets/readme/export-formats.webp" alt="export-formats" loading="lazy" decoding="async" />

### (M)ASS 字幕直接烧录
添加了独创性的 **MASS** 语法，你可以直接在编辑器内做这样花哨的字幕效果：

<img src="../../docs-assets/docs/assets/1.9.0/%E7%89%B9%E6%AE%8A%E6%96%87%E6%9C%AC%E6%A0%B7%E5%BC%8F%EF%BC%88MASS%EF%BC%89.webp" alt="特殊文本样式（MASS）" loading="lazy" decoding="async" />

在启动器的「工具箱」和编辑器的右上角，都提供了**烧录视频**的功能：

<img src="../../docs-assets/docs/assets/readme/burn-video.webp" alt="burn-video" loading="lazy" decoding="async" />

小众独特的玩法：你可以生成一个绿幕背景的视频，然后再导入剪辑软件作为字幕层 😋

### 后处理流水线
你可以配置多种不同的后处理步骤，包括但不限于：文稿匹配、AI 整理文稿、固定替换/简繁转换、生成翻译字幕……

在转写之后，将自动依次执行，**一条龙流水线**！
<img src="../../docs-assets/docs/assets/readme/postprocess-pipeline.webp" alt="postprocess-pipeline" loading="lazy" decoding="async" />

## 要钱吗？
### 软件本体
MAW 用爱发电 ❤️
这是开源软件，你可以免费使用！当然，也欢迎 [支持开发](#支持开发)。

### 转写服务
使用本地模型转写时，不会产生任何额外费用——除了你的电费 :P
使用服务商转写时，由服务商收取费用。
以阿里云百炼的 QwenASR 举例，1 小时的音频转写需要约 0.8 元人民币。

你可以直接看到转写费用预览：
<img src="../../docs-assets/docs/assets/readme/price-info.webp" alt="price-info" loading="lazy" decoding="async" />

> API Key 在本机配置，费用和数据政策见 [服务商配置](../documentation-index/#user-providers)。

## 开始使用

先从 [下载页面](https://github.com/Moyf/moys-asr-workflow/releases/latest) 下载，解压即可用。

1. **下载安装包**：在所选版本的附件中选择对应系统和架构。完整版 `MAW` 包含 FFmpeg / FFprobe （推荐）；已安装这两个工具时可选 `MAW-lite` 轻量版。
2. **打开启动器**：Windows 解压完整目录后运行 `MAW.exe` （其他平台同理）。启动问题见 [常见问题](../documentation-index/#user-faq)。
3. **先生成一小段字幕**：选择服务商、配置 API Key，导入一两分钟的短素材，确认转写成功后再处理完整录音。
4. **校对、保存、导出**：转写完成后点击「打开编辑器」即可进行编辑；完成编辑后可以导出 srt 字幕使用，或直接烧录视频。

> 源码安装、命令行起步和媒体迁移见 [从零完成一次字幕工程](../documentation-index/#user-workflow)。

## 星星历史
<a href="https://www.star-history.com/?repos=Moyf%2Fmoys-asr-workflow&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Moyf/moys-asr-workflow&type=date&theme=dark&legend=top-left&sealed_token=_PToQhiZM0l9HWee443BsVO_Ent6c7W9XhetqS-GqzovCVxrR29_zMbiDuhZOZRQd-vsEaQhUvF262_K7KBgtzedaZ57WJ3lkgoDR9-QocuvQgw7_My_06JAPfChISW3AJh0fgpAJWVAi1XXRPs7I-5caimIiS5mNri_lJrB_9iBnvtf8_vvhtgAh-fL" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Moyf/moys-asr-workflow&type=date&legend=top-left&sealed_token=_PToQhiZM0l9HWee443BsVO_Ent6c7W9XhetqS-GqzovCVxrR29_zMbiDuhZOZRQd-vsEaQhUvF262_K7KBgtzedaZ57WJ3lkgoDR9-QocuvQgw7_My_06JAPfChISW3AJh0fgpAJWVAi1XXRPs7I-5caimIiS5mNri_lJrB_9iBnvtf8_vvhtgAh-fL" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=Moyf/moys-asr-workflow&type=date&legend=top-left&sealed_token=_PToQhiZM0l9HWee443BsVO_Ent6c7W9XhetqS-GqzovCVxrR29_zMbiDuhZOZRQd-vsEaQhUvF262_K7KBgtzedaZ57WJ3lkgoDR9-QocuvQgw7_My_06JAPfChISW3AJh0fgpAJWVAi1XXRPs7I-5caimIiS5mNri_lJrB_9iBnvtf8_vvhtgAh-fL" />
 </picture>
</a>

谢谢所有 Star 本项目的朋友们！ 🫡

## 支持开发
如果你觉得它对你有帮助，想要支持 MAW 的开发，可以前往 [B站小店](https://mall.bilibili.com/neul-next/detailuniversal/detail.html?page=detailuniversal_detail&itemsId=41955597&loadingShow=1&noTitleBar=1&track_id=__BGMT__&from=&from_spmid=__SPMID__&msource=cps_comments_585578_cont-1-117125335227239#noReffer=true) 购买支持。
<img src="../../docs-assets/docs/assets/readme/bili-support.webp" alt="bili-support" loading="lazy" decoding="async" />

也支持使用 [Kofi](https://ko-fi.com/moy) 进行赞助 ☕️

> 所有支持过的用户将在将来的版本中列入「支持者名单」！

## 反馈与交流
问题和建议请提 [GitHub Issues](https://github.com/Moyf/moys-asr-workflow/issues)；交流可加入 [QQ 群 1079160201](https://qm.qq.com/q/4YtxZIpzxC)。

<img src="../../docs-assets/docs/assets/stickers/%E6%95%AC%E7%A4%BC.gif" alt="敬礼" loading="lazy" decoding="async" />

*表情包来自 刘大狗*
*感谢量子猫和荆轲在开发上的支持！*
