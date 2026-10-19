/* Fixed offline adapter. No file path access; only text edits to snapshot-owned IDs. */
(function (root) {
  'use strict';
  function compose(entry, text, packet) {
    if (packet.mode !== 'bilingual' || !entry.source.trim()) return text;
    if (!text.trim() || entry.source.trim() === text.trim()) return entry.source;
    return packet.translationFirst ? `${text}\n${entry.source}` : `${entry.source}\n${text}`;
  }
  async function readPacket(review) {
    if (typeof review?.snapshot !== 'string' || !/^[a-f0-9]{64}$/.test(review.sha256)) throw new Error('核对快照或指纹无效。');
    const digest = await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(review.snapshot));
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    if (hash !== review.sha256) throw new Error('快照指纹不一致，不能导出。请重新生成核对页。');
    const packet = JSON.parse(review.snapshot);
    if (packet.schema !== 'maw.translation-review.v1' || !Array.isArray(packet.entries)
        || !['single', 'backfill', 'bilingual', 'tracks'].includes(packet.mode)
        || typeof packet.translationFirst !== 'boolean') throw new Error('核对协议无效。');
    for (const project of [packet.source, packet.result]) {
      if (project?.schema !== 'moy.asr.project.v1' || !Array.isArray(project.segments)) throw new Error('工程格式无效。');
      const ids = new Set();
      for (const cue of project.segments) {
        if (typeof cue.id !== 'string' || !cue.id || ids.has(cue.id) || typeof cue.text !== 'string'
            || !Number.isInteger(cue.start) || !Number.isInteger(cue.end) || cue.start < 0 || cue.end <= cue.start) throw new Error('工程字幕ID或时间无效。');
        ids.add(cue.id);
      }
    }
    const source = new Map(packet.source.segments.map(cue => [cue.id, cue]));
    const target = new Map(packet.result.segments.map(cue => [cue.id, cue]));
    const track = packet.mode === 'tracks' ? translationTrack(packet.result, packet.translationTrackId) : null;
    const extensions = new Map((track?.segments || []).map(cue => [cue.id, cue]));
    const seenTargets = new Set();
    const seen = new Set();
    const expected = packet.source.segments.filter(cue => target.has(cue.id)).map(cue => cue.id);
    if (target.size !== expected.length || packet.entries.length !== expected.length) throw new Error('源工程与结果映射不完整。');
    for (const [index, entry] of packet.entries.entries()) {
      const left = source.get(entry.id), right = target.get(entry.id);
      if (!left || !right || seen.has(entry.id) || entry.id !== expected[index]
          || entry.source !== left.text || typeof entry.translation !== 'string'
          || entry.start !== left.start || entry.end !== left.end
          || right.start !== left.start || right.end !== left.end
          || entry.editable !== (!left.disabled && Boolean(left.text.trim()) && (!track || entry.targetId !== null))) throw new Error('字幕映射、原文或时间不一致。');
      if (track) {
        const extension = extensions.get(entry.targetId);
        if (right.text !== left.text || (entry.targetId === null
          ? entry.translation.trim() !== left.text.trim()
          : !extension || seenTargets.has(entry.targetId) || extension.start !== left.start
            || extension.end !== left.end || extension.text !== entry.translation)) throw new Error('主副字幕映射不一致。');
        if (entry.targetId !== null) seenTargets.add(entry.targetId);
      } else if (compose(entry, entry.translation, packet) !== right.text) throw new Error('字幕映射、原文或时间不一致。');
      seen.add(entry.id);
    }
    if (packet.source.segments.some(cue => !target.has(cue.id) && cue.text.trim())) throw new Error('结果漏掉非空字幕。');
    if (track && seenTargets.size !== extensions.size) throw new Error('副字幕映射不完整。');
    return packet;
  }
  function translationTrack(project, id) {
    const tracks = project.multi_subtitle?.tracks?.filter(track => track.id === id);
    if (typeof id !== 'string' || tracks?.length !== 1 || !Array.isArray(tracks[0].segments)) throw new Error('译文副轨无效。');
    const ids = new Set();
    for (const cue of tracks[0].segments) {
      if (typeof cue.id !== 'string' || !cue.id || ids.has(cue.id) || typeof cue.text !== 'string'
          || !Number.isInteger(cue.start) || !Number.isInteger(cue.end) || cue.start < 0 || cue.end <= cue.start) throw new Error('译文副轨ID或时间无效。');
      ids.add(cue.id);
    }
    return tracks[0];
  }
  async function applyEdits(review, edits) {
    const packet = await readPacket(review);
    if (!Array.isArray(edits)) throw new Error('译文修改必须是数组。');
    const entries = new Map(packet.entries.map(entry => [entry.id, entry]));
    const seen = new Set(), result = JSON.parse(JSON.stringify(packet.result));
    const track = packet.mode === 'tracks' ? translationTrack(result, packet.translationTrackId) : null;
    const targets = new Map((track ? track.segments : result.segments).map(cue => [cue.id, cue]));
    let changed = 0;
    for (const edit of edits) {
      const entry = entries.get(edit?.id);
      if (!entry?.editable || seen.has(edit.id) || Object.keys(edit).some(key => !['id', 'text'].includes(key))
          || typeof edit.text !== 'string' || !edit.text.trim() || edit.text.length > 20000
          || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(edit.text)) throw new Error(`译文 ${edit?.id || ''} 为空、超长或映射无效。`);
      seen.add(edit.id);
      const text = edit.text.replace(/\r\n?/g, '\n');
      if (text === entry.translation) continue;
      const cue = targets.get(track ? entry.targetId : edit.id);
      const assembled = compose(entry, text, packet);
      if (assembled !== cue.text) {
        cue.text = assembled;
        delete cue.items;
        cue._dirty = true;
      }
      changed += 1;
    }
    return { project: result, changed };
  }
  root.MAWTranslationReview = Object.freeze({ readPacket, applyEdits });
})(globalThis);
