import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {settlePageAnimations} from './e2e/animation-readiness.mjs';

function run(animations, timeoutMs = 100) {
  return vm.runInNewContext(`(${settlePageAnimations.toString()})({timeoutMs:${timeoutMs}})`, {
    document:{body:{offsetHeight:10},getAnimations:typeof animations === 'function' ? animations : ()=>animations},
    getComputedStyle:()=>({contentVisibility:'auto'}), setTimeout, clearTimeout,
    requestAnimationFrame:callback=>setTimeout(callback,1),cancelAnimationFrame:clearTimeout,
  });
}

test('waits for rendered completion, not a stalled finished Promise', async () => {
  const animation = {playState:'running',pending:false,finished:new Promise(()=>{})};
  const done = run([animation]);
  let settled = false;
  done.then(()=>{settled=true;});
  await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(settled,false);
  animation.playState = 'finished';
  await done;
});

test('accepts cancelled animations even when removed from document enumeration', async () => {
  const animation = {playState:'running',pending:false};
  let calls = 0;
  await run(()=>{
    if (++calls === 1) return [animation];
    animation.playState = 'idle';
    return [];
  });
  assert.ok(calls >= 3);
});

test('includes new animations between quiet frames and waits for pending playback', async () => {
  const animation = {playState:'finished',pending:true};
  let calls = 0;
  await run(()=>{
    calls++;
    if (calls === 1) return [];
    if (calls === 4) animation.pending = false;
    return [animation];
  });
  assert.ok(calls >= 5);
});

test('requires two quiet frames, even with no animations', async () => {
  let calls = 0;
  await run(()=>{calls++;return [];});
  assert.equal(calls,2);
});

test('unfinished animation fails with target, property and state rather than passing', async () => {
  const target = {tagName:'LABEL',id:'',className:'item-purpose',
    getBoundingClientRect:()=>({x:10,y:20000,width:300,height:20}),closest:()=>({})};
  await assert.rejects(run([{transitionProperty:'color',
    playState:'running',pending:false,currentTime:0,startTime:null,
    effect:{target,getComputedTiming:()=>({duration:200,progress:0})}}],15), error => {
    assert.match(error.message,/did not settle/);
    assert.match(error.message,/LABEL#\.item-purpose/);
    assert.match(error.message,/"property":"color"/);
    assert.match(error.message,/"contentVisibility":"auto"/);
    return true;
  });
});
