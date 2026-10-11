// Compose replaceable host capabilities without touching browser APIs at startup.
window.MAWE.register('editor-host', function createEditorHost(dependencies) {
  'use strict';
  const { browser, environment, storage, files, server, runtime, desktop } = dependencies;
  const desktopHost = desktop || window.MAWE.resolve('host-desktop', { bridge: environment.MOSEDesktop });
  return Object.freeze({
    storage: storage || window.MAWE.resolve('host-storage', environment),
    files: files || window.MAWE.resolve('host-files', { browser, environment, desktop: desktopHost }),
    server: server || window.MAWE.resolve('host-server-api', { browser, environment }),
    runtime: runtime || Object.freeze({
      getNavigator: () => environment.navigator,
      hasUserActivation: () => Boolean(environment.navigator?.userActivation?.isActive),
    }),
    desktop: desktopHost,
  });
});
window.MaweHost = window.MAWE.resolve('editor-host', { browser: window, environment: globalThis });
