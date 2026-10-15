import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { cleanupTempDir, DURATION_MS, findFreePort, generateProjectJson, generateWav, makeTempDir, startServer, disableOnboarding } from './helpers.mjs';
let tempDir, server;
test.beforeAll(async()=>{
  tempDir=makeTempDir('filmstrip');
  const media=join(tempDir,'synthetic.wav'), project=join(tempDir,'project.json');
  generateWav(media,DURATION_MS/1000); generateProjectJson(project);
  server=await startServer(project,media,await findFreePort());
});
test.afterAll(async()=>{await server?.stop();cleanupTempDir(tempDir);});

async function enableFilmstrip(page) {
  const demands=[];
  const png=await page.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=160;canvas.height=90;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#27686c';ctx.fillRect(0,0,160,90);
    ctx.fillStyle='#eaa763';ctx.beginPath();ctx.arc(80,45,25,0,Math.PI*2);ctx.fill();
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.route('**/__filmstrip/**',async route=>{
    const request=route.request(), url=new URL(request.url());
    if(url.pathname.includes('/asset/')) {
      await route.fulfill({contentType:'image/png',body:Buffer.from(png,'base64')}); return;
    }
    const body=request.method()==='POST'?request.postDataJSON():null;
    if(body)demands.push(body);
    if(url.pathname.endsWith('/release')) {await route.fulfill({json:{ok:true}});return;}
    const interval=body?.interval_ms||2000;
    await route.fulfill({json:{binding:'test-video',view:body?.view??Number(url.searchParams.get('view')),lease:'test-lease',state:'ready',
      source_identity:{signature:'fixture',stream:0},cache_revision:'fixture-1',duration_ms:DURATION_MS,persisted:false,
      asset_url_template:'/__filmstrip/asset/{asset}?binding={binding}&revision={cache_revision}',
      samples:Array.from({length:Math.ceil(DURATION_MS/interval)},(_,index)=>({requested_ms:index*interval,actual_pts_ms:index*interval,
        status:'target',asset:'frame',crop_rect:[0,0,160,90],cache_revision:'fixture-1',image_spec:{width:160,height:90}}))}});
  });
  await page.evaluate(()=>{
    MaweBoot.SERVER_CONFIG.thumbnailUrls={status:'/__filmstrip/status',demand:'/__filmstrip/demand',asset:'/__filmstrip/asset/',release:'/__filmstrip/release'};
    MaweBoot.SERVER_CONFIG.thumbnailBinding='test-video';
    MaweBoot.SERVER_CONFIG.thumbnailBaseReady=true;
    MaweCoreState.waveformEditor.thumbnailController.setEnabled(true);
    MaweCoreState.waveformEditor.thumbnailController.setMode('strip');
    MaweCoreState.waveformEditor.setThumbnailBinding('test-video');
  });
  await expect(page.locator('.waveform-filmstrip').first()).toBeVisible();
  await page.waitForFunction(()=>MaweCoreState.waveformEditor.thumbnailController.bytes>0);
  return demands;
}

test('filmstrip preserves the waveform region, seek and scroll anchor',async({page})=>{
  await disableOnboarding(page); await page.goto(server.url);
  await page.waitForFunction(()=>MaweCoreState.waveformEditor?.getPayload() && document.getElementById('player').readyState>=1);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const previous=await page.locator('.waveform-row').first().evaluate(row=>row.getBoundingClientRect().height);
  const demands=await enableFilmstrip(page);
  const geometry=await page.locator('.waveform-row').first().evaluate(row=>({height:row.getBoundingClientRect().height,
    shellHeight:row._thumbnailShell.getBoundingClientRect().height,offset:row.getBoundingClientRect().top-row._thumbnailShell.getBoundingClientRect().top,
    filmstrip:row._thumbnailCanvas.getBoundingClientRect().height}));
  expect(geometry.height).toBe(previous);expect(geometry.shellHeight).toBe(previous+48);expect(geometry.offset).toBe(48);expect(geometry.filmstrip).toBe(48);
  const canvas=page.locator('.waveform-filmstrip').first();const box=await canvas.boundingBox();
  const cueCount=await page.evaluate(()=>MaweBoot.DATA.segments.length);
  await page.keyboard.down('Control');await page.mouse.click(box.x+box.width*.5,box.y+24);await page.keyboard.up('Control');
  const time=await page.evaluate(()=>document.getElementById('player').currentTime);
  expect(time).toBeGreaterThan(4.8);expect(time).toBeLessThan(5.2);
  expect(await page.evaluate(()=>MaweBoot.DATA.segments.length)).toBe(cueCount);
  await page.screenshot({path:'.artifacts/filmstrip/filmstrip-multi.png'});
  await page.locator('#waveform-settings-toggle').click();
  const spacing=await page.locator('#waveform-thumbnail-setting').evaluate(row=>{
    const rect=row.getBoundingClientRect(),above=row.previousElementSibling.getBoundingClientRect(),below=row.nextElementSibling.getBoundingClientRect();
    return {above:rect.top-above.bottom,below:below.top-rect.bottom,marginTop:getComputedStyle(row).marginTop,marginBottom:getComputedStyle(row).marginBottom};
  });
  expect(spacing.above).toBeGreaterThanOrEqual(8);expect(spacing.below).toBeGreaterThanOrEqual(8);
  writeFileSync('.artifacts/filmstrip/filmstrip-checkbox-spacing.json',JSON.stringify(spacing,null,2)+'\n');
  await expect(page.locator('#waveform-thumbnail-status')).toContainText('本次会话缓存');
  await page.screenshot({path:'.artifacts/filmstrip/filmstrip-settings.png'});
  await page.evaluate(()=>window.MAWE_I18N.applyLanguage('en',false));
  await expect(page.locator('#waveform-thumbnail-status')).toHaveText('Pictures ready · Session cache');
  await expect(page.locator('#waveform-thumbnail-mode')).toHaveValue('strip');
  await expect(page.locator('#waveform-thumbnail-mode option[value="marks"]')).toHaveText('Keyframe marks');
  await page.screenshot({path:'.artifacts/filmstrip/filmstrip-settings-en.png'});
  await page.evaluate(()=>window.MAWE_I18N.applyLanguage('zh',false));
  await page.locator('#waveform-settings-toggle').click();
  const anchors=await page.evaluate(async()=>{
    const wave=MaweCoreState.waveformEditor,scroll=wave.scroll;
    scroll.scrollTop=4.37*(wave.getTimelineRowHeight()+10);wave.renderMultiVisible();
    const before=scroll.scrollTop/(wave.getTimelineRowHeight()+10);
    wave.thumbnailController.setEnabled(false);
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    return {before,after:scroll.scrollTop/(wave.getTimelineRowHeight()+10)};
  });
  expect(anchors.after).toBeCloseTo(anchors.before,2);await expect(page.locator('.waveform-filmstrip')).toHaveCount(0);
  expect(demands.some(demand=>demand.binding==='test-video')).toBe(true);
  await page.evaluate(()=>{const wave=MaweCoreState.waveformEditor;wave.thumbnailController.setMode('marks');wave.renderMultiVisible();});
  await expect(page.locator('.waveform-filmstrip').first()).toBeVisible();
  await page.evaluate(()=>MaweCoreState.waveformEditor.thumbnailController.setMode('strip'));
  await expect(page.locator('.waveform-filmstrip').first()).toBeVisible();
  await page.evaluate(()=>{const wave=MaweCoreState.waveformEditor;wave.settings.mode='basic';wave.render();});
  await expect(page.locator('.waveform-filmstrip')).toHaveCount(1);
  await page.evaluate(()=>{
    const wave=MaweCoreState.waveformEditor;
    wave.settings.visibleSeconds=10;wave.basicWindowStartMs=0;wave.render();
    const row=wave.renderedRows[0];
    row.dataset.testIdentity='stable';
    row.querySelector('canvas.waveform-canvas').dataset.testIdentity='stable';
    row._thumbnailCanvas.dataset.testIdentity='stable';
  });
  const basicRow=page.locator('.waveform-row').first();
  const basicBox=await basicRow.boundingBox();
  await page.mouse.move(basicBox.x+basicBox.width/2,basicBox.y+basicBox.height/2);
  await page.mouse.wheel(0,120);
  await expect.poll(()=>basicRow.getAttribute('data-start-ms')).toBe('1200');
  await expect(basicRow).toHaveAttribute('data-test-identity','stable');
  await expect(basicRow.locator('canvas.waveform-canvas')).toHaveAttribute('data-test-identity','stable');
  await expect(page.locator('.waveform-filmstrip')).toHaveAttribute('data-test-identity','stable');
  await expect(page.locator('.waveform-row-shell-basic > .waveform-row')).toHaveCount(1);
  await page.screenshot({path:'.artifacts/filmstrip/filmstrip-basic.png'});
  expect(errors).toEqual([]);
});


test('filmstrip dragging seeks across rows and keeps source-frame snapping',async({page})=>{
  await disableOnboarding(page);await page.goto(server.url);
  await page.waitForFunction(()=>MaweCoreState.waveformEditor?.getPayload()&&document.getElementById('player').readyState>=1);
  await enableFilmstrip(page);
  await page.evaluate(()=>{const wave=MaweCoreState.waveformEditor;wave.settings.dragPlayhead=true;wave.scroll.scrollTop=0;wave.renderMultiVisible();});
  const first=await page.locator('.waveform-row-shell[data-row-index="0"] .waveform-filmstrip').boundingBox();
  const second=await page.locator('.waveform-row-shell[data-row-index="1"] .waveform-filmstrip').boundingBox();
  await page.mouse.move(first.x+first.width*.3,first.y+24);await page.mouse.down();
  await page.mouse.move(second.x+second.width*.5,second.y+24,{steps:8});await page.mouse.up();
  expect(await page.evaluate(()=>document.getElementById('player').currentTime)).toBeCloseTo(15,1);
  await page.evaluate(()=>{MaweBoot.DATA.timebase={unit:'frames',fps:24};MaweTimeline.syncProjectTimebase();MaweSettings.EDITOR_SETTINGS.timelineSnapToFrame=true;});
  const current=await page.locator('.waveform-row-shell[data-row-index="1"] .waveform-filmstrip').boundingBox();
  const x=current.x+current.width*.437;
  const expected=await page.locator('.waveform-row[data-row-index="1"]').evaluate((row,x)=>MaweCoreState.waveformEditor.pointerTimeMs({clientX:x},row)/1000,x);
  await page.mouse.click(x,current.y+24);
  expect(await page.evaluate(()=>document.getElementById('player').currentTime)).toBeCloseTo(expected,3);
});
