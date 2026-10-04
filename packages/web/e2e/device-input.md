# Manual device input checklist

Use Safari on a real iPhone, iPad and 13-inch MacBook with a disposable document.
Playwright's WebKit covers engine behavior and device-sized layouts; these
checks cover native input it cannot reproduce. This checklist is not a delivery
gate.

| Device | Action | Expected result |
| --- | --- | --- |
| iPhone | Tap a paragraph to show the on-screen keyboard; open the slash menu, then select text and open Link and Comment. Dismiss and reopen the keyboard. | The caret, active field and menu choices remain reachable above the keyboard; long menus scroll internally, and dismissing the keyboard restores the visible area. |
| iPad | In portrait and landscape, repeat the keyboard check with the on-screen keyboard, including Link and Comment fields. | The editor keeps focus, the active input stays visible, and the cards remain usable within the visible area. |
| iPhone and iPad | Long-press prose, adjust the native selection handles, then use the native Copy and Paste menu. | The native selection menu remains usable; selection follows the handles, and pasting inserts the chosen text once without losing the selection or leaving stale editor controls. |
| iPhone and iPad | Enable a Japanese or Chinese keyboard, compose text in prose and a Link or Comment field, choose a candidate, then continue typing. | Candidate selection commits the composed text once; intermediate composition does not prematurely submit a field or choose an editor menu item, and the caret stays at the committed text. |
| MacBook | In Safari, use a Japanese or Chinese input method to compose prose and a Link or Comment field; choose a candidate, continue typing, then undo. | Composition commits once without premature menu activation or field submission; continued typing and undo preserve the text and caret. |
