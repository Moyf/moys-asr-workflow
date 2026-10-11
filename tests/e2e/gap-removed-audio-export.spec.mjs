import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { makeTempDir, cleanupTempDir, generateWav, generateProjectJson, startServer, findFreePort } from './helpers.mjs';

const source = fs.readFileSync(new URL('../../web/editor/io/editor-wiring-export-actions.js', import.meta.url), 'utf8');
const first = source.indexOf("document.getElementById('download-gap-removed-video')");
const last = source.indexOf("document.getElementById('download-gap-removed-regions-json')", first);
const handler = source.slice(first, last);
const projectLoad = fs.readFileSync(new URL('../../web/editor/io/editor-project-load.js', import.meta.url), 'utf8');
const i18n = fs.readFileSync(new URL('../../web/shared/editor-i18n.js', import.meta.url), 'utf8');

async function fixture(page, mode, run) {
  const requests = [];
  const job = { ok: true, jobId: 'audio-1', state: 'running', stage: 'rebuilding', progress: .25,
    bindingGeneration: 1, sourceMediaId: 'audio-source', cleanupComplete: false };
  const server = http.createServer(async (req, res) => {
    if (req.url === '/') return res.end('<button id="download-gap-removed-video">Export</button><audio id="player"></audio>');
    if (req.url === '/favicon.ico') { res.writeHead(404); return res.end(); }
    requests.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/jobs' && req.method === 'POST') {
      let data = ''; for await (const bytes of req) data += bytes;
      job.payload = JSON.parse(data);
      res.writeHead(202); return res.end(JSON.stringify(job));
    }
    if (req.url.endsWith('/cancel')) {
      if (mode === 'cleanup-stop') Object.assign(job, { state: 'failed', cleanupError: 'Access denied' });
      else if (mode !== 'failed-cleanup') Object.assign(job, { cleanupComplete: true, state: job.state === 'failed' ? 'failed' : 'cancelled' });
      return res.end(JSON.stringify(job));
    }
    if (req.url.endsWith('/download')) {
      res.setHeader('Content-Type', mode === 'wrong-mime' ? 'video/mp4' : 'audio/wav');
      res.setHeader('Content-Length', '4');
      Object.assign(job, { state: mode === 'save-cleanup' ? 'failed' : 'completed', cleanupComplete: mode !== 'save-cleanup',
        ...(mode === 'save-cleanup' ? { cleanupError: 'Access denied' } : {}) });
      return res.end('RIFF');
    }
    if (mode.startsWith('failed')) Object.assign(job, { state: 'failed', error: '[extract_extradata @ 0] No start code is found. C:\\Temp\\maw-media-job-abc\\restructured.mp4: Invalid data found when processing input',
      cleanupComplete: mode !== 'failed-cleanup', ...(mode === 'failed-cleanup' ? { cleanupError: 'Access denied' } : {}) });
    else if (!['stop', 'cleanup-stop'].includes(mode) && job.state === 'running') Object.assign(job, { state: 'ready', stage: 'ready' });
    res.end(JSON.stringify(job));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(mode => {
      window.hints = []; window.saved = false; window.bytes = 0; window.writableCreated = false;
      window.MaweInlineEdit = {};
      window.MaweProjectLoad = { projectBindingEpoch: 1 };
      window.MaweBoot = { FILENAME_BASE: 'music', DATA: { media: 'source.mp3' }, SERVER_CONFIG: {
        canGapRemovedVideoExport: false, gapRemovedVideoSourceName: null,
        canGapRemovedMediaExport: true, gapRemovedMediaKind: 'audio', gapRemovedMediaSourceName: 'source.mp3',
        gapRemovedMediaOutputExtension: '.wav', gapRemovedMediaOutputMime: 'audio/wav', gapRemovedMediaAudioTrack: 0,
        gapRemovedVideoExportUrl: '/legacy', gapRemovedVideoJobsUrl: '/jobs', requestToken: 'audio',
        bindingGeneration: 1, sourceMediaId: 'audio-source',
      } };
      window.MaweExportSrt = { gapRemovedExportContext: () => ({ intervals: [{ start: 123, end: 567 }, { start: 1001, end: 1502 }] }) };
      window.MaweHint = { flashHint: (text, level) => window.hints.push({ text, level }) };
      window.MaweServerSave = { configureServerSaveControls() {}, scheduleAutoSave() {} };
      window.MaweDynamicExports = { updateLottieExportButton() {}, updateOgrafExportButton() {} };
      const handle = { name: mode === 'wrong-extension' ? 'result.mp3' : 'result.wav', createWritable: async () => {
        window.writableCreated = true;
        return { write: async bytes => { window.bytes += bytes.byteLength; }, close: async () => { window.saved = true; }, abort: async () => { window.aborted = true; } };
      } };
      window.MaweHost = { server: { fetch: (...args) => fetch(...args) }, files: { hasSavePicker: () => true,
        pickSaveFile: async options => { window.picker = options; if (mode === 'picker') await new Promise(resolve => { window.resumePicker = resolve; }); return handle; },
      } };
    }, mode);
    await page.addScriptTag({ content: handler });
    await run({ job, requests });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test('audio source uses WAV picker, media capability, exact intervals and complete save', async ({ page }) => {
  await fixture(page, 'save', async ({ job }) => {
    await expect(page.locator('#download-gap-removed-video')).toHaveText('重组后音频');
    await page.click('#download-gap-removed-video');
    await expect.poll(() => page.evaluate(() => window.saved)).toBe(true);
    const picker = await page.evaluate(() => window.picker);
    expect(picker.suggestedName).toBe('music_gap-removed.wav');
    expect(picker.types).toEqual([{ description: '重组后音频', accept: { 'audio/wav': ['.wav'] } }]);
    expect(job.payload).toEqual({ requestToken: 'audio', bindingGeneration: 1, sourceMediaId: 'audio-source', selectedAudioTrack: 0,
      intervals: [{ startMs: 123, endMs: 567 }, { startMs: 1001, endMs: 1502 }] });
    expect(await page.evaluate(() => window.bytes)).toBe(4);
    expect(await page.evaluate(() => window.hints.at(-1).text)).toBe('去空隙音频已重组并保存');
  });
});

for (const mode of ['wrong-extension', 'wrong-mime']) {
  test(`audio ${mode} cannot save a mislabeled file`, async ({ page }) => {
    await fixture(page, mode, async ({ requests }) => {
      await page.click('#download-gap-removed-video');
      await expect.poll(() => page.evaluate(() => window.hints.at(-1).text)).toContain(mode === 'wrong-extension' ? '.wav' : '格式不符合预期');
      expect(await page.evaluate(() => window.writableCreated)).toBe(false);
      expect(await page.evaluate(() => window.saved)).toBe(false);
      if (mode === 'wrong-extension') expect(requests).toEqual([]);
    });
  });
}

for (const mode of ['stop', 'cleanup-stop']) {
  test(`audio ${mode} reports the actual cleanup outcome once`, async ({ page }, testInfo) => {
    await fixture(page, mode, async ({ job }) => {
      await page.click('#download-gap-removed-video');
      await expect(page.locator('#gap-video-job-stop')).toHaveText('停止音频导出');
      await expect(page.locator('#gap-video-job-status')).toContainText('重组去空隙音频');
      if (mode === 'stop') await page.screenshot({ path: testInfo.outputPath('audio-export-progress.png') });
      await page.click('#gap-video-job-stop');
      await expect(page.locator('#download-gap-removed-video')).toBeEnabled();
      const hints = await page.evaluate(() => window.hints);
      expect(hints.filter(hint => hint.text.includes('临时文件清理失败'))).toHaveLength(mode === 'cleanup-stop' ? 1 : 0);
      expect(hints.filter(hint => hint.text === '音频导出已停止')).toHaveLength(mode === 'stop' ? 1 : 0);
      expect(await page.evaluate(() => window.saved)).toBe(false);
      expect(job.state).toBe(mode === 'stop' ? 'cancelled' : 'failed');
    });
  });
}

for (const mode of ['failed-cleaned', 'failed-cleanup']) {
  test(`${mode} hides FFmpeg diagnostics and separates export from cleanup failure`, async ({ page }) => {
    await fixture(page, mode, async () => {
      await page.click('#download-gap-removed-video');
      await expect.poll(() => page.evaluate(() => window.hints.some(hint => hint.text.includes('导出失败')))).toBe(true);
      await expect(page.locator('#download-gap-removed-video')).toBeEnabled();
      const hints = await page.evaluate(() => window.hints);
      expect(hints.filter(hint => hint.text.includes('重组后音频导出失败'))).toHaveLength(1);
      expect(hints.filter(hint => hint.text.includes('临时文件清理失败'))).toHaveLength(mode === 'failed-cleanup' ? 1 : 0);
      expect(hints.some(hint => /extract_extradata|No start code|maw-media-job-|Access denied/.test(hint.text))).toBe(false);
      expect(hints.some(hint => hint.text.includes('无法确认'))).toBe(false);
    });
  });
}

test('successful file save still reports real backend cleanup failure once', async ({ page }) => {
  await fixture(page, 'save-cleanup', async () => {
    await page.click('#download-gap-removed-video');
    await expect.poll(() => page.evaluate(() => window.saved)).toBe(true);
    await expect(page.locator('#download-gap-removed-video')).toBeEnabled();
    const hints = await page.evaluate(() => window.hints);
    expect(hints.filter(hint => hint.text === '去空隙音频已重组并保存')).toHaveLength(1);
    expect(hints.filter(hint => hint.text.includes('临时文件清理失败'))).toHaveLength(1);
    expect(hints.some(hint => hint.text.includes('导出失败'))).toBe(false);
  });
});

for (const selection of [{ selected_audio_track: 1 }, { audio_tracks: [{ audio_index: 2, default: true }] }]) {
  test(`audio export freezes current metadata selection ${JSON.stringify(selection)}`, async ({ page }) => {
    await fixture(page, 'save', async ({ job }) => {
      await page.evaluate(selection => { MaweBoot.DATA.media_metadata = selection; }, selection);
      await page.click('#download-gap-removed-video');
      await expect.poll(() => page.evaluate(() => window.saved)).toBe(true);
      expect(job.payload.selectedAudioTrack).toBe(selection.selected_audio_track ?? 2);
    });
  });
}

test('English export failures translate the backend user message', async ({ page }) => {
  await fixture(page, 'stop', async ({ job }) => {
    await page.addScriptTag({ content: i18n });
    await page.evaluate(() => MAWE_I18N.applyLanguage('en'));
    await page.click('#download-gap-removed-video');
    await expect.poll(() => Boolean(job.payload)).toBe(true);
    Object.assign(job, { state: 'failed', cleanupComplete: true, error: '保留区间超出了音频实际时长，请重新加载工程后再试' });
    await expect.poll(() => page.evaluate(() => window.hints.at(-1).text)).toContain('The kept intervals exceed the audio duration');
    await expect(page.locator('#download-gap-removed-video')).toBeEnabled();
    const hints = await page.evaluate(() => window.hints);
    expect(hints.some(hint => /[\u4e00-\u9fff]/.test(hint.text))).toBe(false);
  });
});

for (const field of ['gapRemovedMediaKind', 'gapRemovedMediaSourceName', 'gapRemovedMediaOutputExtension', 'gapRemovedMediaOutputMime', 'canGapRemovedMediaExport', 'gapRemovedMediaAudioTrack', 'local-audio-track']) {
  test(`audio picker rejects changed ${field}`, async ({ page }) => {
    await fixture(page, 'picker', async ({ requests }) => {
      await page.click('#download-gap-removed-video');
      await expect.poll(() => page.evaluate(() => Boolean(window.resumePicker))).toBe(true);
      await page.evaluate(field => {
        if (field === 'local-audio-track') MaweBoot.DATA.media_metadata = { selected_audio_track: 1 };
        else MaweBoot.SERVER_CONFIG[field] = field === 'canGapRemovedMediaExport' ? false : 'changed';
        window.resumePicker();
      }, field);
      await expect.poll(() => page.evaluate(() => window.hints.at(-1).text)).toContain('绑定已变更');
      expect(requests).toEqual([]);
      expect(await page.evaluate(() => window.writableCreated)).toBe(false);
    });
  });
}

test('detach clears all capabilities and label follows media and language changes', async ({ page }) => {
  await fixture(page, 'save', async () => {
    await page.addScriptTag({ content: projectLoad });
    await page.addScriptTag({ content: i18n });
    await page.evaluate(() => MaweProjectLoad.detachServerProjectSaving());
    expect(await page.evaluate(() => [MaweBoot.SERVER_CONFIG.canGapRemovedMediaExport, MaweBoot.SERVER_CONFIG.canGapRemovedVideoExport])).toEqual([false, false]);
    expect(await page.evaluate(() => [MaweBoot.SERVER_CONFIG.gapRemovedMediaKind, MaweBoot.SERVER_CONFIG.gapRemovedMediaSourceName,
      MaweBoot.SERVER_CONFIG.gapRemovedMediaOutputExtension, MaweBoot.SERVER_CONFIG.gapRemovedMediaOutputMime,
      MaweBoot.SERVER_CONFIG.gapRemovedVideoSourceName, MaweBoot.SERVER_CONFIG.sourceMediaId,
      MaweBoot.SERVER_CONFIG.gapRemovedMediaAudioTrack])).toEqual([null, null, null, null, null, null, null]);
    await expect(page.locator('#download-gap-removed-video')).toHaveText('重组后音频');
    await page.evaluate(() => MAWE_I18N.applyLanguage('en'));
    await expect(page.locator('#download-gap-removed-video')).toHaveText('Reconstructed audio');
    await page.evaluate(() => { MaweBoot.SERVER_CONFIG.gapRemovedMediaKind = 'video'; MaweGapRemovedMediaExport.updateButton(); });
    await expect(page.locator('#download-gap-removed-video')).toHaveText('Reconstructed video');
    await page.evaluate(() => MAWE_I18N.applyLanguage('zh'));
    await expect(page.locator('#download-gap-removed-video')).toHaveText('重组后视频');
    await page.evaluate(() => {
      MaweBoot.SERVER_CONFIG.gapRemovedMediaKind = null;
      MaweBoot.DATA.media = 'not-yet-loaded.mp4';
      MaweGapRemovedMediaExport.updateButton();
    });
    // Project reset uses an empty audio element even for a video project.
    await expect(page.locator('#download-gap-removed-video')).toHaveText('重组后视频');
    await page.evaluate(() => { MaweBoot.DATA.media = ''; MaweGapRemovedMediaExport.updateButton(); });
    await expect(page.locator('#download-gap-removed-video')).toHaveText('重组后视频');
  });
});

test('rendered audio editor offers WAV and saves the real server output', async ({ page }, testInfo) => {
  const dir = makeTempDir('gap-audio-editor');
  let server;
  try {
    const wav = generateWav(join(dir, 'source.wav'), 3);
    const project = generateProjectJson(join(dir, 'source.mosp'));
    server = await startServer(project, wav, await findFreePort());
    await page.goto(server.url);
    await page.waitForFunction(() => window.MaweExportSrt && MaweBoot.SERVER_CONFIG.canGapRemovedMediaExport);
    await expect(page.locator('#download-gap-removed-video')).toHaveText('重组后音频');
    await page.evaluate(() => {
      MaweBoot.DATA.gap_remove = { gaps: [{ start: 567, end: 1001, removed: true }] };
      MaweGapRemoveUi.updateGapRemoveUi();
    });
    await page.click('#gap-removed-export-btn');
    await expect(page.locator('#download-gap-removed-video')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('real-audio-export-menu.png') });
    await page.evaluate(() => {
      window.audioChunks = []; window.audioSaved = false; window.audioHints = [];
      window.MaweHint = { ...window.MaweHint, flashHint: text => window.audioHints.push(text) };
      window.MaweExportSrt = { ...window.MaweExportSrt, gapRemovedExportContext: () => ({ intervals: [{ start: 123, end: 567 }, { start: 1001, end: 1502 }] }) };
      window.showSaveFilePicker = async options => {
        window.audioPicker = options;
        return { name: 'result.wav', createWritable: async () => ({ write: async bytes => window.audioChunks.push(Array.from(bytes)),
          close: async () => { window.audioSaved = true; }, abort: async () => {} }) };
      };
      document.getElementById('download-gap-removed-video').click();
    });
    await expect.poll(() => page.evaluate(() => window.audioSaved), { timeout: 15000 }).toBe(true);
    expect(await page.evaluate(() => window.audioPicker.types[0].accept)).toEqual({ 'audio/wav': ['.wav'] });
    const output = Buffer.from(await page.evaluate(() => window.audioChunks.flat()));
    expect(output.subarray(0, 4).toString()).toBe('RIFF');
    const outputPath = testInfo.outputPath('real-gap-removed-audio.wav');
    fs.writeFileSync(outputPath, output);
    // WAV fixtures use mono PCM16; check exact output samples through RIFF chunks.
    let offset = 12;
    let dataBytes = null;
    let sampleRate = null;
    let blockAlign = null;
    while (offset + 8 <= output.length) {
      const kind = output.subarray(offset, offset + 4).toString();
      const length = output.readUInt32LE(offset + 4);
      if (kind === 'fmt ') { sampleRate = output.readUInt32LE(offset + 12); blockAlign = output.readUInt16LE(offset + 20); }
      if (kind === 'data') { dataBytes = length; break; }
      offset += 8 + length + length % 2;
    }
    expect(dataBytes).not.toBeNull();
    expect(dataBytes / blockAlign).toBe(Math.round(567 * sampleRate / 1000) - Math.round(123 * sampleRate / 1000)
      + Math.round(1502 * sampleRate / 1000) - Math.round(1001 * sampleRate / 1000));
    expect(await page.evaluate(() => window.audioHints.at(-1))).toBe('去空隙音频已重组并保存');
    await page.screenshot({ path: testInfo.outputPath('real-audio-editor-saved.png') });
  } finally {
    await server?.stop();
    cleanupTempDir(dir);
  }
});

test('rendered compressed stereo audio exports float WAV decodable by the browser', async ({ page }, testInfo) => {
  const dir = makeTempDir('gap-audio-mp3-editor');
  let server;
  try {
    const mp3 = join(dir, 'stereo.mp3');
    execFileSync('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i',
      'aevalsrc=0.25*sin(2*PI*440*t)|0.25*sin(2*PI*660*t):s=44100:d=3', '-c:a', 'libmp3lame', '-b:a', '192k', mp3], { timeout: 15000 });
    const original = fs.readFileSync(mp3);
    const project = generateProjectJson(join(dir, 'stereo.mosp'));
    server = await startServer(project, mp3, await findFreePort());
    await page.goto(server.url);
    await page.waitForFunction(() => window.MaweExportSrt && MaweBoot.SERVER_CONFIG.canGapRemovedMediaExport);
    await expect(page.locator('#download-gap-removed-video')).toHaveText('重组后音频');
    await page.evaluate(() => {
      window.floatChunks = []; window.floatSaved = false; window.floatHints = [];
      window.MaweHint = { ...window.MaweHint, flashHint: text => window.floatHints.push(text) };
      window.MaweExportSrt = { ...window.MaweExportSrt, gapRemovedExportContext: () => ({ intervals: [{ start: 123, end: 567 }, { start: 1001, end: 1502 }] }) };
      window.showSaveFilePicker = async () => ({ name: 'result.wav', createWritable: async () => ({
        write: async bytes => window.floatChunks.push(Array.from(bytes)), close: async () => { window.floatSaved = true; }, abort: async () => {},
      }) });
      document.getElementById('download-gap-removed-video').click();
    });
    await expect.poll(() => page.evaluate(() => window.floatSaved), { timeout: 15000 }).toBe(true);
    const output = Buffer.from(await page.evaluate(() => window.floatChunks.flat()));
    fs.writeFileSync(testInfo.outputPath('stereo-float-gap-removed.wav'), output);
    const decoded = await page.evaluate(async () => {
      const context = new AudioContext({ sampleRate: 44100 });
      try {
        const bytes = Uint8Array.from(window.floatChunks.flat());
        const buffer = await context.decodeAudioData(bytes.buffer);
        return { sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels, length: buffer.length,
          duration: buffer.duration, peaks: Array.from({ length: buffer.numberOfChannels }, (_, channel) => {
            const samples = buffer.getChannelData(channel);
            return Math.max(...samples.subarray(0, 1000).map(Math.abs));
          }) };
      } finally { await context.close(); }
    });
    const expectedSamples = Math.round(567 * 44.1) - Math.round(123 * 44.1)
      + Math.round(1502 * 44.1) - Math.round(1001 * 44.1);
    expect(decoded.sampleRate).toBe(44100);
    expect(decoded.channels).toBe(2);
    expect(decoded.length).toBe(expectedSamples);
    expect(decoded.duration).toBeCloseTo(expectedSamples / 44100, 8);
    expect(decoded.peaks.every(peak => peak > .1 && peak < .5)).toBe(true);
    expect(fs.readFileSync(mp3).equals(original)).toBe(true);
    expect(await page.evaluate(() => window.floatHints.at(-1))).toBe('去空隙音频已重组并保存');
    fs.writeFileSync(testInfo.outputPath('browser-decoded-audio.json'), JSON.stringify(decoded, null, 2));
  } finally {
    await server?.stop();
    cleanupTempDir(dir);
  }
});
