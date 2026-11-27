import { MaweBoot } from './editor-boot.js';
import { AsrEditorUtils } from '../../shared/editor-utils.js';

export function initMaweBootDiagnostics() {
  window.addEventListener('error', (event) => {
    const details = {
      message: event.message,
      source: event.filename,
      line: event.lineno,
      column: event.colno,
      stack: event.error?.stack || null,
    };
    console.error('[MAWE][runtime] uncaught error', details);
  });
  window.addEventListener('unhandledrejection', (event) => {
    console.error('[MAWE][runtime] unhandled rejection', event.reason);
  });
  if (!AsrEditorUtils) {
    console.error('[MAWE][boot] AsrEditorUtils is unavailable; editor scripts are incomplete or out of order');
  }
  MaweBoot.maweDomContractCheck();
}
