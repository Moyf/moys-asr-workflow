import { createUtilsModule } from '../../web/shared/utils/project-tracks.js';

export const projectModel = createUtilsModule();

// Arrange a canonical runtime tree while preserving supplied array/entity
// identity. Deliberately invalid timings remain available to repair/export tests;
// this fixture builder is not an import or validation substitute.
export function runtimeProject(main = [], { overlay = null, extensions = [], ...fields } = {}) {
  const track = (role, options, index = 0) => {
    const id = options.id ?? (role === 'secondary' ? `extension-${index + 1}` : role);
    const segments = options.segments ?? [];
    segments.forEach((segment, cueIndex) => {
      const defaults = { id: `${id}-cue-${cueIndex + 1}`, start: cueIndex * 1000,
        end: (cueIndex + 1) * 1000, text: '' };
      for (const [key, value] of Object.entries(defaults)) if (!Object.hasOwn(segment, key)) segment[key] = value;
    });
    return { name: role === 'main' ? '主字幕' : role === 'overlay' ? '叠加字幕' : '副字幕',
      enabled: true, ...options, id, role, segments };
  };
  const tracks = [track('main', { segments: main }),
    ...(overlay ? [track('overlay', overlay)] : []), ...extensions.map((options, index) => track('secondary', options, index))];
  return { ...fields, schema: projectModel.PROJECT_TRACKS_SCHEMA, tracks,
    bilingual: fields.bilingual ?? { display_mode: 'both', ...(extensions.length ? { active_track_id: tracks.find(value => value.role === 'secondary').id } : {}) },
    bindings: fields.bindings ?? [], subtitle_groups: fields.subtitle_groups ?? { next_id: 1, color: [], sticker: [] } };
}
