import {expect,test} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const fileUrl = path => pathToFileURL(resolve(path)).href;
const widths = [320,375,414,768,959,960,979,980,981,1100,1440];
const project = {segments:[
  {start:0,end:1000,text:'你好',items:[{text:'你',start:0,end:500},{text:'好',start:500,end:1000}]},
  {start:1200,end:2500,text:'长标题与证据测试',items:[]},
]};

async function captureStates(page,testInfo,name) {
  await page.setViewportSize({width:1440,height:900});
  for(const theme of ['dark','light']) {
    await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;document.dispatchEvent(new CustomEvent('tool-theme-change'));},theme);
    const colors=await page.evaluate(()=>({accent:getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()}));
    expect(colors.accent).toBe(theme==='dark'?'#f09a50':'#c84545');
    if(name!=='waveform'){
      const tiny=await page.evaluate(()=>{
        const results=[];
        for(const node of document.querySelectorAll('body *')){
          if(!node.getClientRects().length)continue;
          if(node.textContent.trim()&&parseFloat(getComputedStyle(node).fontSize)<11)results.push(node.tagName+'.'+node.className);
          for(const pseudo of ['::before','::after']){
            const style=getComputedStyle(node,pseudo);
            if(style.content!=='none'&&style.content!=='normal'&&style.content!=='""'&&parseFloat(style.fontSize)<11)results.push(node.tagName+pseudo);
          }
        }
        return results;
      });
      expect(tiny,`${name} minimum font size`).toEqual([]);
    }
    await page.screenshot({path:testInfo.outputPath(name+'-'+theme+'.png')});
  }
  for(const width of [320,375,414,768]) {
    await page.setViewportSize({width,height:812});
    const sizes=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth}));
    expect(sizes.scroll,`${name} ${width}`).toBe(sizes.client);
    if(width===375)await page.screenshot({path:testInfo.outputPath(name+'-narrow.png')});
  }
  await page.setViewportSize({width:1440,height:900});
  const reflow = await page.evaluate(widths => {
    const root=document.querySelector('main') || document.body;
    return widths.map(width => {
      const start=performance.now();root.style.width=width+'px';void root.offsetHeight;
      const elapsed=performance.now()-start;root.style.width='';
      return {width,ms:Math.round(elapsed*100)/100};
    });
  },widths);
  writeFileSync(testInfo.outputPath(name+'-reflow.json'),JSON.stringify(reflow,null,2));
}

test('theme and density switches persist independently of tool content',async({page})=>{
  await page.goto(fileUrl('tools/timestamp-compare.html'));
  const theme=await page.locator('html').getAttribute('data-theme');
  await page.locator('[data-tool-theme]').click();
  const switched=theme==='dark'?'light':'dark';
  await expect(page.locator('html')).toHaveAttribute('data-theme',switched);
  await page.locator('.tool-density').click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme',switched);
  await expect(page.locator('[data-tool-compact]')).toBeChecked();
  await expect(page.locator('[data-tool-theme]')).toHaveAttribute('aria-label',switched==='light'?'切换为深色主题':'切换为浅色主题');
});

test('transcript compare retains reference and data across filter reset and themes',async({page},testInfo)=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(fileUrl('tools/compare.html'));
  await page.locator('#fileInput').setInputFiles([
    {name:'baseline.mosp',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project))},
    {name:'after.mosp',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project))},
  ]);
  await page.getByRole('button',{name:'设为基准'}).first().click();
  await page.locator('#search').fill('no-match');
  await expect(page.locator('.tool-empty')).toBeVisible();
  await page.locator('.tool-empty button').click();
  await expect(page.locator('#search')).toHaveValue('');
  expect(await page.evaluate(()=>window.MAWCompare.state.refId)).not.toBeNull();
  await captureStates(page,testInfo,'compare');
  expect(errors).toEqual([]);
});

test('timestamp detail focus, density and reset preserve loaded projects',async({page},testInfo)=>{
  await page.goto(fileUrl('tools/timestamp-compare.html'));
  await page.evaluate(project=>window.MAWTsCompare.loadProjectObjects([{name:'a',project},{name:'b',project}]),project);
  await page.locator('.row-grid').first().click();
  await expect(page.locator('.details')).toBeVisible();
  expect(await page.locator('.row-grid').first().evaluate(el=>el===document.activeElement)).toBe(true);
  await page.evaluate(()=>{
    const range=document.createRange();range.selectNodeContents(document.querySelector('.subtitle-text'));
    window.getSelection().removeAllRanges();window.getSelection().addRange(range);
    document.querySelector('.row-grid').click();
  });
  await expect(page.locator('.details')).toBeVisible();
  await page.evaluate(()=>window.getSelection().removeAllRanges());
  await page.locator('.tool-density').click();
  await expect(page.locator('[data-tool-compact]')).toBeChecked();
  await page.locator('#search').fill('no-match');
  await expect(page.locator('.table-empty button')).toBeVisible();
  await page.locator('.table-empty button').click();
  await expect(page.locator('.row-grid')).toHaveCount(2);
  await captureStates(page,testInfo,'timestamp');
});

test('copy review supports scoped collapse, editing, reset and matching result preview',async({page},testInfo)=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(fileUrl('tools/copy-review/copy-review.html'));
  await expect(page.locator('.newtext').first()).toBeVisible();
  const input=page.locator('.newtext').first();
  await input.fill('核对文本');
  const rowId=await input.evaluate(el=>el.closest('tr').dataset.rowId);
  await page.locator('.result-preview summary').click();
  await page.locator('#importFile').setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from('{}')});
  await expect(page.locator('#feedback')).toContainText('导入失败');
  await expect(page.locator(`tr[data-row-id="${rowId}"] input`)).toHaveValue('核对文本');
  await expect(page.locator('#resultPreview')).toContainText('核对文本');
  const downloaded=page.waitForEvent('download');
  await page.locator('#exportBtn').click();
  const download=await downloaded;
  const result=JSON.parse(readFileSync(await download.path(),'utf8'));
  expect(result.sections.flatMap(s=>s.rows).find(r=>r.id===rowId).final).toBe('核对文本');
  await page.locator('.group-toggle').first().click();
  await expect(page.locator('.table-scroll').first()).toBeHidden();
  await page.locator('#searchInput').fill('no-match');
  await expect(page.locator('.tool-empty')).toBeVisible();
  await page.locator('.tool-empty button').click();
  await expect(page.locator('.table-scroll').first()).toBeHidden();
  await page.locator('.group-toggle').first().click();
  await expect(page.locator(`tr[data-row-id="${rowId}"] input`)).toHaveValue('核对文本');
  await page.locator('.result-preview summary').click();
  await captureStates(page,testInfo,'copy-review');
  await page.setViewportSize({width:320,height:812});
  const overflow=await page.locator('.group-toggle').evaluateAll(nodes=>nodes.filter(node=>{
    const title=node.getBoundingClientRect(),card=node.closest('.card').getBoundingClientRect();
    return title.right>card.right+1 || title.left<card.left-1;
  }).map(node=>node.textContent));
  expect(overflow).toEqual([]);
  expect(errors).toEqual([]);
});

test('generated checklist is standalone, preserves legacy progress and expands narrow controls',async({page},testInfo)=>{
  const output=testInfo.outputPath('checklist.html');
  execFileSync(process.env.MAW_E2E_PYTHON||'python',[
    'tools/verification-checklist/build.py','--data','tools/verification-checklist/examples/checklist.json','--output',output,
  ],{timeout:15000});
  const html=readFileSync(output,'utf8');
  expect(html).not.toContain('src="../../shared/');
  expect(html).not.toContain('href="../../shared/');
  await page.goto(fileUrl(output));
  const item=page.locator('#manual .item').first();
  await item.click({position:{x:4,y:4}});
  await expect(item.locator('input[type=checkbox]')).toBeChecked();
  await item.locator('.note-toggle').click();
  await item.locator('textarea').fill('保留备注');
  const heat=await item.evaluate(el=>({checkbox:el.querySelector('input').getBoundingClientRect().width,gap:getComputedStyle(el).columnGap}));
  expect(heat.checkbox).toBeGreaterThanOrEqual(24);
  expect(parseFloat(heat.gap)).toBeGreaterThanOrEqual(8);
  await page.reload();
  await expect(item.locator('textarea')).toHaveValue('保留备注');
  await captureStates(page,testInfo,'checklist');
  await page.setViewportSize({width:375,height:812});
  await page.reload();
  await expect(page.locator('.checklist-controls')).not.toHaveAttribute('open');
  await page.locator('.checklist-controls summary').click();
  await expect(page.locator('#export-json')).toBeVisible();
});

test('changelog editor preserves edit/preview behavior without writing repository files',async({page},testInfo)=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(fileUrl('tools/changelog-editor/index.html'));
  await page.evaluate(async text=>{await loadClText(text,'测试载入');},readFileSync(resolve('CHANGELOG.md'),'utf8'));
  await expect(page.locator('#split-wrap')).toBeVisible();
  const input=page.locator('#cards textarea').first();
  await input.fill((await input.inputValue())+' 测试');
  await expect(page.locator('#dirty-dot')).toBeVisible();
  await page.evaluate(()=>{
    document.getElementById('btn-finish').focus();
    window.conflictResult=null;
    resolveConflictModal().then(result=>window.conflictResult=result);
  });
  await expect(page.locator('#modal')).toBeVisible();
  const background=await page.evaluate(()=>({ids:['layout','topbar','restore-banner','lock-banner'].filter(id=>!document.getElementById(id).inert)}));
  expect(background.ids).toEqual([]);
  const imageCount=await page.evaluate(()=>S.images.size);
  await page.evaluate(()=>{
    const file=new File([new Uint8Array([1])],'fixture.png',{type:'image/png'});
    const data=new DataTransfer();data.items.add(file);
    document.getElementById('modal').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,clipboardData:data}));
  });
  expect(await page.evaluate(()=>S.images.size)).toBe(imageCount);
  await page.keyboard.press('Escape');
  await expect(page.locator('#mask')).not.toHaveClass('show');
  expect(await page.evaluate(()=>window.conflictResult)).toBe('cancel');
  expect(await page.evaluate(()=>document.activeElement.id)).toBe('btn-finish');
  expect(await page.locator('#layout').evaluate(node=>node.inert)).toBe(false);
  await captureStates(page,testInfo,'changelog');
  expect(errors).toEqual([]);
});

test('narrow checklist exposes storage warnings outside its collapsed actions',async({page},testInfo)=>{
  const output=testInfo.outputPath('checklist-warning.html');
  execFileSync(process.env.MAW_E2E_PYTHON||'python',['tools/verification-checklist/build.py','--data','tools/verification-checklist/examples/checklist.json','--output',output],{timeout:15000});
  await page.setViewportSize({width:375,height:812});
  await page.goto(fileUrl(output));
  await page.evaluate(()=>{Storage.prototype.setItem=function(){throw new DOMException('quota','QuotaExceededError');};});
  await page.locator('#manual-persistence').check();
  await expect(page.locator('.checklist-controls')).not.toHaveAttribute('open');
  await expect(page.locator('#save-status')).toBeVisible();
  await expect(page.locator('#save-status')).toContainText('本机存储不可用');
});

test('pending image conversion cannot commit through an opened and closed modal',async({page})=>{
  await page.goto(fileUrl('tools/changelog-editor/index.html'));
  const result=await page.evaluate(async()=>{
    await loadClText('## [未发布]\n\n### 提升\n\n- **测试** ： 文本\n','fixture');
    const parsed=S.parsed.get(S.selected),card=parsed.cards.find(c=>c.kind==='entry');
    const original=toWebp;let complete;
    toWebp=()=>new Promise(resolve=>complete=resolve);
    try {
      const pending=attachImage(card,parsed.cards.indexOf(card),new File(['png'],'fixture.png',{type:'image/png'}));
      modal('<h3>确认</h3><button>取消</button>');closeModal(true);
      complete({blob:new Blob(['test']),filename:'fixture.webp',size:4});
      await pending;
      return {count:S.images.size,refs:card.images?.length||0};
    } finally {toWebp=original;}
  });
  expect(result).toEqual({count:0,refs:0});
});

test('catalog lists tools, filters maintenance states and provides valid page links',async({page},testInfo)=>{
  await page.goto(fileUrl('tools/index.html'));
  await expect(page.locator('.card')).toHaveCount(10);
  await page.locator('#status').selectOption('paused');
  await expect(page.locator('.card')).toHaveCount(1);
  await expect(page.locator('.card')).toContainText('波形工具台');
  await page.locator('#status').selectOption('retired');
  await expect(page.locator('.card')).toHaveCount(1);
  await expect(page.locator('.card')).toContainText('文案重写／文案评审');
  await expect(page.getByRole('link',{name:'查看历史页面'})).toBeVisible();
  await page.locator('#reset').click();
  await captureStates(page,testInfo,'catalog');
});

test('waveform generated page inlines shared resources and repaints its canvas theme',async({page},testInfo)=>{
  const fixture={duration:8,scenes:[],cases:[{
    key:'mono-wav',label:'合成测试',detail:'只验证绘图交互，不作为性能证据',audio:'',rate:16000,channels:1,
    benchmark:{oldMs:0,newMs:0,quapeaksMs:null},sizes:{old:2,new:2},
    variants:[{id:'mopeaks-old',label:'测试波形',color:'#e8844b',source:'合成夹具',payload:{data:Buffer.from([236,20]).toString('base64'),sample_rate:100,division:100,peak_count:1}}],
  }]};
  const data=testInfo.outputPath('waveform.json'), output=testInfo.outputPath('waveform.html');
  writeFileSync(data,JSON.stringify(fixture));
  const script=testInfo.outputPath('render-waveform.py');
  writeFileSync(script,[
    'import importlib.util,json,sys',
    'from pathlib import Path',
    "spec=importlib.util.spec_from_file_location('waveform_builder','tools/waveform-compare/build.py')",
    'builder=importlib.util.module_from_spec(spec);spec.loader.exec_module(builder)',
    "Path(sys.argv[2]).write_text(builder.render_page(json.loads(Path(sys.argv[1]).read_text())),encoding='utf-8')",
  ].join('\n'));
  execFileSync(process.env.MAW_E2E_PYTHON||'python',[script,data,output],{timeout:15000});
  expect(readFileSync(output,'utf8')).not.toContain('src="../shared/');
  await page.goto(fileUrl(output));
  await expect(page.locator('canvas')).toHaveCount(1);
  const color=()=>page.locator('canvas').evaluate(canvas=>Array.from(canvas.getContext('2d').getImageData(0,0,1,1).data));
  const before=await color();
  await page.locator('[data-tool-theme]').click();
  const after=await color();
  expect(after).not.toEqual(before);
  await captureStates(page,testInfo,'waveform');
});

test('dashboard uses CSP-compatible shared assets and preserves board status on reset',async({page},testInfo)=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const prs=[{number:1,title:'测试 PR',headRefName:'feature',author:{login:'demo'},url:'https://example.invalid',milestone:null,statusCheckRollup:[]}];
  await page.route('http://127.0.0.1:8262/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    const assets={'/':'tools/dev-dashboard/index.html','/app.js':'tools/dev-dashboard/app.js','/marked-15.0.12.min.js':'tools/dev-dashboard/marked-15.0.12.min.js','/style.css':'tools/dev-dashboard/style.css','/shared/tool-page.css':'tools/shared/tool-page.css','/shared/tool-page.js':'tools/shared/tool-page.js'};
    if(path.startsWith('/api/')) {
      const body=path==='/api/prs'?prs:path==='/api/checklists'?[]:path==='/api/status'?{'1':'review'}:{};
      return route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
    }
    if(!assets[path])return route.fulfill({status:404});
    return route.fulfill({contentType:path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html',body:readFileSync(resolve(assets[path]),'utf8'),headers:{'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'"}});
  });
  await page.goto('http://127.0.0.1:8262/');
  await expect(page.locator('.card')).toHaveCount(1);
  await page.locator('#search').fill('no-match');
  await expect(page.locator('.card')).toHaveCount(0);
  await page.locator('#reset-filters').click();
  await expect(page.locator('.column[data-status=review] .card')).toHaveCount(1);
  await captureStates(page,testInfo,'dashboard');
  expect(errors).toEqual([]);
});
