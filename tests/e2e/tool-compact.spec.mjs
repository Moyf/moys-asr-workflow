import {expect, test} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// A captured, unmodified WIP tree can be served read-only for the negative run.
const baseline = process.env.MAW_COMPACT_BASELINE_DIR;
const source = path => readFileSync(resolve(baseline || '.', path), 'utf8');
const fileUrl = path => pathToFileURL(resolve(path)).href;
const project = {segments:[{start:0,end:1000,text:'测试字幕',items:[{start:0,end:500,text:'测试'},{start:500,end:1000,text:'字幕'}]}]};

test('compact board keeps long unbroken titles within a reachable column',async({page})=>{
  await dashboard(page);
  await page.evaluate(()=>{
    state.prs[0].title='UnbrokenTitle'.repeat(25);render();
  });
  await page.setViewportSize({width:375,height:812});
  const input=page.locator('[data-tool-compact]');
  await projectChecked(input,true);
  const widths=await page.locator('.card').evaluate(card=>({
    card:card.getBoundingClientRect().width,column:card.closest('.column').getBoundingClientRect().width,
    actions:card.querySelector('.card-actions').getBoundingClientRect().right<=card.getBoundingClientRect().right,
  }));
  expect(widths.column).toBeLessThanOrEqual(300);
  expect(widths.card).toBeLessThanOrEqual(widths.column);
  expect(widths.actions).toBe(true);
});

function generateChecklist(testInfo, stress = false) {
  const output = testInfo.outputPath('checklist.html');
  const data = JSON.parse(readFileSync(resolve('tools/verification-checklist/examples/checklist.json'), 'utf8'));
  data.title = 'Compact switch regression';
  data.sections[2].blocks[0].note = '详细说明在打印和恢复完整视图时保留';
  if (stress) {
    data.sections = Array.from({length:30}, (_, group) => ({id:'group-' + group, title:'分区 ' + group, blocks:[
      {type:'command', text:'node ' + 'very-long-command/'.repeat(50)},
      {type:'table', headers:['命令','结果'], rows:[['x'.repeat(200),'待确认']]},
      ...Array.from({length:30}, (_, item) => ({type:'check', id:'item-' + group + '-' + item, purpose:'核对标题 ' + item, operation:'测试操作', expected:'测试预期', note:'辅助说明'})),
    ]}));
  }
  const input = testInfo.outputPath('source.json');
  writeFileSync(input, JSON.stringify(data));
  const script = testInfo.outputPath('build-checklist.py');
  writeFileSync(script, [
    'import importlib.util,json,sys',
    'from pathlib import Path',
    "spec=importlib.util.spec_from_file_location('checklist_builder','tools/verification-checklist/build.py')",
    'builder=importlib.util.module_from_spec(spec);spec.loader.exec_module(builder)',
    'if sys.argv[3]: builder.TEMPLATE=Path(sys.argv[3])/"tools/verification-checklist/templates/verification-checklist.html"',
    'result=builder.render_source(json.loads(Path(sys.argv[1]).read_text(encoding="utf-8")))',
    'Path(sys.argv[2]).write_text(result,encoding="utf-8",newline="\\n")',
  ].join('\n'));
  execFileSync(process.env.MAW_E2E_PYTHON || 'python', [script,input,output,baseline || ''], {timeout:15000});
  return output;
}

function generateOcr(testInfo) {
  const script = testInfo.outputPath('build-ocr.py'), output = testInfo.outputPath('ocr.html');
  writeFileSync(script, [
    'import sys', 'from pathlib import Path',
    'sys.path.insert(0,"tools/term-extract")',
    'from term_extract.report import build_report,write_report_html',
    'report=build_report(video_name="fixture",fps=1,model="fixture",duration_ms=1000,min_score=60,scan_summary={},candidates=[],ai_enabled=False)',
    'write_report_html(Path(sys.argv[1]),report)',
  ].join('\n'));
  execFileSync(process.env.MAW_E2E_PYTHON || 'python', [script,output], {timeout:15000});
  return output;
}

async function dashboard(page) {
  const status = {'1':'review'}, ignored = {}, posts = [];
  const prs = [{number:1,title:'测试卡片',body:'## PR 正文\n\n**重点** 与 [链接](https://example.invalid)\n\n- [ ] 核验\n\n<script>window.injected=true</script>',headRefName:'feature',baseRefName:'main',author:{login:'demo'},url:'https://example.invalid',milestone:null,statusCheckRollup:[]}];
  const assets = {'/':'tools/dev-dashboard/index.html','/app.js':'tools/dev-dashboard/app.js','/marked-15.0.12.min.js':'tools/dev-dashboard/marked-15.0.12.min.js','/style.css':'tools/dev-dashboard/style.css','/shared/tool-page.css':'tools/shared/tool-page.css','/shared/tool-page.js':'tools/shared/tool-page.js'};
  await page.route('http://127.0.0.1:8262/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/api/')) {
      if (route.request().method() === 'POST') {
        const data = route.request().postDataJSON(); posts.push({path,...data});
        const map = path === '/api/status' ? status : ignored;
        const next = path === '/api/status' ? data.status : data.ignored;
        if (next) map[String(data.pr)] = next; else delete map[String(data.pr)];
      }
      const body = path === '/api/prs' ? prs : path === '/api/checklists' ? [] : path === '/api/status' ? status : ignored;
      return route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
    }
    if (!assets[path]) return route.fulfill({status:404});
    const body = source(assets[path]);
    return route.fulfill({body,contentType:path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html',headers:{'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'"}});
  });
  await page.goto('http://127.0.0.1:8262/');
  await expect(page.locator('.card')).toHaveCount(1);
  return {status,ignored,posts};
}

async function timestamp(page) {
  if (baseline) {
    await page.route('http://127.0.0.1:8263/**', async route => {
      const path = new URL(route.request().url()).pathname;
      const file = path === '/' ? 'tools/timestamp-compare.html' : 'tools' + path;
      return route.fulfill({body:source(file),contentType:path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html'});
    });
    await page.goto('http://127.0.0.1:8263/');
  } else await page.goto(fileUrl('tools/timestamp-compare.html'));
}

async function setTheme(page, theme) {
  await page.evaluate(theme => {document.documentElement.dataset.theme = theme;}, theme);
  // Wait for real color transitions before capturing or comparing their settled state.
  await page.evaluate(async () => {
    void document.body.offsetHeight;
    await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {})));
  });
}

async function measure(input) {
  return input.evaluate(input => {
    const label = input.closest('label'), track = input.nextElementSibling;
    const a = getComputedStyle(track), b = getComputedStyle(track,'::after'), c = getComputedStyle(label);
    const fields = ['width','height','borderRadius','backgroundColor','borderWidth','boxShadow','transitionDuration','transitionTimingFunction'];
    const props = style => Object.fromEntries(fields.map(name => [name,style[name]]));
    return {track:props(a),knob:{...props(b),left:b.left,top:b.top,transform:b.transform},label:{height:c.height,padding:c.padding,gap:c.gap,color:c.color,fontSize:c.fontSize,cursor:c.cursor,userSelect:c.userSelect},focus:{outline:a.outline,offset:a.outlineOffset}};
  });
}

async function projectChecked(input, on) {
  await input.evaluate((input,on) => {input.checked = on;input.dispatchEvent(new Event('change',{bubbles:true}));}, on);
}

async function assertNative(input) {
  expect(await input.evaluate(input => ({tag:input.tagName,type:input.type,parent:input.parentElement.tagName,track:input.nextElementSibling?.className}))).toEqual({tag:'INPUT',type:'checkbox',parent:'LABEL',track:'switch-track'});
  await expect(input).toHaveAttribute('role','switch');
}

test('all maintained switches match production OCR dimensions, colors, hover and focus', async ({page,context}, testInfo) => {
  const output = generateChecklist(testInfo), ocr = await context.newPage();
  await ocr.goto(fileUrl(generateOcr(testInfo)));
  const reference = ocr.locator('#compact-toggle');
  const measurements = [];
  for (const tool of ['timestamp','checklist','dashboard']) {
    if (tool === 'timestamp') await timestamp(page);
    else if (tool === 'checklist') await page.goto(fileUrl(output));
    else await dashboard(page);
    const inputs = tool === 'timestamp' ? [page.locator('[data-tool-compact]'),page.locator('#showItemText')] : [page.locator('[data-tool-compact]')];
    for (const input of inputs) await assertNative(input);
    for (const width of [1440,375]) {
      await page.setViewportSize({width,height:900}); await ocr.setViewportSize({width,height:900});
      for (const theme of ['dark','light']) {
        await setTheme(page,theme); await setTheme(ocr,theme);
        for (const input of inputs) {
          for (const checked of [false,true]) {
            await input.evaluate(input => input.blur()); await reference.evaluate(input => input.blur());
            await projectChecked(input,checked); await projectChecked(reference,checked);
            await page.mouse.move(0,0); await ocr.mouse.move(0,0);
            await expect.poll(async () => (await measure(reference)).knob.transform).toBe(checked ? 'matrix(1, 0, 0, 1, 14, 0)' : 'none');
            await expect.poll(async () => (await measure(reference)).track.backgroundColor).toBe(checked ? (theme === 'dark' ? 'rgb(240, 154, 80)' : 'rgb(200, 69, 69)') : (theme === 'dark' ? 'rgb(68, 68, 76)' : 'rgb(210, 210, 215)'));
            await expect.poll(async () => measure(input)).toEqual(await measure(reference));
            const actual = await measure(input);
            expect(actual.track.width).toBe('34px'); expect(actual.track.height).toBe('20px');
            expect(actual.knob.width).toBe('14px'); expect(actual.knob.top).toBe('3px');
            measurements.push({tool,width,theme,checked,actual});
          }
          await input.evaluate(input => input.blur()); await reference.evaluate(input => input.blur());
          await projectChecked(input,false); await projectChecked(reference,false);
          await input.locator('..').hover(); await reference.locator('..').hover();
          await expect.poll(async () => (await measure(reference)).track.backgroundColor).toBe(theme === 'dark' ? 'rgb(90, 90, 99)' : 'rgb(185, 185, 192)');
          await expect.poll(async () => measure(input)).toEqual(await measure(reference));
          await page.mouse.move(0,0); await ocr.mouse.move(0,0);
          await input.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
          await reference.focus(); await ocr.keyboard.press('Tab'); await ocr.keyboard.press('Shift+Tab');
          await expect.poll(async () => (await measure(reference)).track.backgroundColor).toBe(theme === 'dark' ? 'rgb(68, 68, 76)' : 'rgb(210, 210, 215)');
          await expect.poll(async () => measure(input)).toEqual(await measure(reference));
          expect((await measure(input)).focus.outline).toContain('2px');
        }
        await page.screenshot({path:testInfo.outputPath(`${tool}-${width}-${theme}.png`)});
        await ocr.screenshot({path:testInfo.outputPath(`ocr-${width}-${theme}.png`)});
      }
    }
  }
  writeFileSync(testInfo.outputPath('switch-measurements.json'),JSON.stringify(measurements,null,2));
  await ocr.close();
});

test('shared theme control copies the production OCR 32px ghost icon and feedback', async ({page,context}, testInfo) => {
  await timestamp(page);
  const ocr = await context.newPage(); await ocr.goto(fileUrl(generateOcr(testInfo)));
  const reference = ocr.locator('#theme-btn'), actual = page.locator('[data-tool-theme]');
  const measure = locator => locator.evaluate(button => {
    const style=getComputedStyle(button);
    return Object.fromEntries(['width','height','padding','borderWidth','borderRadius','borderColor','backgroundColor','color','fontSize','transform','transitionDuration','transitionTimingFunction','outline','outlineOffset'].map(name=>[name,style[name]]));
  });
  const metrics=[];
  for (const theme of ['dark','light']) {
    await setTheme(page,theme); await setTheme(ocr,theme);
    await page.mouse.move(0,0); await ocr.mouse.move(0,0);
    await actual.evaluate(button=>button.blur()); await reference.evaluate(button=>button.blur());
    await expect.poll(async () => measure(actual)).toEqual(await measure(reference));
    await expect(actual).toHaveText('◐');
    await actual.hover(); await reference.hover();
    await expect.poll(async () => (await measure(reference)).color).toBe(theme === 'dark' ? 'rgb(243, 241, 238)' : 'rgb(29, 29, 32)');
    await expect.poll(async () => measure(actual)).toEqual(await measure(reference));
    await page.mouse.down(); await ocr.mouse.down();
    expect((await measure(actual)).transform).toBe((await measure(reference)).transform);
    await page.mouse.up(); await ocr.mouse.up();
    await setTheme(page,theme); await setTheme(ocr,theme);
    await page.mouse.move(0,0); await ocr.mouse.move(0,0);
    await actual.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
    await reference.focus(); await ocr.keyboard.press('Tab'); await ocr.keyboard.press('Shift+Tab');
    await expect.poll(async () => (await measure(reference)).color).toBe(theme === 'dark' ? 'rgb(176, 171, 165)' : 'rgb(100, 100, 108)');
    await expect.poll(async () => measure(actual)).toEqual(await measure(reference));
    metrics.push({theme,actual:await measure(actual)});
  }
  writeFileSync(testInfo.outputPath('theme-control-measurements.json'),JSON.stringify(metrics,null,2));
  await ocr.close();
});

test('timestamp item-text track uses the OCR 34 by 20 geometry rather than the old mini switch', async ({page}) => {
  await timestamp(page);
  const input = page.locator('#showItemText');
  const size = await input.evaluate(input => {
    const track=input.nextElementSibling, knob=getComputedStyle(track,'::after'), style=getComputedStyle(track);
    return {width:style.width,height:style.height,radius:style.borderRadius,knob:knob.width,left:knob.left,top:knob.top};
  });
  expect(size).toEqual({width:'34px',height:'20px',radius:'10px',knob:'14px',left:'3px',top:'3px'});
});

test('native label, input change and Space toggle compact once and preserve search focus', async ({page}) => {
  await timestamp(page);
  const input = page.locator('[data-tool-compact]'); await assertNative(input);
  await page.evaluate(project => {
    window.MAWTsCompare.loadProjectObjects([{name:'fixture',project}]);
    window.densityEvents = 0;
    document.addEventListener('tool-density-change', () => window.densityEvents++);
  }, project);
  await input.locator('..').click(); await expect(input).toBeChecked();
  expect(await page.evaluate(() => window.densityEvents)).toBe(1);
  await input.focus(); await page.keyboard.press('Space'); await expect(input).not.toBeChecked();
  expect(await page.evaluate(() => window.densityEvents)).toBe(2);
  await page.locator('#search').focus();
  await projectChecked(input,true); await expect(input).toBeChecked();
  expect(await page.evaluate(() => document.activeElement.id)).toBe('search');
  expect(await page.evaluate(() => window.densityEvents)).toBe(3);
  expect(await page.evaluate(() => localStorage.getItem('maw-tool:timestamp-compare:compact'))).toBe('1');
  await page.reload(); await expect(input).toBeChecked();
  await page.locator('#showItemText').locator('..').click();
  await expect(page.locator('#showItemText')).toBeChecked();
  await page.locator('#showItemText').focus(); await page.keyboard.press('Space');
  await expect(page.locator('#showItemText')).not.toBeChecked();
});

test('retired button declarations are mechanically upgraded without stale button state', async ({page}) => {
  await page.goto(fileUrl('tools/copy-review/copy-review.html'));
  const input = page.locator('[data-tool-compact]'); await assertNative(input);
  await expect(page.locator('button[data-tool-compact]')).toHaveCount(0);
  await input.locator('..').click(); await expect(input).toBeChecked();
  await input.focus(); await page.keyboard.press('Space'); await expect(input).not.toBeChecked();
  await expect(input).not.toHaveAttribute('aria-checked');
});

async function downloadResult(page) {
  const event = page.waitForEvent('download'); await page.locator('#export-json').click();
  const result = JSON.parse(readFileSync(await (await event).path(), 'utf8'));
  delete result.exportedAt; return result;
}

test('checklist compact keeps only title and checkbox, retains notes and exports, and prints full content', async ({page}, testInfo) => {
  const output = generateChecklist(testInfo); await page.goto(fileUrl(output));
  const input = page.locator('[data-tool-compact]'), item = page.locator('#manual .item').first();
  const box = item.locator('input[type=checkbox]');
  await item.locator('.note-toggle').click(); await item.locator('textarea').fill('第一行备注\n第二行备注');
  const before = await downloadResult(page);
  // Use the existing legacy control in the negative run so old content CSS is exercised too.
  await page.locator('.tool-density').click();
  await expect(item.locator('.item-purpose')).toBeVisible(); await expect(box).toBeVisible();
  for (const selector of ['.item-op','.item-exp','.item-hint','.item-actions','.item-note']) await expect(item.locator(selector)).toBeHidden();
  const sizes = await item.evaluate(item => ({height:item.getBoundingClientRect().height,font:getComputedStyle(item.querySelector('label')).fontSize,gap:getComputedStyle(item).columnGap}));
  expect(sizes.font).toBe('15px'); expect(sizes.height).toBeLessThanOrEqual(44); expect(parseFloat(sizes.gap)).toBeGreaterThanOrEqual(8);
  await expect(item.locator('textarea')).toHaveValue('第一行备注\n第二行备注');
  expect(await downloadResult(page)).toEqual(before);
  await item.locator('label').click(); await expect(box).toBeChecked();
  const afterCheck = await downloadResult(page); expect(afterCheck.sections[0].items[0].confirmed).toBe(true);
  await page.emulateMedia({media:'print'});
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  for (const selector of ['.item-purpose','.item-op','.item-exp','.item-hint','.print-note']) await expect(item.locator(selector)).toBeVisible();
  await expect(item.locator('.print-note')).toContainText('第一行备注');
  expect(await page.locator('.section').first().evaluate(item => getComputedStyle(item).contentVisibility)).toBe('visible');
  await page.emulateMedia({media:'screen'}); await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  for (const theme of ['dark','light']) {
    await setTheme(page,theme);
    for (const width of [1440,375]) {
      await page.setViewportSize({width,height:900}); await item.scrollIntoViewIfNeeded();
      await page.screenshot({path:testInfo.outputPath(`checklist-compact-${width}-${theme}.png`)});
    }
  }
  await page.setViewportSize({width:1440,height:900});
  await page.locator('.tool-density').click(); await expect(input).not.toBeChecked();
  await expect(item.locator('.item-note')).toBeVisible(); await expect(item.locator('.note-toggle')).toHaveAttribute('aria-expanded','true');
  expect(await downloadResult(page)).toEqual(afterCheck);
  await page.reload(); await expect(box).toBeChecked(); await expect(item.locator('textarea')).toHaveValue('第一行备注\n第二行备注');
  writeFileSync(testInfo.outputPath('compact-item-measurements.json'),JSON.stringify(sizes,null,2));
});

test('dashboard compact shows only title and two actions while status and ignore still save', async ({page}, testInfo) => {
  const errors = []; page.on('pageerror',error => errors.push(error.message));
  const state = await dashboard(page); const card = page.locator('.card');
  const font = await card.locator('.card-title').evaluate(node => getComputedStyle(node).fontSize);
  await page.locator('.tool-density').click();
  for (const selector of ['.card-badges','.card-meta','.card-check']) await expect(card.locator(selector)).toBeHidden();
  expect(await card.evaluate(card => [...card.children].filter(node => getComputedStyle(node).display !== 'none').map(node => node.className))).toEqual(['card-title','card-actions']);
  await expect(card.locator('.card-actions button')).toHaveCount(1); await expect(card.locator('.card-actions select')).toHaveCount(1);
  expect(await card.locator('.card-title').evaluate(node => getComputedStyle(node).fontSize)).toBe(font);
  const gap = await card.evaluate(card => card.querySelector('.card-actions').getBoundingClientRect().top - card.querySelector('.card-title').getBoundingClientRect().bottom);
  expect(gap).toBeGreaterThanOrEqual(8);
  await card.locator('.card-title').hover(); await expect(page.locator('#pr-preview')).toBeVisible();
  await expect(page.locator('#pr-preview-body h2')).toHaveText('PR 正文');
  await expect(page.locator('#pr-preview-body strong')).toHaveText('重点');
  await expect(page.locator('#pr-preview-body script,img')).toHaveCount(0);
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
  await page.keyboard.press('Escape'); await expect(page.locator('#pr-preview')).toBeHidden();
  await card.locator('select').selectOption('fixing');
  await expect(page.locator('.column[data-status=fixing] .card')).toHaveCount(1);
  await expect.poll(() => state.status['1']).toBe('fixing');
  await card.getByRole('button',{name:'忽略',exact:true}).click(); await expect(card).toHaveCount(0);
  await expect.poll(() => state.ignored['1']).toBe(true);
  await page.locator('#toggle-ignored').click(); await expect(card).toHaveClass(/is-ignored/);
  await card.getByRole('button',{name:'取消忽略',exact:true}).click(); await expect(card).not.toHaveClass(/is-ignored/);
  await expect.poll(() => state.ignored['1']).toBeUndefined();
  for (const theme of ['dark','light']) {
    await setTheme(page,theme);
    for (const width of [1440,375]) {
      await page.setViewportSize({width,height:900}); await card.scrollIntoViewIfNeeded();
      const visibility=await page.evaluate(() => ({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth,small:[...document.querySelectorAll('body *')].filter(node=>node.getClientRects().length && node.textContent.trim() && parseFloat(getComputedStyle(node).fontSize)<11).map(node=>node.className)}));
      expect(visibility.scroll).toBe(visibility.client); expect(visibility.small).toEqual([]);
      await page.screenshot({path:testInfo.outputPath(`dashboard-compact-${width}-${theme}.png`)});
    }
  }
  await page.setViewportSize({width:1440,height:900});
  await page.reload(); await expect(page.locator('[data-tool-compact]')).toBeChecked();
  await expect(card.locator('select')).toHaveValue('fixing');
  await page.locator('.tool-density').click(); await expect(card.locator('.card-badges')).toBeVisible(); await expect(card.locator('.card-check')).toBeVisible();
  expect(errors).toEqual([]);
  writeFileSync(testInfo.outputPath('dashboard-state.json'),JSON.stringify({gap,...state},null,2));
});

test('long compact checklist preserves 15px text and bounded layout across breakpoints', async ({page}, testInfo) => {
  const output = generateChecklist(testInfo,true); await page.goto(fileUrl(output));
  await page.locator('.tool-density').click();
  const measurements = [];
  for (const theme of ['dark','light']) {
    await setTheme(page,theme);
    for (const width of [320,375,414,768,979,980,981,1440]) {
      await page.setViewportSize({width,height:900});
      const measurement = await page.evaluate(() => {
        const start=performance.now(); void document.querySelector('.content').offsetHeight;
        const small = [...document.querySelectorAll('body *')].filter(node => node.getClientRects().length && node.textContent.trim() && parseFloat(getComputedStyle(node).fontSize) < 11).map(node => node.className);
        return {scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth,small,ms:performance.now()-start};
      });
      expect(measurement.scroll).toBe(measurement.client); expect(measurement.small).toEqual([]);
      expect(await page.locator('.item label').first().evaluate(node => getComputedStyle(node).fontSize)).toBe('15px');
      measurements.push({width,theme,...measurement});
      if (width === 375 || width === 1440) await page.screenshot({path:testInfo.outputPath(`long-checklist-${width}-${theme}.png`)});
    }
  }
  const reflow = await page.evaluate(() => {
    const root=document.querySelector('.content');
    return [320,375,414,768,979,980,981,1440].map(width => {
      const start=performance.now(); root.style.width=width+'px'; void root.offsetHeight;
      const ms=performance.now()-start; root.style.width=''; return {width,ms};
    });
  });
  writeFileSync(testInfo.outputPath('long-checklist-measurements.json'),JSON.stringify({items:900,measurements,reflow},null,2));
});
