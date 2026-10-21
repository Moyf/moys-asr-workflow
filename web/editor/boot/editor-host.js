// Compose replaceable host capabilities without touching browser APIs at
// startup. ESM init module: the assembler calls this at the file's original
// manifest position. Host trio comes from explicit imports; the storage /
// files / server registry entries stay until G04 retires them.
import { createStorage } from '../../shared/host/storage.js';
import { createFiles } from '../../shared/host/files.js';
import { createServerApi } from '../../shared/host/server-api.js';

export function initEditorHost() {
  'use strict';
  // runtime 默认按调用方传入的 environment 构造：resolve
  // 注入环境的宿主读到的平台/用户激活与该环境一致，不再
  // 误读当前页面（review P2）。
  const runtimeFor = (environment) => Object.freeze({
    getNavigator: () => environment.navigator,
    hasUserActivation: () => Boolean(environment.navigator?.userActivation?.isActive),
  });
  const buildHost = (browser, environment) => Object.freeze({
    storage: createStorage(environment),
    files: createFiles({ browser, environment }),
    server: createServerApi({ browser, environment }),
    runtime: runtimeFor(environment),
  });
  // Desktop host can replace every capability: the registered factory keeps
  // the override contract (provided capabilities win; browser services are
  // only created when the default host is actually built).
  if (window.MAWE?.register) {
    window.MAWE.register('editor-host', function createEditorHost(dependencies) {
      const { browser, environment, storage, files, server, runtime: rt } = dependencies;
      const defaults = buildHost(browser, environment);
      return Object.freeze({
        storage: storage || defaults.storage,
        files: files || defaults.files,
        server: server || defaults.server,
        runtime: rt || defaults.runtime,
      });
    });
  }
  window.MaweHost = buildHost(window, globalThis);
}
