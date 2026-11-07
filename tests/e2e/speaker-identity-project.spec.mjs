import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, disableOnboarding, findFreePort, generateWav, makeTempDir, startServer } from './helpers.mjs';

test('speaker core commands, save and reopen preserve identities and collapsed slots', async ({ page }) => {
  const directory = makeTempDir('speaker-identity-project');
  const projectPath = join(directory, 'asr.mosp');
  const mediaPath = join(directory, 'synthetic.wav');
  let server;
  try {
    generateWav(mediaPath, 2);
    execFileSync(process.env.MAW_E2E_PYTHON || 'python', ['-c', [
      'import json, sys', 'from pathlib import Path', 'from maw.project_tracks import make_project',
      "segments = [dict(start=i*200, end=(i+1)*200, text='word', speaker=str(i), items=[dict(start=i*200,end=(i+1)*200,text='word',speaker=str(i))]) for i in range(6)]",
      "project = make_project(segments, project_fields={'media': 'synthetic.wav', 'palette_size': 9})",
      "Path(sys.argv[1]).write_text(json.dumps(project, ensure_ascii=False), encoding='utf-8')",
    ].join('\n'), projectPath]);
    server = await startServer(projectPath, mediaPath, await findFreePort());
    await disableOnboarding(page);
    await page.addInitScript(() => localStorage.setItem('moy.asr.editor.settings.v1', JSON.stringify({ autoSaveProject: false })));
    await page.goto(server.url);
    await page.waitForFunction(() => Boolean(window.MaweProjectSave));
    expect(await page.evaluate(() => MaweBoot.DATA.speakers.length)).toBe(6);
    expect(await page.evaluate(() => MaweBoot.DATA.palette_size)).toBe(9);
    const items = await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].items);
    await page.evaluate(() => {
      const track = AsrEditorUtils.getMainTrack(MaweBoot.DATA);
      MaweSpeakerLabels.assignIdentity([{ track_id: track.id, segment_id: track.segments[0].id }], 'spk-002');
    });
    expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].speaker)).toBe('spk-002');
    expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].items)).toEqual(items);
    await page.locator('#undo-btn').click();
    expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].speaker)).toBe('spk-001');
    await page.locator('#redo-btn').click();
    expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].speaker)).toBe('spk-002');
    await page.evaluate(() => {
      MaweBoot.DATA.palette_size = 5;
      const track = AsrEditorUtils.getMainTrack(MaweBoot.DATA);
      MaweSpeakerLabels.clearIdentity([{ track_id: track.id, segment_id: track.segments[0].id }]);
    });
    const response = page.waitForResponse(r => r.url().endsWith('/api/project') && r.request().method() === 'POST');
    await page.keyboard.press('Control+s');
    expect((await response).ok()).toBe(true);
    const saved = JSON.parse(readFileSync(projectPath, 'utf8'));
    expect(saved.palette_size).toBe(5);
    expect(saved.speakers).toHaveLength(6);
    expect(saved.speaker_shortcuts['6']).toBe('spk-006');
    expect(saved.tracks[0].segments[0].speaker).toBeNull();
    for (const cue of saved.tracks[0].segments) for (const item of cue.items) expect(item).not.toHaveProperty('speaker');
    await page.reload();
    await page.waitForFunction(() => Boolean(window.MaweProjectSave));
    expect(await page.evaluate(() => ({ speakers: MaweBoot.DATA.speakers, slots: MaweBoot.DATA.speaker_shortcuts,
      palette: MaweBoot.DATA.palette_size, identity: AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].speaker })))
      .toEqual({ speakers: saved.speakers, slots: saved.speaker_shortcuts, palette: 5, identity: null });
    await page.evaluate(() => MaweSpeakerLabels.mergeIdentities(['spk-002'], 'spk-001'));
    expect(await page.evaluate(() => MaweBoot.DATA.speakers.length)).toBe(5);
    expect(await page.evaluate(() => MaweBoot.DATA.speaker_shortcuts['2'])).toBe('spk-001');
    expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[1].speaker)).toBe('spk-001');
    await page.locator('#undo-btn').click();
    expect(await page.evaluate(() => MaweBoot.DATA.speakers)).toEqual(saved.speakers);
    expect(await page.evaluate(() => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[1].speaker)).toBe('spk-002');
    await page.evaluate(() => {
      AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].speaker = 'missing';
      MaweState.markProjectDirty();
    });
    await page.keyboard.press('Control+s');
    await expect(page.locator('.hint-project-error')).toContainText('must reference a project speaker');
    expect(JSON.parse(readFileSync(projectPath, 'utf8'))).toEqual(saved);
    const downgraded = { ...saved };
    delete downgraded.speakers;
    const rejected = await page.evaluate(async project => {
      const config = MaweBoot.SERVER_CONFIG;
      const response = await fetch(config.saveUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project, bindingGeneration: config.bindingGeneration, sourceMediaId: config.sourceMediaId }) });
      return { ok: response.ok, result: await response.json() };
    }, downgraded);
    expect(rejected.ok).toBe(false);
    expect(rejected.result.error).toContain('speakers');
    expect(JSON.parse(readFileSync(projectPath, 'utf8'))).toEqual(saved);
    const modeCheck = await page.evaluate(() => {
      const track = AsrEditorUtils.getMainTrack(MaweBoot.DATA);
      track.segments[0].speaker = null;
      MaweStickerPicker.assignColor([0], 'red');
      const group = track.segments[0].color_group_id;
      MaweBoot.DATA.annotation_mode = 'speaker';
      MaweStickerPicker.assignColor([0], 'yellow');
      const assigned = track.segments[0].speaker;
      const label = AsrEditorUtils.speakerLabelForSegment(track.segments[0], track.segments, { red: '错误的颜色姓名' });
      MaweStickerPicker.clearColorOnTargets([0]);
      return { assigned, label, cleared: track.segments[0].speaker,
        groupPreserved: group === track.segments[0].color_group_id,
        emptyLabel: AsrEditorUtils.speakerLabelForSegment(track.segments[0], track.segments, { red: '不应复活' }) };
    });
    expect(modeCheck).toEqual({ assigned: 'spk-001', label: '说话人 1', cleared: null, groupPreserved: true, emptyLabel: '' });
  } finally {
    await server?.stop();
    cleanupTempDir(directory);
  }
});
