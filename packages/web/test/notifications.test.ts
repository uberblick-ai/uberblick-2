import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalToast } from "sonner";

type Severity = "success" | "info" | "warning" | "error";
interface Publication {
  severity: Severity;
  title: string;
  options: ExternalToast;
}

const sonner = vi.hoisted(() => {
  const publications: Publication[] = [];
  const visible = new Map<string | number, Publication>();
  const publish = (severity: Severity) => vi.fn((title: string, options: ExternalToast) => {
    const publication = { severity, title, options };
    publications.push(publication);
    visible.set(options.id!, publication);
    return options.id!;
  });
  const toast = {
    success: publish("success"),
    info: publish("info"),
    warning: publish("warning"),
    error: publish("error"),
    dismiss: vi.fn((id: string | number) => { visible.delete(id); }),
  };
  return { publications, visible, toast };
});

vi.mock("sonner", () => ({ toast: sonner.toast }));

let notifications: typeof import("../src/notifications");

function lastPublication(): Publication {
  return sonner.publications.at(-1)!;
}

// Keep callbacks from earlier publications to exercise late removal signals.
// The publisher does not use the Toast argument, so deliver callbacks directly.
function dismiss(publication: Publication): void {
  sonner.visible.delete(publication.options.id!);
  (publication.options.onDismiss as (() => void) | undefined)?.();
}

function expire(publication: Publication): void {
  sonner.visible.delete(publication.options.id!);
  (publication.options.onAutoClose as (() => void) | undefined)?.();
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  sonner.publications.length = 0;
  sonner.visible.clear();
  notifications = await import("../src/notifications");
});

describe("transient notifications", () => {
  it("replaces keyed feedback with a fresh addition and full native duration", () => {
    notifications.notifyTransient({ key: "copy", message: "Copied", severity: "success" });
    const first = lastPublication();
    notifications.notifyTransient({ key: "copy", message: "Copied", severity: "success" });
    const replacement = lastPublication();

    expect(replacement.options.id).not.toBe(first.options.id);
    expect(sonner.visible.size).toBe(1);
    expect(sonner.visible.has(first.options.id!)).toBe(false);
    expect(replacement.options.duration).toBe(10_000);
    expect(replacement.options.description).toBe("Copied");

    // Removal of the old element must not forget the currently showing one.
    dismiss(first);
    expire(first);
    notifications.notifyTransient({ key: "copy", message: "Copy failed", severity: "error" });
    const retry = lastPublication();
    expect(sonner.toast.dismiss).toHaveBeenLastCalledWith(replacement.options.id);
    expect(retry.options.id).not.toBe(replacement.options.id);
    expect(retry.severity).toBe("error");
    expect(retry.options.duration).toBe(10_000);
    expect(sonner.visible.size).toBe(1);
  });

  it.each([dismiss, expire])("forgets a removed transient before its next publication", (remove) => {
    notifications.notifyTransient({ key: "saved", message: "Saved", severity: "info" });
    const removed = lastPublication();
    remove(removed);
    sonner.toast.dismiss.mockClear();

    notifications.notifyTransient({ key: "saved", message: "Saved again", severity: "info" });
    expect(lastPublication().options.id).not.toBe(removed.options.id);
    expect(sonner.toast.dismiss).not.toHaveBeenCalled();
    expect(sonner.visible.size).toBe(1);
  });

  it("keeps independently keyed and unkeyed actions independent", () => {
    notifications.notifyTransient({ key: "copy-a", message: "Copied A", severity: "success" });
    const first = lastPublication();
    notifications.notifyTransient({ key: "copy-b", message: "Copied B", severity: "success" });
    const second = lastPublication();
    notifications.notifyTransient({ message: "Background task finished", severity: "info" });
    notifications.notifyTransient({ message: "Background task finished", severity: "info" });

    expect(sonner.visible.size).toBe(4);
    notifications.notifyTransient({ key: "copy-a", message: "Copied A again", severity: "success" });
    expect(sonner.visible.size).toBe(4);
    expect(sonner.visible.has(first.options.id!)).toBe(false);
    expect(sonner.visible.has(second.options.id!)).toBe(true);
    expect(sonner.toast.dismiss).toHaveBeenCalledTimes(1);
  });
});

describe("sticky notifications", () => {
  it("updates a visible condition in place and ignores unchanged publications", () => {
    notifications.notifySticky({ key: "sync", message: "Offline", severity: "warning" });
    const first = lastPublication();
    notifications.notifySticky({ key: "sync", message: "Offline", severity: "warning" });
    expect(sonner.publications).toHaveLength(1);

    notifications.notifySticky({ key: "sync", message: "Retry failed", severity: "warning" });
    const updated = lastPublication();
    expect(updated.options.id).toBe(first.options.id);
    expect(updated.options.description).toBe("Retry failed");
    notifications.notifySticky({ key: "sync", message: "Retry failed", severity: "error" });
    expect(lastPublication().options.id).toBe(first.options.id);
    expect(lastPublication().severity).toBe("error");
    expect(lastPublication().options.duration).toBe(Infinity);
    expect(sonner.visible.size).toBe(1);
    expect(sonner.toast.dismiss).not.toHaveBeenCalled();
  });

  it.each([
    { message: "Offline again", severity: "warning" as const },
    { message: "Offline", severity: "error" as const },
  ])("keeps dismissed content hidden until text or severity changes: %j", (changed) => {
    notifications.notifySticky({ key: "sync", message: "Offline", severity: "warning" });
    const hidden = lastPublication();
    dismiss(hidden);
    notifications.notifySticky({ key: "sync", message: "Offline", severity: "warning" });
    expect(sonner.publications).toHaveLength(1);
    expect(sonner.visible.size).toBe(0);

    notifications.notifySticky({ key: "sync", ...changed });
    const revived = lastPublication();
    expect(revived.options.id).not.toBe(hidden.options.id);
    expect(sonner.visible.size).toBe(1);

    // A delayed callback from the hidden element cannot hide its replacement.
    dismiss(hidden);
    notifications.notifySticky({ key: "sync", message: "Connection lost", severity: "error" });
    expect(lastPublication().options.id).toBe(revived.options.id);
    expect(sonner.visible.size).toBe(1);
  });

  it("resolves safely after dismissal and shows a fresh recurrence", () => {
    notifications.notifySticky({ key: "sync", message: "Offline", severity: "warning" });
    const original = lastPublication();
    dismiss(original);
    notifications.resolveSticky("sync");
    notifications.resolveSticky("sync");
    expect(sonner.toast.dismiss).toHaveBeenCalledTimes(1);
    expect(sonner.toast.dismiss).toHaveBeenCalledWith(original.options.id);

    notifications.notifySticky({ key: "sync", message: "Offline", severity: "warning" });
    const recurrence = lastPublication();
    expect(recurrence.options.id).not.toBe(original.options.id);
    dismiss(original);
    notifications.notifySticky({ key: "sync", message: "Still offline", severity: "error" });
    expect(lastPublication().options.id).toBe(recurrence.options.id);
    notifications.resolveSticky("sync");
    expect(sonner.visible.size).toBe(0);
    expect(sonner.toast.dismiss).toHaveBeenLastCalledWith(recurrence.options.id);
  });

  it("leaves other conditions and transient feedback intact when one condition resolves", () => {
    notifications.notifySticky({ key: "sync", message: "Offline", severity: "warning" });
    const sync = lastPublication();
    notifications.notifySticky({ key: "save", message: "Save failed", severity: "error" });
    const save = lastPublication();
    notifications.notifyTransient({ key: "copy", message: "Copied", severity: "success" });
    const copy = lastPublication();

    notifications.resolveSticky("sync");
    expect(sonner.visible.has(sync.options.id!)).toBe(false);
    expect(sonner.visible.has(save.options.id!)).toBe(true);
    expect(sonner.visible.has(copy.options.id!)).toBe(true);
    expect(sonner.visible.size).toBe(2);
    notifications.resolveSticky("unknown");
    expect(sonner.toast.dismiss).toHaveBeenCalledTimes(1);
  });
});
