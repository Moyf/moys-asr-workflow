import {test, expect} from '@playwright/test';
import {fileURLToPath, pathToFileURL} from 'node:url';

const launcherUrl = pathToFileURL(fileURLToPath(new URL('../../web/launcher/index.html', import.meta.url))).href;
const projects = [
  {path: 'D:/Demo/current.mosp', name: '当前工程.mosp'},
  {path: 'D:/Demo/missing.mosp', name: '已移动工程.mosp', exists: false},
];

async function openLauncher(page, entries = projects) {
  await page.goto(launcherUrl);
  await page.waitForFunction(() => window.MAWLauncher?.config?.postprocessProviders?.length > 0);
  const config = await page.evaluate(() => window.MAWLauncher.config);
  await page.addInitScript(({config, entries}) => {
    window.__recentProjects = entries;
    window.__recentReads = 0;
    window.__statusReads = 0;
    window.__projectReady = false;
    window.__serverStarted = false;
    window.__mediaChecks = [];
    window.pywebview = {api: new Proxy({}, {get: (_target, method) => method === 'then' ? undefined : async payload => {
      if (method === 'get_config') return config;
      if (method === 'recent_projects') {
        window.__recentReads++;
        return {ok: true, projects: window.__recentProjects};
      }
      if (method === 'check_server_media') {
        window.__mediaChecks.push(payload.jsonPath);
        const exists = !payload.jsonPath.includes('missing');
        return {ok: exists, hasMedia: exists, mediaExists: exists};
      }
      if (method === 'get_server_status') {
        window.__statusReads++;
        return {ok: true, running: window.__serverStarted, url: 'http://127.0.0.1:8250/', pid: 123,
          startupStatus: window.__projectReady ? 'ready' : 'loading'};
      }
      if (method === 'start_server') {
        window.__serverStarted = true;
        return {ok: true, url: 'http://127.0.0.1:8250/'};
      }
      return {ok: true};
    }})};
  }, {config, entries});
  await page.reload();
  await page.waitForFunction(() => document.body.classList.contains('launcher-ready'));
  await page.waitForFunction(() => window.__recentReads > 0);
}

test('recent projects select paths, check media and translate missing badges', async ({page}, testInfo) => {
  await openLauncher(page);
  const items = page.locator('#recentProjectsList button');
  await expect(items).toHaveCount(2);
  await items.first().click();
  await expect(page.locator('#jsonPath')).toHaveValue(projects[0].path);
  await expect(page.locator('#serverMediaField')).toBeHidden();
  await items.last().click();
  await expect(page.locator('#jsonPath')).toHaveValue(projects[1].path);
  await expect(page.locator('#serverMediaField')).toBeVisible();
  await expect(items.last()).toHaveClass(/is-missing/);
  await expect(items.last()).toContainText('已失效');
  expect(await page.evaluate(() => window.__mediaChecks)).toEqual(projects.map(item => item.path));
  const spacing = await page.locator('#recentProjectsField').evaluate(field => ({
    above: field.getBoundingClientRect().top - field.previousElementSibling.getBoundingClientRect().bottom,
    below: field.nextElementSibling.getBoundingClientRect().top - field.getBoundingClientRect().bottom,
  }));
  expect(spacing.above).toBeGreaterThanOrEqual(8);
  expect(spacing.below).toBeGreaterThanOrEqual(8);
  await testInfo.attach('recent-project-spacing', {body: JSON.stringify(spacing), contentType: 'application/json'});
  await page.locator('#serverCard').screenshot({path: testInfo.outputPath('recent-projects-zh.png')});
  await page.evaluate(() => document.getElementById('langEn').click());
  await expect(page.locator('.recent-projects-label')).toHaveText('Recent projects');
  await expect(items.last()).toContainText('Missing');
  await page.locator('#serverCard').screenshot({path: testInfo.outputPath('recent-projects-en.png')});
});

test('recent projects refresh after slow project readiness and when the launcher regains focus', async ({page}) => {
  await openLauncher(page);
  await page.locator('#recentProjectsList button').first().click();
  await page.locator('#openMawe').click();
  const before = await page.evaluate(() => window.__recentReads);
  await page.waitForFunction(() => window.__statusReads >= 3);
  expect(await page.evaluate(() => window.__recentReads)).toBe(before);
  await page.evaluate(() => {
    window.__recentProjects = [{path: 'D:/Demo/loaded.mosp', name: '后台加载完成.mosp'}];
    window.__projectReady = true;
  });
  await expect(page.locator('#recentProjectsList')).toContainText('后台加载完成.mosp');
  await page.evaluate(() => {
    window.__recentProjects = [{path: 'D:/Demo/editor-opened.mosp', name: '编辑器中打开.mosp'}];
    window.dispatchEvent(new Event('focus'));
  });
  await expect(page.locator('#recentProjectsList')).toContainText('编辑器中打开.mosp');
});

test('recent projects start collapsed, expand to the full history and can be collapsed again', async ({page}, testInfo) => {
  const entries = Array.from({length: 10}, (_, i) => ({path: `D:/Demo/project-${i + 1}.mosp`, name: `Project ${i + 1}`}));
  await openLauncher(page, entries);
  const list = page.locator('#recentProjectsList');
  const visibleItems = list.getByRole('button');
  const toggle = page.locator('#recentProjectsToggle');
  await expect(visibleItems).toHaveText(entries.slice(0, 3).map(item => item.name));
  await expect(toggle).toHaveText('显示更多');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const gap = await list.evaluate(el => el.getBoundingClientRect().top - el.previousElementSibling.getBoundingClientRect().bottom);
  expect(gap).toBeGreaterThanOrEqual(8);
  await page.locator('#serverCard').screenshot({path: testInfo.outputPath('recent-projects-collapsed.png')});
  await toggle.focus();
  await toggle.press('Enter');
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveText('收起');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(visibleItems).toHaveText(entries.map(item => item.name));
  await page.locator('#serverCard').screenshot({path: testInfo.outputPath('recent-projects-expanded.png')});
  await page.evaluate(() => {
    window.__recentProjects.at(-1).name = 'Refreshed project';
    window.dispatchEvent(new Event('focus'));
  });
  await expect(visibleItems.last()).toHaveText('Refreshed project');
  await expect(visibleItems).toHaveCount(10);
  await visibleItems.last().click();
  await expect(page.locator('#jsonPath')).toHaveValue(entries.at(-1).path);
  await page.evaluate(() => document.getElementById('langEn').click());
  await expect(toggle).toHaveText('Show less');
  await toggle.click();
  await expect(toggle).toHaveText('Show more');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(visibleItems).toHaveCount(3);
});

test('exactly three recent projects need no toggle', async ({page}) => {
  await openLauncher(page, [...projects, {path: 'D:/Demo/third.mosp', name: '第三个工程.mosp'}]);
  await expect(page.locator('#recentProjectsList').getByRole('button')).toHaveCount(3);
  await expect(page.locator('#recentProjectsToggle')).toBeHidden();
});

test('empty recent history hides the whole field', async ({page}) => {
  await openLauncher(page, []);
  await expect(page.locator('#recentProjectsField')).toBeHidden();
  await expect(page.locator('#recentProjectsList button')).toHaveCount(0);
});
