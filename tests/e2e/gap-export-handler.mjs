import { initModuleSource } from '../helpers/init-module-source.mjs';

const source = initModuleSource('editor/io/editor-wiring-export-actions.js');
const start = source.indexOf("document.getElementById('download-gap-removed-video')");
const end = source.indexOf("document.getElementById('download-gap-removed-regions-json')", start);
if (start < 0 || end <= start) throw new Error('Video export handler not found');

export const handler = `let activeGapRemovedVideoTask;\n${source.slice(start, end)}`;
