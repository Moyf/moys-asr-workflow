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

// Layout/media tests still use real libass rendering. Only system-wide font
// discovery is deterministic here; cold/lazy coverage stays in the dedicated
// font lifecycle cases and the default-profile export UI test.
export async function stubAssFontCoverage(page) {
  await page.route('**/api/ass-font-coverage', route => route.fulfill({ json: {
    schema: 'moy.asr.font_coverage.v1', faces: [], cmaps: [], fallbacks: [], complete: true,
  } }));
}
