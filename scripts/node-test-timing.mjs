import { subscribe } from "node:diagnostics_channel";
import { beforeEach, getTestContext } from "node:test";

export const START_MARKER = "uberblick:node-test-start ";
export const END_MARKER = "\u001euberblick:node-test-end ";

const workerStartedAt = performance.now();
const roots = new WeakSet();

// The first inherited hook runs after shared before() hooks and before the
// test's own hooks. Diagnostics stay attached to the test through failures.
beforeEach((context) => {
	context.diagnostic(`${START_MARKER}${JSON.stringify({ startedAt: performance.now() })}`);
});

// Subscribing to start binds the end callback to the test's async context.
// The root is the only test whose start has no TestContext.
subscribe("tracing:node.test:start", (event) => {
	if (getTestContext() === undefined && event.name === "<root>") roots.add(event);
});

// This public lifecycle event runs after afterEach and context.after cleanup,
// including when an earlier hook throws. stdout also works before a test body
// starts, when Node cannot bind the callback to that test's async context.
subscribe("tracing:node.test:end", (event) => {
	process.stdout.write(`\n${END_MARKER}${JSON.stringify({
		name: event.name,
		nesting: event.nesting,
		type: event.type,
		endedAt: performance.now(),
		workerStartedAt,
		root: roots.has(event),
	})}\n`);
});
