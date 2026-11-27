// The local renderer embeds the palette from maw/colors.py as JSON.
const data = typeof document === 'undefined' ? null : document.getElementById?.('maw-editor-palette');
const text = data?.textContent;
export const ASR_EDITOR_PALETTE = typeof text === 'string' && text.trim() ? JSON.parse(text) : null;
