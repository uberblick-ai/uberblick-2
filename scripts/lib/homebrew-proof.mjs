import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * A content digest of one directory tree: every path, mode, symlink target and
 * file byte under `root`.
 *
 * Both Homebrew proofs compare one of these across an operation — the formula
 * proof over the installed payload, the upgrade proof over the files a person
 * created. Equality is the whole assertion, so the digest covers what a change
 * would show up in and nothing that varies between runs.
 */
export function treeDigest(root) {
	const hash = createHash("sha256");
	const visit = (dir) => {
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name);
			const stat = lstatSync(path);
			hash.update(relative(root, path));
			hash.update(String(stat.mode));
			if (stat.isDirectory()) visit(path);
			else hash.update(stat.isSymbolicLink() ? readlinkSync(path) : readFileSync(path));
		}
	};
	visit(root);
	return hash.digest("hex");
}

/**
 * Call tools on an installed `ub mcp serve` over its stdio transport.
 *
 * The Homebrew proofs are the only callers: they exercise a packaged install
 * the way a client does, so they need a JSON-RPC client and nothing more. The
 * session is torn down on every path — a proof that leaks a replica holding the
 * SQLite store makes the next assertion about that store meaningless.
 *
 * `body` receives `callTool(name, args)`, which returns the tool's parsed JSON
 * answer.
 */
export async function withMcpSession({ cwd, env, clientName, clientVersion, timeoutMs = 60_000 }, body) {
	const child = spawn("ub", ["mcp", "serve"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
	let stderr = "";
	const closed = new Promise((resolve) => child.once("close", resolve));
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	let buffer = "";
	let nextId = 1;
	const pending = new Map();
	const failPending = (error) => {
		for (const waiter of pending.values()) waiter.reject(error);
		pending.clear();
	};
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline === -1) break;
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (line === "") continue;
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				failPending(new Error(`MCP server wrote non-JSON stdout: ${line.slice(0, 120)}`));
				continue;
			}
			const waiter = pending.get(message.id);
			if (waiter === undefined) continue;
			pending.delete(message.id);
			if (message.error === undefined) waiter.resolve(message.result);
			else waiter.reject(new Error(message.error.message));
		}
	});
	child.once("exit", (code, signal) => {
		failPending(
			new Error(
				`ub mcp serve ${signal === null ? `exited ${code}` : `ended from ${signal}`}: ${stderr}`,
			),
		);
	});
	const request = (method, params) =>
		new Promise((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { resolve, reject });
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	const callTool = async (name, args) => {
		const result = await request("tools/call", { name, arguments: args ?? {} });
		const text = result?.content?.[0]?.text;
		if (typeof text !== "string") throw new Error(`${name} returned no text content`);
		if (result.isError === true) throw new Error(`${name} failed: ${text}`);
		return JSON.parse(text);
	};
	const deadline = setTimeout(() => {
		failPending(new Error(`ub mcp serve did not answer within ${timeoutMs}ms: ${stderr}`));
		child.kill("SIGKILL");
	}, timeoutMs);
	try {
		await request("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: clientName, version: clientVersion },
		});
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
		return await body(callTool);
	} finally {
		clearTimeout(deadline);
		child.stdin.end();
		child.kill("SIGTERM");
		await closed;
	}
}
