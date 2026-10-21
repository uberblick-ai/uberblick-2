# Writing and editing ablauf

You choose placement; the renderer sizes and draws without moving nodes or
rerouting edges. [Renderer details](https://github.com/uberblick-ai/ablauf/blob/main/docs/plan.md).

## Flow syntax and nodes

Start with `flow v0`, then `columns` naming columns left to right, once,
before nodes. Declarations occupy one line. Blank lines and whole-line
`#` comments are allowed. Keep declarations unindented; indent panel
children and legend entries two spaces. Use each key once per line.

Nodes: `kind unique-id "text" key=value`.
Double quotes group spaces, including `title="Readable title"`; strings
have no escape syntax. Use typographic quotes inside them; backslashes are
literal. Edge labels are unquoted text after the colon.

| Kind | Meaning of text | Default tone |
| --- | --- | --- |
| `text` | caption | `muted` |
| `pill` | dotted label | `muted` |
| `box` | subtitle; id supplies title | `agent` |
| `end` | final caption | `done` |
| `panel` | indented children only | `stop` |
| `decision` | question over a diamond | `neutral` |

Omitted text uses the id, except boxes have no subtitle; panels show only
children. `title=` overrides
the visible title; outside boxes, use it instead of quoted text. Use readable
box titles; subtitles should add information.
Panel children: `pill`, `text`, `muted`, `strong` followed by text, or
`rule` alone.

`tone=` accepts `ink`, `muted`, `neutral`, `agent`, `system`, `done`, `rework`,
`stop` on nodes, edges and legend entries. Neutral gives grey fills; ink and
muted keep surface fills. System suits automated steps, agent suits workers,
done success, rework retries and stop human intervention.

## Layout and edges

Rows follow **node declaration order**. Each node starts the next row unless
`row=other-id` joins another node's row. `col=name` selects a column; omission
inherits the **previously declared node's column**. The first node needs
`col=`. `span=N` covers N
rows downwards (default 1). `section "Title"` starts a band for following
nodes; give every section nodes. `gap=60` requests a minimum 60px gap after
the node's last covered row, across all columns; use non-negative whole
pixels and omit it on the final row.

Edges: `a --> b key=value : label`; `-.->` is dashed. Label and keys
are optional: `tone=` (default `ink`), `from=`, `to=`, `label=`.
Sides are `top`, `right`, `bottom`, `left`. Defaults: same column uses
bottom-to-top; overlapping rows use facing sides; otherwise leave toward
the target's column and enter its top or bottom.

Slots such as `to=top.1` count left-to-right on top/bottom, top-to-bottom on
left/right. Leave both ends of a same-column bottom-to-top main edge
unnumbered to keep it centred; other entries use off-centre slots.
Unnumbered entries use available slots in source order, favouring the side
facing their other node when a main edge reserves the centre.
Decisions have one midpoint port per side: omit slot numbers.

`label=start` (default) sits beside the source segment; `label=end` beside
the target segment. `label=inline` makes a gap on the longest segment; use
it for decision answers.

```
flow v0
columns main stop
text start col=main "A maintainer starts"
pill ready
box work title="Do work" "Prepare the change"
decision approved "Is it approved?"
end shipped "Shipped"
panel human col=stop row=work span=2
  pill needs-human
  muted "Waiting for approval"
  rule
  strong "A person decides"
  text "Continue when ready"

start --> ready
ready --> work
work --> approved
approved --> shipped label=inline : yes
approved --> human tone=stop label=inline : no

legend
  pill "status" sample=ready
  box "worker"
  panel tone=stop "human intervention"
```

One `legend` has indented `pill`, `box`, `end`, `panel`, `decision`, `edge`
or `dashed` entries: kind, optional `tone=`, required quoted meaning.
Defaults match nodes; line samples default to ink. Shape entries additionally
accept non-empty `sample=ready` or `sample="two words"` for text inside them.

## Editing a diagram

- Insert between `a` and `b`: declare the new node after `a`, before `b`
  in row order. Replace `a --> b` with `a --> new` and `new --> b`.
  Deliberately preserve or redirect every other connection.
- Remove a step: delete its declaration and incident edges, reconnect its
  predecessor and successor, and update references to its id, including `row=`.
- Put a branch beside its source with explicit `col=side row=source`.
  Reset the next declaration's `col=` if needed.
- Add a column by editing `columns`; put its node in an
  existing row with `col=new-column row=existing-id`, then connect those ids.
- Order shared-side slots spatially: nearer branches take slots nearer
  the main path. On a shared right side, put an upward edge at `right.1`,
  a horizontal branch at `right.2`.
- After inserting/removing rows, review every affected `span=` count to
  preserve its intended coverage.

## Making it look good

Keep main paths downward in one column and branches beside their sources.
Span shared stop panels across incoming rows. Keep labels short;
choose start/end/inline to leave room. Trace all routes before adding a
branch, including existing edges to farther columns; choose sides and slot
order so nested branches and returns avoid crossings.

Common fixes: correct unknown ids/columns; remove duplicate
nodes in a cell; shorten overlapping labels or move them with `label=`;
increase `gap=` for cramped vertical labels; change sides, slots or placement
for edges crossing nodes or edges. A visible crossing gap still needs fixing.

## Fan-out

```
fan-out v0
style branches
step "Record the result"
outcome "Success" reason="Checks passed" destination="Review" tone="done"
outcome "Blocked" reason="A decision is needed" destination="Ask a person" tone="stop"
```

Declare one non-empty `step`, then at least one outcome with required
non-empty text, `reason=` and `destination=`; optional `tone=` accepts every
flow tone, defaulting to a plain box. Fields may appear in any order, once
each. All values are double-quoted JSON strings: escape quotes as `\"`,
backslashes as `\\`. Indentation is optional; blank lines and whole-line
comments work. There are no ids, authored edges or placement keys;
destinations are text. Outcomes stay in source order even with
matching destinations. Before the step, choose `style branches` (default:
step left, branches to outcomes, arrows to destinations with reasons below)
or `style ladder` (step above, rail of dots, reasons below outcomes,
destinations right-aligned, no arrows).
