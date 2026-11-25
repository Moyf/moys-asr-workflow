import { readFileSync } from 'node:fs';

const readOnly = [
  '$', 'L', 'S', 'addCard', 'applyFinish', 'attachImage', 'collectErrors', 'connectRepo',
  'dirtyVersions', 'editLocked', 'finishEditing', 'finishInProgress', 'isDirty', 'loadClText',
  'modal', 'renderPane', 'resolveConflictModal', 'resolvePasteCard', 'scheduleSplitPreview',
  'selectCard', 'selectSection', 'serializeCurrentDoc', 'showReconnectUi', 'tryReconnect',
];
const mutable = ['closeModal', 'readFileAt', 'toWebp', 'writeFileAt'];

export async function exposeChangelogFixture(page, url) {
  const script = readFileSync(new URL('../../tools/changelog-editor/editor-browser.js', import.meta.url), 'utf8');
  const boundary = '\n}\n  mountChangelogEditor(createChangelogLibrary());';
  if (!script.includes(boundary)) throw new Error('Changelog editor module entry not found');
  const getters = readOnly.map(name => `${JSON.stringify(name)}: {get: () => ${name}}`);
  const setters = mutable.map(name => `${name}: {get: () => ${name}, set: value => { ${name} = value; }}`);
  const instrumented = script.replace(boundary, () =>
    `\n  Object.defineProperties(window, {${[...getters, ...setters].join(',\n')}});` + boundary);
  await page.route(new URL('editor-browser.js', url).href, route =>
    route.fulfill({ contentType: 'text/javascript', body: instrumented }));
}
