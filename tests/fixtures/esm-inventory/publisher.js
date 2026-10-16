// 夹具：发布者（window 赋值 + defineProperty）+ 内部函数
const state = { v: 1 };
window.MaweFixPub = Object.freeze({ get() { return state.v; } });
Object.defineProperty(window, 'MaweFixMut', {
  configurable: true,
  get: () => state.v,
  set: (value) => { state.v = value; },
});
