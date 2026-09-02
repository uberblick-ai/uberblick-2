#!/usr/bin/env python3
"""Derive packages/web/e2e/proof0b-control.ts from proof0-control.ts.

Helpers (McpProcess, trace, editorBlocks, ...) are kept verbatim; main() is
replaced with the instrumented, parameterised version below.

Env flags of the derived driver:
  PROOF0_KEEP_DIR      keep the run root (hub.sqlite, trace.jsonl, result.json)
  PROOF0_NO_IDB=1      disable IndexedDB in the browser
  PROOF0B_AUTHORS      comma list of pre-outage authors of the block, default
                       "web,agents,concurrent" (= the Proof 0 control):
                         web        browser types "-web" before the agents edit
                         agents     Agent Alpha and Agent Beta append via edit_block
                         concurrent browser offline + same-block agent edit + reconnect
                       "creator" alone leaves the MCP creator's "middle" as the only text
  PROOF0B_OUTAGE       "stop" (default: hub.stop(), then restart), "pause"
                       (context.setOffline(true/false); the hub never stops) or
                       "none" (no outage at all)
  PROOF0B_SETTLE_MS    wait this long after the outage is noticed before typing (default 0)
  PROOF0B_NO_CLICK=1   do not re-click the block before typing after the outage
  PROOF0B_TYPE_TEXT    what the browser types after the outage (default "-hub-down")
  PROOF0B_CARET        how the driver places the caret before typing after the outage:
                         click     (default) page.mouse.click at the block's right edge — the Proof 0 gesture
                         keyboard  press End when the editor already has focus; click only when it does not
                         wait      wait out ProseMirror's 500 ms multi-click window, then click
"""
import os
import sys

W = sys.argv[1]
SRC = os.path.join(W, "packages/web/e2e/proof0-control.ts")
DST = os.path.join(W, "packages/web/e2e/proof0b-control.ts")

src = open(SRC).read()
marker = "/** Production-path control run. */"
assert src.count(marker) == 1
head = src[: src.index(marker)]

head = head.replace(
    " * Proof 0 CONTROL: the same user-visible scenario on the production path.",
    " * Proof 0b CONTROL (instrumented, parameterised): derived from proof0-control.ts.",
)

MAIN = r'''/** Production-path control run, instrumented. */
async function main(): Promise<void> {
  const root = KEEP_DIR
    ? mkdtempSync(join(KEEP_DIR, "control-run-"))
    : mkdtempSync(join(tmpdir(), "uberblick-proof0b-control-"));
  traceFile = join(root, "trace.jsonl");
  const disableIndexedDb = process.env.PROOF0_NO_IDB === "1";
  const authors = new Set((process.env.PROOF0B_AUTHORS ?? "web,agents,concurrent").split(",").map((a) => a.trim()).filter(Boolean));
  const outage = process.env.PROOF0B_OUTAGE === "pause" ? "pause" : process.env.PROOF0B_OUTAGE === "none" ? "none" : "stop";
  const settleMs = Number(process.env.PROOF0B_SETTLE_MS ?? "0");
  const noClick = process.env.PROOF0B_NO_CLICK === "1";
  const typeText = process.env.PROOF0B_TYPE_TEXT ?? "-hub-down";
  const caret = process.env.PROOF0B_CARET === "keyboard" ? "keyboard" : process.env.PROOF0B_CARET === "wait" ? "wait" : "click";
  const scenario = { authors: [...authors], outage, settleMs, noClick, typeText, caret, disableIndexedDb };
  trace("start", { root, keep: KEEP_DIR !== null, node: process.version, platform: process.platform, scenario });
  const hubDatabase = join(root, "hub.sqlite");
  const hubLogs: HubLogRecord[] = [];
  let hub: Hub | null = null;
  let vite: ViteDevServer | null = null;
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  const clients = new Set<McpProcess>();
  const hubConfig: HubConfig = {
    authSecret: SECRET,
    port: 0,
    databasePath: hubDatabase,
    log: (record) => hubLogs.push(record),
    debounce: 20,
    maxDebounce: 200,
    shutdownTimeoutMs: 5_000,
  };
  const directEnv = (name: string): NodeJS.ProcessEnv => {
    const home = join(root, name);
    return {
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      WORKSPACE_ID: WORKSPACE,
      HUB_AUTH_TOKEN: SECRET,
      UBERBLICK_DB: join(home, `${name}.sqlite`),
    };
  };
  const writeConfig = (env: NodeJS.ProcessEnv, hubUrl: string): void => {
    const { configDir } = resolveStorage({ env });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), `${JSON.stringify({ workspace: WORKSPACE, hubUrl })}\n`);
  };

  try {
    hub = await createHub(hubConfig);
    const hubPort = hub.port;
    const hubUrl = `ws://127.0.0.1:${hubPort}`;
    const alphaEnv = directEnv("alpha");
    const betaEnv = directEnv("beta");
    writeConfig(alphaEnv, hubUrl);
    writeConfig(betaEnv, hubUrl);
    const alpha = new McpProcess(alphaEnv, { name: "codex", title: "Agent Alpha" });
    const beta = new McpProcess(betaEnv, { name: "claude-code", title: "Agent Beta" });
    clients.add(alpha);
    clients.add(beta);
    await Promise.all([alpha.ready, beta.ready]);

    const document = await alpha.call<DocPayload>("create_doc", {
      title: "Proof 0b control",
      description: "Production path, instrumented.",
      blocks: [{ type: "paragraph", text: "middle" }],
    });
    const uuid = document.uuid;
    const room = `${WORKSPACE}/${uuid}`;
    await waitUntil("Beta to see the document", async () => {
      try {
        const read = await beta.call<DocPayload>("get_doc", { uuid });
        return read.blocks.length > 0 ? read : false;
      } catch {
        return false;
      }
    });

    const runningVite = await startVite(hubUrl);
    vite = runningVite.server;
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    if (disableIndexedDb) {
      await context.addInitScript(() => {
        Object.defineProperty(globalThis, "indexedDB", { value: undefined, configurable: true });
      });
    }
    const page = await context.newPage();
    page.on("console", (msg) => {
      const text = msg.text();
      if (text.startsWith("P0B ")) {
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = JSON.parse(text.slice(4)) as Record<string, unknown>;
        } catch {
          parsed = null;
        }
        traceLine(`P0B ${JSON.stringify({ t: Date.now(), from: "browser", ...(parsed ?? { raw: text.slice(4, 2000) }) })}`);
        return;
      }
      if (msg.type() === "error" || msg.type() === "warning") {
        trace("browser-console", { type: msg.type(), text: text.slice(0, 500) });
      }
    });
    page.on("pageerror", (error) => trace("browser-pageerror", { text: String(error).slice(0, 500), stack: String((error as { stack?: string }).stack ?? "").slice(0, 2000) }));
    const allAwareness = () => {
      const states = hub?.hocuspocus.documents.get(room)?.awareness.getStates();
      return states
        ? [...states.entries()].map(([clientId, state]) => ({
            clientId,
            name: (state.user as { name?: string } | undefined)?.name ?? null,
            client: state.client ?? null,
          }))
        : null;
    };
    const pmState = async (): Promise<unknown> => {
      try {
        return await page.evaluate(() => (globalThis as { __p0state?: () => unknown }).__p0state?.() ?? null);
      } catch (error) {
        return `error: ${message(error)}`;
      }
    };
    const snap = async (step: string, client: McpProcess | null, extra: Record<string, unknown> = {}): Promise<void> => {
      let mcp: unknown = null;
      if (client !== null) {
        try {
          mcp = (await client.call<DocPayload>("get_doc", { uuid })).blocks.map((block) => ({ id: block.id, text: block.text }));
        } catch (error) {
          mcp = `error: ${message(error)}`;
        }
      }
      let web: unknown = null;
      try {
        web = await editorBlocks(page);
      } catch (error) {
        web = `error: ${message(error)}`;
      }
      let webStatus: string | null = null;
      try {
        webStatus = await page.locator(".ub-status .ub-status-word").first().textContent({ timeout: 2_000 });
      } catch {
        webStatus = null;
      }
      trace(step, { web, webStatus, mcp, hub: hubRawBlocks(hub, room), pm: await pmState(), ...extra });
    };

    await page.goto(new URL(`/${WORKSPACE}/${uuid}`, runningVite.appUrl).href);
    await page.locator(".ub-editor .ProseMirror").waitFor();
    await waitUntil("the browser to read the document", async () => ((await editorText(page)) === "middle" ? "middle" : false));
    const indexedDbPresent = await page.evaluate(() => typeof indexedDB !== "undefined");
    await snap("01-browser-opened", alpha, { indexedDbPresent });

    if (authors.has("web")) {
      await caretToEnd(page);
      await page.keyboard.type("-web", { delay: 15 });
      await waitUntil("an MCP client to read the web write", async () => {
        const read = await alpha.call<DocPayload>("get_doc", { uuid });
        return read.blocks[0]?.text.endsWith("-web") ? read.blocks[0].text : false;
      });
    }
    await snap("02-web-typed", alpha);

    if (authors.has("agents")) {
      const alphaBlock = (await alpha.call<DocPayload>("get_doc", { uuid })).blocks[0];
      ensure(alphaBlock !== undefined, "agent document has no block");
      await alpha.call<EditPayload>("edit_block", { uuid, block_id: alphaBlock.id, old_text: alphaBlock.text, new_text: `${alphaBlock.text}-alpha`, rev: alphaBlock.rev });
      await waitUntil("Agent Alpha's edit in the web app", async () => ((await editorText(page)).endsWith("-alpha") ? true : false));
      await snap("03-alpha-edited", alpha);
      const betaBlock = await waitUntil("Beta to see Alpha's edit", async () => {
        const block = (await beta.call<DocPayload>("get_doc", { uuid })).blocks[0];
        return block?.text.endsWith("-alpha") ? block : false;
      });
      await beta.call<EditPayload>("edit_block", { uuid, block_id: betaBlock.value.id, old_text: betaBlock.value.text, new_text: `${betaBlock.value.text}-beta`, rev: betaBlock.value.rev });
      await waitUntil("Agent Beta's edit in the web app", async () => ((await editorText(page)).endsWith("-beta") ? true : false));
    }
    await snap("04-beta-edited", beta, { awareness: allAwareness() });

    if (authors.has("concurrent")) {
      const beforeConcurrent = (await beta.call<DocPayload>("get_doc", { uuid })).blocks[0];
      ensure(beforeConcurrent !== undefined, "concurrency block missing");
      await context.setOffline(true);
      await caretToEnd(page);
      await page.keyboard.type("-offline-web", { delay: 5 });
      await beta.call<EditPayload>("edit_block", { uuid, block_id: beforeConcurrent.id, old_text: beforeConcurrent.text, new_text: `agent-${beforeConcurrent.text}`, rev: beforeConcurrent.rev });
      await snap("05-offline-both-edited", beta);
      await context.setOffline(false);
      await waitUntil("the concurrent same-block edits to converge", async () => {
        const webText = await editorText(page);
        const mcpText = (await beta.call<DocPayload>("get_doc", { uuid })).blocks[0]?.text ?? "";
        return webText === mcpText && webText.includes("agent-") && webText.includes("-offline-web") ? webText : false;
      });
    } else if (authors.has("web")) {
      await caretToEnd(page);
      await page.keyboard.type("-offline-web", { delay: 5 });
      await waitUntil("the online web edit to reach Beta", async () => {
        const webText = await editorText(page);
        const mcpText = (await beta.call<DocPayload>("get_doc", { uuid })).blocks[0]?.text ?? "";
        return webText === mcpText && webText.includes("-offline-web") ? webText : false;
      });
    }
    const converged = await waitUntil("web and Beta to agree before the outage", async () => {
      const webText = await editorText(page);
      const mcpText = (await beta.call<DocPayload>("get_doc", { uuid })).blocks[0]?.text ?? "";
      return webText === mcpText && webText !== "" ? webText : false;
    });
    await snap("06-online-converged", beta, { preOutageText: converged.value });

    await alpha.close();
    clients.delete(alpha);
    await snap("07-alpha-left", beta, { awareness: allAwareness() });

    await snap("08-before-outage", beta, { hubUp: true, outage });
    if (outage === "stop") {
      await hub.stop();
      hub = null;
      trace("09-hub-stopped");
      const hubDown = await waitUntil("Beta to report the hub down", async () => {
        const status = await beta.call<SyncPayload>("sync_status");
        return status.hub.status === "hub-down" ? status : false;
      });
      await snap("10-mcp-reports-hub-down", beta, { betaStatus: hubDown.value.hub.status });
      const webStatusDuringOutage = await waitUntil("the browser to notice the hub is gone", async () => {
        const word = await page.locator(".ub-status .ub-status-word").first().textContent();
        return word !== null && word !== "synced" ? word : false;
      });
      await snap("11-before-typing", beta, { webStatusDuringOutage: webStatusDuringOutage.value });
    } else if (outage === "pause") {
      await context.setOffline(true);
      trace("09-network-paused");
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      await snap("11-before-typing", beta, { webStatusDuringOutage: null });
    } else {
      trace("09-no-outage");
      await snap("11-before-typing", beta, { webStatusDuringOutage: null });
    }
    if (settleMs > 0) {
      trace("11b-settling", { settleMs });
      await new Promise((resolveWait) => setTimeout(resolveWait, settleMs));
      await snap("11c-settled", beta);
    }
    // The candidate harness fix. A mouse click is classified by ProseMirror
    // against its own `input.lastClick` (<500 ms, <10 px => double, then
    // triple), independent of the event's native click count, and a triple
    // click selects the whole textblock. Placing the caret by keyboard when
    // the editor already has focus never enters that heuristic; waiting out
    // the window keeps a click a single click.
    if (!noClick) {
      if (caret === "keyboard") {
        // `globalThis.document`: this file has a local `document` (the created doc), which esbuild renames inside the serialised arrow.
        const focused = await page.evaluate(() => globalThis.document.activeElement?.closest(".ProseMirror") != null);
        if (focused) await page.keyboard.press("End");
        else await caretToEnd(page);
        trace("12a-caret-strategy", { caret, focused });
      } else if (caret === "wait") {
        await new Promise((resolveWait) => setTimeout(resolveWait, 550));
        await caretToEnd(page);
        trace("12a-caret-strategy", { caret });
      } else {
        await caretToEnd(page);
      }
    }
    await snap("12-caret-placed", beta, { clicked: !noClick, caret });
    await page.keyboard.type(typeText, { delay: 5 });
    await snap("13-typed", beta);
    const expectedOutageText = `${converged.value}${typeText}`;
    const webDuringOutage = await editorBlocks(page);

    if (outage === "stop") {
      hub = await createHub({ ...hubConfig, port: hubPort });
      trace("15-hub-restarted");
    } else if (outage === "pause") {
      await context.setOffline(false);
      trace("15-network-resumed");
    } else {
      trace("15-no-outage");
    }
    const reconnect = await waitUntil("Beta reconnected with nothing pending", async () => {
      const status = await beta.call<SyncPayload>("sync_status");
      return status.hub.status === "connected" && status.pendingRooms.length === 0 ? status : false;
    });
    const atHub = await waitUntil("the outage edit at the hub", () => {
      const documentAtHub = hub?.hocuspocus.documents.get(room);
      if (!documentAtHub) return false;
      const texts = getBlocks(documentAtHub).map((block) => block.text);
      return texts.some((text) => text.includes(typeText)) ? texts : false;
    });
    const convergedAfter = await waitUntil("browser, Beta and hub to converge after the outage", async () => {
      const mcpText = (await beta.call<DocPayload>("get_doc", { uuid })).blocks.map((block) => block.text).join("\n");
      const webText = await editorAllText(page);
      return mcpText === webText && mcpText.includes(typeText) ? mcpText : false;
    });
    await snap("16-after-reconnect", beta, { awareness: allAwareness() });
    const retainedPreOutageContent = convergedAfter.value.split("\n").some((text) => text === expectedOutageText);

    const gamma = new McpProcess(directEnv("gamma"), { name: "fresh", title: "Agent Gamma" });
    writeConfig(directEnv("gamma"), hubUrl);
    clients.add(gamma);
    await gamma.ready;
    const gammaRead = await waitUntil("a fresh MCP client to hydrate the document", async () => {
      try {
        const read = await gamma.call<DocPayload>("get_doc", { uuid });
        return read.blocks.some((block) => block.text.includes(typeText)) ? read.blocks : false;
      } catch {
        return false;
      }
    });
    await snap("17-fresh-client-hydrated", gamma);

    const finalWeb = await editorBlocks(page);
    const finalMcp = (await beta.call<DocPayload>("get_doc", { uuid })).blocks;
    const finalHub = hubRawBlocks(hub, room) ?? [];
    const result = {
      schemaVersion: 2,
      control: "proof0b instrumented production path",
      scenario,
      node: process.version,
      platform: process.platform,
      indexedDbPresent,
      preOutageText: converged.value,
      outage: {
        expectedText: expectedOutageText,
        webBlocksDuringOutage: webDuringOutage,
        atHubAfterRestart: atHub.value,
        convergedText: convergedAfter.value,
        retainedPreOutageContent,
        reconnectStatus: reconnect.value.hub.status,
      },
      freshClient: gammaRead.value.map((block) => block.text),
      final: {
        web: finalWeb,
        mcp: finalMcp.map((block) => ({ id: block.id, text: block.text })),
        hub: finalHub,
      },
      lossObserved: !retainedPreOutageContent,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    writeFileSync(join(root, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  } finally {
    for (const client of clients) await client.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await vite?.close().catch(() => {});
    await hub?.stop().catch(() => {});
    if (KEEP_DIR === null) {
      rmSync(root, { recursive: true, force: true });
    } else {
      trace("kept", { root, hubDatabase, traceFile });
      process.stderr.write(`proof0b-control: run root kept at ${root}\n`);
    }
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(`proof0b control failed: ${message(error)}\n`);
  process.exitCode = 1;
});
'''

open(DST, "w").write(head + MAIN)
print(f"wrote {DST}")
