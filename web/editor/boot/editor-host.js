// Compose replaceable host capabilities without touching browser APIs at
// startup. ESM init module: the assembler calls this at the file's original
// manifest position. Host trio comes from explicit imports; the storage /
// files / server registry entries stay until G04 retires them.
import { createStorage } from '../../shared/host/storage.js';
import { createFiles } from '../../shared/host/files.js';
import { createServerApi } from '../../shared/host/server-api.js';

export function initEditorHost() {
  'use strict';
  const runtime = Object.freeze({
    getNavigator: () => globalThis.navigator,
    hasUserActivation: () => Boolean(globalThis.navigator?.userActivation?.isActive),
  });
  // Desktop host can replace every capability: the registered factory keeps
  // the override contract (provided capabilities win; browser services are
  // only created when the default host is actually built).
  if (window.MAWE?.register) {
    window.MAWE.register('editor-host', function createEditorHost(dependencies) {
      const { browser, environment, storage, files, server, runtime: rt } = dependencies;
      return Object.freeze({
        storage: storage || createStorage(environment),
        files: files || createFiles({ browser, environment }),
        server: server || createServerApi({ browser, environment }),
        runtime: rt || runtime,
      });
    });
  }
  window.MaweHost = Object.freeze({
    storage: createStorage(globalThis),
    files: createFiles({ browser: window, environment: globalThis }),
    server: createServerApi({ browser: window, environment: globalThis }),
    runtime,
  });
}
