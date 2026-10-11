// Browser file capabilities. A future desktop host can replace this whole service.
export function createFiles(dependencies) {
  'use strict';
  const { browser, environment, desktop } = dependencies;
  return Object.freeze({
    hasSavePicker: () => typeof browser.showSaveFilePicker === 'function',
    pickSaveFile: (options) => browser.showSaveFilePicker(options),
    async writeBlob(handle, buildBlob) {
      const writable = await handle.createWritable();
      await writable.write(buildBlob());
      await writable.close();
    },
    async downloadBlob(blob, filename) {
      const url = environment.URL.createObjectURL(blob);
      const anchor = environment.document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      environment.document.body.appendChild(anchor);
      let anchorAttached = true;
      const removeAnchor = () => {
        if (!anchorAttached) return;
        environment.document.body.removeChild(anchor);
        anchorAttached = false;
      };
      try {
        if (desktop?.available()) {
          const prepared = await desktop.command('prepareExportDownload', {
            url, filename, language: environment.MAWE_I18N?.language,
          });
          if (prepared.status !== 'ok' || typeof prepared.data?.taskId !== 'string') {
            environment.URL.revokeObjectURL(url);
            return prepared;
          }
          const taskId = prepared.data.taskId;
          const result = await new Promise((resolve) => {
            const unsubscribe = desktop.onExportResult((value) => {
              if (value?.taskId !== taskId) return;
              unsubscribe();
              resolve(value);
            });
            try {
              anchor.click();
              removeAnchor();
            } catch (error) {
              unsubscribe();
              resolve({ status: 'error', error: { code: 'DOWNLOAD_START_FAILED', message: error.message || '无法开始导出' } });
            }
          });
          environment.URL.revokeObjectURL(url);
          return result;
        }
        anchor.click();
        environment.setTimeout(() => environment.URL.revokeObjectURL(url), 1000);
        return { status: 'dispatched' };
      } catch (error) {
        environment.URL.revokeObjectURL(url);
        return { status: 'error', error: { code: 'DOWNLOAD_FAILED', message: error?.message || '无法下载文件' } };
      } finally {
        removeAnchor();
      }
    },
  });
}
