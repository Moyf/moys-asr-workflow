import { validateProjectSpeakers } from './speaker-identity.js';

// Importing a subtitle track is a new source, even when its speaker IDs, names
// and colours happen to match people already registered in this project.
// Prepare everything off-project so rejected imports cannot partially register
// identities. The caller installs the result inside its normal undo command.
export function prepareImportedSpeakerIdentities(targetProject, sourceSpeakers, sourceSegments) {
  const clone = value => JSON.parse(JSON.stringify(value));
  const source = {
    speakers: sourceSpeakers === undefined ? [] : sourceSpeakers,
    tracks: [{ segments: sourceSegments }],
  };
  const target = { ...targetProject, speakers: targetProject.speakers === undefined ? [] : targetProject.speakers };
  const issues = [...validateProjectSpeakers(target), ...validateProjectSpeakers(source)];
  if (issues.length) throw new Error(issues.map(issue => `${issue.path}: ${issue.message}`).join('; '));

  const speakers = clone(target.speakers);
  const segments = clone(sourceSegments);
  const bySourceId = new Map(source.speakers.map(speaker => [speaker.id, speaker]));
  const usedIds = new Set(speakers.map(speaker => speaker.id));
  const sourceToTarget = new Map();
  let sequence = 1;
  for (const segment of segments) {
    if (segment.speaker == null) continue;
    if (!sourceToTarget.has(segment.speaker)) {
      let id;
      do { id = `spk-${String(sequence++).padStart(3, '0')}`; } while (usedIds.has(id));
      usedIds.add(id);
      speakers.push({ ...clone(bySourceId.get(segment.speaker)), id });
      sourceToTarget.set(segment.speaker, id);
    }
    segment.speaker = sourceToTarget.get(segment.speaker);
  }
  return { speakers, segments };
}
