// Runs in the page. Keep real transitions enabled, but report which animation
// prevents settlement instead of losing the entire test to its outer timeout.
export async function settlePageAnimations({timeoutMs = 5000} = {}) {
  void document.body.offsetHeight;
  const pending = new Set(document.getAnimations());
  const settled = Promise.all([...pending].map(animation =>
    animation.finished.catch(() => {}).finally(() => pending.delete(animation))));
  let timer;
  try {
    await Promise.race([settled, new Promise((_, reject) => {
      timer = setTimeout(() => {
        const details = [...pending].slice(0, 20).map(animation => {
          const target = animation.effect?.target;
          const rect = target?.getBoundingClientRect?.();
          const skippedAncestor = target?.closest?.('.section,.card');
          return {
            target: target ? `${target.tagName}#${target.id}.${target.className}` : null,
            property: animation.transitionProperty ?? animation.animationName ?? null,
            playState: animation.playState, pending: animation.pending,
            currentTime: animation.currentTime, startTime: animation.startTime,
            timing: animation.effect?.getComputedTiming?.(),
            rect: rect ? {x:rect.x,y:rect.y,width:rect.width,height:rect.height} : null,
            contentVisibility: skippedAncestor ? getComputedStyle(skippedAncestor).contentVisibility : null,
            ancestorId: skippedAncestor?.id ?? null,
          };
        });
        reject(new Error(`Page animations did not settle within ${timeoutMs}ms (${pending.size} pending; first 20): ${JSON.stringify(details)}`));
      }, timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
