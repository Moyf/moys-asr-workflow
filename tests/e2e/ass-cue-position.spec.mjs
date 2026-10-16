import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cleanupTempDir, disableOnboarding, findFreePort, generateWaveformPayload, makeTempDir, startServer } from './helpers.mjs';
let tempDir, server, portraitServer;
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const roundPosition = value => Math.floor(value + 0.5);

test.beforeAll(async () => {
  tempDir = makeTempDir('ass-cue-position');
  const media = join(tempDir, 'synthetic.mp4');
  // Phase regression samples at 220/340ms must be actual video frame PTS.
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=640x360:r=50:d=5', '-c:v', 'libx264', '-y', media]);
  const project = join(tempDir, 'project.mosp');
  writeFileSync(project, JSON.stringify({ media: 'synthetic.mp4', preserve_punctuation: true,
    segments: [{ id: 'main', start: 0, end: 2000, text: 'MMMM' }, { id: 'next', start: 2000, end: 4000, text: 'NEXT' }], waveform: generateWaveformPayload(5000) }));
  server = await startServer(project, media, await findFreePort());
  const portraitMedia=join(tempDir,'portrait.mp4'),portraitProject=join(tempDir,'portrait.mosp');
  execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=black:s=360x640:r=25:d=5','-c:v','libx264','-y',portraitMedia]);
  writeFileSync(portraitProject,JSON.stringify({media:'portrait.mp4',segments:[{id:'main',start:0,end:2000,text:'MMMM'}],waveform:generateWaveformPayload(5000)}));
  portraitServer=await startServer(portraitProject,portraitMedia,await findFreePort());
});
test.afterAll(async () => { await server?.stop(); await portraitServer?.stop(); if (tempDir) cleanupTempDir(tempDir); });
test.beforeEach(async ({ page }, info) => {
  await disableOnboarding(page);
  await page.addInitScript(() => localStorage.setItem('moy.asr.editor.settings.v1', JSON.stringify({ autoSaveProject: false })));
  await page.goto(info.title.includes('360x640 actual')?portraitServer.url:server.url);
  await page.waitForFunction(() => window.MaweCoreState?.player?.videoWidth > 0 && window.MaweAssCuePosition);
  await page.evaluate(async () => {
    await loadAssStyleLibrary({ force: true });
    ASS_STYLE_LIBRARY = AsrEditorUtils.defaultAssStyleLibrary();
    Object.assign(ASS_STYLE_LIBRARY.styles.find(style => style.id === 'ass'), { fontName: 'Arial', fontSize: 90,
      outline: 0, shadow: 0, primaryColor: '#ff0000', emphasisColor: '#ff0000', alignment: 2, marginV: 40 });
    ASS_STYLE_LIBRARY.assProfiles[0].animations = { fad: { enabled: false }, fade: { enabled: false }, move: { enabled: false }, t: { enabled: false } };
    Object.assign(MaweSettings.EDITOR_SETTINGS, { assMode: true, assFrameAutoRender: false, autoSaveProject: false });
    MaweDom.overlayToggle.checked = true;
    delete MaweBoot.DATA.segments[0].assOverride;
    MaweBoot.DATA.segments[0].text = 'MMMM';
    MaweCoreState.player.currentTime = 1;
    MaweSelection.selectOnly(0);
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
    MaweAssFrame.syncAssFrameControls();
  });
  await expect(page.locator('#ass-cue-position')).toBeHidden();
});
const snapshot = page => page.evaluate(() => ({ override: MaweBoot.DATA.segments[0].assOverride ?? null,
  undo: MaweHistory.editorHistory.undoLength(), redo: MaweHistory.editorHistory.redoLength(), dirty: MaweServerSave.hasUnsavedProjectChanges() }));

test('inspector, focus-scoped arrows, reset, undo and save/reopen retain positioning', async ({ page }, info) => {
  const before = await snapshot(page);
  const box = page.locator('.ass-cue-drag-target').first();
  const bounds = await box.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width / 2 + 20, bounds.y + bounds.height / 2 - 10);
  await page.mouse.up();
  await expect(page.locator('#ass-cue-position')).toBeVisible();
  await page.locator('#ass-cue-x').fill('321.25'); await page.locator('#ass-cue-x').press('Tab');
  await page.locator('#ass-cue-y').fill('160.5'); await page.locator('#ass-cue-y').press('Tab');
  expect((await snapshot(page)).override).toEqual({ pos: { x: 321, y: 161 } });
  const caret = page.locator('#cue-panel-text');
  await caret.focus(); await caret.press('ArrowLeft');
  expect((await snapshot(page)).override.pos.x).toBe(321);
  await page.locator('#ass-cue-position').focus(); await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.press('ArrowDown');
  expect((await snapshot(page)).override.pos).toEqual({ x: 331, y: 162 });
  await page.locator('#ass-cue-x').fill('331.25'); await page.locator('#ass-cue-x').press('ArrowRight');
  expect((await snapshot(page)).override.pos.x).toBe(332);
  await expect(page.locator('#ass-cue-x')).toHaveValue('332');
  await page.locator('#ass-cue-x').press('ArrowLeft');
  await page.locator('#ass-cue-reset').click(); expect((await snapshot(page)).override).toBeNull();
  await page.locator('#undo-btn').click(); expect((await snapshot(page)).override.pos).toEqual({ x: 331, y: 162 });
  await page.locator('#redo-btn').click(); expect((await snapshot(page)).override).toBeNull();
  await page.locator('#undo-btn').click();
  const save = await page.evaluate(async () => { const json = JSON.parse(MaweJsonRepair.buildJson());
    await MaweProjectSave.saveProjectToServer({ silent: true }); return json.segments[0].assOverride; });
  expect(save).toEqual({ pos: { x: 331, y: 162 } });
  expect((await snapshot(page)).dirty).toBe(false);
  await page.reload(); await page.waitForFunction(() => Boolean(MaweBoot.DATA.segments[0].assOverride));
  expect((await snapshot(page)).override).toEqual(save);
  await page.evaluate(() => { MaweSettings.EDITOR_SETTINGS.assMode = true; MaweSelection.selectOnly(0); MawePlaybackLoop.refreshSubtitlePreview(1000,0); });
  const gaps = await page.locator('#ass-cue-position').evaluate(panel => ({
    rows: parseFloat(getComputedStyle(document.getElementById('ass-cue-coordinate-controls')).gap),
    columns: parseFloat(getComputedStyle(panel).gap),
    text: panel.getBoundingClientRect().left - document.getElementById('cue-panel-text').getBoundingClientRect().right,
    height: panel.getBoundingClientRect().height,
  }));
  expect(gaps.rows).toBeGreaterThanOrEqual(8);
  expect(gaps.columns).toBeGreaterThanOrEqual(8);
  expect(gaps.text).toBeGreaterThanOrEqual(8);
  writeFileSync(info.outputPath('spacing.json'), JSON.stringify(gaps, null, 2));
  await page.locator('#current-cue-panel').screenshot({ path: info.outputPath('inspector.png') });
  expect(before.override).toBeNull();
});

test('scale handles and video wheel use one scale-only transaction and independent resets', async ({ page }, info) => {
  const layout = () => page.evaluate(() => {
    const box = element => {
      if (!element || element.hidden) return null;
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, height: rect.height };
    };
    return {
      panel: box(document.getElementById('current-cue-panel')),
      stage: box(document.querySelector('.player-stage')),
      text: box(document.getElementById('cue-panel-text')),
      scale: box(document.getElementById('ass-cue-scale-controls')),
      scaleLabel: box(document.querySelector('#ass-cue-scale-controls label')),
      scaleInput: box(document.getElementById('ass-cue-scale')),
      position: box(document.getElementById('ass-cue-coordinate-controls')),
    };
  });
  const baselineLayout = await layout();
  expect(await snapshot(page)).toMatchObject({ override: null });
  await expect(page.locator('#ass-cue-position')).toBeHidden();
  const handle = page.locator('.ass-cue-scale-handle--se:not([hidden])');
  await expect(handle).toBeVisible();

  const beforeClick = await snapshot(page);
  await handle.click();
  expect(await snapshot(page)).toEqual(beforeClick);

  const handleBox = await handle.boundingBox();
  const center = { x: handleBox.x + handleBox.width / 2, y: handleBox.y + handleBox.height / 2 };
  await page.mouse.move(center.x, center.y); await page.mouse.down();
  await page.mouse.move(center.x + 18, center.y + 18, { steps: 3 });
  expect(await page.evaluate(() => MaweAssCuePosition.dragging)).toBe(true);
  await page.keyboard.press('Escape'); await page.mouse.up();
  expect(await snapshot(page)).toEqual(beforeClick);

  const dragBefore = await snapshot(page);
  await page.mouse.move(center.x, center.y); await page.mouse.down();
  await page.mouse.move(center.x + 28, center.y + 28, { steps: 4 }); await page.mouse.up();
  let state = await snapshot(page);
  expect(state.undo).toBe(dragBefore.undo + 1);
  expect(state.override.pos).toBeUndefined();
  expect(state.override.scale).toBeGreaterThan(1);
  await expect(page.locator('#ass-cue-scale-controls')).toBeVisible();
  await expect(page.locator('#ass-cue-coordinate-controls')).toBeHidden();
  await expect(page.locator('#ass-cue-scale')).toHaveValue(state.override.scale.toFixed(2));
  await page.locator('.player-stage').screenshot({ path: info.outputPath('scale-handles.png') });
  const scaleOnlyLayout = await layout();
  expect(scaleOnlyLayout.panel.height).toBe(baselineLayout.panel.height);
  expect(scaleOnlyLayout.stage.top).toBe(baselineLayout.stage.top);
  expect(scaleOnlyLayout.text.height).toBe(baselineLayout.text.height);
  expect(scaleOnlyLayout.scaleLabel.height).toBeLessThanOrEqual(scaleOnlyLayout.scaleInput.height + 0.5);

  await page.locator('#ass-cue-scale').fill('1.225');
  await page.locator('#ass-cue-scale').press('Tab');
  state = await snapshot(page);
  expect(state.override.scale).toBe(1.23);
  await expect(page.locator('#ass-cue-scale')).toHaveValue('1.23');

  const video = await page.locator('#overlay').boundingBox();
  await page.mouse.move(video.x + video.width / 2, video.y + video.height / 2);
  const wheelBefore = await snapshot(page);
  await page.mouse.wheel(0, -100); await page.mouse.wheel(0, -100);
  await page.waitForTimeout(320);
  state = await snapshot(page);
  expect(state.undo).toBe(wheelBefore.undo + 1);
  expect(state.override.scale).toBeGreaterThan(wheelBefore.override.scale);
  expect(state.override.pos).toBeUndefined();

  const outsideBefore = await snapshot(page);
  await page.mouse.move(0, 0); await page.mouse.wheel(0, -100);
  expect(await snapshot(page)).toEqual(outsideBefore);

  const box = page.locator('.ass-cue-drag-target.selected').first();
  const boxRect = await box.boundingBox();
  await page.mouse.move(boxRect.x + boxRect.width / 2, boxRect.y + boxRect.height / 2);
  await page.mouse.down(); await page.mouse.move(boxRect.x + boxRect.width / 2 + 16, boxRect.y + boxRect.height / 2 - 8, { steps: 3 });
  await page.mouse.up();
  state = await snapshot(page);
  expect(Number.isInteger(state.override.pos?.x)).toBe(true);
  expect(Number.isInteger(state.override.pos?.y)).toBe(true);
  expect(state.override.scale).toBeGreaterThan(1);
  await expect(page.locator('#ass-cue-coordinate-controls')).toBeVisible();
  await expect(page.locator('#ass-cue-scale-controls')).toBeVisible();
  const bothLayout = await layout();
  expect(bothLayout.position.left - bothLayout.scale.right).toBeGreaterThanOrEqual(8);
  expect(bothLayout.scale.left - bothLayout.text.right).toBeGreaterThanOrEqual(8);
  expect(bothLayout.panel.height).toBe(baselineLayout.panel.height);
  expect(bothLayout.stage.top).toBe(baselineLayout.stage.top);
  expect(bothLayout.scaleLabel.height).toBeLessThanOrEqual(bothLayout.scaleInput.height + 0.5);
  writeFileSync(info.outputPath('scale-controls-spacing.json'), JSON.stringify({ baselineLayout, scaleOnlyLayout, bothLayout }, null, 2));
  await page.locator('#current-cue-panel').screenshot({ path: info.outputPath('scale-controls.png') });

  await page.locator('#ass-cue-scale-reset').click();
  expect((await snapshot(page)).override).toEqual({ pos: state.override.pos });
  await expect(page.locator('#ass-cue-scale-controls')).toBeHidden();
  await expect(page.locator('#ass-cue-coordinate-controls')).toBeVisible();
  expect((await layout()).panel.height).toBe(baselineLayout.panel.height);

  await page.mouse.move(video.x + video.width / 2, video.y + video.height / 2);
  await page.mouse.wheel(0, -100); await page.waitForTimeout(320);
  state = await snapshot(page);
  expect(state.override.scale).toBeGreaterThan(1);
  await page.locator('#ass-cue-reset').click();
  expect((await snapshot(page)).override).toEqual({ scale: state.override.scale });
  await expect(page.locator('#ass-cue-coordinate-controls')).toBeHidden();
  await expect(page.locator('#ass-cue-scale-controls')).toBeVisible();
  expect((await layout()).panel.height).toBe(baselineLayout.panel.height);
  await page.locator('#ass-cue-scale-reset').click();
  expect((await snapshot(page)).override).toBeNull();
  await expect(page.locator('#ass-cue-position')).toBeHidden();
  await page.evaluate(() => {
    MaweDom.playerStage.style.cssText = 'flex:0 0 auto;width:440px;height:300px;';
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
  });
  await page.waitForFunction(() => {
    const stage = MaweDom.playerStage.getBoundingClientRect(), video = MaweDom.overlayEl.getBoundingClientRect();
    return stage.height - video.height > 20;
  });
  const letterbox = await page.evaluate(() => {
    const stage = MaweDom.playerStage.getBoundingClientRect(), video = MaweDom.overlayEl.getBoundingClientRect();
    return { x: stage.left + stage.width / 2, y: stage.top + 4, topBar: video.top - stage.top };
  });
  expect(letterbox.topBar).toBeGreaterThanOrEqual(10);
  const beforeLetterboxWheel = await snapshot(page);
  await page.mouse.move(letterbox.x, letterbox.y); await page.mouse.wheel(0, -100);
  expect(await snapshot(page)).toEqual(beforeLetterboxWheel);
});

test('wheel resize requires a visible current main-cue preview', async ({ page }) => {
  const video = await page.locator('#overlay').boundingBox();
  const point = { x: video.x + video.width / 2, y: video.y + video.height / 2 };
  const before = await snapshot(page);

  await page.evaluate(() => {
    MaweDom.overlayToggle.checked = false;
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
  });
  await page.mouse.move(point.x, point.y); await page.mouse.wheel(0, -100);
  await page.waitForTimeout(280);
  expect(await snapshot(page)).toEqual(before);

  await page.evaluate(() => {
    MaweDom.overlayToggle.checked = true;
    MaweCoreState.player.currentTime = 3;
    MaweCuePanelState.currentCuePanelKind = 'main';
    MaweCuePanelState.currentCuePanelIdx = 0;
    MaweSelection.selectOnly(0);
    MawePlaybackLoop.refreshSubtitlePreview(3000, 0);
  });
  const preview = await page.evaluate(() => ({
    target: MaweCuePanel.getCurrentCuePanelTarget()?.segment.id,
    selectedRecordVisible: MaweAssCanvas.lastRender?.tracks.some(record =>
      record.role === 'main' && record.cueId === 'main' && !record.skipped && record.opacity > 0),
  }));
  expect(preview).toEqual({ target: 'main', selectedRecordVisible: false });
  await page.mouse.move(point.x, point.y); await page.mouse.wheel(0, -100);
  await page.waitForTimeout(280);
  expect(await snapshot(page)).toEqual(before);
});

test('wheel resize commits before other edits and stays out of pointer transactions', async ({ page }) => {
  const historyState = () => page.evaluate(() => ({
    project: MaweHistory.snapshotSegments(),
    undo: MaweHistory.editorHistory.undoLength(),
    redo: MaweHistory.editorHistory.redoLength(),
    active: MaweAssCuePosition.dragging,
  }));
  const video = await page.locator('#overlay').boundingBox();
  const center = { x: video.x + video.width / 2, y: video.y + video.height / 2 };
  await page.locator('.ass-cue-drag-target.selected').focus();
  const initial = await historyState();
  await page.mouse.move(center.x, center.y); await page.mouse.wheel(0, -100);
  const scalePreview = await historyState();
  expect(scalePreview.project).not.toEqual(initial.project);
  expect(scalePreview.undo).toBe(initial.undo);

  await page.keyboard.press('2');
  const colored = await historyState();
  expect(colored.project).not.toEqual(scalePreview.project);
  expect(colored.undo).toBe(initial.undo + 2);
  await page.keyboard.press('Escape');
  expect(await historyState()).toEqual(colored);
  await page.keyboard.press('Control+z');
  expect((await historyState()).project).toEqual(scalePreview.project);
  await page.keyboard.press('Control+z');
  const restored = await historyState();
  expect(restored.project).toEqual(initial.project);
  expect(restored.undo).toBe(initial.undo);
  await page.evaluate(() => { MaweSelection.selectOnly(0); MawePlaybackLoop.refreshSubtitlePreview(1000, 0); });
  const baseline = await historyState();

  const box = page.locator('.ass-cue-drag-target.selected').first();
  let bounds = await box.boundingBox();
  let pointer = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  await page.mouse.move(pointer.x, pointer.y); await page.mouse.down();
  await page.mouse.move(pointer.x + 12, pointer.y + 8, { steps: 2 });
  const positionPreview = await historyState();
  expect(positionPreview.active).toBe(true);
  await page.mouse.wheel(0, -100);
  expect(await historyState()).toEqual(positionPreview);
  await page.keyboard.press('Escape'); await page.mouse.up();
  expect(await historyState()).toEqual(baseline);

  const handle = page.locator('.ass-cue-scale-handle--se:not([hidden])');
  bounds = await handle.boundingBox();
  pointer = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  await page.mouse.move(pointer.x, pointer.y); await page.mouse.down();
  await page.mouse.move(pointer.x + 14, pointer.y + 14, { steps: 2 });
  const sizePreview = await historyState();
  expect(sizePreview.active).toBe(true);
  await page.mouse.wheel(0, -100);
  expect(await historyState()).toEqual(sizePreview);
  await page.keyboard.press('Escape'); await page.mouse.up();
  expect(await historyState()).toEqual(baseline);
});

test('box drag maps letterbox and scaled portrait/landscape canvases into one undo, cancel and no-op', async ({ page }, info) => {
  for (const [width, height, boxWidth, boxHeight] of [[640,360,440,300],[360,640,340,280]]) {
    await page.evaluate(({ width, height, boxWidth, boxHeight }) => {
      MaweBoot.DATA.media_metadata = { video_width: width, video_height: height };
      delete MaweBoot.DATA.segments[0].assOverride;
      MaweDom.playerStage.style.cssText = `flex:0 0 auto;width:${boxWidth}px;height:${boxHeight}px;`;
      MawePlaybackLoop.refreshSubtitlePreview(1000,0);
    }, {width,height,boxWidth,boxHeight});
    await page.locator('.ass-cue-drag-target').first().scrollIntoViewIfNeeded();
    await page.waitForFunction(() => {
      const r=MaweDom.playerStage.getBoundingClientRect(),o=MaweDom.overlayEl.getBoundingClientRect();
      const aspect=MaweCoreState.player.videoWidth/MaweCoreState.player.videoHeight;
      return Math.abs(o.width-Math.min(r.width,r.height*aspect))<0.1 && Math.abs(o.height-Math.min(r.height,r.width/aspect))<0.1;
    });
    const frame = await page.evaluate(() => ({ track: MaweAssCanvas.lastRender.tracks.find(item=>item.role==='main'),
      rect: (()=>{const r=MaweDom.overlayEl.getBoundingClientRect();return {width:r.width,height:r.height};})() }));
    const target = page.locator('.ass-cue-drag-target').first();
    await target.scrollIntoViewIfNeeded(); const rect = await target.boundingBox();
    const point = { x: rect.x+rect.width/2, y: rect.y+rect.height/2 };
    const before = await snapshot(page);
    await page.evaluate(point => {
      window.__dragEvidence = [{ hit: document.elementFromPoint(point.x, point.y)?.outerHTML,
        box: (() => { const r=MaweDom.overlayEl.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })() }];
      for(const name of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture']) document.addEventListener(name, event=>{
        window.__dragEvidence.push({name,target:event.target.className,id:event.pointerId,x:event.clientX,y:event.clientY,
          override: JSON.parse(JSON.stringify(MaweBoot.DATA.segments[0].assOverride||null))});
      }, true);
    }, point);
    await page.mouse.move(point.x,point.y); await page.mouse.down();
    await page.mouse.move(point.x+25,point.y-18,{steps:6}); await page.mouse.up();
    const changed = await snapshot(page);
    writeFileSync(info.outputPath(`drag-${width}-diagnostic.json`), JSON.stringify({frame,point,before,changed,events:await page.evaluate(()=>window.__dragEvidence)},null,2));
    await page.locator('.player-stage').screenshot({path:info.outputPath(`drag-${width}-diagnostic.png`)});
    expect(changed.undo).toBe(before.undo+1);
    expect(changed.override.pos.x).toBe(roundPosition(frame.track.anchor.x+25*width/frame.rect.width));
    expect(changed.override.pos.y).toBe(roundPosition(frame.track.anchor.y-18*height/frame.rect.height));
    await page.locator('#undo-btn').click(); expect((await snapshot(page)).override).toBeNull();
    await page.locator('#redo-btn').click(); expect((await snapshot(page)).override).toEqual(changed.override);
    // History restores its selection snapshot. Select again before asking for
    // a new drag; the first gesture on an unselected cue intentionally cannot move it.
    await target.click();
    let currentBox=await target.boundingBox(), next={x:currentBox.x+currentBox.width/2,y:currentBox.y+currentBox.height/2};
    const committed=await snapshot(page);
    await page.mouse.move(next.x,next.y); await page.mouse.down(); await page.mouse.move(next.x+12,next.y+9,{steps:3});
    expect(await page.evaluate(()=>MaweAssCuePosition.dragging)).toBe(true);
    expect(await page.evaluate(()=>MaweProjectSave.saveCurrentProject({silent:true}))).toBe(false);
    await page.keyboard.press('Escape'); await page.mouse.up(); expect(await snapshot(page)).toEqual(committed);
    currentBox=await target.boundingBox();next={x:currentBox.x+currentBox.width/2,y:currentBox.y+currentBox.height/2};
    await page.mouse.move(next.x,next.y);await page.mouse.down();await page.mouse.move(next.x+10,next.y,{steps:2});
    expect(await page.evaluate(()=>MaweAssCuePosition.dragging)).toBe(true);
    await page.evaluate(()=>MaweHistory.performUndo());await page.mouse.up();expect(await snapshot(page)).toEqual(committed);
    await target.click(); expect(await snapshot(page)).toEqual(committed);
    currentBox=await target.boundingBox();next={x:currentBox.x+currentBox.width/2,y:currentBox.y+currentBox.height/2};
    await page.mouse.move(next.x,next.y); await page.mouse.down(); await page.mouse.move(next.x+10,next.y,{steps:2}); await page.mouse.move(next.x,next.y,{steps:2}); await page.mouse.up();
    expect(await snapshot(page)).toEqual(committed);
    await page.locator('.player-stage').screenshot({path:info.outputPath(`drag-${width}x${height}.png`)});
  }
});

test('active ASS dragging isolates editing shortcuts and cancellation preserves real color history', async ({ page }) => {
  const state = () => page.evaluate(() => ({
    project: MaweHistory.snapshotSegments(),
    selection: MaweHistory.snapshotEditorSelection(),
    undo: MaweHistory.editorHistory.undoLength(),
    redo: MaweHistory.editorHistory.redoLength(),
    dirty: MaweServerSave.hasUnsavedProjectChanges(),
    modals: [...document.querySelectorAll('.modal.show')].map(element => element.id).sort(),
  }));
  const beginDrag = async () => {
    const box = page.locator('.ass-cue-drag-target.selected');
    await box.scrollIntoViewIfNeeded();
    const rect = await box.boundingBox();
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width / 2 + 18, rect.y + rect.height / 2 - 8, { steps: 3 });
    expect(await page.evaluate(() => MaweAssCuePosition.dragging)).toBe(true);
    expect((await snapshot(page)).override?.pos).toBeTruthy();
  };

  // Use actual keyboard edits, so the history entry being protected contains
  // a real color change rather than an injected test-only undo record.
  await page.locator('.ass-cue-drag-target.selected').focus();
  await page.keyboard.press('0');
  const uncolored = await state();
  await page.keyboard.press('2');
  const colored = await state();
  expect(colored.project).not.toEqual(uncolored.project);
  expect(colored.undo).toBe(uncolored.undo + 1);
  expect(colored.redo).toBe(0);

  await beginDrag();
  const preview = await state();
  expect(preview.project).not.toEqual(colored.project);
  expect(preview.undo).toBe(colored.undo);
  // Include a different color and destructive, boundary, selection, playback,
  // and modal-opening shortcuts while the pointer remains held down.
  for (const key of ['1', '0', '3', '4', '5', 'Delete', 'Backspace', 'c', 'z', 'x',
    'Control+Shift+a', 'Control+Shift+d', 'b', 'Shift+b', 'Control+Shift+b',
    'n', 't', 'g', 'Shift+g', 'h', 'a', 'd', 'Control+a', 'Control+d', 'Space', 'Tab']) {
    await page.keyboard.press(key);
    expect(await state(), `held drag must isolate ${key}`).toEqual(preview);
    expect(await page.evaluate(() => MaweAssCuePosition.dragging), key).toBe(true);
  }
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(await page.evaluate(() => MaweAssCuePosition.dragging)).toBe(false);
  expect(await state()).toEqual(colored);

  // Every history shortcut cancels only the in-flight gesture. Cover both an
  // existing undo entry and an existing redo entry without consuming either.
  for (const key of ['Control+z', 'Control+y', 'Control+Shift+z']) {
    await beginDrag();
    await page.keyboard.press(key);
    await page.mouse.up();
    expect(await page.evaluate(() => MaweAssCuePosition.dragging)).toBe(false);
    expect(await state(), `${key} cancels without consuming undo history`).toEqual(colored);
  }
  await page.keyboard.press('Control+z');
  // Ordinary segment history intentionally clears its selection. Restore the
  // selection before starting another gesture, without creating a mutation.
  await page.evaluate(() => { MaweSelection.selectOnly(0); MawePlaybackLoop.refreshSubtitlePreview(1000, 0); });
  const undone = await state();
  expect(undone.project).toEqual(uncolored.project);
  expect(undone.undo).toBe(uncolored.undo);
  expect(undone.redo).toBe(1);
  expect((await snapshot(page)).override).toBeNull();

  for (const key of ['Control+y', 'Control+Shift+z', 'Control+z']) {
    await beginDrag();
    await page.keyboard.press(key);
    await page.mouse.up();
    expect(await page.evaluate(() => MaweAssCuePosition.dragging)).toBe(false);
    expect(await state(), `${key} cancels without consuming redo history`).toEqual(undone);
  }
  await page.keyboard.press('Control+y');
  const redone = await state();
  expect(redone.project).toEqual(colored.project);
  expect(redone.undo).toBe(colored.undo);
  expect(redone.redo).toBe(0);
  expect((await snapshot(page)).override).toBeNull();
});

function paintedBox(canvas) {
  const g=canvas.getContext('2d'),pixels=g.getImageData(0,0,canvas.width,canvas.height).data;
  let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
  for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++) {
    const at=(y*canvas.width+x)*4;
    if(pixels[at+3]<16 || pixels[at]<60 || pixels[at]<=Math.max(pixels[at+1],pixels[at+2])+30) continue;
    left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x+1);bottom=Math.max(bottom,y+1);
  }
  return Number.isFinite(left)?[left,top,right,bottom]:null;
}

for(const [width,height] of [[640,360],[360,640]]) test(`all nine anchors match Canvas, Server libass and exported ${width}x${height} actual frames`, async ({ page }, info) => {
  test.setTimeout(180000);
  await page.locator('#ass-frame-quick-open').click();
  const evidence=[];
  for (let an=1;an<=9;an++) {
    const frame=await page.evaluate(({an,width,height,paintedBox}) => {
      MaweBoot.DATA.media_metadata={video_width:width,video_height:height};
      MaweBoot.DATA.segments[0].assOverride={pos:{x:width/2,y:height/2}};
      ASS_STYLE_LIBRARY.styles.find(style => style.id === 'ass').alignment = an;
      ASS_STYLE_LIBRARY.assProfiles[0].animations.move={enabled:true,x1:10,y1:10,x2:200,y2:300,t1:0,t2:2000};
      MawePlaybackLoop.refreshSubtitlePreview(1000,0);
      const canvas=document.querySelector('.ass-preview-canvas');
      return { box:(0,eval)(`(${paintedBox})`)(canvas),ass:MaweExportSrt.buildAss() };
    },{an,width,height,paintedBox:paintedBox.toString()});
    await page.evaluate(()=>MaweAssFrame.renderAssFrame());
    await expect(page.locator('#ass-frame-window-status')).toHaveText('渲染完成');
    const serverBox=await page.evaluate(paintedBox=>{
      const image=document.getElementById('ass-frame-image'),canvas=document.createElement('canvas');
      canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
      canvas.getContext('2d').drawImage(image,0,0);
      return (0,eval)(`(${paintedBox})`)(canvas);
    },paintedBox.toString());
    const path=info.outputPath(`an-${an}.ass`);writeFileSync(path,frame.ass);
    const result=JSON.parse(execFileSync(process.env.MAW_PIXEL_PYTHON||process.env.MAW_E2E_PYTHON||'python',
      [resolve('tests/helpers/ass-stacking-pixel-oracle.py'),path,'1000',info.outputPath(`an-${an}-export`)],
      {encoding:'utf8',timeout:40000,windowsHide:true}));
    const exportBox=result.nativeTracks.main.box;
    expect(frame.box).not.toBeNull();expect(serverBox).not.toBeNull();expect(exportBox).not.toBeNull();
    for(let axis=0;axis<4;axis++) {
      expect(Math.abs(frame.box[axis]-exportBox[axis])).toBeLessThanOrEqual(5);
      expect(Math.abs(serverBox[axis]-exportBox[axis])).toBeLessThanOrEqual(1);
    }
    expect(frame.ass.split('\n').filter(line=>line.startsWith('Dialogue: 0,')).every(line=>!line.endsWith('MMMM') || !line.includes('\\move('))).toBe(true);
    evidence.push({an,canvas:frame.box,server:serverBox,export:exportBox,font:result.fontSelections});
  }
  writeFileSync(info.outputPath('frame-comparison.json'),JSON.stringify(evidence,null,2));
});


test('positioned shake phase survives non-periodic overlap in Canvas, Server libass and exported frames', async ({ page }, info) => {
  test.setTimeout(180000);
  await page.evaluate(() => {
    // Release the current text-panel draft before changing fixture timing/text.
    // Selecting it afterwards must not commit the old draft over this setup.
    MaweSelection.clearSelection();
    const [shaken, ordinary] = MaweBoot.DATA.segments;
    Object.assign(shaken, { start: 100, end: 400, text: '!!MMMM!!', assOverride: { pos: { x: 320, y: 240 } } });
    delete shaken.color; delete shaken.color_ref;
    Object.assign(ordinary, { start: 200, end: 300, text: 'NEXT', assOverride: { pos: { x: 120, y: 100 } },
      color: { name: 'green', value: MaweColors.COLOR_BY_NAME.green.value, start: 200, end: 300 } });
    delete ordinary.color_ref;
    MaweBoot.DATA.preview ??= {};
    MaweBoot.DATA.preview.subtitle = { ...MaweBoot.DATA.preview.subtitle, ass_color_style: 'text' };
    MaweSelection.selectOnly(0);
    MawePlaybackLoop.refreshSubtitlePreview(100, 0);
  });
  await page.locator('#ass-frame-quick-open').click();
  const evidence = [];
  for (const timeMs of [220, 340]) {
    await page.evaluate(async timeMs => {
      const player = MaweCoreState.player;
      await new Promise(resolveSeek => {
        player.addEventListener('seeked', resolveSeek, { once: true });
        player.currentTime = timeMs / 1000;
      });
      MawePlaybackLoop.refreshSubtitlePreview(timeMs, 0);
    }, timeMs);
    const frame = await page.evaluate(({ timeMs, paintedBox }) => {
      MawePlaybackLoop.refreshSubtitlePreview(timeMs, 0);
      return { box: (0, eval)(`(${paintedBox})`)(document.querySelector('.ass-preview-canvas')),
        ass: MaweExportSrt.buildAss(), currentTime: MaweCoreState.player.currentTime,
        tracks: MaweAssCanvas.lastRender.tracks.map(({ cueId, anchor, positionAnchor, bounds }) => ({ cueId, anchor, positionAnchor, bounds })) };
    }, { timeMs, paintedBox: paintedBox.toString() });
    expect(frame.currentTime).toBeCloseTo(timeMs / 1000, 5);
    await page.evaluate(() => MaweAssFrame.renderAssFrame());
    await expect(page.locator('#ass-frame-window-status')).toHaveText('渲染完成');
    const serverBox = await page.evaluate(paintedBox => {
      const image = document.getElementById('ass-frame-image'), canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      canvas.getContext('2d').drawImage(image, 0, 0);
      return (0, eval)(`(${paintedBox})`)(canvas);
    }, paintedBox.toString());
    const path = info.outputPath(`shake-phase-${timeMs}.ass`);
    writeFileSync(path, frame.ass);
    const result = JSON.parse(execFileSync(process.env.MAW_PIXEL_PYTHON || process.env.MAW_E2E_PYTHON || 'python',
      [resolve('tests/helpers/ass-stacking-pixel-oracle.py'), path, String(timeMs), info.outputPath(`shake-phase-${timeMs}-export`)],
      { encoding: 'utf8', timeout: 40000, windowsHide: true }));
    const exportBox = result.nativeTracks.main.box;
    const sample = { timeMs, currentTime: frame.currentTime, canvas: frame.box, server: serverBox, export: exportBox,
      tracks: frame.tracks, font: result.fontSelections };
    evidence.push(sample);
    writeFileSync(info.outputPath('shake-phase-comparison.json'), JSON.stringify(evidence, null, 2));
    await page.locator('.player-stage').screenshot({ path: info.outputPath(`shake-phase-${timeMs}-canvas.png`) });
    await page.locator('#ass-frame-image').screenshot({ path: info.outputPath(`shake-phase-${timeMs}-server.png`) });
    expect(frame.box).not.toBeNull(); expect(serverBox).not.toBeNull(); expect(exportBox).not.toBeNull();
    for (let axis = 0; axis < 4; axis++) {
      expect(Math.abs(frame.box[axis] - exportBox[axis]), JSON.stringify(sample)).toBeLessThanOrEqual(5);
      expect(Math.abs(serverBox[axis] - exportBox[axis]), JSON.stringify(sample)).toBeLessThanOrEqual(1);
    }
  }
});

test('inactive selected cue inspector reuses the cached ASS plan during playback refreshes', async ({page}) => {
  const result = await page.evaluate(() => {
    delete MaweBoot.DATA.segments[0].assOverride;
    MaweSelection.selectOnly(0);
    MawePlaybackLoop.refreshSubtitlePreview(3000,1);
    const original=window.MaweExportSrt;
    let builds=0;
    window.MaweExportSrt={...original,buildAss(...args){builds++;return original.buildAss(...args);}};
    try { for(let index=0;index<30;index++) MaweAssCuePosition.sync(); }
    finally {window.MaweExportSrt=original;}
    return {builds,selected:MaweCuePanel.getCurrentCuePanelTarget().segment.id,
      visible:MaweAssCanvas.lastRender.tracks.map(item=>item.cueId)};
  });
  expect(result.selected).toBe('main');
  expect(result.visible).not.toContain('main');
  expect(result.builds).toBe(0);
});

test('shaken cue matches Canvas, Server libass and exported frame boxes at sample time', async ({ page }, info) => {
  const frame = await page.evaluate(({ paintedBox }) => {
    MaweBoot.DATA.segments[0].text = '!!MMMM!!';
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
    const canvas = document.querySelector('.ass-preview-canvas');
    return { box: (0,eval)(`(${paintedBox})`)(canvas), ass: MaweExportSrt.buildAss() };
  }, { paintedBox: paintedBox.toString() });
  await page.evaluate(() => MaweAssFrame.renderAssFrame());
  await expect(page.locator('#ass-frame-window-status')).toHaveText('渲染完成');
  const serverBox = await page.evaluate(paintedBox => {
    const image = document.getElementById('ass-frame-image'), canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    canvas.getContext('2d').drawImage(image, 0, 0);
    return (0,eval)(`(${paintedBox})`)(canvas);
  }, paintedBox.toString());
  const path = info.outputPath('shake.ass'); writeFileSync(path, frame.ass);
  const result = JSON.parse(execFileSync(process.env.MAW_PIXEL_PYTHON || process.env.MAW_E2E_PYTHON || 'python',
    [resolve('tests/helpers/ass-stacking-pixel-oracle.py'), path, '1000', info.outputPath('shake-export')],
    { encoding: 'utf8', timeout: 40000, windowsHide: true }));
  const exportBox = result.nativeTracks.main.box;
  expect(frame.box).not.toBeNull(); expect(serverBox).not.toBeNull(); expect(exportBox).not.toBeNull();
  for (let axis = 0; axis < 4; axis++) {
    expect(Math.abs(frame.box[axis] - exportBox[axis])).toBeLessThanOrEqual(5);
    expect(Math.abs(serverBox[axis] - exportBox[axis])).toBeLessThanOrEqual(1);
  }
  expect(frame.ass.split('\n').filter(line => line.startsWith('Dialogue: 0,') && line.includes('MMMM')).length).toBe(Math.ceil(2000 / 60));
});

test('scaled main cue matches Canvas, Server libass and exported frame boxes', async ({ page }, info) => {
  const frame = await page.evaluate(({ paintedBox }) => {
    MaweBoot.DATA.segments[0].text = 'MMMM';
    MaweBoot.DATA.segments[0].assOverride = { scale: 1.22 };
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
    const canvas = document.querySelector('.ass-preview-canvas');
    return { box: (0, eval)(`(${paintedBox})`)(canvas), ass: MaweExportSrt.buildAss() };
  }, { paintedBox: paintedBox.toString() });
  expect(frame.ass).toContain(String.raw`\fs36.6`);
  await page.evaluate(() => MaweAssFrame.renderAssFrame());
  await expect(page.locator('#ass-frame-window-status')).toHaveText('渲染完成');
  const serverBox = await page.evaluate(paintedBox => {
    const image = document.getElementById('ass-frame-image'), canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    canvas.getContext('2d').drawImage(image, 0, 0);
    return (0, eval)(`(${paintedBox})`)(canvas);
  }, paintedBox.toString());
  const path = info.outputPath('scale.ass'); writeFileSync(path, frame.ass);
  const result = JSON.parse(execFileSync(process.env.MAW_PIXEL_PYTHON || process.env.MAW_E2E_PYTHON || 'python',
    [resolve('tests/helpers/ass-stacking-pixel-oracle.py'), path, '1000', info.outputPath('scale-export')],
    { encoding: 'utf8', timeout: 40000, windowsHide: true }));
  const exportBox = result.nativeTracks.main.box;
  expect(frame.box).not.toBeNull(); expect(serverBox).not.toBeNull(); expect(exportBox).not.toBeNull();
  for (let axis = 0; axis < 4; axis++) {
    expect(Math.abs(frame.box[axis] - exportBox[axis])).toBeLessThanOrEqual(5);
    expect(Math.abs(serverBox[axis] - exportBox[axis])).toBeLessThanOrEqual(1);
  }
});

test('scaled automatic stack matches Canvas, Server libass and exported frame boxes', async ({ page }, info) => {
  const frame = await page.evaluate(({ paintedBox }) => {
    const [base, scaled] = MaweBoot.DATA.segments;
    // The small synthetic video uses 640×360 PlayRes. A larger baseline font
    // keeps the auto-fit path active there as it is in the 1080p unit fixture.
    ASS_STYLE_LIBRARY.styles.find(style => style.id === 'ass').fontSize = 150;
    Object.assign(base, { start: 0, end: 2000, text: Array(10).fill('BASE').join('\n') });
    delete base.assOverride;
    Object.assign(scaled, { start: 0, end: 2000, text: Array(10).fill('SCALED').join('\n'), assOverride: { scale: 0.62 } });
    MaweSelection.selectOnly(0);
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
    const canvas = document.querySelector('.ass-preview-canvas');
    const slice = MaweAssPreview.stackPlan.slices.find(item => item.start <= 1000 && 1000 < item.end);
    const automatic = slice.items.find(item => item.segment.id === 'next');
    return { box: (0, eval)(`(${paintedBox})`)(canvas), ass: MaweExportSrt.buildAss(),
      groupScale: slice.scale, automaticOffset: automatic.offset,
      records: MaweAssCanvas.lastRender.tracks.filter(record => record.role === 'main' && !record.skipped).length };
  }, { paintedBox: paintedBox.toString() });
  expect(frame.groupScale).toBeLessThan(1);
  expect(Math.abs(frame.automaticOffset.y)).toBeGreaterThan(1);
  expect(frame.records).toBe(2);
  await page.evaluate(() => MaweAssFrame.renderAssFrame());
  await expect(page.locator('#ass-frame-window-status')).toHaveText('渲染完成');
  const serverBox = await page.evaluate(paintedBox => {
    const image = document.getElementById('ass-frame-image'), canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    canvas.getContext('2d').drawImage(image, 0, 0);
    return (0, eval)(`(${paintedBox})`)(canvas);
  }, paintedBox.toString());
  const path = info.outputPath('scaled-stack.ass'); writeFileSync(path, frame.ass);
  const result = JSON.parse(execFileSync(process.env.MAW_PIXEL_PYTHON || process.env.MAW_E2E_PYTHON || 'python',
    [resolve('tests/helpers/ass-stacking-pixel-oracle.py'), path, '1000', info.outputPath('scaled-stack-export')],
    { encoding: 'utf8', timeout: 40000, windowsHide: true }));
  const exportBox = result.nativeTracks.main.box;
  expect(frame.box).not.toBeNull(); expect(serverBox).not.toBeNull(); expect(exportBox).not.toBeNull();
  for (let axis = 0; axis < 4; axis++) {
    expect(Math.abs(frame.box[axis] - exportBox[axis])).toBeLessThanOrEqual(5);
    expect(Math.abs(serverBox[axis] - exportBox[axis])).toBeLessThanOrEqual(1);
  }
});

test('unselected gesture only selects, no-op stays clean and coordinate visibility never changes panel or video height', async ({page}, info) => {
  await page.evaluate(() => { MaweSelection.clearSelection(); MawePlaybackLoop.refreshSubtitlePreview(1000,0); });
  const box = page.locator('.ass-cue-drag-target').first();
  await expect(box).not.toHaveClass(/selected/);
  const baseline = await snapshot(page);
  const layout = () => page.evaluate(() => ['#current-cue-panel', '.player-stage', '#cue-panel-text'].map(id => {
    const r=document.querySelector(id).getBoundingClientRect(); return {id,top:r.top,height:r.height};
  }));
  const before = await layout();
  let r=await box.boundingBox(), p={x:r.x+r.width/2,y:r.y+r.height/2};
  await page.mouse.move(p.x,p.y); await page.mouse.down(); await page.mouse.move(p.x+20,p.y+10); await page.mouse.up();
  expect(await snapshot(page)).toEqual(baseline);
  await expect(box).toHaveClass(/selected/);
  await expect(page.locator('#ass-cue-position')).toBeHidden();
  await box.click(); expect(await snapshot(page)).toEqual(baseline);
  r=await box.boundingBox(); p={x:r.x+r.width/2,y:r.y+r.height/2};
  await page.mouse.move(p.x,p.y); await page.mouse.down(); await page.mouse.move(p.x+20,p.y-10); await page.mouse.up();
  await expect(page.locator('#ass-cue-position')).toBeVisible();
  expect((await snapshot(page)).undo).toBe(baseline.undo+1);
  const positioned=await layout();
  await page.locator('#ass-cue-reset').click();
  await expect(page.locator('#ass-cue-position')).toBeHidden();
  const reset=await layout();
  await page.evaluate(() => MaweSelection.clearSelection());
  const cleared=await layout();
  expect(positioned).toEqual(before); expect(reset).toEqual(before); expect(cleared).toEqual(before);
  writeFileSync(info.outputPath('layout.json'),JSON.stringify({before,positioned,reset,cleared},null,2));
  await page.locator('#current-cue-panel').screenshot({path:info.outputPath('layout.png')});
});

test('shaken cue scale does not depend on pointermove event count', async ({ page }) => {
  const scales = [];
  for (const steps of [1, 8]) {
    await page.evaluate(() => {
      ASS_STYLE_LIBRARY.styles.find(style => style.id === 'ass').fontSize = 12;
      Object.assign(MaweBoot.DATA.segments[0], { text: '!!I!!', assOverride: { scale: 4 } });
      MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
    });
    const handle = page.locator('.ass-cue-scale-handle[data-corner="nw"]').filter({ visible: true });
    const box = await handle.boundingBox();
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x - 3, y - 3, { steps }); await page.mouse.up();
    scales.push((await snapshot(page)).override.scale);
  }
  expect(scales[1]).toBe(scales[0]);
});

test('shaken cue corner scaling projects movement around the stable center', async ({ page }, info) => {
  await page.evaluate(() => {
    ASS_STYLE_LIBRARY.styles.find(style => style.id === 'ass').fontSize = 12;
    MaweBoot.DATA.segments[0].text = '!!I!!';
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
  });
  const handle = page.locator('.ass-cue-scale-handle[data-corner="nw"]').filter({ visible: true });
  const box = await handle.boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const expected = await page.evaluate(({ x, y }) => {
    const frame = MaweAssCanvas.lastRender;
    const record = frame.tracks.find(item => item.cueId === 'main');
    const rect = MaweDom.overlayEl.getBoundingClientRect();
    const px = (x - rect.left) * frame.playResX / rect.width;
    const py = (y - rect.top) * frame.playResY / rect.height;
    const dx = px - (record.bounds.left + record.bounds.right) / 2;
    const dy = py - (record.bounds.top + record.bounds.bottom) / 2;
    const distance = Math.hypot(dx, dy);
    const sensitivity = Math.max(24, Math.hypot(record.bounds.right - record.bounds.left,
      record.bounds.bottom - record.bounds.top) / 2);
    const delta = -3 * frame.playResY / rect.height * dy / distance;
    return Math.round(Math.min(5, Math.max(0.1, 1 + delta / sensitivity)) * 100) / 100;
  }, { x, y });
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x, y - 3); await page.mouse.up();
  expect((await snapshot(page)).override.scale).toBe(expected);
  await page.locator('.player-stage').screenshot({ path: info.outputPath('shake-scale.png') });
});

test('dragged shaken cue saves the base anchor and window blur cancels the next gesture', async ({page},info) => {
  await page.locator('#cue-panel-text').fill('++!!喂喂喂嗯!!++');
  await page.locator('#cue-panel-text').press('Tab');
  await page.evaluate(() => {MaweCuePanel.commitCuePanelEdit(); MawePlaybackLoop.refreshSubtitlePreview(1000,0);});
  const box=page.locator('.ass-cue-drag-target').first(),r=await box.boundingBox();
  const data=await page.evaluate(()=>({anchor:MaweAssCanvas.lastRender.tracks[0].anchor,
    res:MaweAssCanvas.lastRender.playResX, width:MaweDom.overlayEl.getBoundingClientRect().width,
    text:MaweBoot.DATA.segments[0].text,count:MaweBoot.DATA.segments.length}));
  await page.mouse.move(r.x+r.width/2,r.y+r.height/2);await page.mouse.down();await page.mouse.move(r.x+r.width/2+15,r.y+r.height/2);await page.mouse.up();
  const saved=await snapshot(page);
  expect(saved.override.pos.x).toBe(roundPosition(data.anchor.x+15*data.res/data.width));
  expect(saved.override.pos.y).toBe(roundPosition(data.anchor.y));
  const next=await box.boundingBox();await page.mouse.move(next.x+next.width/2,next.y+next.height/2);
  await page.mouse.down();await page.mouse.move(next.x+next.width/2+12,next.y+next.height/2);
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await page.mouse.up();
  expect(await snapshot(page)).toEqual(saved);
  expect(await page.evaluate(()=>({text:MaweBoot.DATA.segments[0].text,count:MaweBoot.DATA.segments.length}))).toEqual({text:data.text,count:data.count});
  await page.locator('.player-stage').screenshot({path:info.outputPath('shake-drag.png')});
});

test('dragging an automatically stacked upper cue uses the global top anchor', async ({page}) => {
  const before=await page.evaluate(() => {
    const cue=MaweBoot.DATA.segments[1]; cue.start=0; cue.end=2000;
    ASS_STYLE_LIBRARY.styles.find(style=>style.id==='ass').alignment=8;
    MaweSelection.selectOnly(1); MawePlaybackLoop.refreshSubtitlePreview(1000,0);
    const frame=MaweAssCanvas.lastRender, record=frame.tracks.find(item=>item.cueId==='next');
    return {record,res:frame.playResX,width:MaweDom.overlayEl.getBoundingClientRect().width};
  });
  expect(before.record.alignment).toBe(2);
  const box=page.locator('.ass-cue-drag-target.selected'),r=await box.boundingBox();
  await page.mouse.move(r.x+r.width/2,r.y+r.height/2);await page.mouse.down();
  await page.mouse.move(r.x+r.width/2+15,r.y+r.height/2);await page.mouse.up();
  const after=await page.evaluate(()=>({pos:MaweBoot.DATA.segments[1].assOverride.pos,
    record:MaweAssCanvas.lastRender.tracks.find(item=>item.cueId==='next')}));
  expect(after.record.alignment).toBe(8);
  expect(after.pos.x).toBe(roundPosition(before.record.positionAnchor.x+15*before.res/before.width));
  expect(after.pos.y).toBe(roundPosition(before.record.positionAnchor.y));
  expect(after.record.bounds.top).toBeCloseTo(before.record.bounds.top + after.pos.y - before.record.positionAnchor.y, 2);
});
