// Direct synchronous ASS builders require the same readiness as UI exports.
// Keep this explicit at call sites; globally prewarming would hide lazy-load bugs.
export async function waitForAssFonts(page) {
  await page.waitForFunction(() => Boolean(window.MaweAssFontAliases));
  await page.evaluate(async () => {
    await window.MaweAssFontAliases.ensureCoverage();
    await window.MaweAssFontAliases.whenReady();
    if (window.MaweAssFontAliases.pending()) throw new Error('ASS fonts are still pending');
  });
}
