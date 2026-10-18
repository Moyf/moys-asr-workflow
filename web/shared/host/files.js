// Browser file capabilities. A future desktop host can replace this whole service.
export function createFiles(dependencies) {
  'use strict';
  const { browser, environment } = dependencies;
  return Object.freeze({
    hasSavePicker: () => typeof browser.showSaveFilePicker === 'function',
    pickSaveFile: (options) => browser.showSaveFilePicker(options),
    async writeBlob(handle, buildBlob) {
      const writable = await handle.createWritable();
      try {
        await writable.write(buildBlob());
        await writable.close();
      } catch (error) {
        try { await writable.abort?.(); } catch (_) {}
        throw error;
      }
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
}
