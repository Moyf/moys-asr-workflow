
// === 表情包根目录配置 ===












document.getElementById('sticker-root-confirm')?.addEventListener('click', () => {
  const newRoot = MaweStickerRoot.stickerRootInput.value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  MaweBoot.STICKER_ROOT = newRoot;
  MaweExportTimeline.updateStickerExportButtons();
  MaweStickerRoot.stickerRootModal.classList.remove('show');
  MaweStickerRoot.stickerRootReturnFocus?.focus();
  MaweStickerRoot.stickerRootReturnFocus = null;
  // 重新渲染所有 cue 让 sticker URL 用新根目录拼接
  MaweCuePanel.renderAll();
  MaweHint.flashHint(newRoot ? `根目录已更新` : '已清空根目录', 'success');
});



if (!MaweStickerRoot.stickerRootServerEnabled) {
  MaweStickerRoot.stickerRootInput.disabled = true;
  MaweStickerRoot.stickerRootRead.disabled = true;
}

document.getElementById('sticker-root-btn')?.addEventListener('click', () => {
  MaweStickerRoot.stickerRootInput.value = MaweBoot.STICKER_ROOT || '';
  MaweStickerRoot.setStickerRootStatus(MaweStickerRoot.stickerRootServerEnabled
    ? (MaweBoot.STICKER_ROOT
      ? `当前路径已读取 ${Number(MaweBoot.SERVER_CONFIG.initialStickerCount) || MaweBoot.STICKERS.length} 张图片。可输入 Windows、macOS 或 Linux 绝对路径。`
      : '请输入绝对路径，例如 C:\\Media\\Stickers、/Users/name/Stickers 或 /home/name/Stickers。')
    : '仅 Server 编辑器可以读取和验证表情包绝对路径。');
  MaweStickerRoot.setStickerRootModalOpen(true);
});

document.getElementById('sticker-root-cancel')?.addEventListener('click', () => MaweStickerRoot.setStickerRootModalOpen(false));
MaweStickerRoot.stickerRootModal?.addEventListener('click', (event) => {
  if (event.target === MaweStickerRoot.stickerRootModal) MaweStickerRoot.setStickerRootModalOpen(false);
});
MaweStickerRoot.stickerRootModal?.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    MaweStickerRoot.setStickerRootModalOpen(false);
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = [...MaweStickerRoot.stickerRootModal.querySelectorAll('input:not(:disabled), button:not(:disabled)')];
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

MaweStickerRoot.stickerRootRead.addEventListener('click', async () => {
  if (!MaweStickerRoot.stickerRootServerEnabled || MaweStickerRoot.stickerRootRead.disabled) return;
  const path = MaweStickerRoot.stickerRootInput.value.trim();
  MaweStickerRoot.stickerRootHintCard?.remove();
  MaweStickerRoot.stickerRootHintCard = null;
  MaweStickerRoot.stickerRootRead.disabled = true;
  MaweStickerRoot.stickerRootInput.disabled = true;
  MaweStickerRoot.setStickerRootStatus('正在读取并验证表情包目录…');
  try {
    const response = await fetch(new URL(MaweBoot.SERVER_CONFIG.stickerRootUrl, window.location.href), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestToken: MaweBoot.SERVER_CONFIG.requestToken, path }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || `服务器返回 ${response.status}`);
    MaweBoot.STICKERS.splice(0, MaweBoot.STICKERS.length, ...result.stickers);
    MaweBoot.STICKER_ROOT = result.root;
    MaweBoot.SERVER_CONFIG.initialStickerCount = result.count;
    MaweStickerRoot.stickerRootInput.value = result.root;
    MaweStickerOverlay.stickerAssetRevision += 1;
    MaweServerSave.projectImportDirty = true;
    MaweCuePanel.renderAll();
    MaweStickerRoot.setStickerRootStatus(`路径有效，已读取 ${result.count} 张图片。`);
    MaweStickerRoot.flashStickerRootHint(`表情包根目录已更新，读取 ${result.count} 张图片`, 'success');
  } catch (error) {
    MaweStickerRoot.setStickerRootStatus(`读取失败：${error.message || error}。当前有效根目录和表情包保持不变。`);
    MaweStickerRoot.flashStickerRootHint(`表情包根目录读取失败：${error.message || error}`, 'warning');
  } finally {
    MaweStickerRoot.stickerRootRead.disabled = false;
    MaweStickerRoot.stickerRootInput.disabled = false;
    MaweStickerRoot.stickerRootInput.focus();
  }
});
