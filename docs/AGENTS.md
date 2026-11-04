# docs 目录补充约定

本文件只补充 `docs/` 子树内对 Agent 的额外约束；根 `AGENTS.md` 的规则继续生效。

## 发布配图命名规范

发布配图放在 `docs/assets/<版本>/`（与 CHANGELOG 正式条目同版本号），命名约定以 **1.10.0 起的新标准**为准：

- 文件名使用**有语义的英文名**，按 CHANGELOG 条目主题命名（如 `loudness-popup.webp`、`thumbnail-toggle.webp`）；不用时间戳、`CHANGELOG-img-` 前缀或其他无语义名。
- CHANGELOG 中使用标准 Markdown 图片语法 `![条目说明](docs/assets/<版本>/<名称>.webp)`；不要用 Obsidian 的 `![[…]]` 嵌入语法——发布管线（`scripts/prepare_release_notes.py`）不转换它，图片在 Release 与官网不会显示。
- 图片文件必须随发布提交入库；`scripts/check_docs.py` 会拦截缺失文件，`prepare_release_notes.py` 生成归档时把相对路径自动 pin 到对应 tag 的 raw 链接。
- 截图用 webp，动图用 gif，与现有素材保持一致。

历史例外（保留原样，不迁移、不作为新范例）：`1.4.0/` 为纯时间戳名，`1.9.0/` 为中文语义名。
