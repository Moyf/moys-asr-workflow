import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, disableOnboarding, findFreePort, generateWav, generateWaveformPayload, makeTempDir, startServer } from './helpers.mjs';
import { serverRequest, spawnServerProcess, stopServerProcess } from './server-process.mjs';

const python = process.env.MAW_E2E_PYTHON || 'uv';
const pythonPrefix = process.env.MAW_E2E_PYTHON ? [] : ['run','--frozen','python'];
let directory, source;
test.beforeAll(() => {
  directory = makeTempDir('filmstrip-cache');
  source = join(directory, 'source.mp4');
  execFileSync('ffmpeg', ['-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=12:duration=12',
    '-f','lavfi','-i','sine=frequency=440:duration=12','-c:v','libx264','-threads','2','-preset','ultrafast',
    '-pix_fmt','yuv420p','-c:a','aac','-shortest','-y',source], {timeout:20000,windowsHide:true,stdio:'pipe'});
});
test.afterAll(() => cleanupTempDir(directory));

async function fixture(mode, launcher = false) {
  const root = join(directory, `${mode}-${launcher ? 'launcher' : 'direct'}`);
  mkdirSync(root, {recursive:true});
  const media = join(root,mode==='audio'?'audio.wav':'video.mp4'), project = join(root,'project.mosp'), app = join(root,'.settings');
  if(mode==='audio')generateWav(media,12);else copyFileSync(source,media);
  writeFileSync(project, JSON.stringify({media, waveform:generateWaveformPayload(12000),
    segments:[{start:0,end:11000,text:'Synthetic cache navigation',items:[]}]}));
  const env = {...process.env,MAW_APP_DATA_ROOT:app,LOCALAPPDATA:app,XDG_CONFIG_HOME:app};
  if (['complete','partial'].includes(mode)) {
    // Real decoded frames and sidecar. Incomplete generation deliberately returns only
    // the first two requested points, leaving the other cells for the real worker.
    const script = `import json,sys\nfrom pathlib import Path\nfrom maw import thumbnail_cache as c, thumbnails as t\np=Path(sys.argv[1])\nmode=sys.argv[2]\ndef extract(path,targets,**kw):\n return t.extract_frames(path,[point for point in targets if point<4000],**kw)\nm=c.load_or_build_base(p,**({'batch_extract':extract,'keyframes':False} if mode=='partial' else {}))\nprint(json.dumps({'complete':m['base_complete'],'assets':[a['id'] for a in m['assets']]}))`;
    const metadata = JSON.parse(execFileSync(python,[...pythonPrefix,'-c',script,media,mode],{env,encoding:'utf8',timeout:30000,windowsHide:true}).trim());
    expect(metadata.complete).toBe(mode === 'complete');
  }
  const port = await findFreePort();
  if (!launcher) return {media, server:await startServer(project,media,port)};
  const proc = spawnServerProcess(python,[...pythonPrefix,'tests/e2e/fixtures/launcher-thumbnail-server.py',project,String(port)],{cwd:process.cwd(),env});
  let tail='';
  proc.stdout.on('data',chunk=>{tail=(tail+chunk.toString()).slice(-4000);});
  proc.stderr.on('data',chunk=>{tail=(tail+chunk.toString()).slice(-4000);});
  const url=`http://127.0.0.1:${port}/`;
  try {
    await expect.poll(async()=>{
      try {return (await serverRequest(`${url}api/startup-status`,{json:true})).body.status;}
      catch {return tail;}
    },{timeout:30000}).toBe('ready');
  } catch (error) {await stopServerProcess(proc);throw error;}
  return {media,server:{url,stop:()=>stopServerProcess(proc)}};
}

async function selectThumbnailMode(page, mode) {
  const select=page.locator('#waveform-thumbnail-mode');
  const openSettings=!(await select.isVisible());
  if(openSettings)await page.locator('#waveform-settings-toggle').click();
  await select.selectOption(mode);
  await expect(select).toHaveValue(mode);
  if(openSettings)await page.locator('#waveform-settings-toggle').click();
}

for (const launcher of [false,true]) {
  test(`complete sidecar is painted on ${launcher ? 'Launcher' : 'direct Server'} open and reload`,async({page})=>{
    const {server}=await fixture('complete',launcher);
    try {
      await disableOnboarding(page);
      await page.addInitScript(()=>localStorage.setItem('mawe-filmstrip-decode','false'));
      const states=[],assets=[],demands=[];
      page.on('request',request=>{
        if(new URL(request.url()).pathname==='/api/thumbnails/demand')demands.push(request.postDataJSON());
      });
      page.on('response',response=>{
        const url=new URL(response.url());
        if(url.pathname==='/api/thumbnails'||url.pathname==='/api/thumbnails/demand')
          void response.json().then(result=>states.push(result)).catch(()=>{});
        if(url.pathname.startsWith('/api/thumbnails/asset/'))assets.push(url.pathname);
      });
      await page.goto(server.url);
      await page.waitForFunction(()=>MaweCoreState.waveformEditor?.thumbnailController.bytes>0,null,{timeout:30000});
      await expect(page.locator('#waveform-thumbnail-mode')).toHaveValue('marks');
      await expect(page.locator('#waveform-thumbnail-status')).toHaveText('显示关键帧标记');
      await expect(page.locator('.waveform-filmstrip').first()).toBeVisible();
      await expect.poll(()=>assets.some(asset=>asset.includes('/sprite-'))).toBe(true);
      await expect.poll(()=>states.some(state=>state.base_complete&&state.samples.some(sample=>sample.asset?.startsWith('sprite-')))).toBe(true);
      const beforeStrip=demands.length;
      await selectThumbnailMode(page,'strip');
      await expect(page.locator('#waveform-thumbnail-status')).toHaveText('仅显示缓存缩略图，不实时补帧');
      await expect.poll(()=>demands.slice(beforeStrip).some(demand=>demand.visible&&demand.decode===false)).toBe(true);
      expect(demands.every(demand=>demand.decode===false)).toBe(true);
      await expect(page.locator('.waveform-filmstrip').first()).toBeVisible();
      await page.reload();
      await page.waitForFunction(()=>MaweCoreState.waveformEditor?.thumbnailController.bytes>0,null,{timeout:30000});
      await expect(page.locator('#waveform-thumbnail-mode')).toHaveValue('strip');
      await expect(page.locator('#waveform-thumbnail-decode')).not.toBeChecked();
      await expect(page.locator('.waveform-filmstrip').first()).toBeVisible();
      const evidence=join('.artifacts','filmstrip-cache',launcher?'launcher':'direct');
      mkdirSync(evidence,{recursive:true});
      await page.screenshot({path:join(evidence,'cache-reopened.png')});
      writeFileSync(join(evidence,'evidence.json'),JSON.stringify({states:states.map(({state,base_complete,samples=[]})=>({state,base_complete,samples:samples.length})),assets,demands},null,2));
    } finally {await server.stop();}
  });
}

test('cached thumbnails and timed words fit the single-row viewport together',async({page})=>{
  const {server}=await fixture('complete');
  try {
    await disableOnboarding(page);
    await page.goto(server.url);
    await page.waitForFunction(()=>MaweCoreState.waveformEditor?.thumbnailController.bytes>0,null,{timeout:30000});
    await selectThumbnailMode(page,'strip');
    await page.evaluate(()=>{
      AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0].items=[
        {start:0,end:3500,text:'Synthetic'},
        {start:3500,end:7000,text:'cache'},
        {start:7000,end:11000,text:'navigation'},
      ];
    });
    for(const viewport of [{width:1280,height:800},{width:900,height:600}]) {
      await page.setViewportSize(viewport);
      await page.locator('[data-waveform-mode="basic"]').click();
      await page.evaluate(()=>MaweWordTiming.setEnabled(true));
      await expect(page.locator('.waveform-filmstrip').first()).toBeVisible();
      await expect.poll(()=>page.evaluate(()=>{
        const editor=MaweCoreState.waveformEditor;
        const viewport=editor.scroll.getBoundingClientRect();
        const row=editor.renderedRows[0];
        const shell=row._thumbnailShell.getBoundingClientRect();
        const block=row.querySelector('.waveform-cue-block[data-track="main"]').getBoundingClientRect();
        return Math.min(shell.top-viewport.top,viewport.bottom-shell.bottom,viewport.bottom-block.bottom);
      })).toBeGreaterThanOrEqual(8);
      await expect(page.locator('.waveform-word-block').first()).toBeVisible();
      await page.locator('.waveform-pane').screenshot({path:test.info().outputPath(`cached-single-${viewport.width}.png`)});
    }
  } finally {await server.stop();}
});

test('partial sidecar is displayed and missing cells are filled by the real worker',async({page})=>{
  const {server}=await fixture('partial');
  try {
    await disableOnboarding(page);
    const states=[];
    page.on('response',response=>{
      if(['/api/thumbnails','/api/thumbnails/demand'].includes(new URL(response.url()).pathname))
        void response.json().then(result=>states.push(result)).catch(()=>{});
    });
    await page.goto(server.url);
    await page.waitForFunction(()=>MaweCoreState.waveformEditor?.thumbnailController.bytes>0,null,{timeout:30000});
    await expect(page.locator('#waveform-thumbnail-mode')).toHaveValue('marks');
    await expect.poll(()=>states.some(result=>!result.base_complete&&result.samples?.some(sample=>sample.asset?.startsWith('sprite-'))),{timeout:30000}).toBe(true);
    expect(states.some(result=>result.samples?.some(sample=>sample.requested_ms>=4000&&sample.status==='target'))).toBe(false);
    await selectThumbnailMode(page,'strip');
    await expect(page.locator('#waveform-thumbnail-decode')).toBeChecked();
    await expect.poll(()=>states.some(result=>result.samples?.some(sample=>sample.requested_ms>=4000&&sample.status==='target')),{timeout:30000}).toBe(true);
  } finally {await server.stop();}
});

for(const [mode,text] of [['audio','当前媒体没有可用画面'],['corrupt','画面缓存暂不可用']]) {
  test(`real worker ${mode==='audio'?'unavailable':'error'} state is distinguishable from hidden preference`,async({page})=>{
    const {media,server}=await fixture(mode);
    try {
      // Replace the already loaded test-owned media before the first thumbnail probe.
      if(mode==='corrupt')writeFileSync(media,'not a video');
      await disableOnboarding(page);
      await page.goto(server.url);
      await expect(page.locator('#waveform-thumbnail-mode')).toHaveValue('hidden');
      await selectThumbnailMode(page,'strip');
      await expect(page.locator('#waveform-thumbnail-status')).toHaveText(text,{timeout:30000});
      await page.waitForFunction(expected=>MaweCoreState.waveformEditor.thumbnailController.state===expected,mode==='audio'?'unavailable':'error');
      await expect(page.locator('.waveform-filmstrip')).toHaveCount(0);
      await expect(page.locator('#waveform-thumbnail-mode')).toBeEnabled();
      await expect(page.locator('#waveform-thumbnail-mode')).toHaveValue('strip');
      expect(await page.evaluate(()=>localStorage.getItem('mawe-filmstrip-mode'))).toBe('strip');
    } finally {await server.stop();}
  });
}

test('an explicit per-origin hidden preference stays hidden until the user enables thumbnails',async({page})=>{
  const {server}=await fixture('cold');
  try {
    await disableOnboarding(page);
    await page.addInitScript(()=>localStorage.setItem('mawe-filmstrip-mode','hidden'));
    const requests=[];
    page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/thumbnails'))requests.push(request.url());});
    await page.goto(server.url);
    await page.waitForFunction(()=>MaweCoreState.waveformEditor?.getPayload());
    await expect(page.locator('.waveform-filmstrip')).toHaveCount(0);
    await expect(page.locator('#waveform-thumbnail-status')).toHaveText('视频缩略图已隐藏');
    await expect(page.locator('#waveform-thumbnail-mode')).toHaveValue('hidden');
    expect(requests).toEqual([]);
    await selectThumbnailMode(page,'strip');
    await page.waitForFunction(()=>MaweCoreState.waveformEditor.thumbnailController.bytes>0,null,{timeout:30000});
    await expect(page.locator('.waveform-filmstrip').first()).toBeVisible();
    expect(await page.evaluate(()=>localStorage.getItem('mawe-filmstrip-mode'))).toBe('strip');
  } finally {await server.stop();}
});
