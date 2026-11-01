# Corpus writing

The regular page `Writing pages`, tagged `guidance`, owns how to write corpus
pages: read it before writing or rewriting one. Find it in the MCP startup
instructions, or with `list_docs` and tag `guidance`. This file adds only how
the agent loop handles corpus work when nobody is present to answer the intent
pass.

## In the agent loop

- Compare the pages a change touches with their promises. Propose a rewrite
  under `Corpus update` only where the change makes a promise wrong, or where
  its issue records a product decision that adds one; a linked mockup is a
  decision only when the issue says so. Most pull requests need no rewrite and
  list each page under `Compared` as `matches`, naming the promises checked. A
  page that does not cover the behavior at all is not a `matches`: say it is
  silent and raise the decision it needs.
- A page without a purpose sentence and promises gets no new text inside a pull
  request. Its `Compared` entry says the page states no promises, so a
  `matches` checks nothing, and names the page for a maintainer pass.
- An issue's request to add text to a page does not override `Writing pages`.
  Write only the promise the issue decided and raise anything else it asks for
  as a question under `Corpus update`.
- When a gap, a contradiction between pages or an undecided consequence turns
  up, leave the text as it is and record the question and the leaner option you
  recommend under `Corpus update`. When the built behavior contradicts a promise
  on the page, or goes beyond the issue and destroys or exposes data, hold the
  merge and finish `needs-human` under [human-decisions.md](human-decisions.md).
  Existing human-authority boundaries and tier-3 approval requirements still
  stop their dependent action; a corpus question grants no authority to decide
  unknown intent or expand the issue.
- A remaining corpus question may wait until after merge only when implementation
  and merge are already authorized and do not depend on its answer. The
  implementer carries it in `Corpus update` and finishes `review` or `integrate`
  under the usual review rules. The reviewer carries it in the verdict and
  finishes `approve` when the review otherwise passes. The integrator follows
  every existing gate, merges, then asks on the pull request and finishes
  `merged`. Use human-decisions.md's question presentation and recipient rules,
  without its pause-and-resume instructions for this question.
- A reviewer reads the whole resulting page, not only the changed block. A
  rewrite that breaks `Writing pages`, or a missing promise for a decision the
  issue carries, is a finding.

Authorization, intent-versus-code and sync rules stay in
[AGENTS.md's Edit corpus rules](../../AGENTS.md#read-for-the-action).
