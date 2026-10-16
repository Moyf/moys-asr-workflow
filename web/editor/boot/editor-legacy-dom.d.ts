// 存量 DOM 类型债的过渡放宽（全量 ESM 迁移时从隐式全局显式化）：
// 业务代码大量以 input/button 语义使用 getElementById/querySelector 返回值
// （.checked/.value/.disabled 等），历史上无类型层。终态方向是消费侧
// 精确 cast（HTMLInputElement 等），逐点迁移完成后删除本文件。
// 索引签名放行的仅是属性访问的存在性，方法调用仍受真实类型约束。

interface Element { [key: string]: any; }
interface Node { [key: string]: any; }
interface EventTarget { [key: string]: any; }
