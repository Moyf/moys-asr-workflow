# Ubuntu ASS 参照核对

基线：PR374 `33a0693a`，失败run `43637727609`。证据为CI实际ASS、PNG、JSON与fontselect；原始输出只留 `.artifacts/pr374-ci-43637727609/`，不提交图片或字体。

## Guard裁切与内部栅格差异不是同一属性

- scaled right-aligned native/guard三轨bbox完全相同；extension/overlay glyph hash相同。
- main仅118个内部像素不同，差异bbox `[1200,256,1209,324]`，距画面右边仍71px；最大red差32，不是viewport边缘被切掉。
- 整数平移且改变画布后的逐字节hash不变，不是libass子像素量化的通用保证。底层具体量化临界点没有同版Linux本地复现，不能将推断写成根因已确定。
- 正确属性仍须守住：guard真实非零RGB不出原viewport，native/guard实际轨道边界一致，差异若有应严格在画面内部；hash保留诊断。不能用平台hash白名单或增加Canvas/libass的3px容差绕过。

## 多行band数混入了跨轨遮挡

- 实际文本为11个M、10个换行，带q2禁自动换行。
- 副轨3个W按固定预设绘制在更高层，切断3个M的红色dominance行，11个字形被合成掩膜观察为14段。
- Canvas参考逐轨独立replay，libass却从合成图取角色颜色，比较不对称。行数/缩放验证应按Dialogue Layer隔离后真实渲染；组合可见性及出画检查继续保留。

## 时钟参考需要相同几何路径

- 500ms开始的slice用 `t(-500,500,2,fs120)`；750ms采样的相对时钟250ms对应原始750ms，进度0.5625、字号95.5；fade参数也已平移，而非重启。
- grouped显式pos/q2，standalone自动布局。两图字形均209×63、peak192，但crop仍有内部栅格相位差，位置归零crop不保证消除差异。
- 参考应保留原始未分片动画，只对齐非时间定位/预换行几何，继续严格hash并用错误重启时钟作负对照；不能把candidate动画复制成参考。

## 独立helper精度缺陷

guard坐标的默认 `:g` 只有6位有效数字，例如710.4341+256被写成966.434，应保留原始精度。当前scaled案例的活跃坐标仅一位小数，故不能把此缺陷冒充该hash失败的根因。

## 环境边界

CI选中LiberationSans-Regular.ttf，native/guard一致；日志为libass0.17.4、FriBidi1.0.16、HarfBuzz12.3.2。缺字/无字体不是已证实原因。当前本机没有可用Linux发行版，Windows真实渲染和单位回归不替代后续Linux CI验收。
