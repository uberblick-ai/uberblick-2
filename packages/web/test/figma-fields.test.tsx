import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FigmaFields } from "../src/editor/figma-fields.js";
import { act, render } from "./react-render.js";

const URL = "https://www.figma.com/design/key/Checkout-flow";

function fixture(options: { url?: string; title?: string; height?: string; discardInvalid?: boolean; saveOnBlur?: boolean } = {}) {
  const onSave = vi.fn();
  const onDone = vi.fn();
  render(<FigmaFields url={options.url ?? URL} title={options.title ?? "Payment"} height={options.height ?? "560"}
    discardInvalid={options.discardInvalid ?? false} saveOnBlur={options.saveOnBlur ?? true} onSave={onSave} onDone={onDone} />);
  const link = screen.getByRole<HTMLInputElement>("textbox", { name: "Figma link" });
  const title = screen.getByRole<HTMLInputElement>("textbox", { name: "Title" });
  const height = screen.getByRole<HTMLInputElement>("textbox", { name: "Height" });
  const submit = (): void => {
    const form = link.closest("form");
    if (form === null) throw new Error("Figma fields have no form");
    act(() => { fireEvent.submit(form); });
  };
  return { onSave, onDone, link, title, height, submit };
}

function change(input: HTMLInputElement, value: string): void {
  act(() => { fireEvent.change(input, { target: { value } }); });
}

function blur(input: HTMLInputElement): void {
  act(() => { fireEvent.blur(input); });
}

describe("Figma fields", () => {
  it.each([
    ["https://example.com/design/key", "figma blocks take figma.com links only; use a plain link for other sites"],
    ["https://figma.com/deck/key", "Figma links must use /design/, /file/, /proto/, /board/, /slides/ or /community/file/, followed by a file key and optional file name"],
  ])("shows the schema refusal for %s and saves none of the fields", (url, message) => {
    const fields = fixture();
    change(fields.link, url);
    change(fields.title, "Changed title");
    change(fields.height, "600");
    expect(fields.onSave).not.toHaveBeenCalled();
    blur(fields.title);
    expect(screen.getByRole("alert").textContent).toBe(message);
    expect(fields.onSave).not.toHaveBeenCalled();
    fields.submit();
    expect(fields.onSave).not.toHaveBeenCalled();
    expect(fields.onDone).not.toHaveBeenCalled();
  });

  it("normalizes a valid link and commits the complete valid form on blur", () => {
    const fields = fixture();
    change(fields.link, "https://figma.com/design/key/Checkout-flow?node-id=12-345&t=tracking#fragment");
    change(fields.title, "**Payment** <strong>mobile</strong>");
    change(fields.height, "600");
    expect(fields.onSave).not.toHaveBeenCalled();
    blur(fields.link);
    expect(fields.onSave).toHaveBeenCalledExactlyOnceWith({
      url: `${URL}?node-id=12-345`, title: "**Payment** <strong>mobile</strong>", height: "600",
    });
    expect(fields.link.value).toBe(`${URL}?node-id=12-345`);
    expect(fields.title.value).toBe("**Payment** <strong>mobile</strong>");
    expect(document.querySelector("strong")).toBeNull();
    expect(fields.onDone).not.toHaveBeenCalled();
  });

  it("keeps title input on one line and clears an empty title and height", () => {
    const fields = fixture();
    change(fields.title, "Payment\nmobile\rnext");
    blur(fields.title);
    expect(fields.onSave.mock.lastCall?.[0].title).not.toMatch(/[\r\n]/);
    change(fields.title, "");
    change(fields.height, "");
    blur(fields.height);
    expect(fields.onSave).toHaveBeenLastCalledWith({ url: URL, title: null, height: null });
    expect(fields.height.placeholder).toBe("480");
  });

  it.each(["239", "961", "480.5"])("refuses invalid height %s without saving another changed field", (height) => {
    const fields = fixture();
    change(fields.height, height);
    change(fields.title, "Changed title");
    blur(fields.title);
    expect(screen.getByRole("alert").textContent).toBe("Height must be a whole number of pixels from 240 to 960");
    expect(fields.onSave).not.toHaveBeenCalled();
    fields.submit();
    expect(fields.onSave).not.toHaveBeenCalled();
    expect(fields.onDone).not.toHaveBeenCalled();
  });

  it.each(["240", "960"])("saves boundary height %s and closes on Done submission", (height) => {
    const fields = fixture();
    change(fields.height, height);
    fields.submit();
    expect(fields.onSave).toHaveBeenCalledExactlyOnceWith({ url: URL, title: "Payment", height });
    expect(fields.onDone).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("lets Done discard an invalid draft without saving it", () => {
    const fields = fixture({ url: "", title: "", height: "", discardInvalid: true });
    change(fields.link, "https://figma.com/deck/key");
    blur(fields.link);
    expect(fields.onSave).not.toHaveBeenCalled();
    expect(fields.onDone).not.toHaveBeenCalled();
    fields.submit();
    expect(fields.onSave).not.toHaveBeenCalled();
    expect(fields.onDone).toHaveBeenCalledOnce();
  });

  it("keeps all draft fields local without validating blurs until submission", () => {
    const fields = fixture({ url: "", title: "", height: "", saveOnBlur: false });
    change(fields.title, "Title first");
    blur(fields.title);
    expect(screen.queryByRole("alert")).toBeNull();
    change(fields.link, URL);
    blur(fields.link);
    change(fields.height, "600");
    blur(fields.height);
    expect(fields.onSave).not.toHaveBeenCalled();
    expect(fields.onDone).not.toHaveBeenCalled();
    fields.submit();
    expect(fields.onSave).toHaveBeenCalledExactlyOnceWith({ url: URL, title: "Title first", height: "600" });
    expect(fields.onDone).toHaveBeenCalledOnce();
  });
});
