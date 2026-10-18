import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CREDENTIAL_SCHEMA, revokeHmacCredentials } from "../packages/hub/src/credentials-schema.ts";
import { assertHubDatabaseUpgrade, seedReleaseCredential, snapshotHubDatabase } from "./lib/hub-release-database.mjs";

const tables = ["hub_principals", "hub_credentials", "hub_memberships", "hub_admin_setup_grants", "hub_claim_state"];
// Exercise the source-text form sent to release images, with no module closure.
const seed = new Function("db", `(${seedReleaseCredential.toString()})(db, "principal", "workspace")`);
const read = new Function("db", "tables", `return (${snapshotHubDatabase.toString()})(db, tables)`);
const snapshot = (db) => JSON.parse(JSON.stringify(read(db, tables)));

function fixture(schema) {
	const db = new DatabaseSync(":memory:");
	db.exec(schema);
	db.exec(`CREATE TABLE documents(name TEXT, data BLOB);
		INSERT INTO documents VALUES ('workspace/document', X'1234');
		CREATE TABLE hub_principals(id TEXT, github_id TEXT, login TEXT);
		INSERT INTO hub_principals VALUES ('principal', '123', 'release-proof');
		CREATE TABLE hub_memberships(workspace_id TEXT, principal_id TEXT, role TEXT);
		INSERT INTO hub_memberships VALUES ('workspace', 'principal', 'admin');
		CREATE TABLE hub_admin_setup_grants(id TEXT, completed INTEGER);
		INSERT INTO hub_admin_setup_grants VALUES ('setup', 1);
		CREATE TABLE hub_claim_state(id INTEGER, default_workspace_id TEXT, unclaimed INTEGER);
		INSERT INTO hub_claim_state VALUES (1, 'workspace', 0);`);
	seed(db);
	db.exec("UPDATE hub_credentials SET id = 'retired', revoked_at = 45, replaced_at = 40");
	seed(db);
	return db;
}

const legacySchema = `CREATE TABLE hub_credentials (
	id TEXT PRIMARY KEY, principal_id TEXT, device_id TEXT, workspaces TEXT,
	signing_key BLOB NOT NULL CHECK(length(signing_key) = 32),
	issued_at INTEGER, revoked_at INTEGER, replaced_at INTEGER
)`;

for (const withName of [false, true]) {
	test(`release proof accepts HMAC migration and refreshed restore revocation times (device names: ${withName})`, () => {
		const db = fixture(legacySchema);
		try {
			if (withName) db.exec("ALTER TABLE hub_credentials ADD COLUMN device_name TEXT; UPDATE hub_credentials SET device_name = 'release device'");
			const original = snapshot(db);
			assert.equal(original.credentialKeyColumn, "signing_key");
			assertHubDatabaseUpgrade(snapshot(db), original);
			revokeHmacCredentials(db);
			const upgraded = snapshot(db);
			assert.equal(upgraded.credentialKeyColumn, "public_key");
			assertHubDatabaseUpgrade(upgraded, original);
			revokeHmacCredentials(db);
			assert.deepEqual(snapshot(db), upgraded, "reopening public-key history is unchanged");
			const restored = structuredClone(upgraded);
			restored.hub_credentials.find((row) => row.id !== "retired").revoked_at += 1;
			assertHubDatabaseUpgrade(restored, original);
			for (const mutate of [
				(value) => { value.documents = []; },
				(value) => { value.hub_memberships = []; },
				(value) => { value.hub_credentials = []; },
				(value) => { value.hub_credentials[0].key = original.hub_credentials[0].key; },
				(value) => { value.hub_credentials[0].revoked_at = null; },
				(value) => { value.hub_credentials.find((row) => row.id === "retired").revoked_at = 46; },
			]) {
				const damaged = structuredClone(upgraded);
				mutate(damaged);
				assert.throws(() => assertHubDatabaseUpgrade(damaged, original), assert.AssertionError);
			}
		} finally { db.close(); }
	});
}

test("release proof seeds public-key releases and requires unchanged credentials across upgrade and restore", () => {
	const db = fixture(CREDENTIAL_SCHEMA);
	try {
		const original = snapshot(db);
		assert.equal(original.credentialKeyColumn, "public_key");
		assert.equal(original.hub_credentials[0].key.length, 64);
		revokeHmacCredentials(db);
		assertHubDatabaseUpgrade(snapshot(db), original);
		const revoked = structuredClone(original);
		revoked.hub_credentials[0].revoked_at = 1;
		assert.throws(() => assertHubDatabaseUpgrade(revoked, original), assert.AssertionError);
		db.exec("ALTER TABLE hub_credentials ADD COLUMN signing_key BLOB");
		assert.throws(() => snapshot(db), /retains both signing_key and public_key/);
	} finally { db.close(); }
});
