import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const requireFromCli = createRequire(config.cliPackage);
const { Server } = requireFromCli("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = requireFromCli(
	"@modelcontextprotocol/sdk/server/stdio.js",
);
const { CallToolRequestSchema, InitializeRequestSchema } = requireFromCli(
	"@modelcontextprotocol/sdk/types.js",
);

function record(event) {
	appendFileSync(config.events, `${JSON.stringify(event)}\n`);
}

record({
	pid: process.pid,
	cwd: process.cwd(),
	marker: process.env.CORPUS_TEST_MARKER,
});

if (config.descendant) {
	spawn(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
writeFileSync(${JSON.stringify(config.descendant)}, String(process.pid));
setInterval(() => {}, 1000);`,
		],
		{ stdio: "ignore" },
	);
	while (!existsSync(config.descendant)) await delay(5);
}

const server = new Server(
	{ name: "synthetic-corpus-health", version: "1.0.0" },
	{ capabilities: { tools: {} } },
);

if (config.mode === "initialize-refused") {
	server.setRequestHandler(InitializeRequestSchema, () => {
		throw new Error("synthetic initialization refused");
	});
}
if (config.mode === "initialize-hang") {
	server.setRequestHandler(InitializeRequestSchema, () => new Promise(() => {}));
}

server.setRequestHandler(CallToolRequestSchema, ({ params }) => {
	record({ tool: params.name, arguments: params.arguments });
	if (params.name === "get_sidebar") {
		const payload = {
			workspace: "synthetic-workspace",
			hub: { status: config.hub ?? "connected" },
			groups:
				config.mode === "no-pins"
					? []
					: [{ id: "synthetic-group", name: "Entry documents", docs: config.pins }],
		};
		return {
			structuredContent: payload,
			content: [{ type: "text", text: JSON.stringify(payload) }],
		};
	}
	if (params.name !== "get_doc") throw new Error("Unexpected corpus tool");
	if (params.arguments.uuid === config.pins.at(-1).uuid) {
		if (config.mode === "document-refused") {
			return {
				isError: true,
				content: [{
					type: "text",
					text: JSON.stringify({
						error: "doc_not_hydrated",
						message: "Synthetic document has not synced.\nRead refused.",
					}),
				}],
			};
		}
		if (config.mode === "document-hang") return new Promise(() => {});
	}
	const payload = {
		uuid: config.mode === "wrong-document" ? config.pins[0].uuid : params.arguments.uuid,
		title: "Synthetic document",
		blocks: [],
	};
	return {
		structuredContent: payload,
		content: [{ type: "text", text: JSON.stringify(payload) }],
	};
});

process.stdin.on("end", () => {
	process.stderr.write("synthetic late shutdown diagnostic\n");
	process.exit(0);
});
await server.connect(new StdioServerTransport());
