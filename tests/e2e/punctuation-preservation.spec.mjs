import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { disableOnboarding, findFreePort, generateWav, startServer } from './helpers.mjs';

test('generated punctuation survives Server open, split, merge, save and reopen', async ({ page }) => {
  const directory = test.info().outputPath('fixture');
  mkdirSync(directory, { recursive: true });
  const media = generateWav(join(directory, 'synthetic.wav'), 6);
  const project = join(directory, 'generated.mosp');
  const python = String(process.env.MAW_E2E_PYTHON || '').trim();
  expect(python, 'use the configured test interpreter').not.toBe('');
  execFileSync(python, ['-c', `
import json, sys
from pathlib import Path
from maw.local_asr import LocalTranscription, build_local_segments
texts = ['你好，世界。真的吗？！', '“3.14，U.S.！”']
tokens = [['你', '好，', '世', '界。', '真', '的', '吗？！'], ['“3.14，', 'U.S.！”']]
rows = []
for index, text in enumerate(texts):
    start = index * 3000
    items = [{'text': token, 'start': start + i * 300, 'end': start + (i + 1) * 300} for i, token in enumerate(tokens[index])]
    rows.append({'id': f'cue-{index}', 'start': start, 'end': items[-1]['end'], 'text': text, 'items': items})
result = LocalTranscription(''.join(texts), 'zh', [], rows, 'synthetic')
segments = build_local_segments(result, duration_ms=6000, max_len=100)
assert [segment['text'] for segment in segments] == texts
Path(sys.argv[1]).write_text(json.dumps({'media': 'synthetic.wav', 'segments': segments}, ensure_ascii=False), encoding='utf-8')
`, project], { encoding: 'utf8', timeout: 30_000 });
  const generated = JSON.parse(readFileSync(project, 'utf8'));
  let server;
  try {
    server = await startServer(project, media, await findFreePort());
    await disableOnboarding(page);
    await page.goto(server.url);
    await expect(page.locator('.cue[data-idx="0"] .text')).toHaveText(generated.segments[0].text);
    // Compare source text and millisecond item data. Loading may add frame caches.
    const content = () => page.evaluate(() => MaweBoot.DATA.segments.map(({ text, items }) => ({
      text, items: items.map(({ text, start, end }) => ({ text, start, end })),
    })));
    const expected = generated.segments.map(({ text, items }) => ({ text, items }));
    expect(await content()).toEqual(expected);
    expect(await page.evaluate(() => MaweSettings.EDITOR_SETTINGS.splitTrimSymbols)).toEqual([]);
    // Exercise the same split modal and confirm control used by waveform split.
    await page.evaluate(() => MaweSplitCore.openMainWaveformSplitModal(0, 600));
    await expect(page.locator('#multi-subtitle-split-modal')).toHaveClass(/show/);
    await page.locator('#multi-subtitle-split-confirm').click();
    await expect.poll(async () => (await content()).length).toBe(3);
    const split = await content();
    expect(split[0].text + split[1].text).toBe(expected[0].text);
    expect([...split[0].items, ...split[1].items]).toEqual(expected[0].items);
    await page.evaluate(() => MaweSegmentOps.mergeSegments([0, 1]));
    expect(await content()).toEqual(expected);
    await page.screenshot({ path: test.info().outputPath('punctuation-after-merge.png') });
    const save = page.waitForResponse((response) => response.url().endsWith('/api/project') && response.request().method() === 'POST');
    await page.locator('#save-project').click();
    expect((await save).ok()).toBe(true);
    expect(JSON.parse(readFileSync(project, 'utf8')).segments.map(({ text, items }) => ({
      text, items: items.map(({ text, start, end }) => ({ text, start, end })),
    }))).toEqual(expected);
    await page.reload();
    await expect(page.locator('.cue[data-idx="0"] .text')).toHaveText(expected[0].text);
    expect(await content()).toEqual(expected);
    // The legacy opt-out flag no longer controls opening; false also preserves text.
    await page.evaluate(async () => {
      MaweBoot.DATA.preserve_punctuation = false;
      await MaweProjectSave.saveProjectToServer({ silent: true });
    });
    await page.reload();
    await expect(page.locator('.cue[data-idx="0"] .text')).toHaveText(expected[0].text);
    expect(await content()).toEqual(expected);
  } finally {
    await server?.stop();
  }
});
