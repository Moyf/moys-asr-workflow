// URL resolution and transport belong to the host; response policy stays in callers.
// ESM 试点：window.MAWE.register 注册改为命名导出，依赖解构进参数表。
export function createHostServerApi({ browser, environment }) {
  return Object.freeze({
    fetch(url, options) {
      return environment.fetch(new environment.URL(url, browser.location.href), options);
    },
  });
}
