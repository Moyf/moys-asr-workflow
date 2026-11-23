// Until a probe succeeds, the direct repository link is the only action.
export function bindGitHubStar({ entry, button, thanks, check, write, fallbackFocus }) {
  if (!entry || !button || !thanks || !check || !write) return { open() {} };

  let state = 'idle';
  function render() {
    button.hidden = state !== 'ready' && state !== 'writing';
    button.disabled = state === 'writing';
    thanks.hidden = state !== 'starred';
    entry.hidden = button.hidden && thanks.hidden;
  }

  async function open() {
    if (state === 'checking' || state === 'writing' || state === 'starred') return;
    state = 'checking';
    render();
    try {
      const result = await check();
      state = result?.starred === true ? 'starred' : result?.starred === false ? 'ready' : 'fallback';
    } catch {
      state = 'fallback';
    }
    render();
  }

  button.addEventListener('click', async () => {
    if (state !== 'ready') return;
    const { ownerDocument } = button;
    const hadFocus = ownerDocument.activeElement === button;
    state = 'writing';
    render();
    try {
      state = (await write())?.starred === true ? 'starred' : 'fallback';
    } catch {
      state = 'fallback';
    }
    render();
    if (hadFocus && (ownerDocument.activeElement === button || ownerDocument.activeElement === ownerDocument.body)) {
      const target = state === 'starred' ? thanks : fallbackFocus;
      if (target?.getClientRects().length) target.focus();
    }
  });
  render();
  return { open };
}
