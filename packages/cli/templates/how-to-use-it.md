---
uuid: d7ddd0b1-fee9-4ef0-8f1e-42882f925c31
title: How to Use It
description: Five steps from one product rule to an agent that reads it, a decision found by issue, and a pull request that keeps the page true. Includes the agent instruction block.
links:
  - 2d56b281-5614-43bd-b8d8-edd1c270a85a
---

## 1. Write one rule

Create a page whose title says what it is about, such as **Checkout: rules**.
Write three sentences about what the product should do:

```text
Guest checkout asks for an email address.
We never ask for a phone number; delivery problems go to the email.
A guest can turn the order into an account afterwards from the confirmation page.
```

Pin the page in the sidebar. Pinned pages are where an agent new to the workspace
starts. Write rules about the product; tasks and delivery stay on GitHub.

You should see: your rule page in the sidebar beside the two starter pages.

## 2. Connect the agent

In a second terminal, in the same project directory, run the command for your
installed client:

```sh
ub mcp install claude
```

For Codex, run `ub mcp install codex`. Restart the client, then copy this workspace
instruction block into your project's `AGENTS.md` or `CLAUDE.md`. It is the block
from [Agents over MCP](https://uberblick.ai/docs/agents#instructions):

```markdown
## The workspace (Uberblick over MCP)

- Product intent lives in the workspace, not in this repository. Start from the
  documents pinned in the sidebar (get_sidebar) when you do not know the project.
- Discover documents with list_docs and search; use list_tags for current tag
  names before filtering by tag. Decisions are listed only with kind: decision.
- Cite pages by title and id, discovered at runtime. Never pin an id in a
  reusable instruction. An id the workspace no longer has is a stale pointer:
  find the live successor by search and note the replacement.
- Before a product-sensitive choice, call find_decisions for the issue you work
  on and read what comes back. Do not reopen a decided question in code.
- Edit the block that is wrong with edit_block. Do not replace a page to change
  a sentence. Never delete and reinsert a block to change its type.
- Pages describe intended behaviour, which may be ahead of the code. Update the
  owning page in the pull request: which page, which block, what it now says.
- Do not load the whole workspace. Read what the change touches.
```

You should see: an MCP server named `uberblick` in your client, with the workspace
instructions in the project's instruction file.

## 3. Ask, change the page, ask again

Ask the agent: "Does our guest checkout ask for a phone number? Answer from the
workspace and name the page you read."

Watch the tool calls: `get_sidebar`, then `get_doc` on **Checkout: rules**. The
answer is no, citing the page's title and id. Now change the second sentence in
the editor to "A phone number is optional, for delivery notifications only."
Ask the same question again.

You should see: an answer that follows the changed sentence and cites the same
page, without restarting the agent or pasting the page into the prompt.

## 4. Record a decision and find it by issue

Open an issue in your repository for the phone number question. Ask the agent to
record the question as an open decision, propose "optional, delivery notifications
only", and link the issue in the record's prose. Tell it not to decide the question.

Review the proposal, then tell the agent: "I accept 'optional, delivery
notifications only'. My name is [your name]. Record my answer as decided now,
with this conversation as its source." Replace [your name] with your name.
In a fresh agent session, ask it to call `find_decisions` for that issue and
read the returned record with `get_doc`.

You should see: the answer in force, who decided and when, found by the issue
alone in a session that knows nothing about the conversation.

## 5. Keep the page true when code changes

When a change lands in code, the same pull request updates the page that describes
it. Ask the agent to include a `Corpus update`: which page, which block, and what
it now says. Review that update alongside the code.

You should see: a pull request with the code change and a concrete update to the
page that describes it.

## Point the next issue at the right pages

Tags group pages so an agent reads less. A `Touches: <tag>, <tag>` line in an issue
points the agent at the pages that matter, such as `Touches: checkout, billing`.

[ub-agents](https://agents.uberblick.ai) is an optional way to run steps 3 to 5
from issue labels on GitHub. You can also start each agent run yourself.
