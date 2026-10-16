import { getMaweState } from "../state/editor-state.js";
import { MaweDom } from "../ui/editor-dom.js";

export function updateSelectionCountText() {
  const selection = getMaweState().selection;
  MaweDom.selCountEl.textContent = String(
    selection.indices('main').size
      + selection.indices('extension').size
      + selection.indices('overlay').size,
  );
}
