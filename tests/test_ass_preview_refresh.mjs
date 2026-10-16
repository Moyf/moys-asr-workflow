import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function scheduler() {
  const frames = new Map(), timers = new Map(), observed = [], unobserved = [], listeners = new Map();
  let id = 0, draws = 0;
  const player = { tagName: 'VIDEO' };
  const context = {
    MaweSettings: { EDITOR_SETTINGS: { assMode: true } },
    MaweDom: { playerStage: {} }, MaweCoreState: { player },
    MawePlaybackLoop: { refreshSubtitlePreview() { draws++; } },
    requestAnimationFrame(fn) { frames.set(++id, fn); return id; },
    cancelAnimationFrame(key) { frames.delete(key); },
    ResizeObserver: class { observe(element) { observed.push(element); } unobserve(element) { unobserved.push(element); } },
    window: { setTimeout(fn) { timers.set(++id, fn); return id; },
      clearTimeout(key) { timers.delete(key); }, addEventListener(name, fn) { listeners.set(name, fn); } },
  };
  const source = fs.readFileSync(new URL('../web/editor/media/editor-wiring-keyboard-guards.js', import.meta.url), 'utf8');
  vm.runInNewContext(source.slice(source.indexOf('let assPreviewRefreshFrame')), context);
  const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); };
  return { context, frames, timers, observed, unobserved, listeners, player, flush, draws: () => draws };
}

test('ASS resize events coalesce without postponing the next frame or fixed trailing refresh', () => {
  const s = scheduler();
  s.context.scheduleAssSubtitlePreviewRefresh();
  const firstTimer = [...s.timers.keys()][0];
  for (let i = 0; i < 20; i++) s.context.scheduleAssSubtitlePreviewRefresh();
  assert.equal(s.frames.size, 1);
  assert.deepEqual([...s.timers.keys()], [firstTimer]);
  s.flush();
  assert.equal(s.draws(), 1);
  assert.equal(s.frames.size, 0);
  const finish = s.timers.get(firstTimer); s.timers.delete(firstTimer); finish(); s.flush();
  assert.equal(s.draws(), 2);
  assert.equal(s.frames.size, 0);
  assert.equal(s.timers.size, 0);
});

test('ASS refresh observes the video and pending work cannot paint after disabling ASS', () => {
  const s = scheduler();
  assert.ok(s.observed.includes(s.player));
  s.context.scheduleAssSubtitlePreviewRefresh();
  s.context.MaweSettings.EDITOR_SETTINGS.assMode = false;
  s.flush();
  for (const finish of s.timers.values()) finish();
  s.flush();
  assert.equal(s.draws(), 0);
});

test('replacing the video detaches the old observation and observes the new player once', () => {
  const s = scheduler();
  const next = { tagName: 'VIDEO' };
  s.context.observeAssSubtitlePreviewPlayer(next);
  s.context.observeAssSubtitlePreviewPlayer(next);
  assert.deepEqual(s.unobserved, [s.player]);
  assert.equal(s.observed.filter(item => item === next).length, 1);
  s.context.observeAssSubtitlePreviewPlayer({ tagName: 'AUDIO' });
  assert.deepEqual(s.unobserved, [s.player, next]);
});
