import assert from "node:assert/strict";

// These two functions also run inside the release images via their source text.
export function snapshotHubDatabase(db, privateTables) {
	const columns = new Set(db.prepare("PRAGMA table_info(hub_credentials)").all().map((column) => column.name));
	if (columns.has("public_key") && columns.has("signing_key")) throw new Error("hub_credentials retains both signing_key and public_key");
	const credentialKeyColumn = columns.has("public_key") ? "public_key" : "signing_key";
	const result = { credentialKeyColumn, documents: db.prepare("SELECT name, hex(data) AS data FROM documents ORDER BY name").all() };
	for (const table of privateTables) {
		result[table] = db.prepare(table === "hub_credentials" ?
			`SELECT id, principal_id, device_id, ${columns.has("device_name") ? "device_name" : "NULL AS device_name"}, workspaces,
			CASE WHEN ${credentialKeyColumn} IS NULL THEN NULL ELSE hex(${credentialKeyColumn}) END AS key,
			issued_at, revoked_at, replaced_at FROM hub_credentials ORDER BY id` :
			`SELECT * FROM ${table} ORDER BY 1, 2`).all();
	}
	if (!privateTables.includes("hub_browser_sessions")) {
		const browserSessions = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'hub_browser_sessions'").get();
		result.hub_browser_sessions = browserSessions === undefined ? [] : db.prepare("SELECT * FROM hub_browser_sessions ORDER BY 1, 2").all();
	}
	return result;
}

export function seedReleaseCredential(db, principalId, workspaceId) {
	const columns = db.prepare("PRAGMA table_info(hub_credentials)").all();
	const keyColumn = columns.some((column) => column.name === "public_key") ? "public_key" : "signing_key";
	// A fixed public test key also supplies synthetic bytes for the older HMAC schema.
	const key = Buffer.from("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "hex");
	db.prepare(`INSERT INTO hub_credentials(id,principal_id,device_id,workspaces,${keyColumn},issued_at) VALUES (?,?,?,?,?,?)`)
		.run("00000000-0000-4000-8000-000000001175", principalId, "00000000-0000-4000-8000-000000001176",
			JSON.stringify([workspaceId]), key, 1172000);
}

export function assertHubDatabaseUpgrade(actual, original) {
	let expected = original;
	if (original.hub_principals.every((row) => !Object.hasOwn(row, "has_signed_in")) &&
		actual.hub_principals.some((row) => Object.hasOwn(row, "has_signed_in"))) {
		// The release fixture seeds device sign-ins only; browser-expiry migration is proved by hub tests.
		assert.deepEqual(original.hub_browser_sessions, [], "release fixture contains no unmodeled browser sign-in evidence");
		const signedIn = new Set(original.hub_credentials.map((row) => row.principal_id));
		expected = { ...original, hub_principals: original.hub_principals.map((row) =>
			({ ...row, has_signed_in: signedIn.has(row.id) ? 1 : 0 })) };
	}
	if (expected.credentialKeyColumn !== "signing_key" || actual.credentialKeyColumn !== "public_key") {
		assert.deepEqual(actual, expected);
		return;
	}
	const { credentialKeyColumn: _oldKey, hub_credentials: oldCredentials, ...oldState } = expected;
	const { credentialKeyColumn: _newKey, hub_credentials: credentials, ...state } = actual;
	assert.deepEqual(state, oldState, "documents and other private tables survive credential migration");
	assert.equal(credentials.length, oldCredentials.length, "credential history survives migration");
	for (const [index, previous] of oldCredentials.entries()) {
		const current = credentials[index];
		assert.equal(current.key, null, "migrated HMAC credentials retain no key");
		if (previous.revoked_at === null) {
			assert.ok(Number.isSafeInteger(current.revoked_at) && current.revoked_at > 0, "migration revokes HMAC credentials");
		} else assert.equal(current.revoked_at, previous.revoked_at, "existing revocation time survives");
		assert.deepEqual(current, { ...previous, key: null, revoked_at: current.revoked_at });
	}
}
