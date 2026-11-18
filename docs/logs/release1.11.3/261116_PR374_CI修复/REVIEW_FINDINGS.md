# PR374 CI修复独立审查

基线 `33a0693a`，审查覆盖本次四个测试源码文件的完整diff及对应生产停止、ASS导出契约。审查者未参与实现，仅只读核对并执行oracle单测9项，通过证据 `.artifacts/checks/20261116T034314Z-ebde1f9a/result.json`。

## 结论

无明确blocker、major、minor或nit finding，无待处置审查项。

- guard检查守住任意非零RGB出界、native/guard角色边界一致及差异不触及viewport边缘；允许内部hash差异不等于放宽像素容差，也不宣称证明内部逐像素一致或检测任意内部丢字。
- Layer隔离只用于同口径band与缩放比较，合成图出界、可见性及Canvas/libass边界检查仍保留。
- clock参考只共享静态q/pos；未切片standalone供应动画，错误重启时钟负对照可区分，实际500/1500ms切片检查保留。
- Decimal保留坐标精度，不改move时间参数。JKL完整stop状态后采样，跨两帧保持原0.01秒容差。

## 双向验证及边界

已核读原helper负对照13失败、修复后Python30通过、ASS Windows40通过、JKL旧采样失败/修复通过/漏停失败及独立完整5通过的实际记录；路径见同目录反馈账本。

Linux仍待新CI验证，Windows不替代Linux；未复现定位libass底层具体浮点量化临界点，不将该推断包装成已确定的底层根因。未修改产品代码、重试策略、跳过允许列表或聚合门禁。

## 续1：第二轮缩略图修复审查

本轮相对e55a44b1，前述“无finding”仅针对前一轮，不覆盖本轮新改动。

| 条目 | 级别 | 状态 | 证据与处理 |
| --- | --- | --- | --- |
| 1 | minor | 已修复 | 异常身份校验与当前错误发布改为同一锁内完成；过期异常只重排，当前源消失/有效错误仍发布，取消正常传播。新增manager级6项边界回归，旧实现真实失败 `.artifacts/pr374-thumbnail-round2/replacement-negative/20261116T052908Z-49fc5457/result.json`，修复小包84通过 `replacement-positive/20261116T053025Z-59a5f5a8/result.json`。 |

filmstrip完整diff暂无finding；独立微单测7通过及jobs/cache60通过分别见 `.artifacts/checks/20261116T051911Z-65d229d1/result.json`、`20261116T051948Z-2c6d6516/result.json`。后端当时仍为WIP，本轮尚未放行。

最终复核：独立审查32项通过（`.artifacts/checks/20261116T053133Z-f1ed6d1e/result.json`），上述minor处置完全、无新增finding，无待处置blocker/major/minor/nit，放行提交。实现者以外再次执行jobs/cache/probe74项通过（`20261116T053157Z-8fbf1a13/result.json`）。

接受的边界：缓存SQLite I/O仍可能持manager锁，本轮只消除确定的重复不可取消probe，不宣称解决任意I/O延迟。跨进程原始启动超时尚未有对应栈，保留原deadline及新增阶段诊断；以新一轮CI结果判断是否还需继续调查。
