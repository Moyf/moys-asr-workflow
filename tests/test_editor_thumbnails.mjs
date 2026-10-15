import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
const text = fs.readFileSync(new URL('../web/editor/media/editor-thumbnails.js', import.meta.url), 'utf8');
const { createThumbnailModule } = await import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`);

function harness(changes=[]) {
  let now = 0, serial = 0;
  const timers = new Map(), calls = [], closedImages = [], values = new Map();
  const config = {requestToken:'test-only-token', thumbnailUrls:{status:'/status', demand:'/demand', release:'/release'}};
  let responder = async () => ({binding:'video-a', view:1, lease:'lease-a', state:'ready',
    source_identity:'source-a', cache_revision:'r1', duration_ms:20000, samples:[],
    asset_url_template:'/asset/{asset}?binding={binding}&revision={cache_revision}'});
  const browser = {
    location:{href:'http://127.0.0.1:8765/'}, URL, AbortController,
    crypto:{randomUUID:()=>'stable-client'},
    setTimeout(fn, delay) { const id=++serial; timers.set(id,{fn,at:now+delay}); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, delay) { const id=++serial; timers.set(id,{fn,at:now+delay,interval:delay}); return id; },
    clearInterval(id) { timers.delete(id); },
    requestAnimationFrame(fn) { return this.setTimeout(fn,16); },
    cancelAnimationFrame(id) { this.clearTimeout(id); },
    async fetch(url, options={}) {
      const call={url:String(url),options,body:options.body ? JSON.parse(options.body) : null}; calls.push(call);
      if (String(url).includes('/asset/')) return {ok:true,status:200,blob:async()=>({})};
      return {ok:true,status:200,json:async()=>await responder(call)};
    },
    async createImageBitmap() { return {width:10240,height:90,close(){closedImages.push(this);}}; },
  };
  const core=createThumbnailModule({browser,getConfig:()=>config,
    storage:{getItem:key=>values.get(key) ?? null,setItem:(key,value)=>values.set(key,value)}});
  const controller=core.createController((layoutChanged,ranges=[])=>changes.push({layoutChanged,ranges}));
  return {core,controller,calls,closedImages,values,browser,
    respond(fn) { responder=fn; },
    async flush() { for(let i=0;i<200;i++) await Promise.resolve(); },
    async advance(delay) {
      now+=delay;
      const due=[...timers].filter(([,entry])=>entry.at<=now);
      for(const [id,entry] of due) {
        if (!timers.has(id)) continue;
        if(entry.interval) entry.at=now+entry.interval; else timers.delete(id);
        entry.fn();
      }
      for(let i=0;i<200;i++) await Promise.resolve();
    },
  };
}

function manifest(call, extra={}) {
  const url=new URL(call.url,'http://127.0.0.1/');
  return {binding:call.body?.binding||url.searchParams.get('binding'),
    view:call.body?.view??Number(url.searchParams.get('view')),lease:'lease-a',state:'ready',
    source_identity:'source-a',cache_revision:'r1',duration_ms:20000,samples:[],
    asset_url_template:'/asset/{asset}?binding={binding}&revision={cache_revision}',...extra};
}

test('density uses CSS pixels with hysteresis, source-zero targets and a real tail',()=>{
  const {core}=harness();
  assert.equal(core.chooseInterval(core.DISPLAY_WIDTH*2),500);
  assert.equal(core.chooseInterval(core.DISPLAY_WIDTH/(Math.sqrt(2)*1.05),1000),1000, 'retain near-boundary density');
  assert.deepEqual(core.gridTargets([{start_ms:100,end_ms:1100},{start_ms:800,end_ms:1500}],250,1100),[0,250,500,750,1000]);
  const demand=core.makeDemand([{start:1000,end:5000,width:400},{start:4000,end:8000,width:400}],9000);
  assert.deepEqual(demand.ranges,[{start_ms:1000,end_ms:8000}]);
  assert.deepEqual(core.prefetchRanges(demand.ranges,9000),[{start_ms:0,end_ms:9000}]);
  assert.ok(demand.representative_ms.every(time=>time% demand.interval_ms===0 && time<9000));
});

test('play immediately updates the shared lease before the pending view debounce',async()=>{
  const h=harness(); h.respond(call=>manifest(call));
  h.controller.setBinding('video-a'); await h.flush();
  h.controller.setView([{start:0,end:10000,width:1000}],20000);
  assert.equal(h.calls.filter(call=>call.body?.visible).length,0);
  h.controller.setPlaying(true); await h.flush();
  const control=h.calls.find(call=>call.body?.playing===true);
  assert.ok(control,'play must submit without advancing 200ms');
  assert.equal(control.body.lease,'lease-a');
  assert.equal(control.body.client_id,'stable-client');
  assert.equal(control.body.requestToken,'test-only-token');
  await h.advance(2000);
  assert.ok(h.calls.filter(call=>call.body?.playing===true).length>=2,'refresh the playback lease');
  h.controller.close();
});

test('a replaced binding discards its delayed status and releases only the old lease',async()=>{
  const h=harness(); h.respond(call=>manifest(call));
  h.controller.setBinding('video-a'); await h.flush();
  let resolveOld;
  h.respond(call=>call.url.includes('video-a') ? new Promise(resolve=>{resolveOld=resolve;}) : manifest(call,{state:'unavailable'}));
  await h.advance(2000);
  h.controller.setBinding('video-b');
  resolveOld({binding:'video-a',view:1,lease:'old',state:'ready',source_identity:'source-a',samples:[]});
  await h.flush(); await h.advance(2000);
  assert.equal(h.controller.visible,false);
  assert.ok(h.calls.some(call=>call.url==='/release' && call.body.binding==='video-a' && call.body.lease==='lease-a'));
  h.controller.close();
});

test('sprites and frames share a byte cap and over-budget assets do not read again each poll',async()=>{
  const h=harness();
  const samples=Array.from({length:40},(_,index)=>({requested_ms:index*250,actual_pts_ms:index*250,status:'target',asset:`sprite-${index}`,crop_rect:[0,0,160,90],cache_revision:'r1'}));
  h.respond(call=>manifest(call,{samples}));
  h.controller.setBinding('video-a'); await h.flush();
  h.controller.setView([{start:0,end:10000,width:1000}],20000);
  await h.advance(200);
  assert.ok(h.controller.bytes<=h.core.IMAGE_BUDGET);
  assert.ok(h.controller.bytes>0);
  assert.ok(h.closedImages.length>0,'close images refused admission');
  const reads=h.calls.filter(call=>call.url.includes('/asset/')).length;
  await h.advance(2000);
  assert.equal(h.calls.filter(call=>call.url.includes('/asset/')).length,reads,'bounded admission misses are retained');
  h.controller.setEnabled(false); await h.flush();
  assert.ok(h.controller.bytes>0,'hidden pictures remain in the bounded reusable LRU');
  assert.equal(h.controller.visible,false);
  assert.equal(h.values.get('mawe-filmstrip-visible'),'false');
  h.controller.close();
  assert.equal(h.controller.bytes,0, 'page close releases retained pictures');
});


test('unchanged status does not repaint and one decoded asset only dirties nearby time rows',async()=>{
  const changes=[], h=harness(changes);
  const sample={requested_ms:5000,actual_pts_ms:5000,status:'target',asset:'one-frame',crop_rect:[0,0,160,90],cache_revision:'r1'};
  h.respond(call=>manifest(call,{samples:[sample]}));
  h.controller.setBinding('video-a');await h.flush();
  h.controller.setView([{start:0,end:30000,width:2560}],40000);await h.advance(200);await h.advance(16);
  const painted=changes.filter(change=>change.ranges.length);
  assert.ok(painted.length>0);
  assert.ok(painted.every(change=>change.ranges.every(range=>range.end_ms<20000)), 'the third time row is untouched');
  changes.length=0;await h.advance(2000);await h.advance(16);
  assert.ok(changes.every(change=>change.ranges.length===0),'a stable manifest is not a visual change');
  h.controller.close();
});

test('unavailable and error responses explicitly release the acquired lease',async()=>{
  for(const state of ['unavailable','error']) {
    const h=harness();h.respond(call=>manifest(call));
    h.controller.setBinding('video-a');await h.flush();
    h.respond(call=>manifest(call,{state}));await h.advance(2000);
    assert.equal(h.controller.visible,false);
    assert.ok(h.calls.some(call=>call.url==='/release'&&call.body.lease==='lease-a'));
    const count=h.calls.length;await h.advance(20000);assert.equal(h.calls.length,count,'hidden source stops all heartbeat/poll work');
    h.controller.close();
  }
});

test('three failed demands suspend transport and retain pictures until a deliberate recovery',async()=>{
  const h=harness();
  h.respond(call=>manifest(call,{samples:[{requested_ms:0,status:'target',asset:'cached',crop_rect:[0,0,160,90],cache_revision:'r1'}]}));
  h.controller.setBinding('video-a');await h.flush();
  h.controller.setView([{start:0,end:10000,width:1000}],20000);await h.advance(200);
  const bytes=h.controller.bytes;assert.ok(bytes>0);
  h.respond(call=>{
    if(call.url==='/demand')throw new Error('synthetic network failure');
    return manifest(call,{samples:[{requested_ms:0,status:'target',asset:'cached',crop_rect:[0,0,160,90],cache_revision:'r1'}]});
  });
  for(let i=0;i<3;i++)await h.advance(2000);
  assert.equal(h.controller.state,'network-error');assert.equal(h.controller.visible,true);
  assert.equal(h.controller.bytes,bytes,'a failed server does not erase navigation pictures');
  const calls=h.calls.length;await h.advance(20000);assert.equal(h.calls.length,calls,'transport does not loop past its retry budget');
  assert.ok(h.calls.some(call=>call.url==='/release'));
  h.respond(call=>manifest(call));h.controller.retry();await h.flush();
  assert.equal(h.controller.state,'ready');await h.advance(2000);
  assert.ok(h.calls.length>calls,'explicit retry establishes a new bounded attempt');
  h.controller.close();
});


test('picture feedback uses user-facing bilingual states and explains session-only persistence',async()=>{
  const source=fs.readFileSync(new URL('../web/editor/media/waveform/thumbnails.js',import.meta.url),'utf8');
  const {createWaveformModule}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  let language='zh';
  const methods=createWaveformModule({localizedWaveformMessage:(zh,en)=>language==='en'?en:zh});
  const editor={thumbnailController:{state:'paused',persisted:false}};
  assert.equal(methods.thumbnailStatusText.value.call(editor),'播放中：暂停补帧 · 本次会话缓存');
  language='en';
  assert.equal(methods.thumbnailStatusText.value.call(editor),'Playing: picture generation paused · Session cache');
  editor.thumbnailController.state='network-error';
  assert.match(methods.thumbnailStatusText.value.call(editor),/re-enable pictures or reconnect/);
});


test('hide releases a client view before its lease is adopted and re-enable uses a newer view',async()=>{
  const h=harness();let resolveStatus;
  h.respond(call=>call.url.includes('/status')?new Promise(resolve=>{resolveStatus=()=>resolve(manifest(call));}):manifest(call));
  h.controller.setBinding('video-a');
  const status=h.calls.find(call=>call.url.includes('/status'));
  const oldView=Number(new URL(status.url).searchParams.get('view'));
  h.controller.setEnabled(false);await h.flush();
  const released=h.calls.find(call=>call.url==='/release');
  assert.ok(released,'an anonymous allocation can be cancelled before its response');
  assert.equal(released.body.lease,'');assert.equal(released.body.client_id,'stable-client');
  assert.equal(released.body.view,oldView);
  resolveStatus();await h.flush();assert.equal(h.controller.visible,false);
  h.respond(call=>manifest(call));h.controller.setEnabled(true);await h.flush();
  const newest=h.calls.filter(call=>call.url.includes('/status')).at(-1);
  assert.ok(Number(new URL(newest.url).searchParams.get('view'))>released.body.view,'re-enable advances past the Server release fence');
  h.controller.close();
});


test('explicit no-video prefix beats future and old cached pictures without asset reads',async()=>{
  const h=harness();
  h.respond(call=>manifest(call,{samples:[{requested_ms:0,status:'target',asset:'old-zero',crop_rect:[0,0,160,90],cache_revision:'r1'}]}));
  h.controller.setBinding('video-a');await h.flush();
  h.controller.setView([{start:0,end:10000,width:1000}],20000);await h.advance(200);
  assert.ok(h.controller.picture(0,2000),'establish an older decoded picture at zero');
  h.respond(call=>manifest(call,{cache_revision:'r2',samples:[
    {requested_ms:0,actual_pts_ms:null,status:'unavailable',asset:null},
    {requested_ms:1000,actual_pts_ms:null,status:'unavailable',asset:null},
    {requested_ms:2000,actual_pts_ms:2000,status:'target',asset:'future-frame',crop_rect:[0,0,160,90],cache_revision:'r2'},
  ]}));
  await h.advance(2000);
  assert.equal(h.controller.picture(0,2000),null,'an old zero-origin frame cannot cover the real source prefix');
  assert.equal(h.controller.picture(500,2000),null,'a prefix sampling cell remains blank between grid points');
  assert.equal(h.controller.picture(1000,2000),null,'the nearby future frame cannot leak into the prefix');
  assert.ok(h.controller.picture(2000,2000),'video appears at its actual source start');
  assert.ok(h.controller.picture(3500,2000),'nearby fallback remains useful in an ordinary cache miss');
  assert.equal(h.controller.picture(5000,2000),null,'fallback remains bounded in source time');
  assert.ok(h.calls.filter(call=>call.url.includes('/asset/')).every(call=>!call.url.includes('null')&&!call.url.includes('undefined')));
  h.controller.close();
});

test('capacity refusal recovers in a narrower view while real image failures stay bounded',async()=>{
  const h=harness();
  const samples=Array.from({length:40},(_,index)=>({requested_ms:index*250,status:'target',asset:`sprite-${index}`,
    crop_rect:[0,0,160,90],cache_revision:'r1'}));
  h.respond(call=>manifest(call,{samples}));
  h.controller.setBinding('video-a');await h.flush();
  h.controller.setView([{start:0,end:10000,width:1000}],20000);await h.advance(200);
  assert.equal(h.controller.picture(9750,0),null,'the wide active view exceeds the shared cap');
  const assetReads=()=>h.calls.filter(call=>call.url.includes('/asset/sprite-39?')).length;
  const refusedReads=assetReads();await h.advance(2000);
  assert.equal(assetReads(),refusedReads,'unchanged polling does not repeat admission failures');
  h.controller.setView([{start:9500,end:10000,width:1000}],20000);await h.advance(200);
  assert.ok(h.controller.picture(9750,0),'a narrower view admits its formerly refused sprite');
  assert.ok(assetReads()>refusedReads);assert.ok(h.controller.bytes<=h.core.IMAGE_BUDGET);
  h.controller.close();

  for (const failure of ['transport','corrupt','oversized']) {
    const failed=harness();
    failed.respond(call=>manifest(call,{samples:[samples[0]]}));
    const originalFetch=failed.browser.fetch;
    if(failure==='transport')failed.browser.fetch=async function(url,options){
      if(String(url).includes('/asset/')){failed.calls.push({url:String(url),options});return {ok:false,status:404};}
      return originalFetch.call(this,url,options);
    };
    if(failure==='corrupt')failed.browser.createImageBitmap=async()=>{throw new Error('bad JPEG');};
    if(failure==='oversized')failed.browser.createImageBitmap=async()=>({width:100000,height:1000,close(){}});
    failed.controller.setBinding('video-a');await failed.flush();
    failed.controller.setView([{start:0,end:1000,width:1000}],20000);await failed.advance(200);
    const reads=failed.calls.filter(call=>call.url.includes('/asset/')).length;assert.equal(reads,1);
    failed.controller.setView([{start:0,end:2000,width:1000}],20000);await failed.advance(200);await failed.advance(2000);
    assert.equal(failed.calls.filter(call=>call.url.includes('/asset/')).length,reads,`${failure} keeps its bounded failure guard across views`);
    failed.controller.close();
  }
});

test('demand keeps visible targets separate from the single bounded prefetch band',async()=>{
  const h=harness();h.respond(call=>manifest(call));
  const rows=[{start:10000,end:20000,width:1000}];
  const demand=h.core.makeDemand(rows,40000);
  assert.deepEqual(demand.ranges,[{start_ms:10000,end_ms:20000}]);
  assert.deepEqual(h.core.prefetchRanges(demand.ranges,40000),[{start_ms:8500,end_ms:21500}]);
  assert.deepEqual(h.core.prefetchRanges([{start_ms:0,end_ms:1000},{start_ms:9000,end_ms:10000}],10000),
    [{start_ms:0,end_ms:1150},{start_ms:8850,end_ms:10000}]);
  h.controller.setBinding('video-a');await h.flush();h.controller.setView(rows,40000);await h.advance(200);
  assert.deepEqual(h.calls.filter(call=>call.body?.visible).at(-1).body.ranges,demand.ranges,
    'Server plan_targets alone expands visible ranges and marks its prefetch as priority 2');
  h.controller.close();
});

test('source playhead reprioritizes the same view with bounded paused seeks and no playing frame requests',async()=>{
  const h=harness();h.respond(call=>manifest(call));
  h.controller.setBinding('video-a');await h.flush();
  h.controller.setView([{start:0,end:10000,width:1000}],20000);await h.advance(200);
  const demands=()=>h.calls.filter(call=>call.body?.visible);
  const view=demands().at(-1).body.view, before=demands().length;
  for(let time=1000;time<=9500;time+=500)h.controller.setPlayhead(time);
  await h.advance(199);assert.equal(demands().length,before);
  await h.advance(1);assert.equal(demands().length,before+1);
  assert.equal(demands().at(-1).body.playhead_ms,9500);assert.equal(demands().at(-1).body.view,view);
  h.controller.setPlaying(true);await h.flush();const playingView=demands().at(-1).body.view;
  const playingCount=demands().length;
  for(let time=10000;time<=15000;time+=40)h.controller.setPlayhead(time);
  await h.advance(300);assert.equal(demands().length,playingCount,'frames update local priority only');
  h.controller.setPlaying(false);await h.flush();
  assert.equal(demands().at(-1).body.playhead_ms,15000,'pause carries the newest source playhead');
  assert.equal(demands().at(-1).body.playing,false);assert.ok(demands().at(-1).body.view>playingView);
  h.controller.close();
});

test('representative priority covers each visible row before optional second pictures and stays bounded',()=>{
  const {core}=harness();
  const rows=Array.from({length:20},(_,index)=>({start:index*10000,end:(index+1)*10000,width:1000}));
  const demand=core.makeDemand(rows,200000);
  assert.deepEqual(demand.ranges,[{start_ms:0,end_ms:200000}],'visible ranges still merge once');
  for(const row of rows)assert.ok(demand.representative_ms.some(time=>time>=row.start&&time<row.end),
    `row starting at ${row.start} receives a representative before second pictures`);
  assert.equal(demand.representative_ms.length,32);
  assert.deepEqual(core.makeDemand([...rows, ...rows].reverse(),200000).representative_ms,demand.representative_ms,
    'duplicate rows and DOM insertion order do not duplicate or reshuffle representatives');
  assert.ok(demand.representative_ms.every(time=>time>=0&&time<200000&&time%demand.interval_ms===0));
  const many=core.makeDemand(Array.from({length:80},(_,index)=>({start:index*10000,end:(index+1)*10000,width:1000})),800000);
  assert.equal(many.representative_ms.length,32,'the Server representative limit is never exceeded');
  const tail=core.makeDemand([{start:19000,end:23000,width:400},{start:21000,end:22000,width:100}],20500);
  assert.ok(tail.representative_ms.every(time=>time>=0&&time<20500&&time%tail.interval_ms===0));
});

test('play and pause events capture their current source head before sending the control state',async()=>{
  const source=fs.readFileSync(new URL('../web/editor/media/waveform/thumbnails.js',import.meta.url),'utf8');
  const {createWaveformModule}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const previousDocument=globalThis.document, previousWindow=globalThis.window, calls=[];
  globalThis.document={getElementById:()=>null,addEventListener(){}};
  globalThis.window={addEventListener(){}};
  try {
    const controller={setPlayhead:time=>calls.push(['head',time]),setPlaying:playing=>calls.push(['playing',playing])};
    const methods=createWaveformModule({thumbnailCore:{createController:()=>controller},ROW_GAP:10});
    const editor={player:{paused:true},currentTimeMs:()=>8500,setThumbnailBinding(){}};
    methods.initThumbnails.value.call(editor);editor.thumbnailPlayListener();
    assert.deepEqual(calls,[['head',8500],['playing',false]]);
    calls.length=0;editor.player.paused=false;editor.currentTimeMs=()=>12500;editor.thumbnailPlayListener();
    assert.deepEqual(calls,[['head',12500],['playing',true]]);
  } finally {globalThis.document=previousDocument;globalThis.window=previousWindow;}
});
