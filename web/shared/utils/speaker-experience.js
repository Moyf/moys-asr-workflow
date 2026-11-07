import { assignProjectSpeaker, SPEAKER_IDENTITY_PALETTE } from './speaker-identity.js';

export const SPEAKER_SHORTCUT_COLORS = Object.freeze(['yellow', 'green', 'red', 'purple', 'blue', 'orange', 'cyan', 'magenta', 'gray']);

function table(project) {
  if (!Array.isArray(project?.speakers)) throw new Error('Project speakers are not initialized');
  return project.speakers;
}

function validSlot(slot) {
  if (!Number.isInteger(slot) || slot < 1 || slot > 9) throw new Error('Speaker shortcut must be from 1 to 9');
  return String(slot);
}

function checkName(value) {
  if (typeof value !== 'string' || Array.from(value).length > 64 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error('Speaker name must contain at most 64 characters without control characters');
  }
  return value;
}

function checkColor(value) {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error('Speaker color must be a six-digit HEX value');
  return value.toLowerCase();
}

/** @param {{ name?: string, color?: string, slot?: number }} [options] */
export function createProjectSpeaker(project, options = {}) {
  const { name, color, slot } = options;
  const speakers = table(project);
  const shortcut = slot === undefined ? null : validSlot(slot);
  const ids = new Set(speakers.map(speaker => speaker.id));
  let number = 1;
  while (ids.has(`spk-${String(number).padStart(3, '0')}`)) number++;
  const speaker = {
    id: `spk-${String(number).padStart(3, '0')}`,
    name: checkName(name ?? `说话人 ${number}`),
    color: checkColor(color ?? SPEAKER_IDENTITY_PALETTE[slot === undefined ? (speakers.length % (project.palette_size === 9 ? 9 : 5)) : slot - 1]),
  };
  speakers.push(speaker);
  if (shortcut !== null) {
    project.speaker_shortcuts ||= {};
    project.speaker_shortcuts[shortcut] = speaker.id;
  }
  return speaker;
}

export function updateProjectSpeaker(project, identity, patch) {
  const speaker = table(project).find(entry => entry.id === identity);
  if (!speaker) throw new Error('Unknown project speaker');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)
      || Object.keys(patch).some(key => key !== 'name' && key !== 'color')) throw new Error('Only speaker name and color can be edited');
  const next = {
    ...(Object.hasOwn(patch, 'name') ? { name: checkName(patch.name) } : {}),
    ...(Object.hasOwn(patch, 'color') ? { color: checkColor(patch.color) } : {}),
  };
  const changed = Object.entries(next).some(([key, value]) => speaker[key] !== value);
  if (changed) Object.assign(speaker, next);
  return changed;
}

export function bindProjectSpeakerShortcut(project, slot, identity) {
  const key = validSlot(slot);
  if (identity !== null && !table(project).some(speaker => speaker.id === identity)) throw new Error('Unknown project speaker');
  const current = project.speaker_shortcuts?.[key] ?? null;
  if (current === identity) return false;
  if (identity === null) delete project.speaker_shortcuts[key];
  else {
    project.speaker_shortcuts ||= {};
    project.speaker_shortcuts[key] = identity;
  }
  return true;
}

export function setProjectAnnotationMode(project, mode) {
  if (mode !== 'speaker' && mode !== 'color') throw new Error('Annotation mode must be speaker or color');
  if ((project.annotation_mode ?? 'color') === mode) return false;
  project.annotation_mode = mode;
  return true;
}

export function setProjectPaletteSize(project, size) {
  if (size !== 5 && size !== 9) throw new Error('Palette size must be 5 or 9');
  if ((project.palette_size ?? 5) === size) return false;
  project.palette_size = size;
  return true;
}

/** @param {{ color?: string }} [options] */
export function assignProjectSpeakerShortcut(project, refs, slot, options = {}) {
  const { color } = options;
  validSlot(slot);
  if (slot > (project.palette_size === 9 ? 9 : 5) || !refs.length) return false;
  // Validate every target before creating an identity or changing a shortcut.
  for (const ref of refs) {
    if (!project.tracks.some(track => track.id === ref.track_id && track.segments.some(segment => segment.id === ref.segment_id))) {
      throw new Error('Unknown subtitle reference');
    }
  }
  let identity = project.speaker_shortcuts?.[String(slot)];
  let created = false;
  if (!identity) {
    identity = createProjectSpeaker(project, { slot, color }).id;
    created = true;
  }
  return assignProjectSpeaker(project, refs, identity) || created;
}
