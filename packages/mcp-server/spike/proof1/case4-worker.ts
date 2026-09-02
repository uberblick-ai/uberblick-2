/**
 * Proof 1, case 4 — the child. A full replica engine with hub sync on, sharing
 * one store with its sibling. The parent drives it command by command.
 */

import {
  blockText,
  createDoc,
  onMessage,
  openEngine,
  send,
  writeBlock,
} from "./common.js";

interface Params {
  id: string;
  databasePath: string;
  hubUrl: string;
  authSecret: string;
}

const params = JSON.parse(process.argv[2] as string) as Params;

const engine = openEngine({
  databasePath: params.databasePath,
  hubUrl: params.hubUrl,
  authSecret: params.authSecret,
  connectTimeoutMs: 2_000,
  syncTimeoutMs: 4_000,
});

interface Command {
  cmd: "create" | "append" | "read" | "settle" | "state" | "quit";
  uuid?: string;
  blockId?: string;
  title?: string;
  text?: string;
  suffix?: string;
}

function state(): Record<string, unknown> {
  return {
    hub: engine.replicas.sync.state(),
    pending: engine.store.pendingRooms(),
    rooms: engine.replicas.attachedReplicas().map((replica) => ({
      room: replica.room,
      lastSeq: replica.lastSeq,
      quiet: engine.replicas.isRoomQuiet(replica.room),
    })),
  };
}

async function handle(command: Command): Promise<void> {
  try {
    if (command.cmd === "create") {
      await engine.replicas.settle();
      const doc = createDoc(engine.replicas, command.title as string, [
        command.text as string,
      ]);
      send({ type: "ack", id: params.id, cmd: command.cmd, ...doc, ...state() });
      return;
    }
    if (command.cmd === "append") {
      await engine.replicas.settle();
      const current = blockText(
        engine.replicas,
        command.uuid as string,
        command.blockId as string,
      );
      writeBlock(
        engine.replicas,
        command.uuid as string,
        command.blockId as string,
        current,
        `${current}${command.suffix as string}`,
      );
      send({
        type: "ack",
        id: params.id,
        cmd: command.cmd,
        text: blockText(engine.replicas, command.uuid as string, command.blockId as string),
        ...state(),
      });
      return;
    }
    if (command.cmd === "settle" || command.cmd === "state") {
      if (command.cmd === "settle") await engine.replicas.settle();
      send({ type: "ack", id: params.id, cmd: command.cmd, ...state() });
      return;
    }
    if (command.cmd === "read") {
      send({
        type: "ack",
        id: params.id,
        cmd: command.cmd,
        text: blockText(engine.replicas, command.uuid as string, command.blockId as string),
        known: engine.replicas.known(command.uuid as string),
        ...state(),
      });
      return;
    }
    send({ type: "ack", id: params.id, cmd: "quit", ...state() });
    engine.destroy();
    setTimeout(() => process.exit(0), 20).unref();
  } catch (error) {
    send({ type: "ack", id: params.id, cmd: command.cmd, error: String(error) });
  }
}

async function main(): Promise<void> {
  await engine.replicas.settle();
  send({ type: "ready", id: params.id, ...state() });
  onMessage<Command>((message) => {
    void handle(message);
  });
}

void main();
