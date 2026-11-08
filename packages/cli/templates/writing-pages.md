---
uuid: 5c61b635-0ac1-44a8-8aa3-9895082aae07
title: Writing pages
description: Default rules for writing pages that state product intent and boundaries, with page shapes, visual examples, decision checks and content to leave out. Adapt these rules to your project.
tags:
  - 00000000-0000-4000-8000-000000000007
---

The product explains itself. A page does not teach how to use it: it shapes the product and sets its boundaries, stating what it must do, what it promises and what it refuses. That holds for every page, setup and operations included. Agents read this page before their first write; change it to fit your project.

Description: "The share dialog has a Copy link button." Intent: "Anyone with the link can read the page; turning the link off ends their access at once." Lead with the second kind.

## Page shapes

A page that already serves its reader keeps its shape. The parts are an order, not heading names. Every sentence fits a part, or it is cut. Related links, if any, go last.

### Feature pages

A feature's promises, on every surface.

1. **Purpose:** one sentence on why the feature exists.
2. **What it promises:** what a person can rely on: what lasts, who may do what, what is refused, what can be undone, and the limits a person can hit. One rule per bullet.
3. **What you can do:** one short section per capability, with an example.
4. **Scenarios (optional):** situations that show where the intent stops.
5. **Notes:** a few bullets, only where dropping them would change what a person expects.

### Surface pages

How one surface (a command line, an API, a screen) presents features whose promises live on their feature pages.

1. **Purpose:** one sentence on what the command, tool or screen is for.
2. **Basic usage:** the command and its real output, help included, shown as is. For a screen, a `wireframe` sketch.
3. **One section per command or capability:** an example, its rules as bullets, and a table of what it prints.
4. **Exit codes:** one table.
5. **Scenarios (optional).**

### Reference and rfc pages

A `technical-reference` page is for readers who act on exact names, fields, codes or formats, such as an API client. The interface belongs; the mechanism behind it does not. An `rfc` page holds the discussion behind a decision record and skips these shapes.

A fact has one owning page; link it instead of repeating it.

## Show before you tell

Write for a person skimming first: a usage block with real output, a `wireframe` sketch for screens, an `ablauf` diagram for flows, a table for reference data; `get_help("wireframe")` and `get_help("ablauf")` give the syntax. The text covers only what the visual cannot.

## Before writing

- Write from the intent of the person who decided it, not from the old text or from what the code does today.
- Check the decision records first. A decision in force is settled.
- List the gaps and open questions, recommend the leaner option, and ask before writing.

## Never on a page

- Guides and configuration in prose: steps to follow, lists of options or variables, defaults and version minimums. Only a command's own output, shown as is, may list them. State the rule instead, for example "Setup checks every prerequisite before it changes anything and names the fix for each one that is missing."
- Code repeated in prose or copied onto the page, unless it clarifies or explains the intent.
- Visual values (sizes, fonts, colours), unless a colour carries meaning.
- Storage formats and internals, unless the page is tagged `technical-reference`.
- Roadmaps, delivery status and provenance such as issue numbers or dates. Intended behaviour that is not built yet still belongs, stated as a promise.
