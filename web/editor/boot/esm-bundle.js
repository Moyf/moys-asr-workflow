(() => {
  // web/shared/host/storage.js
  function createHostStorage(environment) {
    return Object.freeze({
      getItem: (key) => environment.localStorage.getItem(key),
      setItem: (key, value) => environment.localStorage.setItem(key, value)
    });
  }

  // web/shared/host/files.js
  function createHostFiles({ browser, environment }) {
    return Object.freeze({
      hasSavePicker: () => typeof browser.showSaveFilePicker === "function",
      pickSaveFile: (options) => browser.showSaveFilePicker(options),
      async writeBlob(handle, buildBlob) {
        const writable = await handle.createWritable();
        await writable.write(buildBlob());
        await writable.close();
      },
      downloadBlob(blob, filename) {
        const url = environment.URL.createObjectURL(blob);
        const anchor = environment.document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        environment.document.body.appendChild(anchor);
        anchor.click();
        environment.document.body.removeChild(anchor);
        environment.setTimeout(() => environment.URL.revokeObjectURL(url), 1e3);
      }
    });
  }

  // web/shared/host/server-api.js
  function createHostServerApi({ browser, environment }) {
    return Object.freeze({
      fetch(url, options) {
        return environment.fetch(new environment.URL(url, browser.location.href), options);
      }
    });
  }

  // web/editor/boot/editor-host.js
  function createEditorHost({ browser, environment, storage, files, server, runtime }) {
    return Object.freeze({
      storage: storage || createHostStorage(environment),
      files: files || createHostFiles({ browser, environment }),
      server: server || createHostServerApi({ browser, environment }),
      runtime: runtime || Object.freeze({
        getNavigator: () => environment.navigator,
        hasUserActivation: () => Boolean(environment.navigator?.userActivation?.isActive)
      })
    });
  }

  // <stdin>
  window.MaweHost = createEditorHost({ browser: window, environment: globalThis });
})();
