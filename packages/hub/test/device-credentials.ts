import { generateKeyPairSync } from "node:crypto";
import { mintRequestProof as mintProof, readRequestAction, type RequestAction, type RequestProofRequest } from "@uberblick/schema/token";
import { MANAGEMENT_OPERATIONS } from "../src/access-management.js";
import type { CredentialRegistry, CredentialRenewal, IssuedCredential, IssueCredentialRequest } from "../src/credentials.js";
import type { MembershipRegistry } from "../src/memberships.js";
import type { GithubSignIn } from "../src/github-sign-in.js";

export interface TestCredential extends IssuedCredential {
  keyBytes: Uint8Array;
}

const privateKeys = new Map<string, Uint8Array>();
const credentialKeys = new Map<string, Uint8Array>();

export function generateTestCredentialKeyPair(): { keyBytes: Uint8Array; publicKey: Uint8Array } {
  const generated = generateKeyPairSync("ed25519");
  const publicKey = new Uint8Array(Buffer.from(generated.publicKey.export({ format: "jwk" }).x!, "base64url"));
  const keyBytes = new Uint8Array(generated.privateKey.export({ format: "der", type: "pkcs8" }));
  privateKeys.set(Buffer.from(publicKey).toString("base64url"), keyBytes);
  return { keyBytes, publicKey };
}

/** Fixture devices create their key before registering only its public half. */
export function issueCredential(store: CredentialRegistry, request: Omit<IssueCredentialRequest, "publicKey">): TestCredential {
  const pair = generateTestCredentialKeyPair();
  const issued = store.issue({ ...request, publicKey: pair.publicKey });
  credentialKeys.set(issued.record.id, pair.keyBytes);
  return { ...issued, keyBytes: pair.keyBytes };
}

type FixtureProof = RequestProofRequest | Omit<Extract<RequestProofRequest, { operation: "renew-credential" }>, "publicKey">;

export function mintDeviceRequestProof(key: CryptoKey, claims: FixtureProof): Promise<string> {
  if (claims.operation !== "renew-credential" || "publicKey" in claims) return mintProof(key, claims);
  const pair = generateTestCredentialKeyPair();
  return mintProof(key, { ...claims, publicKey: Buffer.from(pair.publicKey).toString("base64url") });
}

export function renewalPublicKey(token: string): string {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8")) as { publicKey?: unknown };
    if (typeof payload.publicKey === "string") return payload.publicKey;
  } catch { /* Invalid proofs still get a syntactically valid request envelope. */ }
  return "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
}

export async function renewCredential(store: CredentialRegistry, token: string, memberships: MembershipRegistry,
  options: { publicKey?: string; ifWorkspacesChanged?: boolean } = {}): Promise<CredentialRenewal> {
  const result = await store.renew(token, memberships, { ...options, publicKey: options.publicKey ?? renewalPublicKey(token) });
  if (result.status === "renewed") {
    const privateKey = privateKeys.get(renewalPublicKey(token));
    if (privateKey !== undefined) credentialKeys.set(result.credential.record.id, privateKey);
  }
  return result;
}

export function replacementCredential(result: CredentialRenewal, proof?: string): TestCredential {
  if (result.status !== "renewed") throw new Error("expected a successful renewal");
  const keyBytes = credentialKeys.get(result.credential.record.id) ?? privateKeys.get(renewalPublicKey(proof ?? ""));
  if (keyBytes === undefined) throw new Error("fixture device did not retain its private key");
  credentialKeys.set(result.credential.record.id, keyBytes);
  return { record: result.credential.record, keyBytes };
}

export type ManagementOperation = keyof typeof MANAGEMENT_OPERATIONS;
type ManagementAction = Exclude<RequestAction, { operation: "renew-credential" }>;
type TargetField = (typeof MANAGEMENT_OPERATIONS)[ManagementOperation]["target"][number];

/** Every management operation, so a new policy row gets each table-driven test. */
export const MANAGEMENT_OPERATION_NAMES = Object.keys(MANAGEMENT_OPERATIONS) as ManagementOperation[];

/** A valid request carrying the targets its policy row declares; change-role asks for member. */
export function managementAction(operation: ManagementOperation, targets: Record<TargetField, string>): ManagementAction {
  const fields: Record<string, unknown> = Object.fromEntries(MANAGEMENT_OPERATIONS[operation].target
    .map((field: TargetField) => [field, targets[field]]));
  const action = readRequestAction({ operation, ...fields, ...(operation === "change-role" ? { role: "member" } : {}) });
  if (action === null || action.operation === "renew-credential") throw new Error(`No valid fixture for ${operation}`);
  return action;
}

export function credentialPrivateKey(record: { id: string }): Uint8Array {
  const key = credentialKeys.get(record.id);
  if (key === undefined) throw new Error("fixture device did not retain its private key");
  return key;
}

const signInKeys = new Map<string, string>();

export async function startDeviceSignIn(flow: GithubSignIn) {
  const publicKey = Buffer.from(generateTestCredentialKeyPair().publicKey).toString("base64url");
  const result = await flow.start(undefined, publicKey);
  if (result.status === "pending") signInKeys.set(result.requestId, publicKey);
  return result;
}

export async function collectDeviceSignIn(flow: GithubSignIn, requestId: string, secret: string) {
  const publicKey = signInKeys.get(requestId);
  const result = await flow.collect(requestId, secret, publicKey);
  if (result.status === "complete" && publicKey !== undefined) {
    const key = privateKeys.get(publicKey);
    if (key !== undefined) credentialKeys.set(result.credential.record.id, key);
  }
  return result;
}

export function cancelDeviceSignIn(flow: GithubSignIn, requestId: string, secret: string) {
  return flow.cancel(requestId, secret, signInKeys.get(requestId));
}

/** Model the fixture client's own key generation and retention across HTTP. */
export const deviceFetch: typeof globalThis.fetch = async (input, init) => {
  const url = String(input);
  const deviceSignIn = /\/auth\/github\/(start|collect|cancel)$/.test(url);
  const renewal = url.endsWith("/auth/credential/renew");
  if ((!deviceSignIn && !renewal) || typeof init?.body !== "string") return globalThis.fetch(input, init);
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(init.body);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return globalThis.fetch(input, init);
    body = parsed as Record<string, unknown>;
  } catch { return globalThis.fetch(input, init); }
  if (!Object.hasOwn(body, "publicKey")) {
    if (url.endsWith("/start")) {
      body.publicKey = Buffer.from(generateTestCredentialKeyPair().publicKey).toString("base64url");
    } else if (deviceSignIn) {
      body.publicKey = signInKeys.get(String(body.requestId)) ?? "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    } else if (typeof body.token === "string" && body.token !== "") body.publicKey = renewalPublicKey(body.token);
  }
  const response = await globalThis.fetch(input, { ...init, body: JSON.stringify(body) });
  const result = await response.clone().json() as {
    requestId?: string;
    credential?: { record: { id: string } };
  };
  if (typeof result.requestId === "string" && typeof body.publicKey === "string") signInKeys.set(result.requestId, body.publicKey);
  if (result.credential !== undefined && typeof body.publicKey === "string") {
    const key = privateKeys.get(body.publicKey);
    if (key !== undefined) credentialKeys.set(result.credential.record.id, key);
  }
  return response;
};
