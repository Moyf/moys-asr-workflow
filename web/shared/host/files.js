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
    downloadBlob(blob, filename, { separateFrame = false } = {}) {
      const url = environment.URL.createObjectURL(blob);
      const frame = separateFrame ? environment.document.createElement('iframe') : null;
      if (frame) {
        frame.hidden = true;
        environment.document.body.appendChild(frame);
      }
      const target = frame?.contentDocument || environment.document;
      const anchor = target.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      target.body.appendChild(anchor);
      try {
        anchor.click();
      } finally {
        target.body.removeChild(anchor);
        environment.setTimeout(() => {
          environment.URL.revokeObjectURL(url);
          frame?.remove();
        }, 1000);
      }
    },
  });
}
