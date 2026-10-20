// 烧录视频任务流回归：两个入口的请求契约、停止取消与保存校验。
// 与 gap-removed-media-jobs.spec.mjs 同一模式：注入编辑器接线源码 + 本地假任务服务器。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileSources, readSources, readModules } from '../../scripts/build-editor.mjs';
import { makeTempDir, cleanupTempDir } from './helpers.mjs';

const source = fs.readFileSync(new URL('../../web/editor/io/editor-wiring-burn-video.js', import.meta.url), 'utf8');
// 整个模块可安全注入：初始化只读取 SERVER_CONFIG 并绑定按钮，业务入口都是点击回调。
const handler = source;

// Compile the real DOM-free shared modules through the production translator,
// as tests/helpers/editor-module-loader.mjs does for Node fixtures.
const root = fileURLToPath(new URL('../../', import.meta.url));
const utilityFiles = readSources(root).filter(name => name === 'editor/boot/editor-runtime.js'
  || name === 'editor/boot/editor-host.js' || name.startsWith('shared/host/')
  || name === 'shared/gap-remove-core.js' || name === 'shared/editor-utils.js'
  || name.startsWith('shared/utils/'));
const utilitySource = (await compileSources(root, utilityFiles,
  readModules(root).filter(module => utilityFiles.includes(module.file)),
  file => fs.readFileSync(join(root, 'web', file), 'utf8'),
  { beforeEntry: 'shared/editor-utils.js' })).code;
const stickerPlanSource = fs.readFileSync(new URL('../../web/editor/io/editor-sticker-burn-plan.js', import.meta.url), 'utf8');


async function fixture(mode, run) {
  const jobs = new Map();
  const requests = [];
  const payloads = [];
  const sockets = new Set();
  let generation = 0;
  const server = http.createServer(async (req, res) => {
    requests.push(req.url);
    if (req.url === '/') {
      res.end('<button id="burn-video-export-btn">Burn</button>'
        + '<button id="download-gap-removed-burn-video">Burn gap-removed</button>'
        + '<button id="download-green-screen-video">Green screen</button>'
        + '<input type="checkbox" id="green-screen-include-audio">');
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/jobs') {
      let data = ''; for await (const chunk of req) data += chunk;
      const payload = JSON.parse(data);
      payloads.push(payload);
      const jobId = String(++generation);
      jobs.set(jobId, { ok: true, jobId, state: 'running', stage: 'burning', progress: .4,
        bindingGeneration: payload.bindingGeneration, sourceMediaId: payload.sourceMediaId,
        admissionToken: payload.admissionToken });
      if (mode === 'admission-body') { res.writeHead(202); res.write('{"ok":true,'); return; }
      res.writeHead(202); res.end(JSON.stringify(jobs.get(jobId))); return;
    }
    if (req.method === 'POST' && req.url === '/jobs/cancel-admission') {
      let data = ''; for await (const chunk of req) data += chunk;
      const payload = JSON.parse(data);
      const job = [...jobs.values()].find(job => job.admissionToken === payload.admissionToken);
      if (!job) { res.writeHead(404); res.end('{}'); return; }
      job.state = 'cancelled'; job.cleanupComplete = true;
      res.end(JSON.stringify(job)); return;
    }
    const match = req.url.match(/^\/jobs\/(\d+)(\/cancel|\/download)?$/);
    const job = match && jobs.get(match[1]);
    if (!job) { res.writeHead(404); res.end('{}'); return; }
    if (match[2] === '/cancel') {
      job.state = 'cancelled'; job.cleanupComplete = true;
      res.end(JSON.stringify(job)); return;
    }
    if (match[2] === '/download') {
      if (job.state !== 'ready') { res.writeHead(409); res.end('{}'); return; }
      job.state = 'downloading';
      res.setHeader('Content-Type', mode === 'mime-failure' ? 'text/plain' : 'video/mp4');
      res.setHeader('Content-Length', '4');
      res.writeHead(200);
      res.end('test'); job.state = 'completed';
      return;
    }
    if (!['prepare', 'burn', 'admission-body'].includes(mode) && job.state === 'running') {
      job.state = 'ready'; job.stage = 'ready'; job.progress = 1;
    }
    res.end(JSON.stringify(job));
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`, { jobs, requests, payloads }); }
  finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
}

let temp;
test.beforeEach(() => { temp = makeTempDir(); });
test.afterEach(() => cleanupTempDir(temp));

async function install(page, origin, mode) {
  await page.goto(origin);
  await page.addScriptTag({ content: utilitySource });
  await page.addScriptTag({ content: stickerPlanSource });

  await page.evaluate(mode => {
    window.hints = []; window.saved = false;
    window.subtitleBuildOptions = [];
    window.MaweGapRemoveData = { getRemovedGapRanges: () => [] };
    window.MaweInlineEdit = {};
    window.MaweCoreState = { player: { currentSrc: location.origin + '/media' } };
    window.MaweProjectLoad = { projectBindingEpoch: 1 };
    window.MaweSettings = { EDITOR_SETTINGS: { assMode: mode !== 'ass-off' },
      updateEditorSettings: patch => Object.assign(MaweSettings.EDITOR_SETTINGS, patch) };
    window.MaweBoot = { FILENAME_BASE: 'fixture', SERVER_CONFIG: { canBurnVideoExport: true, canGreenScreenExport: true,
      burnVideoSourceName: 'source.mp4', burnVideoJobsUrl: '/jobs',
      requestToken: 'fixture', bindingGeneration: 1, sourceMediaId: 'opaque-source' } };
    window.MaweExportSrt = {
      buildAss: options => { subtitleBuildOptions.push(['ass', options && { alignFirstStart: options.alignFirstStart }]); return '[Script Info] full'; },
      buildGapRemovedAss: options => { subtitleBuildOptions.push(['gap-ass', options && { alignFirstStart: options.alignFirstStart }]); return '[Script Info] gap-removed'; },
      buildSrt: options => { subtitleBuildOptions.push(['srt', options && { alignFirstStart: options.alignFirstStart }]); return '1\n00:00:00,000 --> 00:00:01,000\nCURRENT SRT\n'; },
      buildGapRemovedSrt: options => { subtitleBuildOptions.push(['gap-srt', options && { alignFirstStart: options.alignFirstStart }]); return '1\n00:00:00,000 --> 00:00:01,000\nSHORTENED SRT\n'; },
      gapRemovedExportContext: () => ({ intervals: [{ start: 0, end: 1000 }] }),
      currentAssVideoResolution: () => ({ width: 1920, height: 1080 }),
    };
    window.MaweHint = { flashHint: (text) => window.hints.push(text) };
    window.MaweHost = { server: { fetch: (...args) => fetch(...args) }, files: {
      hasSavePicker: () => true,
      pickSaveFile: async ({ suggestedName }) => {
        window.pickedName = suggestedName;
        return { name: mode === 'source-name' ? 'source.mp4'
          : mode === 'bad-extension' ? 'result.mkv' : 'result.mp4',
          createWritable: async () => ({
            write: async () => {},
            close: async () => { window.saved = true; },
            abort: async () => {},
          }) };
      },
    } };
  }, mode);
  await page.addScriptTag({ content: handler });
}

for (const [buttonId, label, expected] of [
  ['#burn-video-export-btn', '烧录视频', { ass: '[Script Info] full' }],
  ['#download-gap-removed-burn-video', '重组后烧录视频',
    { ass: '[Script Info] gap-removed', intervals: [{ startMs: 0, endMs: 1000 }] }],
]) {
  test(`${label} burns, downloads and saves with a dated MP4 name`, async ({ page }) => {
    await fixture('ready', async (origin, state) => {
      await install(page, origin, 'ready');
      await page.click(buttonId);
      await expect.poll(() => page.evaluate(() => window.saved)).toBe(true);
      await expect.poll(() => page.evaluate(() => window.hints.some(text => text.includes('已保存')))).toBe(true);
      const payload = state.payloads[0];
      expect(payload.ass).toBe(expected.ass);
      expect(await page.evaluate(() => window.subtitleBuildOptions)).toEqual([[buttonId.includes('gap') ? 'gap-ass' : 'ass',
        { alignFirstStart: false }]]);
      expect(payload.intervals).toEqual(expected.intervals ?? undefined);
      expect(payload.admissionToken).toMatch(/^[a-f0-9]{64}$/);
      expect(payload.requestToken).toBe('fixture');
      expect(payload.bindingGeneration).toBe(1);
      expect(payload.sourceMediaId).toBe('opaque-source');
      expect(await page.evaluate(() => window.pickedName)).toMatch(/\.mp4$/);
      expect(state.requests.some(path => path.endsWith('/download'))).toBe(true);
    });
  });
}

for (const includeAudio of [false, true]) {
  test(`green screen works without ASS preview and includeAudio=${includeAudio}`, async ({ page }) => {
    await fixture('ready', async (origin, state) => {
      await install(page, origin, 'ass-off');
      await page.evaluate(() => {
        MaweBoot.SERVER_CONFIG.canBurnVideoExport = false;
        MaweBurnVideoExport.syncButton();
      });
      await expect(page.locator('#green-screen-include-audio')).not.toBeChecked();
      if (includeAudio) await page.check('#green-screen-include-audio');
      await page.click('#download-green-screen-video');
      await expect.poll(() => page.evaluate(() => window.saved)).toBe(true);
      expect(state.payloads[0]).toMatchObject({ greenScreen: true, includeAudio, ass: '[Script Info] full' });
      await page.evaluate(() => MaweBurnVideoExport.invalidateBinding());
      await expect(page.locator('#download-green-screen-video')).toBeHidden();
    });
  });
}

test('stop during burning cancels the task and permits retry', async ({ page }) => {
  await fixture('burn', async (origin, state) => {
    await install(page, origin, 'burn');
    await page.click('#burn-video-export-btn');
    await expect(page.locator('#burn-video-job-stop')).toBeVisible();
    await expect(page.locator('#burn-video-job-status')).toContainText('正在烧录字幕');
    await page.click('#burn-video-job-stop');
    await expect.poll(() => page.evaluate(() => window.hints.some(text => text.includes('已停止')))).toBe(true);
    expect([...state.jobs.values()][0].state).toBe('cancelled');
    expect(await page.evaluate(() => window.hints.some(text => text.includes('已保存')))).toBe(false);
    await expect(page.locator('#burn-video-export-btn')).toBeEnabled();
    await page.click('#burn-video-export-btn');
    await expect.poll(() => state.jobs.size).toBe(2);
    await page.click('#burn-video-job-stop');
    await expect(page.locator('#burn-video-export-btn')).toBeEnabled();
  });
});

test('stop cancels admitted work before a delayed admission delivers jobId', async ({ page }) => {
  await fixture('admission-body', async (origin, state) => {
    await install(page, origin, 'admission-body');
    await page.click('#burn-video-export-btn');
    await expect.poll(() => state.jobs.size).toBe(1);
    expect(await page.evaluate(() => window.__maweBurnVideoTask.id)).toBeNull();
    const job = [...state.jobs.values()][0];
    await page.click('#burn-video-job-stop');
    await expect.poll(() => job.state).toBe('cancelled');
    expect(state.requests).toContain('/jobs/cancel-admission');
    expect(state.requests.some(path => path.endsWith('/download'))).toBe(false);
    await expect.poll(() => page.evaluate(() => window.hints.includes('视频烧录已停止'))).toBe(true);
    expect(await page.evaluate(() => window.__maweBurnVideoTask)).toBeNull();
  });
});

test('mime failure, source-name conflict and bad extension clear the task', async ({ page }) => {
  await fixture('mime-failure', async (origin, state) => {
    await install(page, origin, 'mime-failure');
    await page.click('#burn-video-export-btn');
    await expect.poll(() => page.evaluate(() => window.hints.some(text => text.includes('导出失败')))).toBe(true);
    await expect.poll(() => [...state.jobs.values()][0]?.state).toBe('cancelled');
    expect(await page.evaluate(() => window.saved)).toBe(false);
    await expect(page.locator('#burn-video-export-btn')).toBeEnabled();
  });
  await fixture('ready', async (origin) => {
    await install(page, origin, 'source-name');
    await page.click('#burn-video-export-btn');
    expect(await page.evaluate(() => window.hints)).toContain('保存目标不能与源视频同名');
  });
  await fixture('ready', async (origin) => {
    await install(page, origin, 'bad-extension');
    await page.click('#burn-video-export-btn');
    expect(await page.evaluate(() => window.hints)).toContain('烧录视频请使用 .mp4 扩展名');
  });
});

test('gap-removed entry without removed gaps or ASS content stays silent and fails softly', async ({ page }) => {
  await fixture('ready', async (origin) => {
    await install(page, origin, 'ready');
    // 真实实现的 gapRemovedExportContext 返回 null 前会自行提示原因。
    await page.evaluate(() => {
      window.MaweExportSrt.gapRemovedExportContext = () => {
        window.MaweHint.flashHint('没有已移除的静音空隙；请先在「静音空隙」中扫描', 'invalid');
        return null;
      };
    });
    await page.click('#download-gap-removed-burn-video');
    await expect.poll(() => page.evaluate(() => window.hints.some(text => text.includes('静音空隙')))).toBe(true);
    expect(await page.evaluate(() => window.saved)).toBe(false);
  });
});

test('toolbar burn button supports ASS and SRT with a bound video project', async ({ page }) => {
  await fixture('ready', async (origin) => {
    await install(page, origin, 'ass-off');
    await expect(page.locator('#burn-video-export-btn')).toBeVisible();
    await page.evaluate(() => {
      MaweSettings.EDITOR_SETTINGS.assMode = true;
      MaweBurnVideoExport.syncButton();
    });
    await expect(page.locator('#burn-video-export-btn')).toBeVisible();
    await page.evaluate(() => {
      MaweBoot.SERVER_CONFIG.canBurnVideoExport = false;
      MaweBurnVideoExport.syncButton();
    });
    await expect(page.locator('#burn-video-export-btn')).toBeHidden();
  });
});

for (const [buttonId, text] of [['#burn-video-export-btn', 'CURRENT SRT'],
  ['#download-gap-removed-burn-video', 'SHORTENED SRT']]) {
  test(`SRT mode uses current text through the same job API: ${buttonId}`, async ({ page }) => {
    await fixture('ready', async (origin, state) => {
      await install(page, origin, 'ass-off');
      await page.evaluate(() => {
        window.commits = [];
        MaweInlineEdit.editingState = {};
        MaweInlineEdit.extensionEditingState = {};
        MaweInlineEdit.finishEdit = () => commits.push('main');
        MaweInlineEdit.finishExtensionEdit = () => commits.push('extension');
      });
      await page.click(buttonId);
      await expect.poll(() => page.evaluate(() => window.saved)).toBe(true);
      expect(state.payloads[0].srt).toContain(text);
      expect(await page.evaluate(() => window.subtitleBuildOptions)).toEqual([[buttonId.includes('gap') ? 'gap-srt' : 'srt',
        { alignFirstStart: false }]]);
      expect(state.payloads[0].ass).toBeUndefined();
      expect(await page.evaluate(() => commits)).toEqual(['main', 'extension']);
      if (buttonId.includes('gap')) expect(state.payloads[0].intervals).toEqual([{ startMs: 0, endMs: 1000 }]);
    });
  });
}


test('picker resume rejects revoked burn capability before creating a job', async ({ page }) => {
  await fixture('ready', async (origin, state) => {
    await install(page, origin, 'ready');
    await page.evaluate(() => {
      MaweHost.files.pickSaveFile = () => new Promise(resolve => {
        window.finishPicker = () => resolve({ name: 'result.mp4' });
      });
    });
    await page.click('#burn-video-export-btn');
    await expect.poll(() => page.evaluate(() => Boolean(window.finishPicker))).toBe(true);
    await page.evaluate(() => {
      MaweBoot.SERVER_CONFIG.canBurnVideoExport = false;
      window.finishPicker();
    });
    await expect.poll(() => page.evaluate(() => window.hints.some(t => t.includes('绑定已变更')))).toBe(true);
    expect(state.payloads).toEqual([]);
    expect(await page.evaluate(() => window.saved)).toBe(false);
  });
});

for (const button of ['#burn-video-export-btn', '#download-gap-removed-burn-video', '#download-green-screen-video']) {
  test(`${button} snapshots project gain before waiting for the save picker`, async ({ page }) => {
    await fixture('ready', async (origin, state) => {
      await install(page, origin, 'ready');
      await page.evaluate(() => {
        window.fixtureGain = 6;
        window.MaweAudioProcessing = { settings: () => ({ gain_db: window.fixtureGain }) };
        const originalPicker = MaweHost.files.pickSaveFile;
        MaweHost.files.pickSaveFile = options => new Promise(resolve => {
          window.finishGainPicker = () => resolve(originalPicker(options));
        });
      });
      await page.click(button);
      await expect.poll(() => page.evaluate(() => Boolean(window.finishGainPicker))).toBe(true);
      await page.evaluate(() => { window.fixtureGain = -12; window.finishGainPicker(); });
      await expect.poll(() => page.evaluate(() => window.saved)).toBe(true);
      expect(state.payloads[0].audioGainDb).toBe(6);
    });
  });
}

for (const phase of ['admission-body', 'write-pending']) {
  test(`detach cancels burn during ${phase} without committing output`, async ({ page }) => {
    await fixture(phase === 'admission-body' ? phase : 'ready', async (origin, state) => {
      await install(page, origin, 'ready');
      await page.evaluate(phase => {
        window.MaweServerSave = { configureServerSaveControls() {}, scheduleAutoSave() {} };
        window.MaweDynamicExports = { updateLottieExportButton() {}, updateOgrafExportButton() {} };
        window.fileAborted = false;
        if (phase === 'write-pending') MaweHost.files.pickSaveFile = async () => ({ name: 'result.mp4',
          createWritable: async () => ({ write: () => new Promise(() => { window.writeStarted = true; }),
            close: async () => { window.saved = true; }, abort: async () => { window.fileAborted = true; } }) });
      }, phase);
      await page.addScriptTag({ content: fs.readFileSync(new URL('../../web/editor/io/editor-project-load.js', import.meta.url), 'utf8') });
      await page.click('#burn-video-export-btn');
      await expect.poll(() => state.jobs.size).toBe(1);
      if (phase === 'write-pending') await expect.poll(() => page.evaluate(() => window.writeStarted)).toBe(true);
      await page.evaluate(() => MaweProjectLoad.detachServerProjectSaving());
      await expect.poll(() => [...state.jobs.values()][0].state).toBe('cancelled');
      await expect.poll(() => page.evaluate(() => window.__maweBurnVideoTask)).toBeNull();
      expect(await page.evaluate(() => window.saved)).toBe(false);
      if (phase === 'write-pending') expect(await page.evaluate(() => window.fileAborted)).toBe(true);
      await expect(page.locator('#burn-video-export-btn')).toBeHidden();
    });
  });
}


for (const assMode of [true, false]) {
  for (const gapRemoved of [false, true]) {
    test(`${assMode ? 'ASS' : 'SRT'} ${gapRemoved ? 'gap-removed' : 'ordinary'} burn keeps media timing and sticker placement`, async ({ page }) => {
      await fixture('ready', async (origin, state) => {
        await install(page, origin, assMode ? 'ready' : 'ass-off');
        await page.evaluate(({ assMode, gapRemoved }) => {
          Object.assign(MaweSettings.EDITOR_SETTINGS, { assMode, exportStartAtZero: true,
            stickersEnabled: true, stickerBurnMode: 'cue-left' });
          window.MaweDom = { stickerOverlayToggle: { checked: true } };
          window.MawePreviewGeometry = { getStickerGeometry: () => ({
            x: 1400 / 1920, y: 80 / 1080, width: 460 / 1920, height: 324 / 1080,
          }) };
          const removed = [{ start: 1000, end: 2000, removed: true }];
          window.MaweGapRemoveData = { getRemovedGapRanges: () => removed };
          window.MaweStickerOverlay = { rebuildStickerIntervals() {}, stickerIntervals: [
            { start: 3000, end: 4000, source: { rel: 'a.png' } },
            // A second window is wholly removed; it must not survive at a zero-length boundary.
            ...(gapRemoved ? [{ start: 1300, end: 1500, source: { rel: 'removed.png' } }] : []),
          ] };
          const start = gapRemoved ? 2000 : 3000;
          const end = gapRemoved ? 3000 : 4000;
          const plan = { width: 1920, height: 1080, slices: [{ start, end,
            legacy: false, scale: 1, height: 1080, diagnostic: '',
            pieces: [{ start, end, instant: null, from: { x: 900, y: 900 }, to: { x: 900, y: 900 } }],
            items: [{ role: 'main', start, end, fontSize: 60, cueScale: 1,
              alignment: 2, manual: false, absolute: false, offset: { x: 20, y: -10 },
              rect: { left: -30, top: -80, right: 500, bottom: 10 } }],
          }] };
          const build = (format, shortened) => options => {
            subtitleBuildOptions.push([`${shortened ? 'gap-' : ''}${format}`,
              { alignFirstStart: options?.alignFirstStart }]);
            const begin = options?.alignFirstStart === false ? start : 0;
            if (format === 'ass') {
              options?.onAssPlan?.(plan);
              return `[Events]\nDialogue: 0,0:00:0${begin / 1000}.00,0:00:0${end / 1000}.00,Default,,0,0,0,,CURRENT`;
            }
            return `1\n00:00:0${begin / 1000},000 --> 00:00:0${end / 1000},000\nCURRENT\n`;
          };
          Object.assign(MaweExportSrt, { buildAss: build('ass', false), buildGapRemovedAss: build('ass', true),
            buildSrt: build('srt', false), buildGapRemovedSrt: build('srt', true),
            gapRemovedExportContext: () => ({ intervals: [{ start: 0, end: 1000 }, { start: 2000, end: 5000 }] }),
          });
        }, { assMode, gapRemoved });
        await page.click(gapRemoved ? '#download-gap-removed-burn-video' : '#burn-video-export-btn');
        await expect.poll(() => page.evaluate(() => window.saved)).toBe(true);
        expect(state.payloads).toHaveLength(1);
        const payload = state.payloads[0];
        const start = gapRemoved ? 2000 : 3000;
        const end = gapRemoved ? 3000 : 4000;
        const format = assMode ? 'ass' : 'srt';
        expect(payload[format]).toContain(assMode ? `0:00:0${start / 1000}.00` : `00:00:0${start / 1000},000`);
        expect(payload[assMode ? 'srt' : 'ass']).toBeUndefined();
        expect(await page.evaluate(() => window.subtitleBuildOptions)).toEqual([
          [`${gapRemoved ? 'gap-' : ''}${format}`, { alignFirstStart: false }],
        ]);
        expect(payload.intervals).toEqual(gapRemoved
          ? [{ startMs: 0, endMs: 1000 }, { startMs: 2000, endMs: 5000 }] : undefined);
        expect(payload.stickers.placements).toEqual([{
          rel: 'a.png', x: assMode ? 643 : 1400, y: assMode ? 810 : 80,
          width: assMode ? 240 : 460, height: assMode ? 90 : 324,
          align: assMode ? 'right' : 'center', intervals: [{ start, end }],
        }]);
        // SRT cannot provide an ASS layout plan; the real planner must keep the
        // sticker in its fixed box rather than drop it or fabricate cue geometry.
      });
    });
  }
}
