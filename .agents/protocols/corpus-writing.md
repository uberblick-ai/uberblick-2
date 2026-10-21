# Corpus writing

Read before writing or rewriting a page in the MCP corpus. Authorization,
intent-versus-code and sync rules stay in
[AGENTS.md's Edit corpus rules](../../AGENTS.md#read-for-the-action).

## What a page is

A page states product intent: what a person can do and what they see. It is not
technical documentation. Leave out stack, architecture, file paths, data
structures and implementation mechanics. A page may describe how the system is
built only when its title clearly says so, for example "Technical: sync
protocol". Intent is written in the present tense and may be ahead of the code.

No PR or issue number, merge date, run id or "since" clause appears in a
Regular Document; GitHub owns that provenance.

## Start small

Write the smallest page that answers the request: the usage and one or two
scenarios. Expand only when a person asks for more. A new section on an
existing page follows the same rule.

## Shape

1. A usage block or a one-line example first.
2. A short section per command, screen or syntax, each with a snippet.
3. Scenarios: an H3 heading per situation with a short paragraph, including the
   exact output or text where it matters. Tables are for real reference data
   only, not scenarios.
4. Related links last.

## Length and tone

- Intros are one or two sentences. No TL;DR.
- Explain a concept only when the reader needs it to act; a larger concept gets
  its own page.
- Cut any sentence that restates what an example or output already shows.
- Plain words and full sentences.

## Editing

Rewrite, never append. Change the affected sentences to the new truth and
delete what they replace. Add a block only for a fact no existing block owns.
When another page owns a fact, link to it instead of copying it.

## Naming

The product is "Uberblick", never with an umlaut. Commands, syntax and UI labels
appear in code formatting, exactly as the product shows them.
