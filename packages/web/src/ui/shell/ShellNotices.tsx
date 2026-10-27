import { useEffect, useState, type ReactElement } from "react";
import { endpointLabel } from "../../config.js";
import type { LocalServing } from "../../config.js";
import { setSetting } from "../../settings.js";
import type { AvailableUpdate, DocumentSearchClient } from "../../shell/document-search.js";
import { PaneNotice } from "../document/EditorPane.js";
import { useSetting } from "../hooks.js";
import { Button } from "../shadcn/button.js";

/** ub open rereads the tap hourly; asking it more often only shortens the wait after a release. */
export const UPDATE_NOTICE_POLL_MS = 10 * 60 * 1_000;

export const REPLICA_UNAVAILABLE_DETAIL = {
  "replica-held": "This workspace’s replica is serving another ub open. Stop that run, then restart this ub open to view it here.",
  "replica-quarantined": "This workspace’s replica is quarantined. Run ub doctor in a project bound to this workspace and follow its recovery steps.",
  "replica-failed": "This workspace’s replica could not be served. Run ub doctor in a project bound to this workspace and follow its recovery steps.",
};

/** ub open admits a browser only through the address it printed. */
export function LocalSessionNotice(): ReactElement {
  return (
    <PaneNotice>
      <section className="mx-auto w-full max-w-xl p-6 text-(--foreground)" aria-label="Connect this page">
        <div role="status">
          <h1 className="m-0 ub-type-h2 font-semibold">This page is not connected to ub open</h1>
          <p className="mt-3">
            Open the address <code>ub open</code> printed in your terminal to connect this
            browser to it.
          </p>
        </div>
      </section>
    </PaneNotice>
  );
}

/** The frozen serving process is still useful; this notice only names its binding. */
export function ReboundNotice({ serving }: { serving: LocalServing | null }): ReactElement | null {
  if (serving?.rebound !== true) return null;
  const remoteHub = serving.remoteHubUrl === null ? "local workspace" : endpointLabel(serving.remoteHubUrl);
  if (remoteHub === null) return null;
  return (
    <p className="ub-rebound-notice" role="status">
      <strong>This machine’s binding changed.</strong> <code>ub open</code> is still
      serving{" "}
      {serving.workspace === null ? (
        <>without a workspace</>
      ) : (
        <>
          workspace <code>{serving.workspace}</code>
        </>
      )}{" "}
      and is bound to sync with <code>{remoteHub}</code>. Restart <code>ub open</code>{" "}
      to pick up the change.
    </p>
  );
}

/** Ask the serving ub open now and then; a failed read keeps whatever was shown. */
function useAvailableUpdate(client: DocumentSearchClient | null | undefined): AvailableUpdate | null {
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  useEffect(() => {
    if (client === null || client === undefined) return;
    const request = new AbortController();
    const read = (): void => {
      client.update(request.signal).then(setUpdate, () => {});
    };
    read();
    const timer = setInterval(read, UPDATE_NOTICE_POLL_MS);
    return () => {
      clearInterval(timer);
      request.abort();
    };
  }, [client]);
  return client === null || client === undefined ? null : update;
}

/** Name the newer version and its fix; closing it waits for the next release. */
export function UpdateNotice({ client }: { client: DocumentSearchClient | null | undefined }): ReactElement | null {
  const update = useAvailableUpdate(client);
  const dismissed = useSetting("dismissedUpdate");
  if (update === null || dismissed === update.latest) return null;
  return (
    <p className="ub-update-notice" role="status">
      <span>
        <strong>Uberblick {update.latest} is available.</strong> You have {update.current}.
        Run <code>ub update</code>, then restart <code>ub open</code>.
      </span>{" "}
      <a href={update.notesUrl} target="_blank" rel="noreferrer">Release notes</a>
      <Button variant="plain" size="custom" type="button" className="ub-update-notice-close"
        aria-label="Dismiss update notice" title="Dismiss"
        onClick={() => setSetting("dismissedUpdate", update.latest)}>
        <span aria-hidden="true">×</span>
      </Button>
    </p>
  );
}
