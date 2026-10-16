const TEXT_INPUT_TYPES = new Set([
  'text', 'search', 'email', 'url', 'tel', 'password', 'number',
]);

export { TEXT_INPUT_TYPES };

export function isTextEditingTarget(event) {
  const target = event.target;
  const active = document.activeElement;
  if (target?.isContentEditable || active?.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || active instanceof HTMLTextAreaElement) return true;

  const input = target instanceof HTMLInputElement
    ? target
    : active instanceof HTMLInputElement ? active : null;
  if (!input) return false;
  return TEXT_INPUT_TYPES.has(input.type);
}
