// export-workflow: private helpers; dependencies are injected by editor-utils.js.
window.MAWE.register('utils-export-workflow', function createUtilsModule(dependencies) {
  'use strict';
  const { freezeExportValue } = dependencies;


  const EXPORT_SAVE_STATUSES = Object.freeze(['cancelled', 'failed', 'dispatched', 'saved']);


  async function saveSequentialExportArtifacts(artifacts, saveArtifact) {
    if (!Array.isArray(artifacts) || artifacts.length !== 2
      || artifacts[0]?.kind !== 'xml' || artifacts[1]?.kind !== 'srt') {
      throw new Error('export artifacts must contain XML then SRT');
    }
    if (typeof saveArtifact !== 'function') throw new Error('save artifact callback is required');
    const outcomes = { xml: 'not_attempted', srt: 'not_attempted', complete: false };
    for (const artifact of artifacts) {
      const result = await saveArtifact(artifact);
      const status = result?.status;
      if (!EXPORT_SAVE_STATUSES.includes(status)) throw new Error(`invalid export save status: ${status}`);
      outcomes[artifact.kind] = status;
      if (status === 'cancelled' || status === 'failed') return freezeExportValue(outcomes);
    }
    outcomes.complete = true;
    return freezeExportValue(outcomes);
  }


  function quoteFfconcatPath(value) {
    const normalized = String(value || '').trim().replace(/\\/g, '/');
    return `'${normalized.replace(/'/g, "'\\''")}'`;
  }


  function buildFfconcat(mediaPath, intervals) {
    const source = String(mediaPath || '').trim();
    if (!source) return '';
    const lines = ['ffconcat version 1.0'];
    (Array.isArray(intervals) ? intervals : []).forEach((interval) => {
      const start = Math.max(0, Math.round(Number(interval?.start) || 0));
      const end = Math.max(start, Math.round(Number(interval?.end) || 0));
      if (end <= start) return;
      lines.push(`file ${quoteFfconcatPath(source)}`);
      lines.push(`inpoint ${(start / 1000).toFixed(3)}`);
      lines.push(`outpoint ${(end / 1000).toFixed(3)}`);
    });
    return `${lines.join('\n')}\n`;
  }

  return Object.freeze({ buildFfconcat, saveSequentialExportArtifacts });
});
