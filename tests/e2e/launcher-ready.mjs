// File-page journeys have an absent or injected host. Complete discovery via
// the real listener, leaving application clocks and bridge methods untouched.
// The native timeout journey stays in launcher-interactions.spec.mjs.
export async function completeStaticLauncherDiscovery(page) {
  await page.evaluate(() => window.dispatchEvent(new Event('pywebviewready')));
}
