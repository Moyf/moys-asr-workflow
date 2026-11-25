// Compose replaceable host capabilities from the live browser environment.
import { createStorage } from '../../shared/host/storage.js';
import { createFiles } from '../../shared/host/files.js';
import { createServerApi } from '../../shared/host/server-api.js';

export function createEditorHost({ browser, environment, storage, files, server, runtime } = {}) {
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

export function initEditorHost() {
  window.MaweHost = createEditorHost({ browser: window, environment: globalThis });
}
