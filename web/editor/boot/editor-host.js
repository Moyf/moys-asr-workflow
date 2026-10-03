// Compose replaceable host capabilities without touching browser APIs at startup.
window.MAWE.register('editor-host', function createEditorHost(dependencies) {
  'use strict';
  const { browser, environment, storage, files, server, runtime } = dependencies;
  return Object.freeze({
    storage: storage || window.MAWE.resolve('host-storage', environment),
    files: files || window.MAWE.resolve('host-files', { browser, environment }),
    server: server || window.MAWE.resolve('host-server-api', { browser, environment }),
    runtime: runtime || Object.freeze({
      getNavigator: () => environment.navigator,
      hasUserActivation: () => Boolean(environment.navigator?.userActivation?.isActive),
    }),
  });
});
window.MaweHost = window.MAWE.resolve('editor-host', { browser: window, environment: globalThis });
