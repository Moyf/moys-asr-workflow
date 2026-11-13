import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

test('merged translations cover 2.0 track controls and main quick-edit/image export', () => {
  const source = fs.readFileSync(new URL('../web/shared/editor-i18n.js', import.meta.url), 'utf8');
  const context = { window: {} };
  vm.runInNewContext(source, context);
  const i18n = context.window.MAWE_I18N;
  for (const [zh, en] of [
    ['字幕轨道状态', 'Subtitle track status'],
    ['主字幕轨始终启用', 'The main subtitle track is always enabled'],
    ['快捷编辑', 'Quick edit'],
    ['图片字幕 XML 已保存', 'Image subtitle XML saved'],
  ]) {
    assert.equal(i18n.translateText(zh, 'en'), en);
    assert.equal(i18n.translateText(zh, 'zh'), zh);
  }
});

test('manual and automatic merge compound toasts translate duration impacts and speaker synchronization together', () => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(new URL('../web/shared/editor-i18n.js', import.meta.url), 'utf8'), context);
  const i18n = context.window.MAWE_I18N;
  const speakerZh = '副字幕说话人已按主字幕统一';
  const speakerEn = 'Secondary subtitle speakers now match the main subtitles';
  for (const [impactZh, impactEn] of [
    ['裁剪 1 条其他副字幕', ['trimmed 1 other secondary subtitle']],
    ['裁剪 2 条其他副字幕并解除相关绑定', ['trimmed 2 other secondary subtitles and removed related bindings']],
    ['删除 1 条副字幕', ['deleted 1 secondary subtitle']],
    ['删除 2 条副字幕并解除相关绑定', ['deleted 2 secondary subtitles and removed related bindings']],
    ['裁剪 1 条其他副字幕，删除 2 条副字幕', ['trimmed 1 other secondary subtitle', 'deleted 2 secondary subtitles']],
    ['裁剪 2 条其他副字幕，删除 1 条副字幕并解除相关绑定',
      ['trimmed 2 other secondary subtitles', 'deleted 1 secondary subtitle and removed related bindings']],
  ]) {
    for (const [zh, en] of [
      [`已合并 2 条，${impactZh}，${speakerZh}`, `Merged 2 subtitles; ${[...impactEn, speakerEn].join('; ')}`],
      [`已拼合字幕：吸附 1 处间隔，吸收 2 条短字幕，${impactZh}，${speakerZh}`,
        `Join / merge subtitles: snapped 1 intervals, absorbed 2 short subtitles, ${[...impactEn, speakerEn].join(', ')}`],
    ]) {
      assert.equal(i18n.translateText(zh, 'zh'), zh);
      assert.equal(i18n.translateText(zh, 'en'), en);
    }
  }
});
