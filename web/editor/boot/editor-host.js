// Compose replaceable host capabilities without touching browser APIs at startup.
// ESM 试点：registry resolve 改为静态 import——依赖在加载期显式可见；
// window.MaweHost 兼容桥保留，未迁移的消费方（web/editor/io/*）零改动。
import { createHostStorage } from '../../shared/host/storage.js';
import { createHostFiles } from '../../shared/host/files.js';
import { createHostServerApi } from '../../shared/host/server-api.js';

export function createEditorHost({ browser, environment, storage, files, server, runtime }) {
  return Object.freeze({
    storage: storage || createHostStorage(environment),
    files: files || createHostFiles({ browser, environment }),
    server: server || createHostServerApi({ browser, environment }),
    runtime: runtime || Object.freeze({
      getNavigator: () => environment.navigator,
      hasUserActivation: () => Boolean(environment.navigator?.userActivation?.isActive),
    }),
  });
}
