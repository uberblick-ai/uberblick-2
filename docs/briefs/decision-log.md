# Brief: decision topics and RFC discussion

This brief summarizes current design direction. Product details live in the
corpus pages on Decision records, Regular documents and the Domain model;
discover those pages through MCP. Agent rules live in the local protocols.

## A routed topic page: answer, then timeline

Each decision topic has its own routed page. It presents the short current
answer first, then a timeline of earlier answers and proposals. Record links
reach the topic and preserve access to the selected record's history and
comments. The topic remains stable as successive records preserve changing
answers.

## RFC-first discussion with an explicit connection

Detailed options, recommendations, evidence and debate belong in a separately
created or reused regular document tagged `rfc`. Connect that RFC explicitly
to the decision record through MCP. Each proposal has its own discussion
reference; a successor does not inherit it. Creating or connecting a topic
does not create an RFC or tag its related page. Guidance for future work belongs
on the related regular page.

## MCP writes; web comments

Decision content and lifecycle writes happen through MCP. The web presents
answers, history and linked RFC discussion, and supports comments. The live
Decision records page and MCP `lifecycle` help own the lifecycle and recorded
answer rules.

Shaping and resuming shared proposals follow
[issue-shaping.md](../../.agents/protocols/issue-shaping.md) and
[rfc-resumption.md](../../.agents/protocols/rfc-resumption.md). Delivery roles
follow [delivery-policy.md](../../.agents/protocols/delivery-policy.md) and
[human-decisions.md](../../.agents/protocols/human-decisions.md).
