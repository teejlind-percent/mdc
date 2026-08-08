/**
 * The CodeMirror extension stack for edit mode: markdown language + syntax
 * highlighting, 4-space indent, line wrapping, and the keybindings that must
 * win over CodeMirror's defaults.
 */

import { indentWithTab } from "@codemirror/commands";
import { insertNewlineContinueMarkup, deleteMarkupBackward, markdown } from "@codemirror/lang-markdown";
import { indentUnit } from "@codemirror/language";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { markdownHighlightExtension } from "./markdownHighlight.js";
import { livePreviewExtension } from "./livePreview.js";
import { imagePasteExtension, type ImagePasteOptions } from "./imagePaste.js";
import { transientSetextHeadingExtension } from "./transientSetextHeading.js";

export function createEditorExtensions(openPalette: () => void, imagePaste?: ImagePasteOptions) {
  return [
    EditorView.lineWrapping,
    // 4-space indent: markdown needs 4 spaces to nest ORDERED lists (2 nests
    // bullets but flattens numbered lists in the renderer). Tab/continuation
    // both follow this unit, so nesting in the editor matches view mode.
    indentUnit.of("    "),
    markdown({ extensions: transientSetextHeadingExtension }),
    markdownHighlightExtension,
    // Bear-style: conceal inline markup except on the line being edited. Purely
    // decorative — the document stays plain markdown.
    livePreviewExtension,
    ...(imagePaste ? [imagePasteExtension(imagePaste)] : []),
    // Prec.highest so ⌘/ opens the palette instead of CodeMirror's default
    // Mod-/ = toggleComment (which otherwise shadows it). The shadowing is
    // silent and independent of registration order — any custom binding that
    // must beat a CM default needs Prec.highest.
    Prec.highest(
      keymap.of([
        {
          key: "Mod-/",
          preventDefault: true,
          run: () => {
            openPalette();
            return true;
          },
        },
      ]),
    ),
    keymap.of([
      // Enter continues a list/quote marker (numbered lists auto-increment);
      // Backspace on an empty marker removes it.
      { key: "Enter", run: insertNewlineContinueMarkup },
      { key: "Backspace", run: deleteMarkupBackward },
      indentWithTab,
    ]),
  ];
}
