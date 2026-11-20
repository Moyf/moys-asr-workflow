// Direct ASS builds in a test need the same inventory as the production UI.
export async function waitForAssFonts(page) {
  await page.evaluate(async () => {
    await window.MaweAssFontAliases.ensureCoverage();
    await window.MaweAssFontAliases.whenReady();
  });
}

// Media and layout tests can still use real libass without scanning host fonts.
export async function stubAssFontCoverage(page) {
  await page.route('**/api/ass-font-coverage', route => route.fulfill({ json: {
    schema: 'moy.asr.font_coverage.v1', faces: [], cmaps: [], fallbacks: [], complete: true,
  } }));
}
