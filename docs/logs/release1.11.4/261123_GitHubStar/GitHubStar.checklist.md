---
task: maw-1x-github-star
date: 2026-11-23
status: pending
---

# MAW 1.x GitHub Star 人工核对

> Launcher「支持 MAW」与本地编辑器「设置 → 关于」。不要用真实 GitHub Star 接口做验收。

## 实现与审查
<!-- id: implementation -->

打开面板只读取星标状态，明确点击加星才写入；仓库链接与加星是独立操作。

## 修复记录
<!-- id: fixes -->

同步编辑器英文感谢文案和中文原字串；编辑器服务契约测试单独检查新增路由配置，不依赖字段位置。

独立审查发现的含空格 Launcher 路径、Finder 的 Homebrew gh 查找、写入后焦点丢失三项均已修复。

## 自动化验证
<!-- id: automation -->

GitHub CLI 与服务契约用 mock，Chromium 用替身 bridge 和路由拦截；原生 WebView、已登录系统 gh 和打包产物未实测。

## 人工核验
<!-- id: manual -->
<!-- badge: todo 待核查 -->

- [ ] **Launcher 无 gh 时保留仓库入口**
  （操作）在找不到 gh 的环境打开 Launcher，进入「支持 MAW」；关闭弹窗后点主窗口项目仓库入口。
  （预期）弹窗没有加星或感谢按钮，关闭后原项目仓库入口仍可打开 GitHub 网页。
  <!-- id: launcher-fallback -->

- [ ] **本地编辑器的仓库链接可用**
  （操作）在同一环境打开本地编辑器的「设置 → 关于」，Tab 聚焦「GitHub 仓库」并按 Enter。
  （预期）只打开仓库网页；没有加星按钮，整行链接有和相邻链接一致的焦点框。
  <!-- id: editor-fallback -->

- [ ] **关于页跟随界面语言**
  （操作）分别在中文和英文下打开「设置 → 关于」并滚动到底部。
  （预期）仓库入口及底部署名随当前语言显示，署名每种语言只占一行。
  <!-- id: editor-localization -->

## 后续步骤
<!-- id: next -->

确认无 gh 时的原生 Launcher 回退；便携内联副本到发布前统一重生成。
