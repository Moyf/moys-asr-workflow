// Compose replaceable host capabilities from the live browser environment.
import { createStorage } from '../../shared/host/storage.js';
import { createFiles } from '../../shared/host/files.js';
import { createServerApi } from '../../shared/host/server-api.js';

// 模块级宿主门面：initEditorHost() 以实际环境填充一次，
// 消费方（如 waveform）import { MaweHost } 直读。
export let MaweHost;

/** @param {{
 *   browser?: Pick<Window, 'location' | 'showSaveFilePicker'>,
 *   environment?: Pick<typeof globalThis, 'navigator' | 'document' | 'URL' | 'setTimeout' | 'fetch' | 'localStorage'>,
 *   storage?: MaweHostApi['storage'], files?: MaweHostApi['files'],
 *   server?: MaweHostApi['server'], runtime?: MaweHostApi['runtime'],
 * }} [options] */
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
  MaweHost = createEditorHost({ browser: window, environment: globalThis });

}
