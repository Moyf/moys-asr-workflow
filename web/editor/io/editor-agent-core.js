export function createAgentCore(dependencies) {
  'use strict';
  const { applyTimedTextEdit } = dependencies;
  const schema = 'moy.asr.agent.proposal.v1';
  const basic = new Set(['id', 'start', 'end', 'text', 'items', 'speaker', '_dirty']);
  const sourceFields = new Set([...basic, 'start_frame', 'end_frame']);
  const clone = value => JSON.parse(JSON.stringify(value));
  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
      .filter(key => key !== '_dirty' && value[key] !== undefined)
      .map(key => [key, canonical(value[key])]));
    return value;
  }
  const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
  function scope(project) {
    return Object.fromEntries(['media', 'segments', 'multi_subtitle', 'overlay_track', 'timebase',
      'gap_remove', 'markers', 'media_metadata', 'language', 'preserve_punctuation']
      .map(key => [key, project[key] ?? null]));
  }
  function fail(code, message) { throw Object.assign(new Error(message), { code }); }
  function bounds(start, end) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) {
      fail('invalid_range', '时间必须是非负整数毫秒，且结束晚于开始');
    }
  }
  function validateSegments(segments) {
    let previous = 0;
    const ids = new Set();
    for (const s of segments) {
      if (!s || typeof s !== 'object') fail('invalid_request', '字幕格式无效');
      bounds(s.start, s.end);
      if (s.start < previous || typeof s.text !== 'string' || !s.text.trim()) fail('invalid_request', '字幕重叠或文字为空');
      if (typeof s.id !== 'string' || !s.id.trim() || s.id.length > 160 || ids.has(s.id)) fail('invalid_request', '字幕 ID 无效或重复');
      if (s.speaker !== undefined && (typeof s.speaker !== 'string' || !s.speaker.trim())) fail('invalid_request', '说话人格式无效');
      ids.add(s.id);
      previous = s.end;
      let itemEnd = s.start;
      if (s.items !== undefined && !Array.isArray(s.items)) fail('invalid_request', '字词时间码格式无效');
      for (const item of s.items || []) {
        if (!item || typeof item !== 'object') fail('invalid_request', '字词格式无效');
        bounds(item.start, item.end);
        if (item.start < itemEnd || item.end > s.end || typeof item.text !== 'string') fail('invalid_request', '字词时间码超出字幕或互相重叠');
        itemEnd = item.end;
      }
    }
  }
  function plan(project, proposal) {
    if (proposal?.schema !== schema || !proposal.base || !proposal.operation || typeof proposal.reason !== 'string') {
      fail('invalid_proposal', '不是有效的 MAW Agent 提案');
    }
    if (!same(scope(project), scope(proposal.base))) fail('conflict', '工程已变化。请重新导出 Agent 快照并重新生成提案');
    const segments = clone(project.segments);
    const op = proposal.operation;
    let changedIds = [];
    let rows = [];
    if (op.type === 'text') {
      if (!Array.isArray(op.edits) || !op.edits.length) fail('invalid_request', '修改列表为空');
      const seen = new Set();
      for (const edit of op.edits) {
        const index = segments.findIndex(s => s.id === edit?.id);
        if (index < 0 || seen.has(edit.id) || typeof edit.text !== 'string' || !edit.text.trim()
            || Object.keys(edit).some(k => !['id', 'text'].includes(k))) fail('invalid_request', '修改条目或字幕 ID 无效');
        seen.add(edit.id);
        const before = segments[index];
        // One cue at a time: reuse the editor's word reconciliation without moving neighbours.
        const after = applyTimedTextEdit([before], [edit.text])?.[0];
        if (!after || after.start !== before.start || after.end !== before.end) fail('invalid_request', '文字修改不能改变时间范围');
        segments[index] = after;
        if (!same(before, after)) {
          rows.push({ before: [before], after: [after] });
          changedIds.push(after.id);
        }
      }
    } else if (op.type === 'replace_range') {
      bounds(op.start, op.end);
      if (project.timebase?.unit === 'frames' || project.multi_subtitle?.tracks?.length) fail('unsupported_structure', '范围替换暂不支持帧模式或绑定副字幕');
      if (segments.some(s => s.sticker_ref || s.color_ref)) fail('unsupported_structure', '范围替换暂不支持分组表情包或颜色引用');
      const indices = segments.map((s, i) => s.end > op.start && s.start < op.end ? i : -1).filter(i => i >= 0);
      for (const i of indices) {
        const s = segments[i];
        if (s.start < op.start || s.end > op.end) fail('boundary_conflict', '替换范围切穿已有字幕，请显式选择完整字幕范围');
        if (Object.entries(s).some(([k, v]) => !sourceFields.has(k) && v != null)) fail('unsupported_structure', '范围包含装饰、禁用或未知元数据');
      }
      if (!Array.isArray(op.segments)) fail('invalid_request', '替换字幕必须是数组');
      const replacement = clone(op.segments);
      validateSegments(replacement);
      for (const s of replacement) {
        if (Object.keys(s).some(k => !basic.has(k)) || s.start < op.start || s.end > op.end) fail('invalid_range', '替换字幕超出范围或含不支持的元数据');
      }
      const insertion = indices[0] ?? segments.findIndex(s => s.start >= op.end);
      const at = insertion < 0 ? segments.length : insertion;
      rows = [{ before: segments.slice(at, at + indices.length), after: replacement }];
      segments.splice(at, indices.length, ...replacement);
      changedIds = replacement.map(s => s.id);
      validateSegments(segments);
    } else fail('invalid_request', '不支持的操作');
    return { segments, changedIds, rows, changed: !same(project.segments, segments) };
  }
  return Object.freeze({ plan, same });
}
