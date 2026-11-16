import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {settlePageAnimations} from './e2e/animation-readiness.mjs';

function run(animations, timeoutMs = 50) {
  return vm.runInNewContext(`(${settlePageAnimations.toString()})({timeoutMs:${timeoutMs}})`, {
    document:{body:{offsetHeight:10},getAnimations:()=>animations},
    getComputedStyle:()=>({contentVisibility:'auto'}), setTimeout, clearTimeout,
  });
}

test('animation readiness waits for real completion and accepts cancellation', async () => {
  let finish;
  const done = run([{finished:new Promise(resolve=>{finish=resolve;})}, {finished:Promise.reject(new Error('cancelled'))}]);
  let settled = false;
  done.then(()=>{settled=true;});
  await new Promise(resolve=>setTimeout(resolve,1));
  assert.equal(settled,false);
  finish();
  await done;
});

test('unfinished animation fails with target, property and state rather than passing', async () => {
  const target = {tagName:'LABEL',id:'',className:'item-purpose',
    getBoundingClientRect:()=>({x:10,y:20000,width:300,height:20}),closest:()=>({})};
  await assert.rejects(run([{finished:new Promise(()=>{}), transitionProperty:'color',
    playState:'running',pending:false,currentTime:0,startTime:null,
    effect:{target,getComputedTiming:()=>({duration:200,progress:0})}}],5), error => {
    assert.match(error.message,/did not settle/);
    assert.match(error.message,/LABEL#\.item-purpose/);
    assert.match(error.message,/"property":"color"/);
    assert.match(error.message,/"contentVisibility":"auto"/);
    return true;
  });
});
