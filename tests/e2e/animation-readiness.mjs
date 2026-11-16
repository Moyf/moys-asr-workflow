// Runs in the page. Poll rendered animation state rather than awaiting a captured
// finished Promise: skipped content can report finished before that Promise settles.
// Keep transitions enabled and require two quiet frames, including newly created ones.
export async function settlePageAnimations({timeoutMs = 5000} = {}) {
  const pending = new Set();
  let timer, frame;
  let quietFrames = 0;
  try {
    await new Promise((resolve, reject) => {
      const poll = () => {
        try {
          void document.body.offsetHeight;
          for (const animation of document.getAnimations()) pending.add(animation);
          for (const animation of pending) {
            if (animation.playState === 'idle'
                || (animation.playState === 'finished' && !animation.pending)) pending.delete(animation);
          }
          quietFrames = pending.size ? 0 : quietFrames + 1;
          if (quietFrames >= 2) resolve();
          else frame = requestAnimationFrame(poll);
        } catch (error) { reject(error); }
      };
      timer = setTimeout(() => {
        const details = [...pending].slice(0, 20).map(animation => {
          const target = animation.effect?.target;
          const rect = target?.getBoundingClientRect?.();
          const ancestor = target?.closest?.('.section,.card');
          return {
            target: target ? `${target.tagName}#${target.id}.${target.className}` : null,
            property: animation.transitionProperty ?? animation.animationName ?? null,
            playState: animation.playState, pending: animation.pending,
            currentTime: animation.currentTime, startTime: animation.startTime,
            timing: animation.effect?.getComputedTiming?.(),
            rect: rect ? {x:rect.x,y:rect.y,width:rect.width,height:rect.height} : null,
            contentVisibility: ancestor ? getComputedStyle(ancestor).contentVisibility : null,
            ancestorId: ancestor?.id ?? null,
          };
        });
        reject(new Error(`Page animations did not settle within ${timeoutMs}ms (${pending.size} pending; first 20): ${JSON.stringify(details)}`));
      }, timeoutMs);
      frame = requestAnimationFrame(poll);
    });
  } finally {
    clearTimeout(timer);
    cancelAnimationFrame(frame);
  }
}
