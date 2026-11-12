# 独立审查结论：寒蝉字体名脏名修复（2026-11-04）

审查者：未参与实现的后台 subagent（通读全部 diff + 回退实验双向验证）。
验证：目标 33 / 全量 Python 2810（skip 19）/ Node 999 全绿；bundle 新鲜；UTF-8 + LF + `git diff --check` 干净；回退实验 A（priority→旧 setdefault）新顺序无关测试真实变红、实验 B（去掉 Mac 让位）5 条测试变红，验证后已恢复原状。

## 结论

无 blocker / major，放行。以下 nit 与接受的风险逐条记录：

| # | 级别 | 内容 | 处置 |
|---|---|---|---|
| 1 | nit | `_installed_font_files` 注释原写「跨平台、跨运行确定」过度声称：Windows 注册表枚举在排序目录扫描之前且本身无序，注册表与目录字体的相对顺序仍随机器而异（priority 机制已消除 nameID1 归属的顺序依赖，残留影响仅病态重复 family 的等优先级首选） | 已改：措辞收敛为「跨运行确定」 |
| 2 | nit | `kept`/`dropped` 精确值比较未 casefold：Mac 记录与保留 Windows 值仅大小写不同时会进 legacy | 不改：方向保守（legacy 不进下拉、无用户可见危害） |
| 3 | nit | 前端 `aliasChainFor` 对 legacy 存量名返回退化链（仅 canonical；`entries.find` 按 names 查找对 legacy 键必然落空） | 不改：canonical 本身各渲染端可匹配，功能成立且有测试固化；按 canonical 反查补全链留作后续可选改进 |
| 4 | nit | `docs/logs/INDEX.md` 新行引用的台账目录为未跟踪状态 | 已处理：台账目录与 INDEX.md 同批提交 |
| 5 | 接受的风险 | legacy 扩大跨条目「先到先得」碰撞面：某字体的 legacy 脏名恰好等于另一字体的真实名且排序在前时，后者映射到前者 canonical。需病态巧合触发，属既有 first-wins 语义的自然延伸 | 记录在案，不做代码改动 |
