import {expect, test} from '@playwright/test';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readFileSync, writeFileSync} from 'node:fs';

const catalogUrl = pathToFileURL(resolve('tools/index.html')).href;
const docUrl = path => pathToFileURL(resolve('tools', path)).href;

// Optional read-only pre-fix snapshot for real negative controls. Never overwrite worktree source.
test.beforeEach(async ({page}) => {
  const snapshot = process.env.MAW_TOOL_MARKDOWN_SNAPSHOT;
  if (!snapshot) return;
  for (const name of ['markdown.js','markdown.css','doc-viewer.js','doc-viewer.css']) {
    await page.route(docUrl('shared/' + name), route => route.fulfill({
      contentType:name.endsWith('.js') ? 'text/javascript' : 'text/css',
      body:readFileSync(resolve(snapshot, name), 'utf8'),
    }));
  }
});

async function openCatalog(page) {
  const errors = [], remote = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {if (/^https?:/.test(request.url())) remote.push(request.url());});
  await page.route(/^https?:/, route => route.abort());
  await page.goto(catalogUrl);
  await expect(page.locator('.card')).toHaveCount(10);
  return {errors, remote};
}

async function showText(page, markdown, title = '测试说明') {
  return page.evaluate(({markdown, title, baseUrl}) => window.MAWToolDocViewer.open({
    title, path:'合成说明.md', markdown, baseUrl,
  }), {markdown, title, baseUrl:docUrl('README.md')});
}

test('all ten documentation buttons read offline without navigation and retain exact source links and focus', async ({page}) => {
  const evidence = await openCatalog(page);
  const buttons = page.locator('.card button[data-tool-doc]');
  await expect(buttons).toHaveCount(10);
  for (let index = 0; index < 10; index++) {
    const button = buttons.nth(index), path = await button.getAttribute('data-tool-doc');
    await button.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.maw-doc-body')).not.toHaveAttribute('aria-busy', 'true');
    await expect(dialog.locator('.maw-doc-source')).toHaveAttribute('href', docUrl(path));
    await expect(dialog.locator('.maw-doc-source')).toHaveAttribute('target', '_blank');
    expect((await dialog.locator('.maw-doc-body').innerText()).length).toBeGreaterThan(20);
    if (path === 'merge-flow.mjs') {
      await expect(dialog.locator('.maw-doc-source-note')).toContainText('源代码文件');
      await expect(dialog.locator('pre code')).toContainText('merge-flow');
    } else await expect(dialog.locator('.maw-doc-body h1')).toBeVisible();
    expect(page.url()).toBe(catalogUrl);
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(button).toBeFocused();
  }
  expect(evidence.errors).toEqual([]); expect(evidence.remote).toEqual([]);
});

test('Tab is contained, backdrop closes, internal documents switch and catalog filters survive reading', async ({page}) => {
  await openCatalog(page);
  await page.locator('#search').fill('转写');
  const button = page.locator('.card button[data-tool-doc]').first();
  await button.click();
  const dialog = page.getByRole('dialog');
  const popupReady = page.waitForEvent('popup');
  await dialog.locator('.maw-doc-source').click();
  const popup = await popupReady;
  await popup.waitForLoadState('domcontentloaded');
  expect(popup.url()).toBe(docUrl('README.md'));
  await popup.close();
  expect(page.url()).toBe(catalogUrl);
  await expect(page.locator('#search')).toHaveValue('转写');
  await expect(dialog.getByRole('link', {name:'共享模块说明'})).toBeVisible();
  await dialog.getByRole('link', {name:'共享模块说明'}).click();
  await expect(dialog.locator('.maw-doc-path')).toHaveText('shared/README.md');
  await expect(dialog.locator('.maw-doc-source')).toHaveAttribute('href', docUrl('shared/README.md'));
  for (let i = 0; i < 35; i++) {
    await page.keyboard.press(i % 2 ? 'Shift+Tab' : 'Tab');
    expect(await page.evaluate(() => document.querySelector('dialog').contains(document.activeElement))).toBe(true);
  }
  await dialog.evaluate(el => [...el.querySelectorAll('a[href],button:not(:disabled),[tabindex="0"]')].filter(node => node.getClientRects().length).at(-1).focus());
  await page.keyboard.press('Tab');
  await expect(dialog.locator('.maw-doc-source')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  expect(await page.evaluate(() => document.querySelector('dialog').contains(document.activeElement))).toBe(true);
  await page.mouse.click(2, 2);
  await expect(dialog).not.toBeVisible();
  await expect(button).toBeFocused();
  await expect(page.locator('#search')).toHaveValue('转写');
  await expect(page.locator('.card')).toHaveCount(1);
});

test('real DOMPurify blocks executable markup, unsafe and encoded links, images and malicious highlight without requests', async ({page}) => {
  const evidence = await openCatalog(page);
  await page.evaluate(() => {window.markdownExecuted = 0;});
  const malicious = [
    '# 中文标题\n\n# 中文标题\n\n[回到重复标题](#中文标题-1)',
    '==正常 **高亮**==\n\n==<img src="https://evil.invalid/raw" onerror="window.markdownExecuted++"> [危险](javascript:window.markdownExecuted++)==',
    '<script>window.markdownExecuted++</script><iframe src="https://evil.invalid/frame"></iframe>',
    '<svg onload="window.markdownExecuted++"><image href="https://evil.invalid/svg" /></svg>',
    '<style>body{background:url(https://evil.invalid/css)}</style>',
    '<a href="javascript:window.markdownExecuted++" onclick="window.markdownExecuted++">原始链接</a>',
    '![远程图](https://evil.invalid/image.png)\n\n![本地图](local.png)\n\n![危险图](data:image/svg+xml,evil)',
    '[js](javascript:evil) [data](data:text/html,evil) [encoded](jav%61script:evil) [colon](javascript%3Aevil)',
    '[entity](&#106;avascript:evil) [tab](java&#x09;script:evil) [double](%2564ata:text/html,evil)',
    '| 正常列 | 中文 |\n| --- | --- |\n| 表格 | **可读** |',
    '- 一级\n  - 二级\n- [x] 完成',
    '```js\nconst literal = "==代码== <img onerror=evil>";\n```\n\n`==行内代码==` 与 \\==转义==',
    '====\n\n==未闭合\n\n==跨\n行==',
    '[未打包文档](../docs/engineering/JSON_SCHEMA.md) [外链](https://example.com/page)',
  ].join('\n\n');
  expect(await showText(page, malicious)).toBe(true);
  const body = page.locator('dialog .maw-doc-body');
  await expect(body.locator('mark')).toHaveCount(2);
  await expect(body.locator('mark').first()).toHaveText('正常 高亮');
  await expect(body.locator('img,svg,iframe,style,script')).toHaveCount(0);
  const dangerous = await body.evaluate(el => [...el.querySelectorAll('*')].flatMap(node => [...node.attributes])
    .filter(attr => /^on/i.test(attr.name) || ['style','src'].includes(attr.name) || /^(?:javascript|data|vbscript):/i.test(attr.value))
    .map(attr => attr.name + '=' + attr.value));
  expect(dangerous).toEqual([]);
  expect(await page.evaluate(() => window.markdownExecuted)).toBe(0);
  await expect(body.locator('pre code')).toHaveAttribute('class', 'language-js');
  await expect(body.locator('pre')).toHaveAttribute('tabindex', '0');
  await expect(body.locator('.maw-md-code-language')).toHaveText('js');
  await expect(body.locator('.maw-md-table table')).toBeVisible();
  await expect(body.locator('li li')).toHaveText('二级');
  await expect(body.locator('input[type="checkbox"]')).toBeDisabled();
  await expect(body.getByRole('link', {name:'entity',exact:true})).toHaveCount(0);
  await expect(body.getByRole('link', {name:'tab',exact:true})).toHaveCount(0);
  await expect(body.getByRole('link', {name:'未打包文档'})).toContainText('打开源文件');
  await expect(body.getByRole('link', {name:'外链'})).toHaveAttribute('rel', 'nofollow noopener noreferrer');
  await body.getByRole('link', {name:'回到重复标题'}).click();
  await expect(body.locator('h1').nth(1)).toBeFocused();
  expect(page.url()).toBe(catalogUrl);
  expect(evidence.errors).toEqual([]); expect(evidence.remote).toEqual([]);
  const control = await page.evaluate(() => {
    const withExtension = window.MAWMarkdown.render('==中文 **粗体**==');
    const withoutExtension = window.MAWMarkdown.render('==中文 **粗体**==', {highlight:false});
    return {withMark:withExtension.querySelectorAll('mark').length, withoutMark:withoutExtension.querySelectorAll('mark').length, withoutStrong:withoutExtension.querySelectorAll('strong').length};
  });
  expect(control).toEqual({withMark:1, withoutMark:0, withoutStrong:1});
  const strict = await page.evaluate(() => {
    const fragment = window.MAWMarkdown.render('[相对](README.md) [外链](https://example.com/path) ![图片](https://evil.invalid/x)', {absoluteOnly:true,noImages:true});
    return {links:[...fragment.querySelectorAll('a')].map(link => link.href),images:fragment.querySelectorAll('img').length,text:fragment.textContent};
  });
  expect(strict.links).toEqual(['https://example.com/path']); expect(strict.images).toBe(0);
  expect(strict.text).toContain('此视图禁用图片入口');
});

test('loader races, internal link switches, close/reopen and failures do not replace newer content', async ({page}) => {
  await openCatalog(page);
  await page.evaluate(() => {
    window.raceGates = new Map(); window.raceResults = [];
    window.raceViewer = window.MAWDocViewer.create({render:window.MAWMarkdown.render,
      loader:request => request.path === 'bad.md' ? Promise.reject(new Error('合成载入失败')) : new Promise(resolve => window.raceGates.set(request.path, resolve)),
      resolve:href => href.endsWith('/slow.md') ? {path:'slow.md', baseUrl:href, sourceUrl:href} : null,
    });
    window.raceViewer.open({path:'old.md', sourceUrl:new URL('old.md', document.baseURI).href}).then(value => window.raceResults.push(['old',value]));
  });
  let dialog = page.locator('dialog').last();
  await expect(dialog.locator('.maw-doc-status')).toContainText('正在载入');
  await page.evaluate(() => {
    window.raceViewer.open({path:'new.md', markdown:'# 新文档\n\n[慢文档](slow.md)', baseUrl:document.baseURI});
    window.raceGates.get('old.md')('# 旧文档');
  });
  await expect(dialog.locator('h1')).toHaveText('新文档');
  await expect.poll(() => page.evaluate(() => window.raceResults)).toEqual([['old',false]]);
  await dialog.getByRole('link', {name:'慢文档'}).click();
  await expect(dialog.locator('.maw-doc-status')).toContainText('正在载入');
  await page.evaluate(() => {
    window.raceViewer.close();
    window.raceViewer.open({path:'reopen.md', markdown:'# 重开成功', baseUrl:document.baseURI});
    window.raceGates.get('slow.md')('# 不得覆盖');
  });
  await expect(dialog).toBeVisible(); await expect(dialog.locator('h1')).toHaveText('重开成功');
  await page.evaluate(() => window.raceViewer.open({path:'bad.md', sourceUrl:new URL('bad.md', document.baseURI).href}));
  await expect(dialog.locator('.maw-doc-status')).toContainText('合成载入失败');
  await expect(dialog.locator('.maw-doc-source')).toBeVisible();
  await expect(dialog.locator('.maw-doc-body')).not.toHaveAttribute('aria-busy', 'true');
  await page.evaluate(() => {
    window.raceViewer.close();
    window.failingRenderer = window.MAWDocViewer.create({render:() => {throw new Error('合成渲染失败');}});
    return window.failingRenderer.open({markdown:'文本', sourceUrl:new URL('README.md', document.baseURI).href});
  });
  dialog = page.locator('dialog').last();
  await expect(dialog.locator('.maw-doc-status')).toContainText('合成渲染失败');
  await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible();
  const unsupported = await page.evaluate(() => {
    const original = window.DOMPurify;
    window.DOMPurify = {sanitize:original.sanitize,isSupported:false};
    try {window.MAWMarkdown.render('文本'); return false;} catch (_) {return true;} finally {window.DOMPurify = original;}
  });
  expect(unsupported).toBe(true);
});

test('DOMPurify whitelist is an actual defense even if parser output contains active HTML', async ({page}) => {
  const evidence = await openCatalog(page);
  const result = await page.evaluate(() => {
    const OriginalModule = window.marked, OriginalMarked = OriginalModule.Marked;
    window.markdownExecuted = 0;
    const InjectedMarked = class extends OriginalMarked {
      constructor(...args) {
        super(...args);
        this.parse = () => '<mark>净化边界</mark><svg onload="window.markdownExecuted++"></svg>'
          + '<img src="https://evil.invalid/defense" onerror="window.markdownExecuted++">'
          + '<iframe src="https://evil.invalid/frame"></iframe><style>body{color:red}</style>'
          + '<script>window.markdownExecuted++</script><p onclick="window.markdownExecuted++" style="color:red">正文</p>'
          + '<a href="javascript:window.markdownExecuted++">恶链</a><a href="data:text/html,evil">data</a>';
      }
    };
    // Official UMD exports are getter-only. Replace the test's module object, not an ignored assignment.
    window.marked = {...OriginalModule, Marked:InjectedMarked};
    try {
      const fragment = window.MAWMarkdown.render('合成上游输出');
      const host = document.createElement('div'); host.append(fragment); document.body.append(host);
      const summary = {badTags:host.querySelectorAll('svg,img,iframe,style,script').length,
        badAttrs:[...host.querySelectorAll('*')].flatMap(el => [...el.attributes]).filter(attr => /^on/i.test(attr.name) || attr.name === 'style').length,
        unsafeLinks:[...host.querySelectorAll('a')].filter(link => link.hasAttribute('href')).length,
        mark:host.querySelector('mark')?.textContent, executed:window.markdownExecuted};
      host.remove(); return summary;
    } finally {window.marked = OriginalModule;}
  });
  expect(result).toEqual({badTags:0,badAttrs:0,unsafeLinks:0,mark:'净化边界',executed:0});
  expect(evidence.remote).toEqual([]); expect(evidence.errors).toEqual([]);
});

test('review regressions: nested inline tokens, rooted files and GFM table computed alignment', async ({page}) => {
  await openCatalog(page);
  const result = await page.evaluate(() => {
    const baseUrl = 'file:///repo/tools/README.md';
    const code = MAWMarkdown.render('==before `==literal==` after==');
    const link = MAWMarkdown.render('==before [链接](https://example.com/?q===value==) after==');
    const emphasisCode = MAWMarkdown.render('==before **`==literal==`** after==');
    const blocked = ['/C:/private/secret.txt','/etc/passwd','\\private','\\\\server\\share',
      '%2fetc/passwd','%5cprivate','%252fetc/passwd','C:/secret','%43%3a/secret'];
    const fileLinks = blocked.flatMap(href => [...MAWMarkdown.render(`[文件](${href})`, {baseUrl}).querySelectorAll('a')].map(a => a.href));
    const host = document.createElement('div'); host.className = 'maw-markdown';
    host.append(MAWMarkdown.render('| left | right | center |\n| :--- | ---: | :---: |\n| a | b | c |'));
    document.body.append(host);
    const alignment = [...host.querySelectorAll('th,td')].map(el => [el.getAttribute('align'),getComputedStyle(el).textAlign]);
    host.remove();
    return {code:[...code.querySelectorAll('code')].map(el => el.textContent),codeMarks:code.querySelectorAll('mark').length,
      linkMarks:link.querySelectorAll('mark').length,linkHref:link.querySelector('a')?.href,fileLinks,alignment,
      emphasisCode:emphasisCode.querySelector('strong code')?.textContent,emphasisMarks:emphasisCode.querySelectorAll('mark').length};
  });
  expect(result.code).toEqual(['==literal==']); expect(result.codeMarks).toBe(1); expect(result.linkMarks).toBe(1);
  expect(result.linkHref).toBe('https://example.com/?q===value=='); expect(result.fileLinks).toEqual([]);
  expect(result.emphasisCode).toBe('==literal=='); expect(result.emphasisMarks).toBe(1);
  expect(result.alignment).toEqual([['left','left'],['right','right'],['center','center'],['left','left'],['right','right'],['center','center']]);
});

test('modal stack supports precreated and runtime viewers in native/fallback mixed order without focus or state leaks', async ({page}) => {
  await openCatalog(page);
  const configurations = [
    {modes:['fallback','fallback'], precreated:true, order:[1,0]},
    {modes:['native','native'], precreated:true, order:[0,1]},
    {modes:['native','fallback','native'], precreated:false, order:[1,0,2]},
    {modes:['fallback','native','fallback'], precreated:true, order:[2,0,1]},
  ];
  for (const configuration of configurations) {
    await page.evaluate(async configuration => {
      document.documentElement.style.setProperty('overflow', 'scroll', 'important');
      const preserved = document.createElement('div'); preserved.id = 'original-inert'; preserved.inert = true; document.body.append(preserved);
      const initialNodes = [...document.body.children];
      document.querySelector('#search').focus();
      window.stackCase = {viewers:[],initialNodes,initialInert:initialNodes.map(el => el.inert),
        originalOverflow:document.documentElement.style.getPropertyValue('overflow'),originalPriority:document.documentElement.style.getPropertyPriority('overflow')};
      const make = mode => {
        const viewer = MAWDocViewer.create({render:MAWMarkdown.render});
        if (mode === 'fallback') viewer.dialog.showModal = undefined;
        return viewer;
      };
      if (configuration.precreated) stackCase.viewers = configuration.modes.map(make);
      for (let index = 0; index < configuration.modes.length; index++) {
        if (!configuration.precreated) stackCase.viewers.push(make(configuration.modes[index]));
        const viewer = stackCase.viewers[index];
        await viewer.open({markdown:'# 说明 ' + index}, index ? stackCase.viewers[index-1].dialog.querySelector('button') : document.querySelector('#search'));
        if (viewer.dialog.inert || !viewer.dialog.contains(document.activeElement)) throw new Error('Top viewer is inert or unfocused');
      }
    }, configuration);
    await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => stackCase.viewers.at(-1).dialog.contains(document.activeElement))).toBe(true);
    for (const index of configuration.order) {
      const state = await page.evaluate(index => {
        const viewer = stackCase.viewers[index], wasTop = [...stackCase.viewers].reverse().find(v => v.dialog.open) === viewer;
        const previousFocus = document.activeElement; viewer.close();
        const top = [...stackCase.viewers].reverse().find(v => v.dialog.open);
        return {wasTop,closed:!viewer.dialog.open,topFocus:!top || top.dialog.contains(document.activeElement),
          sameFocus:wasTop || previousFocus === document.activeElement,overflow:document.documentElement.style.getPropertyValue('overflow')};
      }, index);
      expect(state.closed).toBe(true); expect(state.topFocus).toBe(true); expect(state.sameFocus).toBe(true);
    }
    const restored = await page.evaluate(() => {
      const result = {inert:stackCase.initialNodes.map(el => el.inert),expected:stackCase.initialInert,
        overflow:document.documentElement.style.getPropertyValue('overflow'),priority:document.documentElement.style.getPropertyPriority('overflow'),
        focus:document.activeElement.id};
      document.querySelector('#original-inert').remove();
      stackCase.viewers.forEach(v => v.dialog.remove());
      document.documentElement.style.removeProperty('overflow'); return result;
    });
    expect(restored.inert).toEqual(restored.expected); expect(restored.overflow).toBe('scroll'); expect(restored.priority).toBe('important');
    expect(restored.focus).toBe('search');
  }
});

test('Escape closes only the top precreated fallback and restores lower focus until the final close', async ({page}) => {
  await openCatalog(page);
  await page.evaluate(async () => {
    document.querySelector('#search').focus();
    window.escapeStack = [MAWDocViewer.create({render:MAWMarkdown.render}),MAWDocViewer.create({render:MAWMarkdown.render})];
    escapeStack.forEach(v => {v.dialog.showModal = undefined;});
    await escapeStack[0].open({markdown:'outer'});
    await escapeStack[1].open({markdown:'inner'},escapeStack[0].dialog.querySelector('button'));
  });
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => ({open:escapeStack.map(v => v.dialog.open),focus:escapeStack[0].dialog.contains(document.activeElement),mainInert:document.querySelector('main').inert})))
    .toEqual({open:[true,false],focus:true,mainInert:true});
  await page.keyboard.press('Escape'); await expect(page.locator('#search')).toBeFocused();
  expect(await page.locator('main').evaluate(el => el.inert)).toBe(false);
});

test('document switch resets scroll, missing data degrades honestly and native fallback restores background', async ({page}) => {
  await openCatalog(page);
  await showText(page, '# 长文\n\n' + Array(100).fill('普通中文段落。').join('\n\n'));
  await page.locator('dialog .maw-doc-body').evaluate(body => {body.scrollTop = body.scrollHeight;});
  expect(await page.locator('dialog .maw-doc-body').evaluate(body => body.scrollTop)).toBeGreaterThan(500);
  await showText(page, '# 短文');
  expect(await page.locator('dialog .maw-doc-body').evaluate(body => body.scrollTop)).toBe(0);
  await page.evaluate(() => window.MAWToolDocViewer.open({path:'missing.md', sourceUrl:new URL('missing.md', document.baseURI).href}));
  await expect(page.locator('dialog .maw-doc-status')).toContainText('未收录');
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    HTMLDialogElement.prototype.showModal = undefined;
    document.querySelector('#search').focus();
    window.fallbackViewer = window.MAWDocViewer.create({render:window.MAWMarkdown.render});
    return window.fallbackViewer.open({markdown:'# 降级说明'});
  });
  const dialog = page.locator('dialog').last();
  await expect(dialog).toHaveAttribute('data-fallback', '');
  await expect(dialog.locator('.maw-doc-source')).toBeHidden();
  expect(await page.locator('main').evaluate(el => el.inert)).toBe(true);
  await page.keyboard.press('Escape');
  expect(await page.locator('main').evaluate(el => el.inert)).toBe(false);
  await expect(page.locator('#search')).toBeFocused();
});

test('desktop and narrow reader stays readable with local table/code scrolling and measured font/spacing', async ({page}, testInfo) => {
  await openCatalog(page);
  const markdown = '# 中文阅读与高亮\n\n==保留工作状态==，正文与 **强调** 清晰可读。\n\n'
    + '| ' + Array(8).fill('宽表格列').join(' | ') + ' |\n| ' + Array(8).fill('---').join(' | ') + ' |\n| ' + Array(8).fill('中文数据').join(' | ') + ' |\n\n'
    + '```powershell\n' + 'command --long-argument '.repeat(30) + '\n```\n\n![说明图片](https://example.com/image.png)';
  await showText(page, markdown);
  const measurements = [];
  for (const width of [320,375,414,768,1440]) {
    await page.setViewportSize({width,height:900});
    const metrics = await page.evaluate(() => {
      const dialog = document.querySelector('dialog'), header = dialog.querySelector('.maw-doc-header'), body = dialog.querySelector('.maw-doc-body');
      const tiny = [...document.querySelectorAll('body *')].filter(el => el.getClientRects().length && el.textContent.trim() && parseFloat(getComputedStyle(el).fontSize) < 11).map(el => el.tagName + '.' + el.className);
      const code = body.querySelector('pre'), table = body.querySelector('.maw-md-table');
      return {width:innerWidth, tiny, pageWidth:document.documentElement.scrollWidth, dialogWidth:dialog.getBoundingClientRect().width,
        bodyWidth:body.clientWidth, bodyScrollWidth:body.scrollWidth,
        headerGap:parseFloat(getComputedStyle(header).gap), actionsGap:parseFloat(getComputedStyle(dialog.querySelector('.maw-doc-actions')).gap),
        bodyPadding:parseFloat(getComputedStyle(body).paddingTop),
        code:{client:code.clientWidth,scroll:code.scrollWidth}, table:{client:table.clientWidth,scroll:table.scrollWidth},
        minActionHeight:Math.min(...[...dialog.querySelectorAll('.maw-doc-actions > *')].map(el => el.getBoundingClientRect().height)),
      };
    });
    measurements.push(metrics);
    expect(metrics.tiny).toEqual([]); expect(metrics.pageWidth).toBe(width);
    expect(metrics.dialogWidth).toBeLessThanOrEqual(width);
    expect(metrics.bodyScrollWidth).toBe(metrics.bodyWidth);
    expect(metrics.headerGap).toBeGreaterThanOrEqual(8); expect(metrics.actionsGap).toBeGreaterThanOrEqual(8);
    expect(metrics.bodyPadding).toBeGreaterThanOrEqual(8); expect(metrics.minActionHeight).toBeGreaterThanOrEqual(width <= 560 ? 44 : 32);
    expect(metrics.code.scroll).toBeGreaterThan(metrics.code.client);
    if (width === 375) {
      expect(metrics.table.scroll).toBeGreaterThan(metrics.table.client);
      await page.screenshot({path:testInfo.outputPath('reader-375.png')});
    }
  }
  for (const theme of ['dark','light']) {
    await page.evaluate(theme => {document.documentElement.dataset.theme = theme;}, theme);
    // Color transitions need to settle before comparing/capturing the OCR-style button baseline.
    await expect.poll(() => page.locator('dialog .maw-doc-close').evaluate(el => getComputedStyle(el).backgroundColor)).toBe(theme === 'dark' ? 'rgb(46, 46, 52)' : 'rgb(246, 246, 247)');
    await page.screenshot({path:testInfo.outputPath('reader-' + theme + '.png')});
  }
  writeFileSync(testInfo.outputPath('reader-measurements.json'), JSON.stringify(measurements, null, 2));
});
