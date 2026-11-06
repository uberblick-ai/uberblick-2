import { log } from "./log.js";
import type { ToolContext } from "./tools/context.js";

/** Each call owns its room set, including calls sharing a session or runtime. */
export function writeAcknowledgement(context: ToolContext) {
  const rooms = new Set<string>();
  return {
    context: {
      ...context,
      runOperation<T>(body: () => T): T {
        const unsubscribe = context.replicas.store.onAppend((room, origin) => {
          if (origin === "local") rooms.add(room);
        });
        try { return body(); }
        finally { unsubscribe(); }
      },
      durability(replica) {
        rooms.add(replica.room);
        return context.durability(replica);
      },
      contentDurability(replica) {
        rooms.add(replica.room);
        return context.contentDurability(replica);
      },
      durabilityAcross(primary, detail) {
        for (const entry of detail) rooms.add(entry.room);
        return context.durabilityAcross(primary, detail);
      },
    } satisfies ToolContext,
    async finish(payload: object): Promise<object> {
      const completed = "completed" in payload && Array.isArray(payload.completed)
        ? payload.completed.filter((entry): entry is Record<string, unknown> & { room: string } =>
          entry !== null && typeof entry === "object" && "room" in entry && typeof entry.room === "string")
        : [];
      for (const entry of completed) rooms.add(entry.room);
      if (rooms.size === 0) return payload;
      try {
        // Existing connect and sync budgets bound this wait even if the hub disappears.
        await context.replicas.waitForSettled({ rooms: [...rooms] });
      } catch (error) {
        // A wait failure must not erase the original applied or partial-write result.
        log.warn("awaiting hosted write acknowledgement failed", error);
      }
      const quiet = (room: string) => context.replicas.isRoomQuiet(room);
      return {
        ...payload,
        ...("applied" in payload && payload.applied === true
          ? { synced: [...rooms].every(quiet), hub: context.replicas.hubState() }
          : {}),
        ...("rooms" in payload && Array.isArray(payload.rooms)
          ? { rooms: payload.rooms.map((entry: { room: string }) => ({ ...entry, synced: quiet(entry.room) })) }
          : {}),
        ...(completed.length > 0
          ? { completed: completed.map(entry => ({ ...entry, synced: quiet(entry.room) })) }
          : {}),
      };
    },
  };
}
