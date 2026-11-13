import {expect,test} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

function candidate(word,score=90,overrides={}) {
  return {word,score,recommended:true,ai:{verdict:'keep',type:'other',reason:'synthetic'},
    export:{ok:true,reason:null},events:[],contexts:[],variants:[],eventCount:1,hitCount:1,avgConf:.9,...overrides};
}

function generateReport(testInfo,candidates,overrides={}) {
  const payload={video:'synthetic.mp4',fps:.2,model:'small',durationMs:20000,minScore:60,
    scan:{framesTotal:4,framesScanned:3,framesSkippedDuplicate:0,framesPlanned:20,truncated:true,sampledThroughMs:15000,framesFailed:1},
    region:{mode:'bottom30',x1:0,y1:.7,x2:1,y2:1},createdAt:'2026-11-10',
    aiEnabled:true,aiModel:'synthetic-model',aiStatus:'complete',weightByScore:true,candidates,...overrides};
  const input=testInfo.outputPath('report-data.json');
  const output=testInfo.outputPath('report.html');
  const script=testInfo.outputPath('generate.py');
  writeFileSync(input,JSON.stringify(payload));
  // File-backed Python source/JSON: no credentials, shell quoting or live OCR.
  writeFileSync(script,`import importlib.util, json, sys
from pathlib import Path
source = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("term_report_fixture", source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.write_report_html(Path(sys.argv[3]), json.loads(Path(sys.argv[2]).read_text(encoding="utf-8")))
`);
  execFileSync(process.env.MAW_E2E_PYTHON||'python',[
    script,process.env.MAW_TERM_REPORT_SOURCE||resolve('tools/term-extract/term_extract/report.py'),input,output,
  ],{timeout:15000});
  return pathToFileURL(output).href;
}

async function downloadText(page) {
  const pending=page.waitForEvent('download');
  await page.locator('#export-btn').click();
  const download=await pending;
  expect(download.suggestedFilename()).toBe('hotwords.txt');
  return readFileSync(await download.path(),'utf8');
}

function writeEvidenceFrame(testInfo,destination) {
  const script=testInfo.outputPath('generate-frame.py');
  writeFileSync(script,'import sys\nfrom PIL import Image\nImage.new("RGB", (20, 20), (80, 120, 160)).save(sys.argv[1], "JPEG")\n');
  execFileSync(process.env.MAW_E2E_PYTHON||'python',[script,destination],{timeout:15000});
}

function evidenceFixture(testInfo) {
  // A descriptive test-result slug plus frames/run-<generation>/<frame> can
  // exceed Chromium's Windows file-path limit. Keep the real files in a short,
  // unique sibling directory that is still covered by the output artifact.
  const directory=mkdtempSync(resolve(testInfo.project.outputDir,'evidence-'));
  return {outputPath:name=>resolve(directory,name)};
}

async function expectDecodedImage(image,src,timeout=5000) {
  await expect(image).toHaveAttribute('src',src,{timeout});
  await expect.poll(()=>image.evaluate(async (image,src)=>{
    if(image.getAttribute('src')!==src||!image.complete||image.naturalWidth<=0||image.naturalHeight<=0)return false;
    try {
      await image.decode();
      return image.getAttribute('src')===src&&image.complete&&image.naturalWidth>0&&image.naturalHeight>0;
    } catch {return false;}
  },src),{timeout,message:'evidence image loads and decodes from the expected path'}).toBe(true);
}

test('weighted prototype words match preview, real download and clipboard; AI reject is manual only',async({page,context},testInfo)=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await context.grantPermissions(['clipboard-read','clipboard-write']);
  await page.goto(generateReport(testInfo,[
    candidate('constructor',95),candidate('toString',75),candidate('__proto__',65),candidate('plain',55),
    candidate('reject',99,{ai:{verdict:'reject',type:'other',reason:'synthetic rejection'}}),
    candidate('constructor',65),
  ]));
  await page.locator('#check-recommended').click();
  await expect(page.locator('.card[data-i="4"] .box')).not.toBeChecked();
  await expect(page.locator('#preview-count')).toHaveText('4 个词');
  expect(await page.locator('.word-chip>span').allTextContents()).toEqual(['constructor: 5','toString: 4','__proto__: 3','plain']);
  const expected='constructor: 5\ntoString: 4\n__proto__: 3\nplain\n';
  expect(await downloadText(page)).toBe(expected);
  await page.locator('#copy-btn').click();
  await expect(page.locator('#toast')).toContainText('已复制 4');
  // Windows 的系统剪贴板读回 CRLF；文本内容与下载保持一致。
  expect((await page.evaluate(()=>navigator.clipboard.readText())).replace(/\r\n/g,'\n')).toBe(expected.trimEnd());
  await page.locator('.card[data-i="4"] .box').check();
  await expect(page.locator('#toast')).toContainText('人工勾选 AI 排除项');
  expect(await downloadText(page)).toBe(expected+'reject: 5\n');
  await page.locator('#q').fill('toString');
  await expect(page.locator('.card')).toHaveCount(1);
  await expect(page.locator('#preview-count')).toHaveText('5 个词');
  await page.locator('#reset-filters').click();
  await expect(page.locator('.card[data-i="4"] .box')).toBeChecked();
  expect(errors).toEqual([]);
});

test('more than 2000 selected words are capped consistently with an explicit ignored count',async({page},testInfo)=>{
  test.setTimeout(90000);
  await page.goto(generateReport(testInfo,Array.from({length:2002},(_,i)=>candidate('term-'+i))));
  await page.locator('#check-recommended').click();
  await expect(page.locator('#preview-count')).toHaveText('2000 个词');
  await expect(page.locator('#export-hint')).toContainText('已忽略 2');
  expect(await page.locator('.word-chip>span').last().textContent()).toBe('term-1999: 5');
  const text=await downloadText(page);
  expect(text.trimEnd().split('\n')).toHaveLength(2000);
  expect(text).not.toContain('term-2000: 5');
  await expect(page.locator('#toast')).toContainText('已忽略 2');
  await page.locator('.word-chip button[data-word="term-0"]').click();
  await expect(page.locator('#export-hint')).toContainText('已忽略 1');
  expect(await page.locator('.word-chip>span').last().textContent()).toBe('term-2000: 5');
});

test('rule-only failure and truncated scan remain visible with unchanged report layout',async({page},testInfo)=>{
  await page.goto(generateReport(testInfo,[candidate('synthetic',80,{ai:null})],{aiEnabled:false,aiStatus:'failed'}));
  await expect(page.locator('#src-name')).toContainText('AI 失败');
  await expect(page.locator('#src-name')).toContainText('扫描已截断');
  await expect(page.locator('#source')).toContainText('采样至 00:15');
  await expect(page.locator('#source')).toContainText('bottom30');
  await expect(page.locator('.badge')).toContainText('仅规则评分');
  const sizes=[];
  for(const theme of ['dark','light']) {
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    await page.setViewportSize({width:1440,height:900});
    sizes.push(await page.locator('.export').evaluate(el=>({
      theme:document.documentElement.dataset.theme,
      gap:getComputedStyle(el.querySelector('.actions')).rowGap,
      hintMargin:getComputedStyle(el.querySelector('.hint')).marginTop,
      font:getComputedStyle(el.querySelector('.hint')).fontSize,
    })));
    await page.screenshot({path:testInfo.outputPath('report-'+theme+'.png')});
  }
  for(const size of sizes) {
    expect(parseFloat(size.gap)).toBeGreaterThanOrEqual(8);
    expect(parseFloat(size.hintMargin)).toBeGreaterThanOrEqual(8);
    expect(parseFloat(size.font)).toBeGreaterThanOrEqual(11);
  }
  writeFileSync(testInfo.outputPath('layout-evidence.json'),JSON.stringify(sizes,null,2));
  for(const width of [320,375,414,768]) {
    await page.setViewportSize({width,height:812});
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
    expect(overflow).toBe(0);
    if(width===375)await page.screenshot({path:testInfo.outputPath('report-narrow.png')});
  }
});

test('hard limits are checked even when old report export flags claim a word is valid',async({page},testInfo)=>{
  await page.goto(generateReport(testInfo,[
    candidate('这是一个超过十五个字符的超长界面提示语'),
    candidate('one two three four five six seven eight'),candidate('invalid: 9'),candidate('valid'),
  ]));
  await page.locator('#check-recommended').click();
  await expect(page.locator('#preview-count')).toHaveText('1 个词');
  await expect(page.locator('.card[data-i="2"] .box')).toBeDisabled();
  expect(await downloadText(page)).toBe('valid: 5\n');
});

test('prototype property names also survive unweighted report export',async({page},testInfo)=>{
  await page.goto(generateReport(testInfo,['constructor','toString','__proto__'].map(word=>candidate(word)),{weightByScore:false}));
  await page.locator('#check-recommended').click();
  await expect(page.locator('#preview-count')).toHaveText('3 个词');
  expect(await downloadText(page)).toBe('constructor\ntoString\n__proto__\n');
});

test('weight-by-score report applies the CLI policy to ordinary words',async({page},testInfo)=>{
  await page.goto(generateReport(testInfo,[candidate('ordinary',95)]));
  await page.locator('#check-recommended').click();
  await expect(page.locator('.word-chip>span')).toHaveText('ordinary: 5');
  expect(await downloadText(page)).toBe('ordinary: 5\n');
});

test('report thumbnails and overlay resolve the same independent evidence generation',async({page},testInfo)=>{
  const fixture=evidenceFixture(testInfo);
  const framesBaseDir='frames/run-'+ 'a'.repeat(32);
  const frame='frame-000000001000.jpg';
  const file=generateReport(fixture,[candidate('evidence',90,{
    events:[{startMs:1000,evidence:[{frame,box:[0,0,20,20]}]}],
  })],{framesBaseDir});
  const directory=fixture.outputPath(framesBaseDir);
  mkdirSync(directory,{recursive:true});
  writeEvidenceFrame(fixture,resolve(directory,frame));
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(file);
  await expect(page.locator('.thumb img')).toHaveAttribute('src',framesBaseDir+'/'+frame);
  await expectDecodedImage(page.locator('.thumb img'),framesBaseDir+'/'+frame);
  await page.locator('.thumb').click();
  await expect(page.locator('#overlay-img')).toHaveAttribute('src',framesBaseDir+'/'+frame);
  await expectDecodedImage(page.locator('#overlay-img'),framesBaseDir+'/'+frame);
  const images=await page.locator('.thumb img,#overlay-img').evaluateAll(images=>images.map(image=>({src:image.getAttribute('src'),complete:image.complete,width:image.naturalWidth,height:image.naturalHeight})));
  writeFileSync(testInfo.outputPath('decoded-evidence-images.json'),JSON.stringify(images,null,2));
  expect(errors).toEqual([]);
});

for(const kind of ['missing','corrupt']) {
  test(`evidence image readiness rejects ${kind} files despite matching thumbnail and overlay paths`,async({page},testInfo)=>{
    const fixture=evidenceFixture(testInfo);
    const framesBaseDir='frames/run-'+'b'.repeat(32),frame='frame-000000001000.jpg';
    const file=generateReport(fixture,[candidate('evidence',90,{
      events:[{startMs:1000,evidence:[{frame,box:[0,0,20,20]}]}],
    })],{framesBaseDir});
    const directory=fixture.outputPath(framesBaseDir);
    mkdirSync(directory,{recursive:true});
    if(kind==='corrupt') {
      writeFileSync(resolve(directory,frame),Buffer.from('not a decodable image'));
    }
    await page.goto(file);
    const src=framesBaseDir+'/'+frame;
    await expect(page.locator('.thumb img')).toHaveAttribute('src',src);
    await expect(expectDecodedImage(page.locator('.thumb img'),src,300)).rejects.toThrow('evidence image loads and decodes');
    await page.locator('.thumb').click();
    const overlay=page.locator('#overlay-img');
    await expect(overlay).toHaveAttribute('src',src);
    await expect(expectDecodedImage(overlay,src,300)).rejects.toThrow('evidence image loads and decodes');
    const state=await overlay.evaluate(async image=>{
      try {await image.decode();return {decoded:true};}
      catch(error){return {decoded:false,error:error.name,complete:image.complete,width:image.naturalWidth};}
    });
    expect(state).toEqual({decoded:false,error:'EncodingError',complete:true,width:0});
    writeFileSync(testInfo.outputPath('image-negative-control.json'),JSON.stringify({kind,...state},null,2));
  });
}
