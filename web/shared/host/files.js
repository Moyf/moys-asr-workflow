// Browser file capabilities. A future desktop host can replace this whole service.
window.MAWE.register('host-files', function createFiles(dependencies) {
  'use strict';
  const { browser, environment } = dependencies;
  return Object.freeze({
    hasSavePicker: () => typeof browser.showSaveFilePicker === 'function',
    pickSaveFile: (options) => browser.showSaveFilePicker(options),
    async writeBlob(handle, buildBlob) {
      const writable = await handle.createWritable();
      await writable.write(buildBlob());
      await writable.close();
    },
    downloadBlob(blob, filename) {
      const url = environment.URL.createObjectURL(blob);
      const anchor = environment.document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      environment.document.body.appendChild(anchor);
      anchor.click();
      environment.document.body.removeChild(anchor);
      environment.setTimeout(() => environment.URL.revokeObjectURL(url), 1000);
    },
  });
});
