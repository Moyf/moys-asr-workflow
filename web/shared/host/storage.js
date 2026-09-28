// Storage errors remain visible to callers so each preference keeps its fallback.
// ESM 试点：window.MAWE.register 注册改为命名导出，依赖经参数显式传入；
// 消费方在完整迁移前仍经 window.MaweHost 兼容桥访问。
export function createHostStorage(environment) {
  return Object.freeze({
    getItem: (key) => environment.localStorage.getItem(key),
    setItem: (key, value) => environment.localStorage.setItem(key, value),
  });
}
