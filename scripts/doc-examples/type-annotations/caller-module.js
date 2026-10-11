// 最小样例 · 调用方侧：这一行是从 main 侧同步进来的旧代码。
// renderAll(true) 在旧签名时代意为「保留滚动位置」的位置参数；
// 所有者签名改成对象参数后，调用方没有任何工具会报警——
// 语法合法、作用域正确、符号能解析，滚动位置开始悄悄丢失。

function onSegmentsReplaced() {
  renderAll(true);
}

globalThis.MaweCaller = Object.freeze({ onSegmentsReplaced });
