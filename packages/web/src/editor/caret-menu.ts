/** A stable key/attribute bridge: mounting UI must not rebuild plugin views. */
import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";

export interface CaretMenuController {
  handleKey: ((key: string) => boolean) | null;
  listId: string;
  activeId: string | undefined;
}

interface CaretMenuStorage {
  menus: Set<CaretMenuController>;
}

declare module "@tiptap/core" {
  interface Storage {
    caretMenuKeys: CaretMenuStorage;
  }
}

export const CaretMenuKeys = Extension.create<Record<string, never>, CaretMenuStorage>({
  name: "caretMenuKeys",
  // Ahead of core Enter, list bindings and collaboration's keymap.
  priority: 1000,
  addStorage: () => ({ menus: new Set() }),
  addProseMirrorPlugins() {
    const { menus } = this.storage;
    return [new Plugin({
      props: {
        handleKeyDown: (_view, event) => {
          if (event.isComposing || event.keyCode === 229) return false;
          for (const menu of menus) {
            if (menu.handleKey?.(event.key)) return true;
          }
          return false;
        },
        attributes: () => {
          const active = [...menus].find((menu) => menu.handleKey !== null && menu.activeId !== undefined);
          return {
            role: "textbox",
            "aria-label": "Document content",
            "aria-multiline": "true",
            "aria-readonly": String(!this.editor.isEditable),
            ...(active?.activeId !== undefined ? { "aria-controls": active.listId, "aria-activedescendant": active.activeId } : {}),
          };
        },
      },
    })];
  },
});
