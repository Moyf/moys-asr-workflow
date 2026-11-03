// Project-owned identity fields are optional for earlier core-v2 files.
export const SPEAKER_PROJECT_FIELDS = Object.freeze(['speakers', 'annotation_mode', 'palette_size', 'speaker_shortcuts']);
export const SPEAKER_IDENTITY_PALETTE = Object.freeze(['#f9ca1f', '#66bb6a', '#f07f6f', '#bf89e6', '#61a7fa', '#f2a65a', '#49c5c1', '#d675b9', '#969fab']);

export function resolveProjectSpeaker(project, segment) {
  return project.speakers?.find(speaker => speaker.id === segment?.speaker) ?? null;
}

export function canMergeSpeakerSegments(segments) {
  return segments.length > 0 && segments.every(segment => (segment.speaker ?? null) === (segments[0]?.speaker ?? null));
}

export function assignProjectSpeaker(project, refs, identity) {
  if (identity !== null && !project.speakers?.some(speaker => speaker.id === identity)) throw new Error('Unknown project speaker');
  const targets = refs.map(ref => {
    const segment = project.tracks.find(track => track.id === ref.track_id)?.segments.find(cue => cue.id === ref.segment_id);
    if (!segment) throw new Error('Unknown subtitle reference');
    return segment;
  });
  let changed = false;
  for (const segment of new Set(targets)) if ((segment.speaker ?? null) !== identity) {
    segment.speaker = identity;
    changed = true;
  }
  return changed;
}

export function mergeProjectSpeakers(project, sourceIds, targetId) {
  const sources = new Set(sourceIds.filter(id => id !== targetId));
  const known = new Set(project.speakers.map(speaker => speaker.id));
  if (!known.has(targetId) || [...sources].some(id => !known.has(id))) throw new Error('Unknown project speaker');
  if (!sources.size) return false;
  for (const track of project.tracks) for (const segment of track.segments) {
    if (sources.has(segment.speaker)) segment.speaker = targetId;
  }
  for (const [slot, id] of Object.entries(project.speaker_shortcuts ?? {})) {
    if (sources.has(id)) project.speaker_shortcuts[slot] = targetId;
  }
  project.speakers = project.speakers.filter(speaker => !sources.has(speaker.id));
  return true;
}

export function upgradeProjectSpeakers(input) {
  const project = JSON.parse(JSON.stringify(input));
  if (Object.hasOwn(project, 'speakers')) return project;
  const mapping = Object.create(null);
  const sourceIds = [];
  for (const track of project.tracks) for (const segment of track.segments) {
    for (const entry of [segment, ...(Array.isArray(segment.items) ? segment.items : [])]) {
      const id = entry.speaker;
      if (typeof id === 'string' && /[^\s\u0085\u001c-\u001f]/u.test(id) && !Object.hasOwn(mapping, id)) {
        sourceIds.push(id); mapping[id] = `spk-${String(sourceIds.length).padStart(3, '0')}`;
      }
    }
  }
  const reserved = new Set(project.tracks.flatMap(track => track.segments.map(segment => segment.id)));
  const replacements = new Map();
  const fail = (path, message) => { throw Object.assign(new Error(message), { path }); };
  for (const [index, track] of project.tracks.entries()) {
    let result;
    try { result = migrateSpeakerSegments(track.segments, mapping, [...reserved]); }
    catch (error) { fail(`$.tracks[${index}].segments`, error.message); }
    track.segments = result.segments;
    const byId = new Map(track.segments.map(segment => [segment.id, segment]));
    replacements.set(track.id, new Map(result.mappings.map(entry => [entry.old_id, entry.new_ids.map(id => byId.get(id))])));
    for (const segment of track.segments) reserved.add(segment.id);
  }
  const usedBindings = new Set(project.bindings.map(binding => binding.id));
  project.bindings = project.bindings.flatMap(binding => {
    const sources = replacements.get(binding.source.track_id).get(binding.source.segment_id);
    const targets = replacements.get(binding.target.track_id).get(binding.target.segment_id);
    if (sources.length === 1 && targets.length === 1) return [binding];
    const paired = sources.length === targets.length && sources.slice(0, -1).every((cue, index) =>
      cue.end === targets[index].end && sources[index + 1].start === targets[index + 1].start);
    // Independent cue splits detach the old one-to-one binding. Import changes
    // exposes this removal; every cue, group membership and source file remains.
    if (!paired) return [];
    return sources.map((source, index) => {
      const target = targets[index];
      let id = binding.id;
      if (index) {
        let suffix = 1;
        const candidate = number => {
          const tail = `-speaker-${number}`;
          return Array.from(binding.id).slice(0, 160 - tail.length).join('') + tail;
        };
        while (usedBindings.has(candidate(suffix))) suffix++;
        id = candidate(suffix); usedBindings.add(id);
      }
      return { ...binding, id, source: { ...binding.source, segment_id: source.id },
        target: { ...binding.target, segment_id: target.id }, start_offset_ms: target.start - source.start,
        end_offset_ms: target.end - source.end };
    });
  });
  const identities = [...new Set(project.tracks.flatMap(track => track.segments.map(segment => segment.speaker)).filter(id => id != null))];
  if (!Object.hasOwn(project, 'annotation_mode')) project.annotation_mode = 'color';
  if (!Object.hasOwn(project, 'palette_size')) project.palette_size = 5;
  if (![5, 9].includes(project.palette_size)) fail('$.palette_size', 'must be 5 or 9');
  project.speakers = identities.map((id, index) => ({ id, name: `说话人 ${index + 1}`, color: SPEAKER_IDENTITY_PALETTE[index % project.palette_size] }));
  if (!Object.hasOwn(project, 'speaker_shortcuts')) {
    project.speaker_shortcuts = Object.fromEntries(identities.slice(0, project.palette_size).map((id, index) => [String(index + 1), id]));
  } else {
    if (!project.speaker_shortcuts || typeof project.speaker_shortcuts !== 'object' || Array.isArray(project.speaker_shortcuts)) {
      fail('$.speaker_shortcuts', 'must be an object');
    }
    project.speaker_shortcuts = Object.fromEntries(Object.entries(project.speaker_shortcuts).map(([slot, id]) => {
      if (typeof id !== 'string' || !Object.hasOwn(mapping, id) || !identities.includes(mapping[id])) {
        fail(`$.speaker_shortcuts.${slot}`, 'must reference an existing source speaker');
      }
      return [slot, mapping[id]];
    }));
  }
  return project;
}

export function validateProjectSpeakers(project) {
  const errors = [];
  const add = (path, message) => errors.push({ path, message });
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(project)) { add('$', 'must be an object'); return errors; }
  let speakers = project?.speakers;
  if (!Array.isArray(speakers)) { add('$.speakers', 'must be an array'); speakers = []; }
  if (Object.hasOwn(project, 'annotation_mode') && !['speaker', 'color'].includes(project.annotation_mode)) {
    add('$.annotation_mode', 'must be speaker or color');
  }
  if (Object.hasOwn(project, 'palette_size') && ![5, 9].includes(project.palette_size)) {
    add('$.palette_size', 'must be 5 or 9');
  }
  const ids = new Set();
  speakers.forEach((speaker, index) => {
    const path = `$.speakers[${index}]`;
    if (!object(speaker)) { add(path, 'must be an object'); return; }
    if (typeof speaker.id !== 'string' || !/[^\s\u0085\u001c-\u001f]/u.test(speaker.id)
        || Array.from(speaker.id).length > 160 || speaker.id !== speaker.id.trim()
        || /[\u0000-\u001f\u007f-\u009f]/u.test(speaker.id) || ids.has(speaker.id)) {
      add(`${path}.id`, 'must be a unique nonempty string');
    } else ids.add(speaker.id);
    if (typeof speaker.name !== 'string' || Array.from(speaker.name).length > 64
        || /[\u0000-\u001f\u007f-\u009f]/u.test(speaker.name)) {
      add(`${path}.name`, 'must be a name of at most 64 characters without control characters');
    }
    if (typeof speaker.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(speaker.color)) {
      add(`${path}.color`, 'must be a six-digit hex color');
    }
  });
  const shortcuts = project.speaker_shortcuts ?? {};
  if (!object(shortcuts) || project.speaker_shortcuts === null) add('$.speaker_shortcuts', 'must be an object');
  else for (const [slot, identity] of Object.entries(shortcuts)) {
    if (!/^[1-9]$/.test(slot)) add(`$.speaker_shortcuts.${slot}`, 'must be a slot from 1 to 9');
    else if (typeof identity !== 'string' || !ids.has(identity)) add(`$.speaker_shortcuts.${slot}`, 'must reference a project speaker');
  }
  if (!Array.isArray(project?.tracks)) { add('$.tracks', 'must be an array'); return errors; }
  project.tracks.forEach((track, trackIndex) => {
    const path = `$.tracks[${trackIndex}].segments`;
    if (!object(track) || !Array.isArray(track.segments)) { add(path, 'must be an array'); return; }
    track.segments.forEach((segment, segmentIndex) => {
      const segmentPath = `${path}[${segmentIndex}]`;
      if (!object(segment)) { add(segmentPath, 'must be an object'); return; }
      if (segment.speaker != null && (typeof segment.speaker !== 'string' || !ids.has(segment.speaker))) {
        add(`${segmentPath}.speaker`, 'must reference a project speaker');
      }
      if (segment.items == null) return;
      if (!Array.isArray(segment.items)) { add(`${segmentPath}.items`, 'must be an array'); return; }
      segment.items.forEach((item, itemIndex) => {
        if (object(item) && Object.hasOwn(item, 'speaker')) {
          add(`${segmentPath}.items[${itemIndex}].speaker`, 'speaker belongs to the segment');
        }
      });
    });
  });
  return errors;
}
// Migration is intentionally separate from project loading and binding updates.
// The mapping is indexed by input position so callers can update references.
export function migrateSpeakerSegments(segments, sourceToProject, reservedSegmentIds = []) {
  const valid = value => typeof value === 'string' && /[^\s\u0085\u001c-\u001f]/u.test(value);
  const identity = value => {
    if (value == null || (typeof value === 'string' && !valid(value))) return null;
    if (typeof value !== 'string') throw new Error('invalid source speaker');
    return value;
  };
  const source = JSON.parse(JSON.stringify(segments));
  const ids = source.map(segment => segment.id).filter(valid);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate segment id');
  const used = new Set([...ids, ...reservedSegmentIds]);
  const newId = base => {
    let number = 1;
    const candidate = number => {
      const suffix = `-speaker-${number}`;
      return Array.from(base).slice(0, 160 - suffix.length).join('') + suffix;
    };
    while (used.has(candidate(number))) number++;
    const id = candidate(number);
    used.add(id);
    return id;
  };
  const result = [];
  const mappings = [];
  source.forEach((segment, index) => {
    const items = segment.items ?? [];
    if (!Array.isArray(items) || items.some(item => item === null || typeof item !== 'object' || Array.isArray(item))) {
      throw new Error('items must be an array of objects');
    }
    const segmentSpeaker = identity(segment.speaker);
    const runs = [];
    let current = [];
    let currentSpeaker = null;
    for (const item of items) {
      const speaker = identity(item.speaker);
      if (current.length && speaker !== null && currentSpeaker !== null && speaker !== currentSpeaker) {
        runs.push([current, currentSpeaker]);
        current = [];
        currentSpeaker = null;
      }
      current.push(item);
      if (speaker !== null) currentSpeaker = speaker;
    }
    if (current.length) runs.push([current, currentSpeaker]);
    if (!runs.length) runs.push([[], null]);
    const split = runs.length > 1;
    let textPieces;
    if (split) {
      if (typeof segment.text !== 'string' || items.some(item => typeof item.text !== 'string')) {
        throw new Error('cannot split segment without matching item text');
      }
      const significant = char => !/[\s\u0085\u001c-\u001f\p{P}]/u.test(char);
      const text = Array.from(segment.text);
      if (text.filter(significant).join('') !== items.flatMap(item => Array.from(item.text)).filter(significant).join('')) {
        throw new Error('cannot split segment without matching item text');
      }
      const cuts = [];
      let cursor = 0;
      for (const [run] of runs.slice(0, -1)) {
        let count = run.flatMap(item => Array.from(item.text)).filter(significant).length;
        while (cursor < text.length && count) {
          if (significant(text[cursor])) count--;
          cursor++;
        }
        while (cursor < text.length && !significant(text[cursor])) cursor++;
        cuts.push(cursor);
      }
      textPieces = [0, ...cuts].map((start, i) => text.slice(start, [...cuts, text.length][i]).join(''));
      const edges = [...runs.slice(1).map(([run]) => [run[0], 'start']),
        ...runs.slice(0, -1).map(([run]) => [run.at(-1), 'end'])];
      if (edges.some(([item, key]) => !Number.isInteger(item[key]))) {
        throw new Error('cannot split segment without integer item timestamps');
      }
      const has = key => Object.hasOwn(segment, key);
      if (has('start_frame') !== has('end_frame')) throw new Error('segment frame boundaries must be paired');
      if (has('start_frame') && edges.some(([item, key]) => !Number.isInteger(item[`${key}_frame`]))) {
        throw new Error('cannot split framed segment without item frame boundaries');
      }
    }
    const oldId = segment.id ?? null;
    const newIds = [];
    runs.forEach(([run, runSpeaker], runIndex) => {
      const out = JSON.parse(JSON.stringify(segment));
      if (split) {
        if (runIndex || !valid(oldId)) out.id = newId(valid(oldId) ? oldId : `segment-${index + 1}`);
        out.items = JSON.parse(JSON.stringify(run));
        out.text = textPieces[runIndex];
        out.start = runIndex === 0 ? segment.start : run[0].start;
        out.end = runIndex === runs.length - 1 ? segment.end : run.at(-1).end;
        if (Object.hasOwn(segment, 'start_frame')) {
          out.start_frame = runIndex === 0 ? segment.start_frame : run[0].start_frame;
          out.end_frame = runIndex === runs.length - 1 ? segment.end_frame : run.at(-1).end_frame;
        }
      }
      const speaker = split ? runSpeaker : (segmentSpeaker ?? runSpeaker);
      if (speaker !== null) {
        const projectId = Object.hasOwn(sourceToProject, speaker) ? sourceToProject[speaker] : null;
        if (!valid(projectId)) throw new Error('unmapped source speaker');
        out.speaker = projectId;
      } else delete out.speaker;
      for (const item of out.items ?? []) delete item.speaker;
      result.push(out);
      newIds.push(out.id ?? null);
    });
    mappings.push({ input_index: index, old_id: oldId, new_ids: newIds });
  });
  return { segments: result, mappings };
}
