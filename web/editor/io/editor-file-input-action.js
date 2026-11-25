/**
 * Launch synchronously for user activation. Only a palette invocation waits
 * for the browser's selection and the application's import result.
 * @param {HTMLInputElement} input
 * @param {(event: Event) => boolean | Promise<boolean>} handleChange
 * @returns {(waitForResult: boolean, prepare?: () => boolean | void) => false | void | Promise<boolean>}
 */
export function bindFileInputAction(input, handleChange) {
  /** @type {{ resolve: (result: boolean) => void, reject: (error: unknown) => void } | null} */
  let waiting = null;
  let processing = false;

  input.addEventListener('change', async event => {
    if (processing) return;
    const request = waiting;
    waiting = null;
    processing = true;
    try {
      const applied = await handleChange(event);
      request?.resolve(applied === true);
    } catch (error) {
      if (!request) throw error;
      request.reject(error);
    } finally {
      processing = false;
    }
  });

  function cancelPendingChoice() {
    const request = waiting;
    waiting = null;
    request?.resolve(false);
  }
  input.addEventListener('cancel', cancelPendingChoice);

  return (waitForResult, prepare) => {
    if (processing) return false;
    // Legacy click() can silently fail without firing cancel. An explicit
    // retry replaces only the waiting choice, never an import in progress.
    cancelPendingChoice();
    if (prepare?.() === false) return false;
    if (!waitForResult) {
      input.value = '';
      input.click();
      return;
    }
    if (input.ownerDocument.defaultView?.navigator.userActivation?.isActive === false) return false;
    input.value = '';
    return new Promise((resolve, reject) => {
      waiting = { resolve, reject };
      try {
        if (typeof input.showPicker === 'function') input.showPicker();
        else input.click();
      } catch (error) {
        waiting = null;
        reject(error);
      }
    });
  };
}
