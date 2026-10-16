import { createStorage } from "../../shared/host/storage.js";
import { createFiles } from "../../shared/host/files.js";
import { createServerApi } from "../../shared/host/server-api.js";

// 真 ESM：register+resolve 对 → 具名工厂导出（原注册名 editor-host）。
export function createEditorHost(dependencies) {
const { browser, environment, storage, files, server, runtime } = dependencies;

return Object.freeze({
  storage: storage || createStorage(environment),
  files: files || createFiles({ browser, environment }),
  server: server || createServerApi({ browser, environment }),
  runtime: runtime || Object.freeze({
    getNavigator: () => environment.navigator,
    hasUserActivation: () => Boolean(environment.navigator?.userActivation?.isActive),
  }),
});
}

// 工厂不再读 window.MAWE（host 三件已直连），但实例化仍不能在
// import 期做——capabilities 检查（hasSavePicker 等）依赖页面环境，
// 与旧 phase-2 时机语义一致：首次访问 window.MaweHost / 裸名导出时
// 实例化——读取者都在启动 phase-2 及之后。
let instance;
export function getMaweHost() {
  // Preserve an explicit host supplied by the desktop shell or a test harness.
  // Consumers import this accessor directly, so they must see the same host
  // object that legacy window.MaweHost readers saw.
  if (!instance && typeof window !== 'undefined') {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'MaweHost');
    if (descriptor && Object.hasOwn(descriptor, 'value') && descriptor.value) {
      instance = descriptor.value;
      return instance;
    }
  }
  instance ??= createEditorHost({ browser: window, environment: globalThis });
  return instance;
}
// 已有同名属性（桌面宿主预挂、测试 stub）优先——与旧「无条件赋值」
// 时代「宿主先挂、模块不覆盖」的行为一致。Node 直导（类型检查、
// 单测 import 工厂）无 window，跳过发布。
if (typeof window !== 'undefined' && !('MaweHost' in window)) {
  Object.defineProperty(window, 'MaweHost', {
    configurable: true,
    get: () => getMaweHost(),
  });
}
