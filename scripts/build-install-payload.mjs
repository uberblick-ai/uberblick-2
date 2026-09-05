#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI_ROOT = join(REPOSITORY_ROOT, "packages", "cli");
const requireFromCli = createRequire(join(CLI_ROOT, "package.json"));
const { build } = requireFromCli("esbuild");
const RELEASE_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function fail(message) {
	throw new Error(`build-install-payload: ${message}`);
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: REPOSITORY_ROOT,
		stdio: "inherit",
		...options,
	});
	if (result.status !== 0) {
		fail(`${command} ${args.join(" ")} ${result.signal === null ? `exited ${result.status}` : `ended from ${result.signal}`}`);
	}
}

function checkedVersion(raw) {
	const version = raw?.trim();
	if (version === undefined || !RELEASE_VERSION.test(version) || version === "0.0.0") {
		fail("usage: mise run build-install-payload -- <release-version> (0.0.0 is not a release)");
	}
	return version;
}

function assertWebBundle(dir) {
	for (const file of ["index.html", "uberblick-build.json"]) {
		if (!existsSync(join(dir, file))) fail(`web build at ${dir} has no ${file}`);
	}
}

async function bundle(entryPoint, outfile) {
	await build({
		entryPoints: [entryPoint],
		outfile,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node26",
		minify: true,
		sourcemap: false,
	});
}

async function main() {
	const version = checkedVersion(process.argv[2]);
	const outputDir = resolve(process.env.UBERBLICK_PAYLOAD_OUTPUT_DIR ?? join(REPOSITORY_ROOT, "dist"));
	const archive = join(outputDir, `uberblick-${version}.tar.gz`);
	const scratch = mkdtempSync(join(tmpdir(), "uberblick-install-payload-"));
	const name = `uberblick-${version}`;
	const payload = join(scratch, name);
	const cli = join(payload, "packages", "cli");
	const web = join(payload, "packages", "web", "dist");
	// Staged beside the archive so the rename is same-filesystem and atomic, and
	// named per builder so two concurrent builds never share one staging file.
	const temporaryArchive = `${archive}.${process.pid}.tmp`;

	try {
		let webDist = process.env.UBERBLICK_PAYLOAD_WEB_DIST;
		if (webDist === undefined) {
			webDist = join(scratch, "web-dist");
			const buildEnvironment = { ...process.env };
			for (const key of ["HUB_AUTH_TOKEN", "HUB_URL", "WORKSPACE_ID", "WORKSPACES"]) {
				delete buildEnvironment[key];
			}
			// The package build cannot redirect Vite away from the checkout's dist,
			// so run its two steps directly against this payload's private directory.
			run("pnpm", ["--filter", "@uberblick/web", "exec", "tsc", "--noEmit"], {
				env: buildEnvironment,
			});
			run(
				"pnpm",
				["--filter", "@uberblick/web", "exec", "vite", "build", "--outDir", webDist, "--emptyOutDir"],
				{ env: buildEnvironment },
			);
		}
		webDist = resolve(webDist);
		assertWebBundle(webDist);

		mkdirSync(join(cli, "lib"), { recursive: true });
		mkdirSync(join(payload, "bin"), { recursive: true });
		await Promise.all([
			bundle(join(CLI_ROOT, "src", "main.ts"), join(cli, "lib", "ub.mjs")),
			bundle(
				join(REPOSITORY_ROOT, "packages", "mcp-server", "src", "main.ts"),
				join(cli, "lib", "mcp.mjs"),
			),
		]);

		cpSync(join(CLI_ROOT, "templates"), join(cli, "templates"), { recursive: true });
		cpSync(webDist, web, { recursive: true });
		writeFileSync(
			join(cli, "package.json"),
			`${JSON.stringify(
				{
					name: "@uberblick/cli",
					version,
					private: true,
					type: "module",
					engines: { node: ">=26" },
					uberblickInstallPayload: true,
				},
				null,
				2,
			)}\n`,
			"utf8",
		);
		writeFileSync(
			join(payload, "bin", "ub"),
			'#!/usr/bin/env node\nimport("../packages/cli/lib/ub.mjs").catch((error) => {\n  console.error(error);\n  process.exitCode = 1;\n});\n',
			{ encoding: "utf8", mode: 0o755 },
		);
		symlinkSync("ub", join(payload, "bin", "uberblick"));

		mkdirSync(outputDir, { recursive: true });
		run("tar", ["-czf", temporaryArchive, "-C", scratch, name]);
		renameSync(temporaryArchive, archive);
		process.stdout.write(`payload: ${archive}\n`);
	} finally {
		rmSync(temporaryArchive, { force: true });
		rmSync(scratch, { recursive: true, force: true });
	}
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
