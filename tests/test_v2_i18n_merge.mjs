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
