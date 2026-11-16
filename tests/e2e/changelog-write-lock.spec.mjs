import {expect, test} from '@playwright/test';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// An alternate local page permits a frozen, file-backed negative control without
// replacing the working tree. All repository handles and writes remain in memory.
const editorUrl = pathToFileURL(resolve(process.env.MAW_CHANGELOG_TEST_PAGE || 'tools/changelog-editor/index.html')).href;
const backgroundIds = ['layout', 'topbar', 'restore-banner', 'lock-banner'];
const beforeLine = '- **Fixture** ： before';
const fixtureText = '## [未发布]\n\n### 提升\n\n- **Fixture** ： original\n\n## [1.2.0-beta.1]\n\n- **Other** ： unchanged\n';

async function openFixture(page, options = {}) {
  const evidence = {errors:[], remote:[]};
  page.on('pageerror', error => evidence.errors.push(error.message));
  page.on('request', request => {if (/^https?:/.test(request.url())) evidence.remote.push(request.url());});
  await page.route(/^https?:/, route => route.abort());
  await page.goto(editorUrl);
  await page.evaluate(async ({text, options}) => {
    localStorage.clear();
    const files = new Map([['CHANGELOG.md', text]]);
    function directory(parts = []) {
      return {
        name:'fixture',
        async getDirectoryHandle(name) {return directory([...parts, name]);},
        async getFileHandle(name, {create = false} = {}) {
          const path = [...parts, name].join('/');
          if (!create && !files.has(path)) throw new DOMException('Missing fixture file', 'NotFoundError');
          return {
            async getFile() {return new Blob([files.get(path)]);},
            async createWritable() {
              let pending;
              return {
                async write(blob) {pending = blob;},
                async close() {files.set(path, pending);},
              };
            },
          };
        },
      };
    }
    await connectRepo(directory());
    S.tab = 'edit'; renderPane();
    if (options.conflict) files.set('CHANGELOG.md', text + '\nExternal fixture edit\n');
    const f = window.writeFixture = {
      files, writes:[], committed:[], reads:[], gateStarted:false, completed:false,
      closeSnapshots:[], focusWhileInert:[], pickerCalls:0, conversions:0,
    };
    const gate = () => new Promise((resolve, reject) => {
      f.gateStarted = true;
      f.release = () => options.failure ? reject(new Error('Fixture ' + options.failure + ' failure')) : resolve();
    });
    const originalRead = readFileAt, originalWrite = writeFileAt;
    readFileAt = async parts => {
      const path = parts.join('/'); f.reads.push(path);
      if (options.gate === 'read' && !f.gateStarted && path === 'CHANGELOG.md') await gate();
      return originalRead(parts);
    };
    writeFileAt = async (parts, blob) => {
      const path = parts.join('/'); f.writes.push(path);
      const gated = options.sidefile ? path.startsWith('.artifacts/changelog-editor/manual-save/') : path === 'CHANGELOG.md';
      if (options.gate !== 'read' && gated) await gate();
      await originalWrite(parts, blob);
      f.committed.push({path, text:await blob.text()});
    };
    const originalClose = closeModal;
    closeModal = cancelled => {
      originalClose(cancelled);
      f.closeSnapshots.push({
        finishing:finishInProgress,
        locked:['layout', 'topbar', 'restore-banner', 'lock-banner'].every(id => document.getElementById(id).inert),
        backgroundFocused:Boolean(document.activeElement.closest('#layout,#topbar,#restore-banner,#lock-banner')),
      });
    };
    window.showDirectoryPicker = async () => {f.pickerCalls++; throw new Error('Fixture picker must not open');};
    document.addEventListener('focusin', event => {
      if (event.target.closest('[inert]')) f.focusWhileInert.push(event.target.id || event.target.tagName);
    });
  }, {text:fixtureText, options});
  await entryInput(page).fill(beforeLine);
  await expect(page.locator('#dirty-dot')).toBeVisible();
  await page.locator('#btn-finish').focus();
  return evidence;
}

const entryInput = page => page.locator('#cards .kind-entry textarea').first();

async function startFinish(page) {
  // Invoke applyFinish directly: no real picker, archive, download or disk write.
  return page.evaluate(() => {
    const f = window.writeFixture;
    f.finish = applyFinish(['未发布'], new Set()).then(() => {f.completed = true;});
    return {
      finishing:finishInProgress,
      locked:['layout', 'topbar', 'restore-banner', 'lock-banner'].every(id => document.getElementById(id).inert),
    };
  });
}

async function expectLocked(page) {
  for (const id of backgroundIds) await expect(page.locator('#' + id)).toHaveAttribute('inert', '');
  expect(await entryInput(page).evaluate(node => Boolean(node.closest('[inert]')))).toBe(true);
  for (const root of ['html', 'body']) {
    expect(await page.locator(root).evaluate(node => getComputedStyle(node).overflowY)).toBe('hidden');
  }
}

async function expectReleased(page, retained = []) {
  expect(await page.evaluate(() => finishInProgress)).toBe(false);
  await expect(page.locator('#mask')).not.toHaveClass('show');
  for (const id of backgroundIds) expect(await page.locator('#' + id).evaluate(node => node.inert)).toBe(retained.includes(id));
  expect(await page.evaluate(() => window.writeFixture.focusWhileInert)).toEqual([]);
}

async function releaseGate(page) {
  await page.evaluate(() => window.writeFixture.release());
  await expect.poll(() => page.evaluate(() => window.writeFixture.completed)).toBe(true);
}

async function expectNoExternalAccess(evidence) {
  expect(evidence.errors).toEqual([]);
  expect(evidence.remote).toEqual([]);
}

test('write await blocks real textarea input, repeated finish, refresh, repository and version controls', async ({page}) => {
  const evidence = await openFixture(page);
  const initial = await startFinish(page);
  await expect.poll(() => page.evaluate(() => window.writeFixture.gateStarted)).toBe(true);
  // Try the real browser editing path before checking the lock marker. This also
  // makes the frozen-page negative control fail on actual mutation, not just CSS.
  const input = entryInput(page);
  await input.click({force:true});
  await page.keyboard.press('End');
  await page.keyboard.type(' typed-during-write');
  await input.fill('typed-during-write', {timeout:500}).catch(error => {
    if (!error.message.includes('Timeout')) throw error;
  });
  await expect(input).toHaveValue(beforeLine);
  expect(initial).toEqual({finishing:true, locked:true});
  await expectLocked(page);
  await page.keyboard.press('Enter');
  await page.evaluate(async () => {
    await applyFinish(['未发布'], new Set());
    await finishEditing();
  });
  for (const selector of ['#btn-reload-cl', '#btn-open', '.version-item:last-child']) {
    await page.locator(selector).click({force:true});
  }
  expect(await page.evaluate(() => ({selected:S.selected, picker:window.writeFixture.pickerCalls})))
    .toEqual({selected:'未发布', picker:0});
  expect(await page.evaluate(() => window.writeFixture.writes.filter(path => path === 'CHANGELOG.md').length)).toBe(1);
  await releaseGate(page);
  const saved = await page.evaluate(async () => ({
    text:await window.writeFixture.files.get('CHANGELOG.md').text(),
    document:serializeCurrentDoc(), clean:!isDirty(),
  }));
  expect(saved.text).toContain(beforeLine);
  expect(saved.text).not.toContain('typed-during-write');
  expect(saved.document).toBe(saved.text); expect(saved.clean).toBe(true);
  await expect(page.locator('#modal h3')).toContainText('完成编辑');
  await expectLocked(page);
  await page.getByRole('button', {name:'好', exact:true}).click();
  await expectReleased(page);
  await expect(page.locator('#btn-finish')).toBeFocused();
  await expect(entryInput(page)).toHaveValue(beforeLine);
  await expectNoExternalAccess(evidence);
});

test('finish locks synchronously before the first read await and releases after conflict cancellation', async ({page}) => {
  const evidence = await openFixture(page, {gate:'read', conflict:true});
  expect(await startFinish(page)).toEqual({finishing:true, locked:true});
  await expectLocked(page);
  await page.evaluate(() => window.writeFixture.release());
  await expect(page.locator('#cf-cancel')).toBeVisible();
  await page.locator('#cf-cancel').click();
  await expect.poll(() => page.evaluate(() => window.writeFixture.completed)).toBe(true);
  expect(await page.evaluate(() => window.writeFixture.writes)).toEqual([]);
  await expectReleased(page);
  await expect(entryInput(page)).toHaveValue(beforeLine);
  await expect(page.locator('#btn-finish')).toBeFocused();
  await expectNoExternalAccess(evidence);
});

test('closing the conflict dialog for overwrite keeps the write phase locked and preserves focus and root styles', async ({page}) => {
  const evidence = await openFixture(page, {conflict:true});
  const styles = () => page.evaluate(() => [document.documentElement, document.body].map(node =>
    ['overflow-x', 'overflow-y'].map(property => [node.style.getPropertyValue(property), node.style.getPropertyPriority(property)])));
  await page.evaluate(() => {
    document.documentElement.style.setProperty('overflow', 'scroll', 'important');
    document.body.style.setProperty('overflow-x', 'clip');
    document.body.style.setProperty('overflow-y', 'auto', 'important');
    document.getElementById('lock-banner').inert = true;
  });
  const beforeStyles = await styles();
  await startFinish(page);
  await expect(page.locator('#cf-force')).toBeVisible();
  await expectLocked(page);
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press(i % 2 ? 'Shift+Tab' : 'Tab');
    expect(await page.evaluate(() => document.getElementById('modal').contains(document.activeElement))).toBe(true);
  }
  await page.locator('#cf-force').click();
  await expect.poll(() => page.evaluate(() => window.writeFixture.gateStarted)).toBe(true);
  await expect(page.locator('#mask')).not.toHaveClass('show');
  expect(await page.evaluate(() => window.writeFixture.closeSnapshots[0]))
    .toEqual({finishing:true, locked:true, backgroundFocused:false});
  await expectLocked(page);
  await releaseGate(page);
  await expectLocked(page);
  // Replacing the completion dialog must not replace its original return target
  // with the now-hidden conflict button or overwrite the lock's saved styles.
  await page.evaluate(() => modal('<h3>Fixture nested confirmation</h3><button onclick="closeModal(true)">Done</button>'));
  await page.getByRole('button', {name:'Done', exact:true}).click();
  await expectReleased(page, ['lock-banner']);
  expect(await styles()).toEqual(beforeStyles);
  await expect(page.locator('#btn-finish')).toBeFocused();
  await expectNoExternalAccess(evidence);
});

test('closing the conflict dialog for a side file keeps the background locked and the saved edit dirty', async ({page}) => {
  const evidence = await openFixture(page, {conflict:true, sidefile:true});
  const diskText = await page.evaluate(() => window.writeFixture.files.get('CHANGELOG.md'));
  await startFinish(page);
  await expect(page.locator('#cf-side')).toBeVisible();
  await page.locator('#cf-side').click();
  await expect.poll(() => page.evaluate(() => window.writeFixture.gateStarted)).toBe(true);
  await expect(page.locator('#mask')).not.toHaveClass('show');
  await expectLocked(page);
  expect(await page.evaluate(() => window.writeFixture.closeSnapshots[0]))
    .toEqual({finishing:true, locked:true, backgroundFocused:false});
  await releaseGate(page);
  await expectLocked(page);
  const result = await page.evaluate(() => ({
    disk:window.writeFixture.files.get('CHANGELOG.md'),
    side:window.writeFixture.committed.find(item => item.path.startsWith('.artifacts/changelog-editor/manual-save/')).text,
    document:serializeCurrentDoc(), dirty:isDirty(),
    clWrites:window.writeFixture.writes.filter(path => path === 'CHANGELOG.md').length,
  }));
  expect(result.disk).toBe(diskText); expect(result.clWrites).toBe(0);
  expect(result.side).toContain(beforeLine); expect(result.document).toBe(result.side);
  expect(result.dirty).toBe(true);
  await page.getByRole('button', {name:'好', exact:true}).click();
  await expectReleased(page);
  await expect(page.locator('#btn-finish')).toBeFocused();
  await expectNoExternalAccess(evidence);
});

for (const cancel of ['button', 'Escape', 'backdrop']) {
  test(`conflict ${cancel} cancellation performs zero writes and restores editing`, async ({page}) => {
    const evidence = await openFixture(page, {conflict:true});
    await startFinish(page);
    await expect(page.locator('#cf-cancel')).toBeVisible();
    await expectLocked(page);
    if (cancel === 'button') await page.locator('#cf-cancel').click();
    else if (cancel === 'Escape') await page.keyboard.press('Escape');
    else await page.mouse.click(2, 2);
    await expect.poll(() => page.evaluate(() => window.writeFixture.completed)).toBe(true);
    expect(await page.evaluate(() => window.writeFixture.writes)).toEqual([]);
    expect(await page.evaluate(() => window.writeFixture.closeSnapshots[0]))
      .toEqual({finishing:true, locked:true, backgroundFocused:false});
    await expectReleased(page);
    await expect(page.locator('#btn-finish')).toBeFocused();
    await entryInput(page).fill(beforeLine + ' resumed');
    await expect(entryInput(page)).toHaveValue(beforeLine + ' resumed');
    await expectNoExternalAccess(evidence);
  });
}

for (const failure of ['read', 'write']) {
  test(`${failure} exception ends finish but keeps the error dialog locked until dismissed`, async ({page}) => {
    const evidence = await openFixture(page, {gate:failure, failure});
    await startFinish(page);
    await expect.poll(() => page.evaluate(() => window.writeFixture.gateStarted)).toBe(true);
    await expectLocked(page);
    await releaseGate(page);
    expect(await page.evaluate(() => finishInProgress)).toBe(false);
    await expect(page.locator('#modal')).toContainText('Fixture ' + failure + ' failure');
    await expectLocked(page);
    expect(await page.evaluate(() => window.writeFixture.committed.filter(item => item.path === 'CHANGELOG.md'))).toEqual([]);
    if (failure === 'read') expect(await page.evaluate(() => window.writeFixture.writes)).toEqual([]);
    await page.getByRole('button', {name:'知道了', exact:true}).click();
    await expectReleased(page);
    await expect(page.locator('#btn-finish')).toBeFocused();
    await expect(entryInput(page)).toHaveValue(beforeLine);
    expect(await page.evaluate(() => isDirty())).toBe(true);
    await expectNoExternalAccess(evidence);
  });
}

test('write phase rejects attachment and document paste without replacing the live textarea', async ({page}) => {
  const evidence = await openFixture(page);
  await startFinish(page);
  await expect.poll(() => page.evaluate(() => window.writeFixture.gateStarted)).toBe(true);
  const result = await page.evaluate(async () => {
    const f = window.writeFixture, original = toWebp;
    const input = document.querySelector('#cards .kind-entry textarea');
    toWebp = async () => {f.conversions++; return {blob:new Blob(['png']), filename:'fixture.png', size:3};};
    try {
      const parsed = S.parsed.get(S.selected), card = parsed.cards.find(card => card.kind === 'entry');
      await attachImage(card, parsed.cards.indexOf(card), new File(['png'], 'fixture.png', {type:'image/png'}));
      const data = new DataTransfer(); data.items.add(new File(['png'], 'fixture.png', {type:'image/png'}));
      document.dispatchEvent(new ClipboardEvent('paste', {bubbles:true, clipboardData:data}));
      await Promise.resolve();
      return {images:S.images.size, conversions:f.conversions, sameInput:input === document.querySelector('#cards .kind-entry textarea')};
    } finally {toWebp = original;}
  });
  expect(result).toEqual({images:0, conversions:0, sameInput:true});
  await releaseGate(page);
  await page.keyboard.press('Escape');
  await expectReleased(page);
  await expectNoExternalAccess(evidence);
});

test('a conversion started before finish cannot attach after cancellation returns to the same card', async ({page}) => {
  const evidence = await openFixture(page, {conflict:true});
  await page.evaluate(() => {
    const f = window.writeFixture, parsed = S.parsed.get(S.selected);
    f.card = parsed.cards.find(card => card.kind === 'entry'); f.originalConversion = toWebp;
    toWebp = () => new Promise(resolve => {f.releaseConversion = resolve;});
    f.attachment = attachImage(f.card, parsed.cards.indexOf(f.card), new File(['png'], 'fixture.png', {type:'image/png'}));
  });
  await startFinish(page);
  await expect(page.locator('#cf-cancel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.writeFixture.completed)).toBe(true);
  await expectReleased(page);
  const result = await page.evaluate(async () => {
    const f = window.writeFixture;
    try {
      f.releaseConversion({blob:new Blob(['png']), filename:'fixture.png', size:3});
      await f.attachment;
      return {images:S.images.size, refs:f.card.images?.length || 0, sameCard:S.parsed.get(S.selected).cards.includes(f.card)};
    } finally {toWebp = f.originalConversion;}
  });
  expect(result).toEqual({images:0, refs:0, sameCard:true});
  expect(await page.evaluate(() => window.writeFixture.writes)).toEqual([]);
  await expectNoExternalAccess(evidence);
});

test('batch confirmation cancellation never starts finish or writes', async ({page}) => {
  const evidence = await openFixture(page);
  await page.evaluate(() => {
    const other = S.parsed.get('1.2.0-beta.1').cards.find(card => card.kind === 'entry');
    other.lines[0] += ' edited';
    return finishEditing();
  });
  await expect(page.locator('#btn-batch-go')).toBeVisible();
  expect(await page.evaluate(() => finishInProgress)).toBe(false);
  await expectLocked(page);
  await page.getByRole('button', {name:'取消', exact:true}).click();
  await expectReleased(page);
  expect(await page.evaluate(() => window.writeFixture.writes)).toEqual([]);
  await expect(page.locator('#btn-finish')).toBeFocused();
  await expect(entryInput(page)).toHaveValue(beforeLine);
  await expectNoExternalAccess(evidence);
});

test('dismissing a modal does not focus a return target inside a pre-existing inert region', async ({page}) => {
  const evidence = await openFixture(page);
  await page.evaluate(() => {
    document.getElementById('topbar').inert = true;
    modal('<h3>Fixture confirmation</h3><button onclick="closeModal(true)">Done</button>');
  });
  await expectLocked(page);
  await page.getByRole('button', {name:'Done', exact:true}).click();
  await expectReleased(page, ['topbar']);
  await expect(page.locator('#btn-finish')).not.toBeFocused();
  expect(await page.evaluate(() => window.writeFixture.writes)).toEqual([]);
  await expectNoExternalAccess(evidence);
});
