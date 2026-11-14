import base from '../config/playwright.config.mjs';
export default { ...base, testDir: '.', outputDir: '../../test-results' };
