import { ToolError } from "../failures.js";
import type { Replica, Replicas } from "../replica.js";

/**
 * Add room details to failures.ts's mutation stamp for any stopped multi-room
 * write, including a disappeared group or refused unpin. Nothing is rolled back.
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
    partial: detail.completed.length > 0,
    recoveryClass: "manual",
    rolledBack: false,
    completed: detail.completed.map((entry) => ({ ...entry, applied: true })),
    failed: detail.failed,
    // Retain the ordinary failure's room field alongside multi-room details.
    room: detail.failed.room,
    recovery: detail.recovery,
    ...(detail.extra ?? {}),
  });
}

/**
 * Append refusals are recorded, not thrown: check after each room before
 * writing the next. Report the log's first failed room, which may be a directory
 * observer's room rather than the stage's target. Callers supply room purposes
 * and recovery for the stage and failed room.
 */
export function roomStages(
  replicas: Replicas,
  tool: string,
  uuid: string,
  purposeOf: (room: string) => string,
  recoveryFor: (stagePurpose: string, failedPurpose: string) => string,
  extra?: Record<string, unknown>,
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
      // A different failed room follows this target's append. For an unrelated
      // sync failure, the target is not rechecked: "other" recovery must tell
      // callers to verify completed rooms with list_docs and get_sidebar.
      completed.push({ purpose, room: target.room });
    }
    throw stoppedPartWay({
      code: "persistence_failed",
      message:
        `The update log refused the write to ${failure.room}, so ${tool} stopped part-way. ` +
        "Nothing was rolled back: the rooms in `completed` are durable and the rooms after " +
        "the failure were never written.",
      uuid,
      completed,
      failed: { purpose: failedAt, room: failure.room },
      recovery: recoveryFor(purpose, failedAt),
      ...(extra === undefined ? {} : { extra }),
    });
  };
  return { completed, stage };
}
