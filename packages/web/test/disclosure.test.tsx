/**
 * The shared disclosure row (#563).
 *
 * Four contracts, and each one is what a consumer will rely on without asking:
 *
 * 1. **The header is one activation target that says what it is.** A button
 *    carrying `aria-expanded` and pointing at the body it controls — so the
 *    state reaches a screen reader from the markup rather than from a rotated
 *    chevron, and there is exactly one thing in the header to click or tab to.
 * 2. **A closed body is hidden, not discarded.** Unmounting would throw away
 *    whatever the caller put inside, and the loss would only show up in the
 *    consumer that happened to hold state — so identity of the child element is
 *    asserted across a close and reopen, not just its value.
 * 3. **Uncontrolled means the row owns the state after the first paint.** The
 *    caller's `defaultOpen` is a starting point; a later render must not drag
 *    the row back to it.
 * 4. **Controlled means the row holds no answer of its own.** It renders what
 *    it is given and reports the activation. Two activations are what would
 *    expose a second value drifting behind the caller's, so the controlled case
 *    activates twice rather than once.
 *
 * What is deliberately not here: the row's 44px minimum height and its
 * behaviour at a narrow pane width are claims about *rendered* layout, and
 * jsdom performs no layout at all. Playwright is where this repo settles those,
 * and the primitive has no consumer mounted in the app for Playwright to reach
 * — so they rest on the rules in `styles.css` and on review of them, and that
 * is said out loud rather than papered over with a test of the stylesheet's
 * text, which would pass on a rule that never reached an element.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactElement } from "react";
import { Disclosure } from "../src/ui/Disclosure.js";

const teardown: Array<() => void> = [];

afterEach(() => {
  while (teardown.length > 0) teardown.pop()?.();
  vi.restoreAllMocks();
});

interface Row {
  /** The header: the button, and the whole of it. */
  head: () => HTMLButtonElement;
  /** The disclosed body, whether it is showing or not. */
  body: () => HTMLElement;
  /** Render again — a controlled caller changing its mind, or just a repaint. */
  render: (next: ReactElement) => void;
  /** Activate the header the way a pointer does. */
  activate: () => void;
}

function mount(element: ReactElement): Row {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = (next: ReactElement): void => {
    act(() => root.render(next));
  };
  render(element);
  teardown.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  const find = <T extends HTMLElement>(selector: string): T => {
    const found = host.querySelector<T>(selector);
    if (found === null) throw new Error(`no ${selector} in the mounted row`);
    return found;
  };
  return {
    head: () => find<HTMLButtonElement>(".ub-disclosure-head"),
    body: () => find<HTMLElement>(".ub-disclosure-body"),
    render,
    activate: () => act(() => find<HTMLButtonElement>(".ub-disclosure-head").click()),
  };
}

describe("the header is the one activation target", () => {
  it("is a button that names its state and the body it controls", () => {
    const row = mount(
      <Disclosure label="Options considered" secondary="2 options">
        <p>Three were weighed.</p>
      </Disclosure>,
    );

    expect(row.head().tagName).toBe("BUTTON");
    // Not a submit button: a consumer may well put this row inside a form.
    expect(row.head().type).toBe("button");
    expect(row.head().getAttribute("aria-expanded")).toBe("false");
    expect(row.body().id).not.toBe("");
    expect(row.head().getAttribute("aria-controls")).toBe(row.body().id);

    // Nothing else in the header can take the click or the tab stop, which is
    // what makes "the whole header" a true statement rather than a layout one.
    expect(row.head().querySelectorAll("button, a, input, [tabindex]")).toHaveLength(0);

    // Label and secondary value are the caller's words, and the component
    // contributes none of its own — no consumer's vocabulary in the markup,
    // and no text of the component's own beside them.
    expect(row.head().textContent).toBe("Options considered2 options");

    // The mark is drawn, not conjured on hover: it is in the header from the
    // first paint, and only its angle moves.
    expect(row.head().querySelector(".ub-disclosure-mark")).not.toBeNull();
  });

  it("renders no secondary value when the caller gives none", () => {
    const row = mount(<Disclosure label="Reconsider when">later</Disclosure>);
    expect(row.head().querySelector(".ub-disclosure-secondary")).toBeNull();
    expect(row.head().textContent).toBe("Reconsider when");
  });
});

describe("closing hides the body", () => {
  it("keeps the caller's subtree mounted across a close and reopen", () => {
    const row = mount(
      <Disclosure label="Notes" defaultOpen>
        <input className="probe" />
      </Disclosure>,
    );

    const field = row.body().querySelector<HTMLInputElement>(".probe");
    expect(field).not.toBeNull();
    // State a child holds and React does not: the DOM value of an
    // uncontrolled field is exactly what an unmount would throw away.
    if (field !== null) field.value = "half-written";

    row.activate();
    expect(row.head().getAttribute("aria-expanded")).toBe("false");
    expect(row.body().hidden).toBe(true);
    // Hidden, and still there.
    expect(row.body().querySelector(".probe")).toBe(field);

    row.activate();
    expect(row.body().hidden).toBe(false);
    expect(row.body().querySelector(".probe")).toBe(field);
    expect(field?.value).toBe("half-written");
  });
});

describe("who owns the open state", () => {
  it("starts an uncontrolled row where the caller said, then owns it", () => {
    const seen: boolean[] = [];
    const row = mount(
      <Disclosure label="Options" defaultOpen onOpenChange={(open) => seen.push(open)}>
        body
      </Disclosure>,
    );
    expect(row.head().getAttribute("aria-expanded")).toBe("true");

    row.activate();
    expect(row.head().getAttribute("aria-expanded")).toBe("false");
    expect(seen).toEqual([false]);

    // The same props again. `defaultOpen` is a starting point, not a value to
    // be re-read: a repaint must not reopen a row the reader just closed.
    row.render(
      <Disclosure label="Options" defaultOpen onOpenChange={(open) => seen.push(open)}>
        body
      </Disclosure>,
    );
    expect(row.head().getAttribute("aria-expanded")).toBe("false");
    expect(seen).toEqual([false]);
  });

  it("renders a controlled caller's value and holds no answer of its own", () => {
    const seen: boolean[] = [];
    const controlled = (open: boolean): ReactElement => (
      <Disclosure label="Options" open={open} onOpenChange={(next) => seen.push(next)}>
        body
      </Disclosure>
    );
    const row = mount(controlled(false));

    // The caller declines to act on the first activation. A row keeping its own
    // value would open anyway, and the two would be out of step from here on.
    row.activate();
    expect(seen).toEqual([true]);
    expect(row.head().getAttribute("aria-expanded")).toBe("false");

    row.render(controlled(true));
    expect(row.head().getAttribute("aria-expanded")).toBe("true");
    expect(row.body().hidden).toBe(false);

    // The second activation is the one that would expose a hidden value: it
    // reports against what the caller last rendered, not against a count of
    // clicks.
    row.activate();
    expect(seen).toEqual([true, false]);
    expect(row.head().getAttribute("aria-expanded")).toBe("true");

    row.render(controlled(false));
    expect(row.head().getAttribute("aria-expanded")).toBe("false");
  });

  it("reads and writes no storage in either mode", () => {
    // The sidebar's group row — this row's nearest relative — persists its own
    // collapse through `useStoredFlag`. A shared primitive must not, or every
    // consumer inherits a key it never asked for.
    const read = vi.spyOn(Storage.prototype, "getItem");
    const write = vi.spyOn(Storage.prototype, "setItem");

    const uncontrolled = mount(<Disclosure label="Options">body</Disclosure>);
    uncontrolled.activate();
    uncontrolled.activate();

    const controlled = mount(
      <Disclosure label="Options" open onOpenChange={() => undefined}>
        body
      </Disclosure>,
    );
    controlled.activate();

    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});
