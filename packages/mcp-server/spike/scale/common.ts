/**
 * Scale probe — shared constants and a hand-rolled Hocuspocus wire codec.
 *
 * Throwaway local code (plan §9 "Scale probe"). Nothing here is production
 * material; it exists to put fan-in on the hub without holding one client-side
 * Y.Doc per room, which is the only way ~300 simulated processes × a few
 * thousand rooms fits on one machine.
 *
 * The codec mirrors @hocuspocus/provider 4.6.0's OutgoingMessages exactly:
 *   varString(documentName) varUint(messageType) …payload
 * lib0's varString is varUint(utf8 byte length) + utf8 bytes; varUint is
 * LEB128. Both are reimplemented here because lib0 is not a direct dependency
 * of this package and a spike must not add one.
 */

import * as Y from "yjs";

export const WORKSPACE = "8f2b1c94-5d6e-4a71-9b03-2c7e5f8a1d40";
export const SECRET = "scale-probe-hmac-secret";

/** @hocuspocus/provider MessageType. */
export const MSG_SYNC = 0;
export const MSG_AWARENESS = 1;
export const MSG_AUTH = 2;

/** y-protocols/sync message types. */
export const SYNC_STEP1 = 0;
export const SYNC_STEP2 = 1;
export const SYNC_UPDATE = 2;

/** @hocuspocus/common AuthMessageType. */
export const AUTH_TOKEN = 0;
export const AUTH_DENIED = 1;
export const AUTH_OK = 2;

/** The version string the 4.6.0 provider appends to its auth message. */
export const PROVIDER_VERSION = "4.6.0";

const utf8 = new TextEncoder();
const utf8d = new TextDecoder();

class Enc {
  private bytes: number[] = [];

  varUint(value: number): void {
    let v = value;
    while (v > 127) {
      this.bytes.push(128 | (v & 127));
      v = Math.floor(v / 128);
    }
    this.bytes.push(v & 127);
  }

  varString(value: string): void {
    const encoded = utf8.encode(value);
    this.varUint(encoded.length);
    for (const byte of encoded) this.bytes.push(byte);
  }

  varUint8Array(value: Uint8Array): void {
    this.varUint(value.length);
    for (const byte of value) this.bytes.push(byte);
  }

  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

export class Dec {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  varUint(): number {
    let value = 0;
    let mult = 1;
    for (;;) {
      const byte = this.bytes[this.offset++];
      value += (byte & 127) * mult;
      if ((byte & 128) === 0) return value;
      mult *= 128;
    }
  }

  varString(): string {
    const length = this.varUint();
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return utf8d.decode(slice);
  }
}

/** The state vector and empty diff a never-populated client would send. */
const EMPTY_DOC = new Y.Doc();
export const EMPTY_STATE_VECTOR = Y.encodeStateVector(EMPTY_DOC);
export const EMPTY_UPDATE = Y.encodeStateAsUpdate(EMPTY_DOC);

export function authMessage(room: string, token: string): Uint8Array {
  const enc = new Enc();
  enc.varString(room);
  enc.varUint(MSG_AUTH);
  enc.varUint(AUTH_TOKEN);
  enc.varString(token);
  enc.varString(PROVIDER_VERSION);
  return enc.toUint8Array();
}

export function syncStep1Message(room: string): Uint8Array {
  const enc = new Enc();
  enc.varString(room);
  enc.varUint(MSG_SYNC);
  enc.varUint(SYNC_STEP1);
  enc.varUint8Array(EMPTY_STATE_VECTOR);
  return enc.toUint8Array();
}

export function syncStep2Message(room: string): Uint8Array {
  const enc = new Enc();
  enc.varString(room);
  enc.varUint(MSG_SYNC);
  enc.varUint(SYNC_STEP2);
  enc.varUint8Array(EMPTY_UPDATE);
  return enc.toUint8Array();
}

export interface Incoming {
  room: string;
  type: number;
  /** For MSG_AUTH and MSG_SYNC: the sub-opcode. */
  sub: number;
}

/** Decode only the envelope — the payload is deliberately never parsed. */
export function decodeIncoming(bytes: Uint8Array): Incoming {
  const dec = new Dec(bytes);
  const room = dec.varString();
  const type = dec.varUint();
  const sub = type === MSG_AUTH || type === MSG_SYNC ? dec.varUint() : -1;
  return { room, type, sub };
}

/** The room name for a document uuid, and for the directory. */
export function roomOf(uuid: string): string {
  return `${WORKSPACE}/${uuid}`;
}
export const DIRECTORY_ROOM = `${WORKSPACE}/_directory`;
export const SIDEBAR_ROOM = `${WORKSPACE}/_sidebar`;
export const FEEDBACK_ROOM = `${WORKSPACE}/_feedback`;

/** Deterministic uuids, so every process derives the same corpus. */
export function corpusUuid(index: number): string {
  const hex = index.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

export function corpusUuids(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => corpusUuid(index));
}
