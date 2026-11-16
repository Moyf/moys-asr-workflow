# OCR 路径回归测试补充自审

范围：基于 `12daf4d2` 的注入断言、新路径回归、精确平台 skip 与简短记录。独立复核已完成，当前0blocker/major/minor；不沿用旧分支结论。

重点：不重复收集导入的业务 TestCase；mock 仅覆盖夹具 setUp，真实事务执行前恢复；短名测试确有不同拼写且 samefile；原退出码/回滚/恢复断言完整保留；精确平台跳过不豁免缺能力。

## 发现与处置

| 级别 | 发现 | 处置 / 结果 |
| --- | --- | --- |
| minor（已修复） | TEMP含..或junction时，API原样返回也可能不同于canonical，误认为真正短名覆盖 | 比较API输出与原始输入、canonical，两者均不得相同；新增原样返回回归捕获精确能力skip，原独立probe现在0failure/0error/1skip |

独立最终复核：原问题已解决，无新增finding，原业务断言未削弱；skip策略只对POSIX精确ID/理由豁免，Windows缺能力仍为required失败。新回归在真实别名卷执行无skip，模块导入不重复收集TestCase。

## 验证证据

- 初次原样返回缺陷探针：`.artifacts/checks/20261112T041241Z-9dd864ef/result.json`。
- 修复后新增回归独立通过：`20261112T041552Z-e3b3ef18`；原probe现在能力skip不误报通过：`20261112T041552Z-ea2cb478`。
- 相邻85项执行，84通过1能力skip；真实别名卷17项通过0skip：`20261112T041503Z-3d4393c8` / `20261112T041503Z-d6850f28`。
- 初次真实缺修复对照：main仅移除fixture resolve的冻结源码失败，当前通过；精确skip条目移除也真实失败，详见验证记录。

未实际执行POSIX、远端CI或全仓套件；只修改测试与精确平台分类，不改生产代码。新PR须等检查通过再合并，不因本地审查放行提前称CI通过。
