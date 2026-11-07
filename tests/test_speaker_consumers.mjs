import assert from 'node:assert/strict';
import test from 'node:test';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';

const context = { window: {} };
loadEditorModule(context, 'shared/editor-utils.js');
const u = context.window.AsrEditorUtils;
const cue = (id, speaker, start = 0) => ({ id, speaker, start, end: start + 1000, text: `text-${id}` });
function fixture(mode = 'speaker') {
  return u.makeProject([cue('a', 'p1'), cue('b', 'p2', 1000), { ...cue('clear', null, 2000), color: { name: 'yellow' } }]
    .map(({ color, ...value }) => value), { projectFields: {
      annotation_mode: mode, palette_size: 5,
      speakers: [{ id: 'p1', name: '主持{人}', color: '#123456' }, { id: 'p2', name: '嘉宾', color: '#969fab' }],
      speaker_shortcuts: { 1: 'p1', 9: 'p2' },
    } });
}

test('identity names remain independent of annotation mode and never revive from old color labels', () => {
  const project = fixture();
  const segments = project.tracks[0].segments;
  const options = { speakerLabelsEnabled: true, speakerLabels: { yellow: '旧名字' }, speakerProject: project, speakerLabelSeparator: ':' };
  segments[2].color = { name: 'yellow' };
  for (const mode of ['speaker', 'color']) {
    project.annotation_mode = mode;
    assert.equal(u.buildPlainTextPayload(segments, options), '主持{人}:text-a\n嘉宾:text-b\ntext-clear');
    const srt = u.buildSrtPayload(segments, options);
    assert.match(srt, /主持\{人\}:text-a/);
    assert.doesNotMatch(srt, /旧名字/);
    assert.doesNotMatch(u.buildPlainTextPayload(segments, { ...options, speakerLabelsEnabled: false }), /主持|嘉宾/);
  }
});

test('effective colors come from identity in speaker mode and category in color mode even when palette is collapsed', () => {
  const project = fixture();
  const segments = project.tracks[0].segments;
  segments[1].color = { name: 'yellow', value: '#f9ca1f' };
  assert.deepEqual(JSON.parse(JSON.stringify(u.effectiveSegmentColor(project, segments[0], segments))), { name: null, value: '#123456' });
  assert.deepEqual(JSON.parse(JSON.stringify(u.effectiveSegmentColor(project, segments[1], segments))), { name: 'gray', value: '#969fab' });
  assert.equal(u.effectiveSegmentColor(project, segments[2], segments), null);
  assert.match(u.buildSrtPayload(segments, { speakerProject: project, colorName: 'gray' }), /text-b/);
  project.annotation_mode = 'color';
  assert.equal(u.effectiveSegmentColor(project, segments[1], segments).name, 'yellow');
});

test('ASS exports actual identity colors and escaped names for main, secondary and overlay without category groups', () => {
  const project = fixture();
  const main = project.tracks[0].segments;
  const secondary = [cue('secondary', 'p2')], overlay = [cue('overlay', 'p1')];
  const before = JSON.stringify(project);
  const library = u.defaultAssStyleLibrary();
  const ass = u.buildAssPayload(main, { speakerProject: project, speakerLabelsEnabled: true, speakerLabelSeparator: ':',
    assProfile: library.assProfiles[0], assStyle: library.styles.find(style => style.id === 'ass'),
    assExtensionStyle: library.styles.find(style => style.id === 'ass-extension'),
    extensionSegments: secondary, overlaySegments: overlay, appearance: { ass_color_style: 'text' } });
  assert.match(ass, /SPEAKER_123456/);
  assert.match(ass, /&H00563412/);
  assert.match(ass, /Extension SPEAKER_969FAB/);
  assert.match(ass, /Overlay SPEAKER_123456/);
  assert.match(ass, /嘉宾/);
  assert.match(ass, /主持\\\{人\\\}/);
  assert.equal(JSON.stringify(project), before);
});

test('timeline plans use their own project identities rather than another loaded project', () => {
  const project = fixture('color');
  project.media = '/synthetic.wav';
  project.waveform = { duration_ms: 4000 };
  const plan = u.buildProjectExportPlan(project, { speakerLabelsEnabled: true, speakerLabelSeparator: ':' });
  assert.deepEqual(Array.from(plan.cues.main, value => value.text), ['主持{人}:text-a', '嘉宾:text-b', 'text-clear']);
});

test('custom identity HEX exports stay separate from unassigned subtitles and retain real names', () => {
  const project = fixture();
  const segments = project.tracks[0].segments;
  const options = { speakerProject: project, speakerLabelsEnabled: true, speakerLabelSeparator: ':' };
  const custom = u.buildSrtPayload(segments, { ...options, colorName: '#123456' });
  assert.match(custom, /主持\{人\}:text-a/);
  assert.doesNotMatch(custom, /text-b|text-clear/);
  const unassigned = u.buildSrtPayload(segments, { ...options, colorName: 'default' });
  assert.match(unassigned, /text-clear/);
  assert.doesNotMatch(unassigned, /text-a|text-b|主持|嘉宾/);
  project.speakers[1].color = '#123456';
  const sharedColor = u.buildSrtPayload(segments, { ...options, colorName: '#123456' });
  assert.match(sharedColor, /主持\{人\}:text-a/);
  assert.match(sharedColor, /嘉宾:text-b/);
  assert.deepEqual(Array.from(project.speakers, person => person.id), ['p1', 'p2']);
});

test('category display follows configured runtime palette while identity display keeps project HEX', () => {
  const project = fixture('color');
  const segment = project.tracks[0].segments[0];
  segment.color_group_id = 'group';
  project.subtitle_groups.color.push({ id: 'group', value: { name: 'yellow', value: '#f9ca1f' } });
  const previous = context.window.MaweColors;
  try {
    context.window.MaweColors = { COLOR_BY_NAME: { yellow: { name: 'yellow', value: '#ab12cd' } } };
    assert.equal(u.effectiveSegmentColor(project, segment).value, '#ab12cd');
    project.annotation_mode = 'speaker';
    assert.equal(u.effectiveSegmentColor(project, segment).value, '#123456');
  } finally { context.window.MaweColors = previous; }
});

test('ASS preserves five-color output while including enabled or actually used extended styles', () => {
  const main = [{ id: 'plain', start: 0, end: 1000, text: 'Main' }];
  const overlay = [{ id: 'over', start: 0, end: 1000, text: 'Overlay' }];
  const baseline = u.buildAssPayload(main, { overlaySegments: overlay });
  for (const name of ['ORANGE', 'CYAN', 'MAGENTA', 'GRAY']) assert.doesNotMatch(baseline, new RegExp(`Style: (?:Overlay )?${name},`));
  const enabled = u.buildAssPayload(main, { overlaySegments: overlay, speakerProject: { annotation_mode: 'color', palette_size: 9, speakers: [] } });
  for (const name of ['ORANGE', 'CYAN', 'MAGENTA', 'GRAY']) assert.match(enabled, new RegExp(`Style: ${name},`));
  const collapsed = u.buildAssPayload(main, { overlaySegments: [{ ...overlay[0], color: { name: 'cyan' } }],
    speakerProject: { annotation_mode: 'color', palette_size: 5, speakers: [] } });
  assert.match(collapsed, /Style: CYAN,/);
  assert.match(collapsed, /Style: Overlay CYAN,/);
  assert.match(collapsed, /Dialogue: 2,[^\n]*,Overlay CYAN,/);
  for (const name of ['ORANGE', 'MAGENTA', 'GRAY']) assert.doesNotMatch(collapsed, new RegExp(`Style: (?:Overlay )?${name},`));
  const identities = fixture();
  identities.speakers.push({ id: 'unused', name: 'Unused', color: '#abcdef' });
  const identityAss = u.buildAssPayload(identities.tracks[0].segments, { speakerProject: identities });
  assert.match(identityAss, /Style: SPEAKER_123456,/);
  assert.match(identityAss, /Style: SPEAKER_969FAB,/);
  assert.doesNotMatch(identityAss, /SPEAKER_ABCDEF/);
});
