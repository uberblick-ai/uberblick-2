import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Reuse the checkout's pinned SDK without adding a root dependency or parsing
// MCP frames ourselves. The launcher-facing Python entry supplies the deadline.
const requireFromCli = createRequire(
	new URL("../packages/cli/package.json", import.meta.url),
);

function toolPayload(result) {
	if (result.isError) {
		const text = result.content.find((item) => item.type === "text")?.text;
		let reason = "tool refused the read";
		try {
			reason = JSON.parse(text).error ?? reason;
		} catch {
			// A non-JSON refusal still fails; never mistake it for document content.
		}
		throw new Error(reason);
	}
	if (!result.structuredContent) throw new Error("missing structured result");
	return result.structuredContent;
}

export async function checkCorpus(timeoutMs = 40_000) {
	let client;
	let timer;
	let stage = "starting or initializing mise exec -- ub mcp serve";
	let failure;
	let serverStderr = "";
	try {
		const { Client } = requireFromCli("@modelcontextprotocol/sdk/client/index.js");
		const { StdioClientTransport } = requireFromCli(
			"@modelcontextprotocol/sdk/client/stdio.js",
		);
		const transport = new StdioClientTransport({
			command: "mise",
			args: ["exec", "--", "ub", "mcp", "serve"],
			env: { ...process.env },
			stderr: "pipe",
		});
		// Drain server logs privately, so late shutdown messages cannot replace
		// the probe's final diagnostic or fill the pipe during initialization.
		transport.stderr.on("data", (chunk) => {
			serverStderr = (serverStderr + chunk.toString()).slice(-4096);
		});
		client = new Client({ name: "uberblick-corpus-health", version: "1.0.0" });
		const work = async () => {
			await client.connect(transport);
			stage = "reading get_sidebar";
			const sidebar = toolPayload(
				await client.callTool({ name: "get_sidebar", arguments: {} }),
			);
			const pins = sidebar.groups.flatMap((group) => group.docs);
			if (pins.length === 0) throw new Error("sidebar pins no document");
			for (const pin of pins) {
				stage = `reading pinned document ${JSON.stringify(pin.title)} (${pin.uuid})`;
				if (typeof pin.uuid !== "string" || !pin.uuid) {
					throw new Error("sidebar pin has no document UUID");
				}
				const doc = toolPayload(
					await client.callTool({ name: "get_doc", arguments: { uuid: pin.uuid } }),
				);
				if (doc.uuid !== pin.uuid || !Array.isArray(doc.blocks)) {
					throw new Error("invalid document result");
				}
			}
		};
		await Promise.race([
			work(),
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs / 1000}s`)), timeoutMs);
			}),
		]);
	} catch (error) {
		failure = `${stage}: ${error.message}`.replaceAll(/\s+/g, " ");
		if (stage.startsWith("starting")) {
			const lastLine = serverStderr.trim().split("\n").at(-1)?.trim();
			if (lastLine) failure += `; server: ${lastLine}`;
		}
	} finally {
		clearTimeout(timer);
		try {
			await client?.close();
		} catch (error) {
			failure ??= `closing corpus route: ${error.message}`;
		}
	}
	return failure;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const failure = await checkCorpus();
	if (failure) {
		process.stderr.write(`${failure}\n`);
		process.exitCode = 1;
	}
}
