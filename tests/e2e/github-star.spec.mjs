import { expect, test } from '@playwright/test';
import { cleanupTempDir, disableOnboarding, findFreePort, makeTempDir, startBlankServer } from './helpers.mjs';
import { completeStaticLauncherDiscovery } from './launcher-ready.mjs';

const repository = 'https://github.com/Moyf/moys-asr-workflow';
const launcher = new URL('../../web/launcher/index.html', import.meta.url).href;

test('Launcher only writes on click and keeps the repository link', async ({ page }, testInfo) => {
  await page.goto(launcher);
  await completeStaticLauncherDiscovery(page);
  const config = await page.evaluate(() => window.MAWLauncher.config);
  await page.addInitScript(config => {
    window.starCalls = [];
    window.pywebview = { api: {
      get_config: async () => config,
      github_star_status: async () => { window.starCalls.push('check'); return { starred: false }; },
      github_star: async () => { window.starCalls.push('write'); return { starred: true }; },
    } };
  }, config);
  await page.reload();
  await completeStaticLauncherDiscovery(page);
  const dialog = page.locator('#supportModal');
  await expect(page.locator('#homeLink')).toBeVisible();
  await page.locator('#supportLink').click();
  const star = dialog.getByRole('button', { name: '⭐️ 一键加星', exact: true });
  await expect(star).toBeVisible();
  await expect(dialog.getByRole('link')).toHaveCount(0);
  expect(await page.evaluate(() => window.starCalls)).toEqual(['check']);
  expect(await dialog.locator('.support-github').evaluate(el => el.getBoundingClientRect().top
    - el.previousElementSibling.getBoundingClientRect().bottom)).toBeGreaterThanOrEqual(8);
  await dialog.locator('.support-card').screenshot({ path: testInfo.outputPath('launcher-github-star.png') });
  await star.focus();
  await star.press('Enter');
  await expect(dialog.getByRole('status')).toHaveText('⭐️ 感谢你的星星！');
  await expect(dialog.getByRole('status')).toBeFocused();
  await expect(star).toBeHidden();
  expect(await page.evaluate(() => window.starCalls)).toEqual(['check', 'write']);
});

test('Launcher shows the English star labels', async ({ page }) => {
  await page.goto(launcher);
  await completeStaticLauncherDiscovery(page);
  const config = await page.evaluate(() => window.MAWLauncher.config);
  await page.addInitScript(config => {
    window.starCalls = [];
    window.pywebview = { api: {
      get_config: async () => config,
      github_star_status: async () => { window.starCalls.push('check'); return { starred: false }; },
      github_star: async () => { window.starCalls.push('write'); return { starred: true }; },
    } };
  }, { ...config, guiLang: 'en' });
  await page.reload();
  await completeStaticLauncherDiscovery(page);
  const dialog = page.locator('#supportModal');
  await page.locator('#supportLink').click();
  const star = dialog.getByRole('button', { name: '⭐️ Star', exact: true });
  await expect(star).toBeVisible();
  await star.click();
  await expect(dialog.getByRole('status')).toHaveText('⭐️ Thanks!');
  await expect(star).toBeHidden();
  expect(await page.evaluate(() => window.starCalls)).toEqual(['check', 'write']);
});

test('Launcher hides the support actions while gh is unavailable', async ({ page }, testInfo) => {
  await page.goto(launcher);
  await completeStaticLauncherDiscovery(page);
  const config = await page.evaluate(() => window.MAWLauncher.config);
  await page.addInitScript(config => {
    window.starCalls = [];
    window.pywebview = { api: {
      get_config: async () => config,
      // gh 缺失或探测失败：status 与写入都给不出结论（starred: null）。
      github_star_status: async () => { window.starCalls.push('check'); return { starred: null }; },
      github_star: async () => { window.starCalls.push('write'); return { starred: null }; },
    } };
  }, config);
  await page.reload();
  await completeStaticLauncherDiscovery(page);
  const dialog = page.locator('#supportModal');
  await expect(page.locator('#homeLink')).toBeVisible();
  await page.locator('#supportLink').click();
  await expect.poll(() => page.evaluate(() => window.starCalls)).toEqual(['check']);
  await expect(dialog.getByRole('link')).toHaveCount(0);
  await expect(dialog.locator('#supportGitHubActions')).toBeHidden();
  await dialog.locator('.support-card').screenshot({ path: testInfo.outputPath('launcher-github-unavailable.png') });
});

test('Editor keeps repository navigation and star write separate, with thanks only when confirmed', async ({ page }, testInfo) => {
  const dir = makeTempDir('github-star');
  let server;
  try {
    server = await startBlankServer(await findFreePort(), dir);
    await disableOnboarding(page);
    const calls = [];
    let alreadyStarred = false;
    await page.route('**/api/github-star**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      calls.push([request.method(), path]);
      await route.fulfill({ json: { starred: path.endsWith('/status') ? alreadyStarred : null } });
    });
    const about = page.locator('#editor-settings-page-about');
    const showAbout = async () => {
      await page.goto(server.url);
      await page.locator('#editor-settings-toggle').click();
      await page.locator('#editor-settings-tab-about').click();
    };
    await showAbout();
    const star = about.getByRole('button', { name: '星标 ⭐️ 一键加星', exact: true });
    const link = about.getByRole('link', { name: 'GitHub 仓库' });
    const starEntry = about.locator('#editor-about-github-star-entry');
    const thanks = about.locator('#editor-about-github-thanks');
    await expect(star).toBeVisible();
    await expect(link).toHaveAttribute('href', repository);
    expect(calls).toEqual([['POST', '/api/github-star/status']]);
    const row = link;
    expect(await starEntry.evaluate(el => el.getBoundingClientRect().top
      - el.previousElementSibling.getBoundingClientRect().bottom)).toBeGreaterThanOrEqual(8);
    await about.locator('.editor-settings-about-grid').last()
      .screenshot({ path: testInfo.outputPath('editor-github-star.png') });

    // 仓库入口整行是链接：点击左侧标签处只打开仓库，不产生星标请求。
    await page.context().route(repository, route => route.fulfill({ body: 'Mock GitHub repository' }));
    const pagesBefore = page.context().pages().length;
    const [rowPopup] = await Promise.all([
      page.waitForEvent('popup'),
      row.click({ position: { x: 12, y: 12 } }),
    ]);
    await expect(rowPopup).toHaveURL(repository);
    await rowPopup.close();
    expect(calls).toEqual([['POST', '/api/github-star/status']]);
    expect(page.context().pages().length).toBe(pagesBefore);

    // 点击星标入口的左侧留白也只加星：写入失败回落后不打开任何仓库页。
    await star.click({ position: { x: 5, y: 5 } });
    await expect(starEntry).toBeHidden();
    await expect(link).toBeVisible();
    expect(calls.at(-1)).toEqual(['POST', '/api/github-star']);
    expect(page.context().pages().length).toBe(pagesBefore);

    const [popup] = await Promise.all([page.waitForEvent('popup'), link.click()]);
    await expect(popup).toHaveURL(repository);
    await popup.close();
    await expect(thanks).toBeHidden();
    expect(calls).toEqual([['POST', '/api/github-star/status'], ['POST', '/api/github-star']]);

    alreadyStarred = true;
    await showAbout();
    await expect(thanks).toBeVisible();
    await expect(thanks.locator('.editor-settings-about-action')).toHaveText('⭐️ 感谢你的星星！');
    await expect(star).toBeHidden();
    await expect(link).toBeVisible();
    expect(calls).toEqual([
      ['POST', '/api/github-star/status'], ['POST', '/api/github-star'], ['POST', '/api/github-star/status'],
    ]);

    // 已加星：点击入口的左侧留白或按 Enter 都不会打开仓库或产生新请求。
    await thanks.click({ position: { x: 5, y: 5 } });
    await thanks.press('Enter');
    expect(page.context().pages().length).toBe(pagesBefore);
    expect(calls).toEqual([
      ['POST', '/api/github-star/status'], ['POST', '/api/github-star'], ['POST', '/api/github-star/status'],
    ]);

    // 键盘：Tab 聚焦仓库链接，整行焦点框与相邻入口一致，Enter 原生打开仓库。
    await about.locator('a.editor-settings-about-entry').nth(1).evaluate(el => el.focus());
    for (let count = 0; count < 10; count += 1) {
      if (await link.evaluate(el => el === document.activeElement)) break;
      await page.keyboard.press('Tab');
    }
    await expect(link).toBeFocused();
    const rowOutline = await row.evaluate(el => {
      const style = getComputedStyle(el);
      return `${style.outlineStyle}|${style.outlineWidth}|${style.outlineOffset}`;
    });
    await page.keyboard.press('Shift+Tab');
    const siblingOutline = await page.evaluate(() => {
      const style = getComputedStyle(document.activeElement);
      return `${style.outlineStyle}|${style.outlineWidth}|${style.outlineOffset}`;
    });
    expect(rowOutline).toBe(siblingOutline);
    await page.keyboard.press('Tab');
    await expect(link).toBeFocused();
    const [enterPopup] = await Promise.all([
      page.waitForEvent('popup'),
      page.keyboard.press('Enter'),
    ]);
    await expect(enterPopup).toHaveURL(repository);
    await enterPopup.close();
    expect(calls).toEqual([
      ['POST', '/api/github-star/status'], ['POST', '/api/github-star'], ['POST', '/api/github-star/status'],
    ]);
  } finally {
    try { await server?.stop(); } finally { cleanupTempDir(dir); }
  }
});

test('Editor shows the English star labels', async ({ page }) => {
  const dir = makeTempDir('github-star-en');
  let server;
  try {
    server = await startBlankServer(await findFreePort(), dir);
    await page.addInitScript(() => localStorage.setItem('mawe.language', 'en'));
    await disableOnboarding(page);
    let alreadyStarred = false;
    let writeResult = true;
    await page.route('**/api/github-star**', async route => {
      const path = new URL(route.request().url()).pathname;
      await route.fulfill({ json: { starred: path.endsWith('/status') ? alreadyStarred : writeResult } });
    });
    const about = page.locator('#editor-settings-page-about');
    const showAbout = async () => {
      await page.goto(server.url);
      await page.locator('#editor-settings-toggle').click();
      await page.locator('#editor-settings-tab-about').click();
    };
    await showAbout();
    const star = about.getByRole('button', { name: 'Star ⭐️ Add Star', exact: true });
    const link = about.getByRole('link', { name: 'GitHub repository' });
    const thanks = about.locator('#editor-about-github-thanks');
    await expect(star).toBeVisible();
    await expect(link).toHaveAttribute('href', repository);
    await star.focus();
    await star.press('Enter');
    await expect(star).toBeHidden();
    await expect(thanks.locator('.editor-settings-about-action')).toHaveText('⭐️ Thanks!');
    await expect(thanks).toBeFocused();
    await expect(link).toBeVisible();

    writeResult = null;
    await showAbout();
    await expect(star).toBeVisible();
    await star.focus();
    await star.press('Enter');
    await expect(star).toBeHidden();
    await expect(thanks).toBeHidden();
    await expect(link).toBeFocused();

    alreadyStarred = true;
    await showAbout();
    await expect(thanks).toBeVisible();
    await expect(thanks.locator('.editor-settings-about-action')).toHaveText('⭐️ Thanks!');
    await expect(star).toBeHidden();
  } finally {
    try { await server?.stop(); } finally { cleanupTempDir(dir); }
  }
});

test('Editor keeps only the repository link while gh is unavailable', async ({ page }, testInfo) => {
  const dir = makeTempDir('github-star-unavailable');
  let server;
  try {
    server = await startBlankServer(await findFreePort(), dir);
    await disableOnboarding(page);
    const calls = [];
    await page.route('**/api/github-star**', async route => {
      const request = route.request();
      calls.push([request.method(), new URL(request.url()).pathname]);
      // gh 缺失或探测失败：status 与写入都给不出结论（starred: null）。
      await route.fulfill({ json: { starred: null } });
    });
    const about = page.locator('#editor-settings-page-about');
    await page.goto(server.url);
    await page.locator('#editor-settings-toggle').click();
    // 以响应送达为同步点：探测失败后按钮不再出现，属于终态而非进行中。
    const statusDelivered = page.waitForResponse(response => response.url().endsWith('/api/github-star/status'));
    await page.locator('#editor-settings-tab-about').click();
    await statusDelivered;
    const link = about.getByRole('link', { name: 'GitHub 仓库' });
    await expect(link).toBeVisible();
    await expect(about.locator('#editor-about-github-star-entry')).toBeHidden();
    expect(calls).toEqual([['POST', '/api/github-star/status']]);
    const row = link;
    await about.locator('.editor-settings-about-grid').last()
      .screenshot({ path: testInfo.outputPath('editor-github-unavailable.png') });

    // 无按钮状态下整行仍是链接行：悬停表现与相邻入口一致（背景与边框同色）。
    const sibling = about.locator('a.editor-settings-about-entry').nth(1);
    const paint = el => {
      const style = getComputedStyle(el);
      return `${style.backgroundColor}|${style.borderTopColor}`;
    };
    const settleHover = () => page.evaluate(() => {
      // 悬停背景带过渡动画：收尾所有有限动画后再读取，避免读到中间帧。
      for (const animation of document.getAnimations({ subtree: true })) {
        try { animation.finish(); } catch { /* 无限动画无法收尾，跳过 */ }
      }
    });
    const rowIdle = await row.evaluate(paint);
    await row.hover({ position: { x: 12, y: 12 } });
    await settleHover();
    const rowHovered = await row.evaluate(paint);
    await sibling.hover();
    await settleHover();
    const siblingHovered = await sibling.evaluate(paint);
    expect(rowHovered).toBe(siblingHovered);
    expect(rowHovered).not.toBe(rowIdle);

    // 整行点击仍打开仓库，且不产生新的星标探测。
    await page.context().route(repository, route => route.fulfill({ body: 'Mock GitHub repository' }));
    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      row.click({ position: { x: 12, y: 12 } }),
    ]);
    await expect(popup).toHaveURL(repository);
    await popup.close();
    expect(calls).toEqual([['POST', '/api/github-star/status']]);
  } finally {
    try { await server?.stop(); } finally { cleanupTempDir(dir); }
  }
});

test('Editor About credits footer shows one line per active language', async ({ page }) => {
  const dir = makeTempDir('about-credits');
  let server;
  try {
    server = await startBlankServer(await findFreePort(), dir);
    await disableOnboarding(page);
    // 星标探测同样走 mock：不触发真实 gh，也不影响署名行断言焦点。
    await page.route('**/api/github-star**', route => route.fulfill({ json: { starred: false } }));
    const credits = page.locator('.editor-settings-about-credits p');
    await page.goto(server.url);
    await page.locator('#editor-settings-toggle').click();
    await page.locator('#editor-settings-tab-about').click();
    await expect(credits).toHaveText('来自 Moy 的用爱发电 ❤️');
    await page.evaluate(() => MAWE_I18N.applyLanguage('en'));
    await expect(credits).toHaveText('Made with love by Moy ❤️');
    await page.evaluate(() => MAWE_I18N.applyLanguage('zh'));
    await expect(credits).toHaveText('来自 Moy 的用爱发电 ❤️');
  } finally {
    try { await server?.stop(); } finally { cleanupTempDir(dir); }
  }
});
