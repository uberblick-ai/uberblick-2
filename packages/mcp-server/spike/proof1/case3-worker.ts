/**
 * Proof 1, case 3 — the child. Two of these share one store and index the same
 * document from different log cuts; the parent drives the interleaving.
 *
 * `mode: "today"` uses the store as it ships. `mode: "sequenced"` swaps in the
 * `indexed_through_seq` prototype.
 */

import { Replicas } from "../../src/replica.js";
import {
  TimedStore,
  blockText,
  config,
  onMessage,
  readDoc,
  send,
  writeBlock,
} from "./common.js";
import { SequencedStore } from "./sequenced-store.js";

interface Params {
  id: string;
  mode: "today" | "sequenced";
  databasePath: string;
  docUuid: string;
  blockId: string;
}

const params = JSON.parse(process.argv[2] as string) as Params;

const cfg = config({ databasePath: params.databasePath });
const store =
  params.mode === "sequenced"
    ? new SequencedStore(cfg.databasePath, cfg.workspaceId)
    : new TimedStore(cfg.databasePath, cfg.workspaceId);
const replicas = new Replicas(cfg, store);
if (store instanceof SequencedStore) store.replicas = replicas;

interface Command {
  type: "cmd";
  cmd: "settle" | "write" | "slow" | "fast" | "read" | "quit";
  text?: string;
  ms?: number;
}

async function handle(command: Command): Promise<void> {
  if (command.cmd === "slow") {
    store.indexDelayMs = command.ms ?? 0;
    send({ type: "ack", id: params.id, cmd: command.cmd });
    return;
  }
  if (command.cmd === "fast") {
    store.indexDelayMs = 0;
    send({ type: "ack", id: params.id, cmd: command.cmd });
    return;
  }
  if (command.cmd === "settle") {
    await replicas.settle();
    send({ type: "ack", id: params.id, cmd: command.cmd });
    return;
  }
  if (command.cmd === "write") {
    await replicas.settle();
    const current = blockText(replicas, params.docUuid, params.blockId);
    writeBlock(
      replicas,
      params.docUuid,
      params.blockId,
      current,
      command.text as string,
    );
    send({ type: "ack", id: params.id, cmd: command.cmd });
    return;
  }
  if (command.cmd === "read") {
    const doc = readDoc(replicas, params.docUuid);
    send({
      type: "ack",
      id: params.id,
      cmd: command.cmd,
      text: doc.blocks.find((b) => b.id === params.blockId)?.text ?? "",
      skipped: store instanceof SequencedStore ? store.skipped : null,
      written: store instanceof SequencedStore ? store.written : null,
    });
    return;
  }
  send({ type: "ack", id: params.id, cmd: "quit" });
  replicas.destroy();
  store.close();
  setTimeout(() => process.exit(0), 20).unref();
}

async function main(): Promise<void> {
  await replicas.settle();
  send({ type: "ready", id: params.id });
  onMessage<Command>((message) => {
    void handle(message);
  });
}

void main();
