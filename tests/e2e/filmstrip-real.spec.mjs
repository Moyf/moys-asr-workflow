import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, disableOnboarding, findFreePort, generateWav, generateWaveformPayload, makeTempDir, startServer } from './helpers.mjs';

let tempDir, server, media, replacement, project, projectJson;
const durationMs=52400;
test.beforeAll(async()=>{
  tempDir=makeTempDir('filmstrip-real');media=join(tempDir,'navigation.mp4');replacement=join(tempDir,'replacement.wav');
  // All footage is synthetic and generated only inside this test's temporary directory.
  execFileSync('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=24:duration=52.4',
    '-f','lavfi','-i','sine=frequency=440:duration=52.4','-c:v','libx264','-preset','ultrafast',
    '-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart','-shortest','-y',media],{timeout:30000,windowsHide:true,stdio:'pipe'});
  generateWav(replacement,2);
  project=join(tempDir,'navigation.mosp');
  projectJson=JSON.stringify({media,waveform:generateWaveformPayload(durationMs),segments:[
    {id:'cue-a',start:500,end:7000,text:'First scene',items:[{start:1000,end:2500,text:'First'},{start:3000,end:6000,text:'scene'}]},
    {id:'cue-b',start:12000,end:16000,text:'Second scene',items:[]},
  ],markers:[{id:'scene-mark',start:2000,name:'Scene marker',note:''}]});
  writeFileSync(project,projectJson,'utf8');
});
test.beforeEach(async()=>{
  // Saving correctly removes inline waveform caches; restore this test-owned baseline.
  writeFileSync(project,projectJson,'utf8');
  server=await startServer(project,media,await findFreePort());});
test.afterEach(async()=>{await server?.stop();server=null;});
test.afterAll(async()=>{await server?.stop();cleanupTempDir(tempDir);});

function matchingDecoders() {
  if(process.platform!=='win32')return [];
  const escaped=media.replaceAll("'","''");
  const script=`Get-CimInstance Win32_Process -Filter "Name='ffmpeg.exe'" | Where-Object { $_.CommandLine -like '*${escaped}*' } | Select-Object -ExpandProperty ProcessId | ConvertTo-Json -Compress`;
  const output=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',timeout:10000,windowsHide:true}).trim();
  if(!output)return [];
  const parsed=JSON.parse(output);return Array.isArray(parsed)?parsed:[parsed];
}

async function opened(page) {
  await disableOnboarding(page);await page.addInitScript(()=>{
    localStorage.setItem('mawe-filmstrip-visible','true');
    localStorage.setItem('moy.asr.editor.settings.v1',JSON.stringify({autoSaveProject:false,autoSnapAdjacentCues:false}));
  });
  const states=[], requests=[];
  page.on('response',response=>{
    const path=new URL(response.url()).pathname;
    if((path==='/api/thumbnails'||path==='/api/thumbnails/demand')&&response.ok())void response.json().then(body=>states.push(body)).catch(()=>{});
  });
  page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname.startsWith('/api/thumbnails/'))requests.push({url:request.url(),body:request.postDataJSON()});});
  await page.goto(server.url);await expect(page.locator('.waveform-filmstrip').first()).toBeVisible();
  await page.waitForFunction(()=>MaweCoreState.waveformEditor.thumbnailController.bytes>0,{},{timeout:30000});
  await expect.poll(()=>states.some(state=>state.samples?.length>0),{timeout:30000}).toBe(true);
  return {states,requests};
}

test('real video frames stay cached during playback, stop decoding and resume the current view',async({page})=>{
  const {states,requests}=await opened(page);
  expect(states.some(state=>['idle','queued','generating','partial'].includes(state.state))).toBe(true,'initial view loads incrementally');
  await page.evaluate(()=>{const wave=MaweCoreState.waveformEditor;wave.setSecondsPerRow(2);wave.scroll.scrollTop=0;wave.renderMultiVisible();});
  await page.evaluate(()=>{const player=document.getElementById('player');player.muted=true;return player.play();});
  await expect.poll(()=>states.some(state=>state.state==='paused'&&state.decoding===false),{timeout:15000}).toBe(true);
  if(process.platform==='win32')await expect.poll(matchingDecoders,{timeout:10000}).toEqual([]);
  const cached=await page.evaluate(()=>({bytes:MaweCoreState.waveformEditor.thumbnailController.bytes,
    frame:document.querySelector('.waveform-filmstrip').toDataURL()}));
  expect(cached.bytes).toBeGreaterThan(0);
  // Advance into another time row while playing; dispatch remains paused, valid cached frames stay drawable.
  await page.evaluate(()=>{const wave=MaweCoreState.waveformEditor;wave.scroll.scrollTop=2*(wave.getTimelineRowHeight()+10);wave.renderMultiVisible();});
  await expect.poll(()=>states.at(-1)?.state,{timeout:10000}).toBe('paused');
  await page.screenshot({path:'.artifacts/filmstrip/filmstrip-real-playing.png'});
  expect(await page.evaluate(()=>MaweCoreState.waveformEditor.thumbnailController.bytes)).toBeGreaterThan(0);
  const resumeAt=states.length;
  await page.evaluate(()=>document.getElementById('player').pause());
  await expect.poll(()=>states.at(-1)?.state,{timeout:15000}).not.toBe('paused');
  await expect.poll(()=>states.slice(resumeAt).some(state=>state.samples?.some(sample=>sample.status==='target'&&sample.requested_ms%1000!==0)),{timeout:20000}).toBe(true,'pause completes fine-grid targets in the current view');
  await page.waitForFunction(()=>MaweCoreState.waveformEditor.thumbnailController.bytes>0);
  await page.screenshot({path:'.artifacts/filmstrip/filmstrip-real-paused.png'});
  const beforeHide=await page.evaluate(()=>MaweCoreState.waveformEditor.thumbnailController.bytes);
  await page.evaluate(()=>MaweCoreState.waveformEditor.thumbnailController.setEnabled(false));
  await expect(page.locator('.waveform-filmstrip')).toHaveCount(0);
  await expect.poll(()=>requests.filter(request=>new URL(request.url).pathname.endsWith('/release')).length).toBeGreaterThan(0);
  expect(await page.evaluate(()=>MaweCoreState.waveformEditor.thumbnailController.bytes)).toBe(beforeHide);
  await page.evaluate(()=>MaweCoreState.waveformEditor.thumbnailController.setEnabled(true));
  await expect(page.locator('.waveform-filmstrip').first()).toBeVisible();
  await page.setInputFiles('#load-media-file',replacement);
  await expect(page.locator('.waveform-filmstrip')).toHaveCount(0);
  expect(await page.evaluate(()=>MaweBoot.SERVER_CONFIG.thumbnailBinding)).toBe('');
  await expect(page.locator('#waveform-show-thumbnails')).toBeDisabled();
  await expect(page.locator('#waveform-thumbnail-status')).toHaveText('从本机 Server 加载视频后可用');
  writeFileSync('.artifacts/filmstrip/filmstrip-real-evidence.json',JSON.stringify({states:states.map(({state,decoding,samples})=>({state,decoding,samples:samples.length})),releaseCount:requests.filter(request=>new URL(request.url).pathname.endsWith('/release')).length},null,2)+'\n');
});

test('video filmstrip respects tail width, cross-row seek, frame snapping and existing cue/word/marker editing',async({page})=>{
  await opened(page);
  await page.evaluate(()=>{const wave=MaweCoreState.waveformEditor;wave.settings.dragPlayhead=true;wave.setSecondsPerRow(10);wave.scroll.scrollTop=0;wave.renderMultiVisible();});
  const first=await page.locator('.waveform-row-shell[data-row-index="0"] .waveform-filmstrip').boundingBox();
  const next=await page.locator('.waveform-row-shell[data-row-index="1"] .waveform-filmstrip').boundingBox();
  await page.mouse.move(first.x+first.width*.3,first.y+24);await page.mouse.down();
  await page.mouse.move(next.x+next.width*.5,next.y+24,{steps:8});await page.mouse.up();
  expect(await page.evaluate(()=>document.getElementById('player').currentTime)).toBeCloseTo(15,1);
  await page.evaluate(()=>{MaweBoot.DATA.timebase={unit:'frames',fps:24};MaweTimeline.syncProjectTimebase();MaweSettings.EDITOR_SETTINGS.timelineSnapToFrame=true;});
  const snap=await page.locator('.waveform-row-shell[data-row-index="1"] .waveform-filmstrip').boundingBox();
  const targetX=snap.x+snap.width*.437;
  const expected=await page.locator('.waveform-row[data-row-index="1"]').evaluate((row,x)=>MaweCoreState.waveformEditor.pointerTimeMs({clientX:x},row)/1000,targetX);
  await page.mouse.click(targetX,snap.y+24);
  expect(await page.evaluate(()=>document.getElementById('player').currentTime)).toBeCloseTo(expected,3);
  await page.evaluate(()=>{const wave=MaweCoreState.waveformEditor;wave.scroll.scrollTop=4*(wave.getTimelineRowHeight()+10);wave.renderMultiVisible();});
  const tail=await page.locator('.waveform-row[data-row-index="5"]').evaluate(row=>({width:row._thumbnailShell.getBoundingClientRect().width,
    total:row.parentElement.parentElement.clientWidth,span:Number(row.dataset.endMs)-Number(row.dataset.startMs),duration:MaweCoreState.waveformEditor.settings.secondsPerRow*1000}));
  expect(tail.width/tail.total).toBeCloseTo(tail.span/tail.duration,2);
  await page.evaluate(()=>{const wave=MaweCoreState.waveformEditor;wave.scroll.scrollTop=0;wave.renderMultiVisible();});
  const cue=page.locator('.waveform-cue-block[data-idx="0"]').first();await cue.click({position:{x:30,y:18}});await expect(cue).toHaveClass(/selected/);
  const before=await page.evaluate(()=>MaweBoot.DATA.segments[0].start), box=await cue.boundingBox();
  await page.mouse.move(box.x+40,box.y+18);await page.mouse.down();await page.mouse.move(box.x+65,box.y+18,{steps:5});await page.mouse.up();
  expect(await page.evaluate(()=>MaweBoot.DATA.segments[0].start)).toBeGreaterThan(before);
  await page.keyboard.press('ControlOrMeta+z');
  const quick=page.locator('#word-timing-quick-toggle');if(await quick.getAttribute('aria-pressed')!=='true')await quick.click();
  const word=page.locator('.waveform-word-block[data-segment-idx="0"][data-item-idx="0"]').first();await expect(word).toBeVisible();
  const wordBox=await word.boundingBox(),wordBefore=await page.evaluate(()=>MaweBoot.DATA.segments[0].items[0].start);
  await page.mouse.move(wordBox.x+15,wordBox.y+15);await page.mouse.down();await page.mouse.move(wordBox.x+35,wordBox.y+15,{steps:4});await page.mouse.up();
  expect(await page.evaluate(()=>MaweBoot.DATA.segments[0].items[0].start)).toBeGreaterThan(wordBefore);
  const mark=page.locator('.waveform-marker-item[data-marker-id="scene-mark"]').first();await expect(mark).toBeVisible();await mark.dblclick();
  const name=page.locator('.waveform-marker-quick-edit input[type="text"]').first();await name.fill('Updated scene');await name.press('Tab');
  expect(await page.evaluate(()=>MaweBoot.DATA.markers.find(marker=>marker.id==='scene-mark').name)).toBe('Updated scene');
  await page.keyboard.press('Escape');
  await page.evaluate(()=>MaweCoreState.waveformEditor.setRowHeight(64));
  expect(await page.locator('.waveform-row').first().evaluate(row=>row.getBoundingClientRect().height)).toBe(64);
  await page.screenshot({path:'.artifacts/filmstrip/filmstrip-real-interactions.png'});
});
