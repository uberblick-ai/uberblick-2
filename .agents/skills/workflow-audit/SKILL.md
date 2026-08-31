---
name: workflow-audit
description: >-
  Run Uberblick's read-only audit every three days across issue preparation,
  queue health, workflow efficiency, and product-context use. Do not use for a
  delivery role, issue or PR review, implementation, or a merge gate.
---

# Workflow audit

Read `.agents/audits/workflow-auditor.md` in full and follow it as the canonical
contract. Use a supplied run identity verbatim; when none is supplied, create
the collision-resistant identity that contract defines. Perform at most the one
report write it permits, then stop.
