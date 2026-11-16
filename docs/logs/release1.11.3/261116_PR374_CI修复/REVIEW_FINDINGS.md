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
