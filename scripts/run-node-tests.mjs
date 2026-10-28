import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { run } from "node:test";
import { dot } from "node:test/reporters";
import { fileURLToPath } from "node:url";
import { budgetFailure, DEFAULT_TEST_BUDGET_MS } from "./test-duration-budget.mjs";

const START_MARKER = "uberblick:node-test-start ";
const END_MARKER = "\u001euberblick:node-test-end ";
const preloader = fileURLToPath(new URL("./node-test-timing.mjs", import.meta.url));

function timingRecord(value, end = false) {
	try {
		const record = JSON.parse(value);
		if (!record || typeof record !== "object") return undefined;
		if (!end) return Number.isFinite(record.startedAt) && record.startedAt >= 0 ? record : undefined;
		return typeof record.name === "string" && Number.isInteger(record.nesting) && record.nesting >= 0
			&& (record.type === "test" || record.type === "suite") && typeof record.root === "boolean"
			&& Number.isFinite(record.workerStartedAt) && record.workerStartedAt >= 0
			&& Number.isFinite(record.endedAt) && record.endedAt >= record.workerStartedAt ? record : undefined;
	} catch {
		return undefined;
	}
}

function intervalUnion(intervals) {
	const merged = [];
	for (const [start, end] of intervals.sort((left, right) => left[0] - right[0])) {
		const previous = merged.at(-1);
		if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
		else merged.push([start, end]);
	}
	return merged;
}

function defaultReportPath() {
	if (process.env.GITHUB_ACTIONS !== "true" || !process.env.RUNNER_TEMP) return undefined;
	return join(process.env.RUNNER_TEMP, "vitest-results", "node-test-durations.json");
}

export async function runNodeTests(files, {
	budgetMs = DEFAULT_TEST_BUDGET_MS,
	reportPath = defaultReportPath(),
} = {}) {
	if (!Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > DEFAULT_TEST_BUDGET_MS) {
		throw new Error(`node:test budget must be positive and at most ${DEFAULT_TEST_BUDGET_MS} ms; longer tests need a declared maintainer exception`);
	}
	const startedAt = performance.now();
	const records = new Map();
	const fileRecords = new Map();
	const lastResult = new Map();
	let success = true;
	function fileRecord(file) {
		file = resolve(file);
		if (!fileRecords.has(file)) fileRecords.set(file, { file, ends: [], stdout: "", totalMs: 0 });
		return fileRecords.get(file);
	}
	function testKey(data) {
		return `${data.entryFile}:${data.testId}`;
	}
	async function* events() {
		// CLI --test enables availableParallelism() - 1 file workers. The
		// programmatic API defaults to one, so retain the CLI's concurrency.
		for await (const event of run({ concurrency: true, globPatterns: files, execArgv: ["--import", preloader] })) {
			const { type, data } = event;
			if (type === "test:dequeue" && !data.entryFile) {
				fileRecord(data.file).startedAt = performance.now();
			}
			if (type === "test:stdout") {
				const file = fileRecord(data.file);
				const lines = `${file.stdout}${data.message}`.split("\n");
				file.stdout = lines.pop();
				for (const line of lines) {
					if (!line.startsWith(END_MARKER)) continue;
					const end = timingRecord(line.slice(END_MARKER.length), true);
					if (!end) continue;
					if (end.root) file.worker = end;
					else file.ends.push(end);
				}
			}
			if (type === "test:dequeue" && data.entryFile) {
				records.set(testKey(data), { ...data, status: "pending" });
			}
			if (type === "test:complete") {
				const file = fileRecord(data.entryFile ?? data.file);
				if (!data.entryFile) {
					file.totalMs = data.details.duration_ms;
					file.endedAt = performance.now();
				}
				else {
					const record = records.get(testKey(data)) ?? { ...data };
					const endIndex = file.ends.findIndex((end) => end.name === data.name
						&& end.nesting === data.nesting && end.type === data.details.type);
					if (endIndex !== -1) record.endedAt = file.ends.splice(endIndex, 1)[0].endedAt;
					Object.assign(record, { ...data, rawDurationMs: data.details.duration_ms });
					records.set(testKey(data), record);
				}
			}
			if ((type === "test:pass" || type === "test:fail") && data.entryFile) {
				const record = records.get(testKey(data)) ?? { ...data, rawDurationMs: data.details.duration_ms };
				record.status = data.skip ? "skipped" : type === "test:fail" ? "failed" : "passed";
				records.set(testKey(data), record);
				lastResult.set(data.entryFile, record);
			}
			if (type === "test:diagnostic" && data.message.startsWith(START_MARKER)) {
				const record = lastResult.get(data.entryFile);
				const timing = timingRecord(data.message.slice(START_MARKER.length));
				if (record && timing && (record.endedAt === undefined || timing.startedAt <= record.endedAt)) {
					record.startedAt = timing.startedAt;
				}
				continue;
			}
			if (type === "test:summary" && data.success === false) success = false;
			yield event;
		}
	}

	let runError;
	try {
		for await (const output of dot(events())) process.stdout.write(output);
	} catch (error) {
		runError = error;
		success = false;
		console.error(error);
	}
	const attempts = [...records.values()].filter((record) => record.details?.type !== "suite");
	const tests = attempts.map((record) => {
		let name = record.name;
		let parent = records.get(`${record.entryFile}:${record.parentId}`);
		while (parent) {
			name = `${parent.name} > ${name}`;
			parent = records.get(`${parent.entryFile}:${parent.parentId}`);
		}
		const durationMs = record.startedAt !== undefined && record.endedAt !== undefined
			? Math.max(0, record.endedAt - record.startedAt) : record.rawDurationMs ?? 0;
		const exceeded = durationMs > budgetMs;
		if (exceeded) {
			success = false;
			console.error(budgetFailure(`${record.file}: ${name}`, durationMs, budgetMs).message);
		}
		return { file: record.file, name, durationMs, budgetMs, status: exceeded ? "failed" : record.status };
	});
	const fileReports = [...fileRecords.values()].map((file) => {
		const intervals = intervalUnion(attempts.filter((test) => test.entryFile === file.file
			&& test.startedAt !== undefined && test.endedAt !== undefined)
			.map((test) => [test.startedAt, test.endedAt]));
		const workerMs = file.worker ? file.worker.endedAt - file.worker.workerStartedAt : undefined;
		const ownMs = intervals.reduce((total, [start, end]) => total + end - start, 0);
		return {
			file: file.file,
			totalMs: file.totalMs,
			sharedSetupMs: file.worker && intervals.length ? intervals[0][0] - file.worker.workerStartedAt : workerMs,
			sharedCleanupMs: file.worker && intervals.length ? file.worker.endedAt - intervals.at(-1)[1] : 0,
			sharedBetweenAttemptsMs: intervals.length
				? intervals.at(-1)[1] - intervals[0][0] - ownMs : 0,
			processSetupCleanupMs: workerMs === undefined ? undefined : Math.max(0, file.totalMs - workerMs),
		};
	});
	const finishedAt = performance.now();
	const fileIntervals = intervalUnion([...fileRecords.values()]
		.filter((file) => file.startedAt !== undefined && file.endedAt !== undefined)
		.map((file) => [file.startedAt, file.endedAt]));
	const fileWallMs = fileIntervals.reduce((total, [start, end]) => total + end - start, 0);
	const runSetupMs = fileIntervals.length ? fileIntervals[0][0] - startedAt : finishedAt - startedAt;
	const runCleanupMs = fileIntervals.length ? finishedAt - fileIntervals.at(-1)[1] : 0;
	const report = {
		framework: "node:test",
		wallTimeMs: finishedAt - startedAt,
		sharedRun: {
			purpose: "Test-runner orchestration outside worker-file lifetimes; file costs overlap across workers",
			setupMs: runSetupMs,
			cleanupMs: runCleanupMs,
			betweenFilesMs: Math.max(0, finishedAt - startedAt - runSetupMs - runCleanupMs - fileWallMs),
		},
		sharedFile: { purpose: "Module loading, file hooks and runner bookkeeping outside complete attempts" },
		tests,
		files: fileReports,
		incomplete: runError !== undefined || attempts.some((test) => test.status === "pending"),
	};
	if (reportPath) {
		try {
			mkdirSync(dirname(reportPath), { recursive: true });
			writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
		} catch (error) {
			console.warn(`Could not write node:test duration report: ${error.message}`);
		}
	}
	return { success, report };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { success } = await runNodeTests(process.argv.slice(2));
	process.exitCode = success ? 0 : 1;
}
