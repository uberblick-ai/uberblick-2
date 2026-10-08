import { ToolError } from "../failures.js";
import type { Replica, Replicas } from "../replica.js";

/**
 * The one answer a multi-room write that stopped part-way gives, whichever way
 * it stopped: what is durable, what is not, that nothing was rolled back, and
 * what to do. One shape, because a caller that learns to read a refused append
 * must not have to learn a second one — for a `create_doc` whose group
 * disappeared underneath it, or for an `archive_doc` whose unpin the log
 * refused.
 *
 * `applied`, `partial` and `synced` come from the shared stamp in
 * ../failures.ts; only what the call knows on top of them is here.
 */
export function stoppedPartWay(detail: {
  code: string;
  message: string;
  uuid: string;
  /** The rooms this call wrote before the one that failed. */
  completed: readonly { purpose: string; room: string }[];
  failed: { purpose: string; room: string };
  recovery: string;
  extra?: Record<string, unknown>;
}): ToolError {
  return new ToolError(detail.code, detail.message, {
    uuid: detail.uuid,
    // Some of this call's work is durable whenever a room completed before the
    // one that failed — `completed` is which, and there is no rollback that
    // could make it false.
    partial: detail.completed.length > 0,
    recoveryClass: "manual",
    rolledBack: false,
    completed: detail.completed.map((entry) => ({ ...entry, applied: true })),
    failed: detail.failed,
    // The room every other failure of this kind names, kept so a caller that
    // reads one field reads the same field here.
    room: detail.failed.room,
    recovery: detail.recovery,
    ...(detail.extra ?? {}),
  });
}

/**
 * Stage a write across several rooms: write one, then check the log took it
 * before touching the next.
 *
 * A refused append is recorded rather than thrown (see ../replica.ts), so without
 * this check the next room would be written on top of a failure and the caller
 * would hear one room name for a call that had touched three. Stopping here is
 * what makes `completed` true.
 *
 * The failed room is the one the log named, not the stage that noticed: writing
 * a document publishes its directory stub through the observer, so the
 * directory is where a document write can fail. The recorded failure is the
 * first refused append, so a room written before it — this stage's own, when
 * the two names differ — did reach the log.
 *
 * The boundary: a second room failing inside this same call (another document
 * syncing while it ran) is the one case where the sticky failure names a room
 * this stage did not write, so the stage's own append is reported durable
 * without having been re-checked. The caller's `other` recovery is why that is
 * survivable — it tells the caller to re-verify with `list_docs` and
 * `get_sidebar` rather than trust `completed`.
 *
 * `purposeOf` names the room a failure reports; `recoveryFor` turns the stage
 * that was running and the room that failed into the sentence the caller acts
 * on, because what a partial write costs is the calling tool's own knowledge.
 */
export function roomStages(
  replicas: Replicas,
  tool: string,
  uuid: string,
  purposeOf: (room: string) => string,
  recoveryFor: (stagePurpose: string, failedPurpose: string) => string,
): {
  completed: { purpose: string; room: string }[];
  stage: (purpose: string, target: Replica, write: () => void) => void;
} {
  const completed: { purpose: string; room: string }[] = [];
  const stage = (
    purpose: string,
    target: Replica,
    write: () => void,
  ): void => {
    write();
    const failure = replicas.persistenceError();
    if (failure === null) {
      completed.push({ purpose, room: target.room });
      return;
    }
    const failedAt = purposeOf(failure.room);
    if (failure.room !== target.room) {
      completed.push({ purpose, room: target.room });
    }
    throw stoppedPartWay({
      code: "persistence_failed",
      message:
        `The update log refused the write to ${failure.room}, so ${tool} stopped part-way. ` +
        "Nothing was rolled back: the rooms in `completed` are durable and the rooms after " +
        `the failure were never written. Cause: ${failure.message}`,
      uuid,
      completed,
      failed: { purpose: failedAt, room: failure.room },
      recovery: recoveryFor(purpose, failedAt),
    });
  };
  return { completed, stage };
}
