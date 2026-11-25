import { MAWE_I18N } from './editor-i18n.js';

function translate(message) {
  return MAWE_I18N?.translateText(message) ?? message;
}

export const editorDialogs = Object.freeze({
  alert(message) {
    window.alert(translate(message));
  },
  confirm(message) {
    return window.confirm(translate(message));
  },
  prompt(message, initial) {
    return window.prompt(translate(message), initial);
  },
});
