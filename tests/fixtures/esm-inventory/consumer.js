// 夹具：消费者——立即读 + 回调延迟读 + 属性写入 + 跨文件绑定重赋值
import './publisher.js';
const immediate = window.MaweFixPub.get();
setTimeout(() => {
  const later = window.MaweFixPub.get();   // 延迟读
  window.MaweFixMut = later;               // window 赋值（语义 = 对可变量写回）
}, 0);
