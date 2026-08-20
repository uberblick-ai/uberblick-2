# Issue spec — loop-ready issues

The contract for issues the implementation loop may pick up. The loop's triage
step lints against this spec: an issue labeled `ready` that fails any check
below gets a comment listing exactly what's missing, loses the `ready` label,
and is skipped. Bad input is bounced, never interpreted — the loop must not
fill gaps by guessing.

Design principle (same as the repo's data invariants): anything **derivable**
(blocked state, execution order) is computed, never stored; anything **not
derivable** (dependencies, footprint, scope) must be declared.

## Machine-readable header

The first lines of the issue body, before any heading:

```
Depends-on: #2, #3
Touches: mcp-server, schema
```

- **`Depends-on`** — mandatory, even when empty. `none` or a comma-separated
  list of issue refs. Grammar: `^Depends-on: (none|#[0-9]+(, #[0-9]+)*)$`.
  A missing line means *untriaged*, which is different from `none`
  (*consciously independent*); untriaged issues are never eligible.
- **`Touches`** — mandatory. Comma-separated footprint names, lowercase:
  the package short names (`hub`, `mcp-server`, `schema`, `web`), plus
  `docs-seed` and `repo` (root config, CI, top-level docs). Grammar:
  `^Touches: [a-z0-9-]+(, [a-z0-9-]+)*$`, every name from that list.

### Scheduling semantics

- **Eligible** = labeled `ready` AND every `Depends-on` issue is closed AND
  not claimed.
- Issues with **disjoint** `Touches` sets may run in parallel (separate
  worktrees). **Overlapping** sets queue behind each other.
- `schema` in `Touches` **serializes globally** — it is the keystone package;
  nothing else is dispatched while a schema-touching issue is in flight.
- Order among eligible issues: dependency topology, then ascending issue
  number. There is no priority field; add one only when reality demands it.

### Gate check

`Touches` is a declared claim, verified at review time: the PR diff must stay
within the declared footprint. A diff that escapes it is a finding — either
the issue was mis-scoped or the agent scope-crept. The resolution is explicit
(fix the scope or re-declare), never silent.

## Labels — lifecycle

| Label | Meaning | Set by |
|---|---|---|
| *(none)* | Draft — invisible to the loop | — |
| `ready` | Spec-complete; the loop may claim it | Human (or agent with human sign-off) |
| `in-progress` | Claimed; branch named in a comment | Loop |
| `needs-decision` | Parked on a question only a human can answer | Loop |

There is deliberately **no `blocked` label**: blocked is derived from
`Depends-on` plus issue closed-state, and stored copies of derivable state
rot.

### Claim protocol

On claiming an issue the loop adds `in-progress` and comments
`Claimed: <branch-name>` (e.g. `Claimed: feat/mcp-server`). Recovery rule: an
issue carrying `in-progress` whose named branch has no live worktree and no
open PR is stale and may be reclaimed. Claims live on GitHub, not in any
session's memory, so a crashed session never strands an issue.

## Body sections

Four required `##` headings after the header. The bar for all of them:
**would the implementing agent have to make a product decision the issue
doesn't answer? Then the issue is not `ready`.**

- **What** — one paragraph, the outcome in behavioral terms.
- **Why** — a sentence or two, tied to the spike acceptance criteria or a
  doc. Keeps the agent from "improving" beyond intent.
- **Acceptance criteria** — a checkbox list (`- [ ]`) where **every item is
  verifiable by running something**: a test, a command, an observable
  behavior. "Works offline" fails this bar; "kill the hub, `create_doc`
  still succeeds, restart the hub, the doc appears on a second client"
  passes. This list is what the coordinator validates the PR against —
  vague criteria make the gate unvalidatable.
- **Out of scope** — explicit non-goals, or `None.` if genuinely none. This
  is the "least code wins" principle made enforceable: it is what scope
  creep gets rejected against.

## Sizing

One issue = one PR, reviewable in one sitting. Work that honestly needs
multiple PRs becomes a parent issue split into loop-ready children; parents
are never labeled `ready`, only their children are.

## Lint — the exact checks

An issue labeled `ready` must pass all of:

1. `Depends-on` line present, first-section, matching the grammar above.
2. `Touches` line present, matching the grammar, every name valid.
3. All four `##` sections present: What, Why, Acceptance criteria,
   Out of scope.
4. At least one `- [ ]` checkbox under Acceptance criteria.
5. Out of scope is non-empty (explicit `None.` is acceptable).

Sizing and decision-completeness are judgment calls, not lintable — the
coordinator applies them when granting or revoking `ready`.
