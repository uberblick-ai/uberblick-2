import { setImmediate } from "node:timers/promises";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { promptForSecret, REMOTE_JOIN_HELP } from "../src/remote.js";

/** A TTY-shaped input; readline still decodes and edits the actual byte stream. */
class TerminalInput extends PassThrough {
  isTTY = true;
  isRaw = false;
  setRawMode(raw: boolean): this {
    this.isRaw = raw;
    return this;
  }
}

function prompt(input = new TerminalInput(), columns = Number.POSITIVE_INFINITY) {
  let stdout = "";
  let stderr = "";
  const answer = promptForSecret({
    out: (text) => { stdout += text; },
    err: (text) => { stderr += text; },
  }, input, columns);
  return {
    input,
    answer,
    stdout: () => stdout,
    stderr: () => stderr,
    async type(text: string | Buffer) {
      input.write(text);
      await setImmediate();
    },
  };
}

const LABEL = "remote signing secret (input masked): ";

describe("remote signing secret prompt", () => {
  it.each(["typed", "pasted"])("masks %s input on stderr and returns the trimmed value", async (entry) => {
    const p = prompt();
    const secret = "  synthetic-secret-雪😀  ";
    expect(p.input.isRaw).toBe(true);
    if (entry === "typed") {
      for (const char of secret) await p.type(char);
    } else {
      await p.type(secret);
    }
    expect(p.stderr()).toBe(LABEL + "*".repeat(Array.from(secret).length));
    expect(p.stdout()).toBe("");
    await p.type("\r");
    expect(await p.answer).toBe(secret.trim());
    expect(p.stderr()).toBe(`${LABEL}${"*".repeat(Array.from(secret).length)}\n`);
    expect(p.input.isRaw).toBe(false);
    expect(p.input.listenerCount("keypress")).toBe(0);
  });

  it("decodes UTF-8 split across pasted chunks before masking", async () => {
    const p = prompt();
    const bytes = Buffer.from("雪😀");
    for (const byte of bytes) await p.type(Buffer.from([byte]));
    expect(p.stderr()).toBe(`${LABEL}**`);
    await p.type("\n");
    expect(await p.answer).toBe("雪😀");
  });

  it.each(["\x7f", "\b"])("removes one mask with backspace %j and submits the corrected value", async (backspace) => {
    const p = prompt();
    await p.type("abc😀");
    await p.type(backspace);
    expect(p.stderr()).toBe(`${LABEL}****\b \b`);
    await p.type("d\r");
    expect(await p.answer).toBe("abcd");
    expect(p.stdout()).toBe("");
    expect(p.input.isRaw).toBe(false);
  });

  it("preserves cursor editing and does not insert escape sequences into the secret", async () => {
    const p = prompt();
    await p.type("ac");
    await p.type("\x1b[D"); // left
    await p.type("b");
    await p.type("\x1b[3~"); // delete right
    await p.type("\x1b[F"); // end
    await p.type("d\r");
    expect(await p.answer).toBe("abd");
    expect(p.stderr().slice(LABEL.length)).not.toMatch(/[abcd]/);
  });

  it("can erase a mask across a terminal line wrap", async () => {
    const p = prompt(new TerminalInput(), LABEL.length + 2);
    await p.type("abc");
    expect(p.stderr()).toBe(`${LABEL}**\r\n*`);
    await p.type("\x7f\x7f");
    // First erase stays on the lower row; the second reaches the preceding row.
    expect(p.stderr()).toContain(`\b \b\x1b[1A\x1b[${LABEL.length + 2}G \r\n\x1b[1A\x1b[${LABEL.length + 2}G`);
    await p.type("\r");
    expect(await p.answer).toBe("a");
  });

  it("does not display extra input after a pasted newline submits the answer", async () => {
    const p = prompt();
    await p.type("synthetic\rtrailing");
    expect(await p.answer).toBe("synthetic");
    expect(p.stderr()).toBe(`${LABEL}*********\n`);
  });

  it.each(["\x03", "\x04"])("cancels on %j and restores the terminal", async (key) => {
    const p = prompt();
    const rejected = expect(p.answer).rejects.toThrow(
      key === "\x03" ? "Aborted with Ctrl+C" : "Aborted with Ctrl+D",
    );
    await p.type(key);
    await rejected;
    expect(p.input.isRaw).toBe(false);
    expect(p.input.listenerCount("keypress")).toBe(0);
    expect(p.stderr()).toBe(`${LABEL}\n`);
    expect(p.stdout()).toBe("");
  });

  it("Ctrl-D at the end of a nonempty line keeps waiting; Ctrl-C still cancels", async () => {
    const p = prompt();
    let settled = false;
    const answer = p.answer.finally(() => { settled = true; });
    const rejected = expect(answer).rejects.toThrow("Aborted with Ctrl+C");
    await p.type("synthetic");
    await p.type("\x04");
    expect(settled).toBe(false);
    expect(p.stderr()).toBe(`${LABEL}*********`);
    await p.type("\x03");
    await rejected;
    expect(p.input.isRaw).toBe(false);
  });

  it("empty or whitespace-only submissions return no credential", async () => {
    for (const text of ["", "   "]) {
      const p = prompt();
      await p.type(`${text}\r`);
      expect(await p.answer).toBeNull();
      expect(p.input.isRaw).toBe(false);
    }
  });

  it("does not prompt, consume input or enter raw mode without a terminal", async () => {
    const input = new TerminalInput();
    input.isTTY = false;
    const p = prompt(input);
    expect(await p.answer).toBeNull();
    expect(p.stderr()).toBe("");
    expect(p.stdout()).toBe("");
    expect(input.isRaw).toBe(false);
    expect(input.listenerCount("data")).toBe(0);
  });

  it("help describes masks rather than hidden input", () => {
    expect(REMOTE_JOIN_HELP).toContain("one * per character entered");
    expect(REMOTE_JOIN_HELP).not.toContain("input hidden");
  });
});
