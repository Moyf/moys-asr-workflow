import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cleanupTempDir, disableOnboarding, findFreePort, generateWav, makeTempDir,
  startAlignmentServer, startServer } from './helpers.mjs';

test('existing take review exposes independent ASR confirmation and blocks unconfirmed wording',async({page})=>{
  const dir=makeTempDir('recording-review');let server;
  try {
    const media=generateWav(join(dir,'audio.wav'),7);
    const source=join(dir,'raw.mosp'),script=join(dir,'script.txt');
    writeFileSync(source,JSON.stringify({model:'qwen3-asr',language:'zh',media,segments:[
      {id:'s1',text:'你好世界',start:500,end:2000},
      {id:'s2',text:'今天介绍两种方法',start:3000,end:4000},
      {id:'s3',text:'额外补充说明',start:4500,end:5500},
    ]}));
    writeFileSync(script,'你好，世界。\n今天介绍三种方法。');
    server=await startAlignmentServer(source,script,await findFreePort());
    await page.goto(server.url);
    await page.locator('#recording-enable').check();
    await expect(page.locator('#recording-status')).toContainText('原始 ASR');
    await page.locator('#recording-source').check();
    await expect(page.locator('#recording-status')).toContainText('有差异');
    await expect(page.locator('#recording-generate')).toBeDisabled();
    await page.locator('#recording-lines input[data-line-id="line-002"]').check();
    await expect(page.locator('#recording-generate')).toBeEnabled();
    const gap=await page.locator('.recording-actions').evaluate(node=>node.getBoundingClientRect().top-node.previousElementSibling.getBoundingClientRect().bottom);
    expect(gap).toBeGreaterThanOrEqual(8);
    writeFileSync(test.info().outputPath("spacing.json"),JSON.stringify({minimum:8,measuredVerticalGap:gap},null,2));
    await page.locator('#recording-panel').screenshot({path:test.info().outputPath('recording-review.png')});
    await page.locator('#skip-gap-playback').uncheck();
    const gapRange=page.locator('#gap-overlay .gap-range:not(.gap-range-preview)').first();
    await expect(gapRange).toBeVisible();
    await gapRange.click({modifiers:['Alt']});
    await expect(gapRange).toHaveClass(/restored/);
    await expect.poll(()=>page.evaluate(()=>window.MAWRecordingReview.snapshot().gapRemove?.gaps.some(g=>g.removed===false))).toBe(true);
    await expect.poll(()=>page.evaluate(()=>{
      const signature=window.MAWRecordingReview.snapshot().inputSignature;
      return JSON.parse(localStorage.getItem('maw.recording.review.v1.'+signature))?.gapRemove?.gaps.some(g=>g.removed===false);
    })).toBe(true);
    await page.reload();
    await expect(page.locator('#recording-enable')).toBeChecked();
    await expect(page.locator('#recording-lines input[data-line-id="line-002"]')).toBeChecked();
    await expect(page.locator('#recording-generate')).toBeEnabled();
    await expect(page.locator('#skip-gap-playback')).not.toBeChecked();
    await expect(page.locator('#gap-overlay .gap-range.restored')).toHaveCount(1);
    expect(await page.evaluate(()=>{
      const signature=window.MAWRecordingReview.snapshot().inputSignature;
      return JSON.parse(localStorage.getItem('maw.recording.review.v1.'+signature)).requestToken;
    })).toBeUndefined();
    const state=await(await page.request.get(server.url+'api/state')).json();
    const noToken=await page.request.post(server.url+'api/recording/start',{data:{inputSignature:state.recordingInputSignature}});
    expect(noToken.status()).toBe(403);
  } finally {await server?.stop();cleanupTempDir(dir);}
});

test('generated script project retains extra content, gap decisions and original timings through MAWE save',async({page})=>{
  const dir=makeTempDir('recording-final-roundtrip');let server;
  try {
    const media=generateWav(join(dir,'audio.wav'),5),source=join(dir,'raw.mosp'),script=join(dir,'script.txt');
    writeFileSync(source,JSON.stringify({model:'qwen3-asr',language:'zh',media,segments:[
      {id:'source-1',text:'你好世界',start:500,end:2000},
      {id:'source-2',text:'额外说明',start:3000,end:4000},
    ]}));
    writeFileSync(script,'你好，世界。');
    const code=`
import json,sys
from pathlib import Path
from unittest import mock
from maw.script_alignment import align_project_to_script
from maw.script_recording_workflow import input_signature,run_recording_job,load_recording_inputs
from maw.timestamp_alignment import TimedToken
source,script=Path(sys.argv[1]),Path(sys.argv[2])
project,text,media=load_recording_inputs(source,script)
alignment=align_project_to_script(project,text)
request={"selectedByLine":alignment["defaultSelection"],"sourceConfirmed":True,"inputSignature":input_signature(source,script,media)}
class Backend:
    def align(self,audio,text,*,language=None):
        return [TimedToken("你",100,300),TimedToken("好",300,500),TimedToken("世",600,800),TimedToken("界",800,1100)]
with mock.patch("maw.local_asr.create_local_engine",side_effect=AssertionError("ASR must not rerun")):
    print(json.dumps(run_recording_job(source,script,request,backend=Backend())))
`;
    const python=process.env.MAW_E2E_PYTHON;
    const result=JSON.parse(execFileSync(python,['-c',code,source,script],{encoding:'utf8'}).trim().split('\n').at(-1));
    const before=JSON.parse(readFileSync(result.projectPath,'utf8'));
    server=await startServer(result.projectPath,media,await findFreePort());
    await disableOnboarding(page);await page.goto(server.url);
    await page.waitForFunction(()=>window.MAWE_EDITOR_BRIDGE?.data?.segments.length===2);
    const take=()=>page.evaluate(()=>({
      segments:MaweBoot.DATA.segments.map(({id,text,start,end,items})=>({id,text,start,end,items:items||[]})),
      gap:MaweBoot.DATA.gap_remove,recording:MaweBoot.DATA.script_alignment.recording,
    }));
    const initial=await take();
    expect(initial.segments.map(c=>c.text)).toEqual(['你好，世界。','额外说明']);
    expect(initial.segments[0].items.map(c=>[c.start,c.end])).toEqual([[600,800],[800,1000],[1100,1300],[1300,1600]]);
    const saved=page.waitForResponse(r=>r.url().endsWith('/api/project')&&r.request().method()==='POST');
    await page.locator('#save-project').click();expect((await saved).ok()).toBe(true);
    await page.reload();await page.waitForFunction(()=>window.MAWE_EDITOR_BRIDGE?.data?.segments.length===2);
    expect(await take()).toEqual(initial);
    expect(JSON.parse(readFileSync(source,'utf8')).segments[0].text).toBe('你好世界');
    expect(before.gap_remove.gaps).toEqual(initial.gap.gaps);
    await page.screenshot({path:test.info().outputPath('recording-mawe-roundtrip.png')});
  } finally {await server?.stop();cleanupTempDir(dir);}
});

test('Launcher recording mode reuses selected ASR settings and opens its raw project',async({page})=>{
  await page.goto(pathToFileURL(resolve('web/launcher/index.html')).href);
  await page.waitForFunction(()=>window.MAWLauncher?.config?.postprocessProviders?.length>0);
  await page.locator('#toolboxFab').click();await page.locator('#toolboxUtilitiesPrimaryTab').click();await page.locator('#toolboxAlignmentTab').click();
  await page.locator('#toolboxRecordingInputMode').selectOption('recording');
  await expect(page.locator('#toolboxAlignmentProjectDropZone')).toBeHidden();
  await page.locator('#toolboxAlignmentScriptPath').fill('/tmp/script.txt');
  await page.evaluate(()=>{
    const original=window.MAWLauncher.callBackend;
    window.MAWLauncher.callBackend=async(method,payload)=>{
      if(method==='start_recording_review'){window.recordingPayload=payload;return {ok:true,status:'running'};}
      if(method==='recording_review_status')return {ok:true,status:'ready',projectPath:'/tmp/raw.mosp',scriptPath:'/tmp/script.txt',mediaPath:'/tmp/audio.wav'};
      if(method==='start_alignment_server'){window.recordingServerPayload=payload;return {ok:true,url:'http://127.0.0.1:8260/'};}
      if(method==='open_url')return {ok:true};
      return original(method,payload);
    };
  });
  await page.locator('#runToolboxAlignment').click();
  await expect(page.locator('#toolboxAlignmentProjectPath')).toHaveValue('/tmp/raw.mosp');
  expect(await page.evaluate(()=>window.recordingPayload.scriptPath)).toBe('/tmp/script.txt');
  expect(await page.evaluate(()=>window.recordingPayload.transcription.providerId)).toBeTruthy();
  expect(await page.evaluate(()=>window.recordingServerPayload.projectPath)).toBe('/tmp/raw.mosp');
  const gap=await page.locator('#toolboxAlignmentInputs').evaluate(node=>node.getBoundingClientRect().top-node.previousElementSibling.getBoundingClientRect().bottom);
  expect(gap).toBeGreaterThanOrEqual(8);
  writeFileSync(test.info().outputPath("spacing.json"),JSON.stringify({minimum:8,measuredVerticalGap:gap},null,2));
  await page.locator('#toolboxAlignmentPanel').screenshot({path:test.info().outputPath('recording-launcher.png')});
});

test('review can retry after failure and resume cancellation or source fill after reload',async({page})=>{
  const dir=makeTempDir('recording-lifecycle');let server;
  try {
    const media=generateWav(join(dir,'audio.wav'),3),source=join(dir,'raw.mosp'),script=join(dir,'script.txt');
    writeFileSync(source,JSON.stringify({model:'qwen3-asr',language:'zh',media,
      segments:[{id:'s1',text:'你好世界',start:500,end:2000}]}));
    writeFileSync(script,'你好，世界。');
    server=await startAlignmentServer(source,script,await findFreePort());
    let status='idle',operation='start',starts=0;
    const body=()=>({ok:true,status,operation,message:status==='error'?'模拟模型失败':status,
      ...(status==='complete'?{artifact:{projectPath:'filled.mosp'}}:{})});
    await page.route('**/api/recording/status',route=>route.fulfill({json:body()}));
    await page.route('**/api/recording/start',route=>{starts++;status='error';return route.fulfill({json:{ok:true,status:'running',operation}});});
    await page.route('**/api/recording/cancel',route=>{status='cancelled';return route.fulfill({json:body()});});
    await page.route('**/api/recording/fill',route=>{operation='fill';status='complete';return route.fulfill({json:body()});});
    await page.goto(server.url);await page.locator('#recording-enable').check();await page.locator('#recording-source').check();
    await expect(page.locator('#recording-generate')).toBeEnabled();
    await page.locator('#recording-generate').click();
    await expect(page.locator('#recording-status')).toContainText('模拟模型失败');
    await expect(page.locator('#recording-generate')).toBeEnabled();
    await page.locator('#recording-generate').click();
    await expect.poll(()=>starts).toBe(2);
    await expect(page.locator('#recording-generate')).toBeEnabled();
    status='running';await page.reload();
    await expect(page.locator('#recording-cancel')).toBeEnabled();
    await expect(page.locator('#recording-generate')).toBeDisabled();
    await page.locator('#recording-cancel').click();
    await expect(page.locator('#recording-status')).toContainText('cancelled');
    await expect(page.locator('#recording-generate')).toBeEnabled();
    await page.locator('#recording-fill').click();
    await expect(page.locator('#recording-status')).toContainText('已补码');
    await expect(page.locator('#recording-status')).toContainText('filled.mosp');
    await page.locator('#recording-panel').screenshot({path:test.info().outputPath('recording-lifecycle.png')});
  } finally {await server?.stop();cleanupTempDir(dir);}
});
