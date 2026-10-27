# Corpus writing

Corpus pages state product intent. The regular page `Writing pages`, tagged
`guidance`, owns how to write them: read it before writing or rewriting a
page. Find it in the MCP startup instructions, or discover the current tag
with `list_tags` and use `list_docs` with tag `guidance`.

## In the agent loop

Nobody is present to answer the intent pass, so:

- A code change checks the pages it touches against their promises. Propose a
  rewrite under `Corpus update` only where the change makes a promise wrong, or
  where its issue records a product decision that adds one. A linked mockup is a
  decision only when the issue says so. Delivered detail no promise covers goes
  on no page; most pull requests need no rewrite and list the page under
  `Compared` as `matches`, naming the promises you checked. A page that does not
  cover the behavior at all is not a `matches`: say it is silent and raise the
  decision it needs.
- Search the decision records for the changed behavior first. A decision in
  force is settled: write from it, and raise only a contradiction with it.
- Never write a guess about intent. When a gap, a contradiction between pages
  or an undecided consequence turns up, leave the text as it is and record the
  question and leaner option you recommend under `Corpus update`. When the built
  behavior contradicts a promise on the page, or goes beyond the issue and
  destroys or exposes data, hold the merge and finish `needs-human` under
  [human-decisions.md](human-decisions.md). Existing human-authority boundaries
  and tier-3 approval requirements still stop their dependent action; a corpus
  question grants no authority to decide unknown intent or expand the issue.
- A remaining corpus question may wait until after merge only when implementation
  and merge are already authorized and do not depend on its answer. The
  implementer carries it in `Corpus update` and finishes `review` or `integrate`
  under the usual review rules. The reviewer carries it
  in the verdict and finishes `approve` when the review otherwise passes. The
  integrator follows every existing gate, merges, then asks on the pull request
  and finishes `merged`. Use human-decisions.md's question presentation and
  recipient rules, without its pause-and-resume instructions for this question.
- Do not reshape a page that has no purpose sentence and promises inside a pull
  request, and do not fix old sentences the change does not touch. Name the page
  on the pull request for a maintainer pass.
- A reviewer reads the whole resulting page, not only the changed block. On a
  feature page, a sentence outside the notes that describes how the screen looks
  or how the feature is built, or a missing promise for a decision the issue
  carries, is a finding. Surface pages may describe how their surface presents
  the feature, and dedicated layout pages may state layout behavior a person
  decided, as `Writing pages` allows; the feature page still owns its promises.

Authorization, intent-versus-code and sync rules stay in
[AGENTS.md's Edit corpus rules](../../AGENTS.md#read-for-the-action).
