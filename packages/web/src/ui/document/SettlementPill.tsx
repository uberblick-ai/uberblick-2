import { useEffect, useId, useReducer, useState } from "react";
import type { ReactElement } from "react";
import { canSettleDecision, settleDecision, settlementFailure } from "../../collab/settle-decision.js";
import type { SettlementAction, SettlementSource } from "../../collab/settle-decision.js";
import { Button } from "../shadcn/button.js";
import { Textarea } from "../shadcn/textarea.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../shadcn/dropdown-menu.js";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogTitle, AlertDialogTrigger,
} from "../shadcn/alert-dialog.js";

const actions = {
  decide: { label: "Decide", title: "Decide this answer?", description: "It becomes the answer in force under your display name. Any answer it replaces stays in the history as Superseded." },
  reject: { label: "Reject", title: "Reject this answer?", description: "The reason stays with this record. The answer in force, if any, stays in force." },
  withdraw: { label: "Withdraw", title: "Withdraw this proposal?", description: "The proposal stays in the history as Withdrawn. The answer in force stays in force." },
};

/** The selected answer owns the action; history pills remain navigation labels. */
export function SettlementPill({ source, state, displayName, disabled, children }: {
  source: SettlementSource; state: string; displayName: string; disabled: boolean; children: ReactElement;
}): ReactElement {
  const [action, setAction] = useState<SettlementAction | null>(null);
  const [reason, setReason] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const reasonId = useId();
  const [, refresh] = useReducer((version: number) => version + 1, 0);
  useEffect(() => {
    source.source.ydoc.on("update", refresh);
    return () => source.source.ydoc.off("update", refresh);
  }, [source.source]);
  const settleable = !disabled && canSettleDecision(source) && (state === "not-yet-decided" || state === "under-review");
  const decideFailure = settlementFailure(source, "decide", displayName);
  const rejectFailure = settlementFailure(source, "reject", displayName, "reason");
  const choose = (next: SettlementAction): void => {
    setReason("");
    setFailure(null);
    setAction(next);
  };
  return <AlertDialog open={action !== null} onOpenChange={(open) => { if (!open) setAction(null); }}>
    {settleable ? <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <AlertDialogTrigger asChild>
          <Button variant="plain" size="custom" className="ub-decision-settle-trigger">{children}</Button>
        </AlertDialogTrigger>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem disabled={decideFailure !== null} onSelect={() => choose("decide")}>
          <span className="flex flex-col gap-1"><span>Decide</span>{decideFailure !== null && <span className="ub-type-caption max-w-72 whitespace-normal">{decideFailure}</span>}</span>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={rejectFailure !== null} onSelect={() => choose("reject")}>
          <span className="flex flex-col gap-1"><span>Reject</span>{rejectFailure !== null && <span className="ub-type-caption max-w-72 whitespace-normal">{rejectFailure}</span>}</span>
        </DropdownMenuItem>
        {state === "under-review" && <DropdownMenuItem onSelect={() => choose("withdraw")}>Withdraw</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu> : children}
    {action !== null && <AlertDialogContent>
      <AlertDialogTitle>{actions[action].title}</AlertDialogTitle>
      <AlertDialogDescription>{actions[action].description}</AlertDialogDescription>
      {action === "reject" && <label htmlFor={reasonId} className="mb-4 grid gap-2">
        Rejection reason
        <Textarea id={reasonId} value={reason} onChange={(event) => { setReason(event.target.value); setFailure(null); }} />
      </label>}
      {failure !== null && <p role="alert" className="mb-4 text-destructive">{failure}</p>}
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction disabled={action === "reject" && reason.trim() === ""} onClick={(event) => {
          const result = disabled ? { ok: false, message: "This record or its topic is archived. Restore it before settling it." }
            : settleDecision({ ...source, action, displayName, reason });
          if (!result.ok) {
            event.preventDefault();
            setFailure(result.message);
          }
        }}>{actions[action].label}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>}
  </AlertDialog>;
}
