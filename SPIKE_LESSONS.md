# Scenario recording dogfood — issue #2408

This is a disposable, local experiment, grounded on `344a07495e2079986b5688ce7387a2af9086ab71`. Its deliverable is what we learn, not production code. Findings below distinguish observations from things still to try.

## Scope agreed in this session

One person opens an existing document with R1 → R2 → R3, visits R2 then R1, returns to R2 and restores it as R4. The existing browser restore test remains in the ordinary regression selection. Synthetic data only; local files and local playback; no shared corpus publication. The two-actor milestone pilot remains untested by this narrower experiment.

## Findings

- **Restore already ships.** The live document-history and automatic-revisions pages promise an additive restore, and the existing `revision-history.spec.ts` exercises restore, another open client's convergence, no-op, undo and archived refusal. We can record the full requested path without adding product behavior.
- **The earlier recording constraint no longer requires a project split.** PR #669 used a separate recording project and accidentally excluded its test from a Chromium-only regression selection. Installed Playwright 1.62.1 has `page.screencast.start/stop` (introduced in 1.59), which can capture only the journey after fixture setup. This experiment used that API without changing the normal Playwright configuration. Reference: https://playwright.dev/docs/api/class-screencast.
- **The old link check was removed intentionally.** Commit `7ce5eebbdd312fc35338c26c6115b8e48ee68f05`, PR #2043, calls its deletion an authorized process self-check deletion. The slash-menu scenario and annotation remain documentation. Do not treat the absence as an unexplained regression or silently restore a new mandatory gate.
- **An ordinary test page does not inherit runner video options.** This harness creates its own contexts through `browser.newContext`. Explicit page capture is a better fit than assuming `use.video` records these pages.
- **Page-scoped recording worked.** First run passed the existing restore test, including its checks after the recorded part. The clip is 14.48 seconds, 1,238,569 bytes, 1280×720, Chromium 151.0.7922.34. Full invocation took 21.18 seconds; Playwright reported 17.5 seconds for the test. Nine named states include the original three revisions, both backward steps, restore confirmation and the four-entry result. Recording adds 1.5 seconds of reader dwell per moment; ordinary runs do not pay it.
- **Capture without tracing.** The opt-in command uses `--trace=off`: another active screencast can own the frame size. Normal regression tracing is unchanged. Native page capture means the old separate-project/`grepInvert` solution is unnecessary here.
- **Provenance itself needs checking.** The first run exposed a path error: `git diff -- packages` from the web package returned an empty diff. Fixed to use the repository-root pathspec `:/packages`, and added a hash of the recorder. The first manifest is retained as an explicitly imperfect experiment, not silently rewritten.

## What the roundtrip established

The prototype has four parts: an annotation and a recording helper in the existing restore test; an opt-in capture command; immutable local run directories; and a native HTML video player injected into a temporary build of Uberblick. A normal document in a disposable workspace holds the starting state, actor, steps, expected result and what the test checks. The player sits beneath that document. It is not a new production block, schema or app route.

The existing test restores a named state through its **Changes since this name** comparison. The clip therefore goes R3 → R2 → R1 → R2, compares R2 with R3, restores R2 from the Before column, returns to now, then shows R4 and the three retained revisions. The scenario's prose was corrected to state that extra comparison step. This is a real example of why an existing test's path must be inspected rather than inferred from its title.

| Experiment | Observed result |
| --- | --- |
| First capture | Passed. 14.48-second clip, 1,238,569 bytes; 21.183 seconds for the command. Nine moments. |
| Second capture after recorder/prose corrections | Passed. 14.52-second clip, 1,238,641 bytes; 20.773 seconds for the command. New run identity; old bytes retained. |
| Intentional failure immediately after R2 | The command exited 1. The manifest says test **failed**, scenario **incomplete**, media **complete**. The 4.92-second, 283,567-byte video is playable and has three moments. The temporary failure was removed in a `finally` block. |
| Named moments | All nine positions sought successfully; sampled R1, the R2/R3 comparison, the confirmation and R4 showed the intended states. Timing is relative to the first screencast frame, not test start. This is a usable checkpoint proof, not a claim of frame-perfect transition capture. |
| Brief confirmation | The original decoded frame at 9.65 seconds contains the restore toast. A screenshot of the paused native player can hide it under the controls. Seeking can also briefly show the browser's loading spinner even after `currentTime` changes. |
| Copy and reopen | Clipboard text includes starting state, actor, run/clip, timestamp, build, test/media facts and observed/desired placeholders. Opening its URL pauses at the copied time. Playback and speed changes work. |
| Refresh and failure after an earlier success | After restarting the preview with the new index, the original URL still opened the first clip at 12.748 seconds. Its served bytes matched the original SHA-256. The old recording warns that a newer attempt exists, including when that attempt failed. |
| Unknown recording | Shows unavailable; it does not substitute the latest clip. |
| Ordinary regression | The same test remains registered in both Chromium and iPad WebKit and passes without capture. Normal Playwright config and test selection are unchanged. |

The ordinary Chromium test took 5.9 seconds in the paired run; the final iPad rerun took 6.8 seconds. The recorded Chromium run took 17.4–17.5 seconds in Playwright. These are individual observations, not benchmark medians. The deliberate 13.5 seconds of recording-only dwell dominates the added cost; harness and cached bundle setup each took roughly 0.3–0.7 seconds in the quiet capture runs. Dwell makes these nine states inspectable and is not a synchronization substitute.

## Friction and limits

- **Legibility is the largest visible weakness.** The 1280×720 recording shrinks into a roughly 650-pixel document column, making labels tiny. Native fullscreen helps with pixels, but the named-moment buttons outside the video are then unavailable. A wider/expanded player that keeps moments nearby is a more credible first improvement than custom transport controls or checkpoint stills.
- **Do not equate finished media with a completed scenario.** The negative run proved these differ. Latest attempt, most recent completed scenario, assertion result and media availability must stay separate. The prototype lists every run but does not yet provide a polished selector for these concepts.
- **Evidence includes context, not just bytes.** The second run changed the scenario prose. Copying an old moment must use that run's scenario snapshot, not today's page text. The prototype was corrected accordingly. It also shows commit, dirty state, tracked diff hash, test hash and recorder hash; this is still not a complete reproducible build attestation for arbitrary untracked source or external dependencies.
- **Recording correctness can fail independently.** The first manifest's empty-diff hash was a recorder bug. It remains unchanged and documented. A passing product test cannot validate the provenance pipeline by itself.
- **Use the correct installed API.** Current online Playwright documentation already describes options newer than the installed 1.62.1. The experiment checked local types and used the available methods only. No dependency was added.
- **The page bootstrap is deliberately incomplete.** It creates an ordinary page in a synthetic workspace from a small seed. Editing that page is not yet an authoritative input to the capture command, and its data disappears when the preview stops. A shared page-to-test flow, scenario tag and index discoverability, MCP authoring/readback of a video block, ordinary editing/sync preservation and arbitrary HTTPS playback were not implemented or proven. They belong to the follow-on work.
- **The native player handles play/pause, seeking and fullscreen;** the prototype adds a plain speed selector and moment buttons. Desktop Chromium playback was exercised. The product journey also passed iPad WebKit, but playback compatibility of these local WebM files on iPad/Safari was not tested.
- **A restarted preview reads the updated index.** The prototype does not hot-reload newly recorded runs. It copies the small local clips into its disposable bundle for same-origin serving and does not change the product CSP. Hosting, expiry renewal, access control and other-machine viewing remain untested.
- **Storage stays opt-in and finite only by operator discipline.** The three clips total 2,760,777 bytes. They survive Playwright cleanup because they are outside `test-results`. There is no automatic pruning. Do not promote this into a recurring job before the team chooses retention and the treatment of recordings referenced by requests.
- **Integration costs more than the video API call.** The helper, capture/preview runner, player, seed and inspection probe are 377 lines, plus 35 net lines in the existing test. Wiring provenance, cleanup, context and references took more code than capture. This is throwaway spike code, not a recommended framework.
- **Human usefulness is still unconfirmed.** Ben was asked to open the local player and identify the restore target from the R2/R3 comparison, then copy any adjustment. No answer has arrived in this session. Do not report a successful independent-reader trial or time saved for a PM. A second actor's clip, live observation versus recording, and a PM-authored real issue are also untested. The two-actor pilot is still necessary.

## A concrete request produced from a recorded moment

This is an agent-observed adjustment, not a PM validation result or a newly filed product issue:

> Starting state: an existing document has R1, R2 and current R3. Actor: a member with write access. At 9.65 seconds in recording `2026-10-27T14-26-24.968Z-5af61b24/member.webm`, R2 has just been restored as R4. Build: `344a07495e2079986b5688ce7387a2af9086ab71` with uncommitted spike changes. Observed: the native paused-player control strip covers the lower-right restore confirmation, and inline playback reduces the text to roughly half its recorded size. Desired: inspect a paused moment at a readable size while keeping named moments accessible and the confirmation unobscured. The raw recording contains the confirmation; it is the viewing experience that obstructs it.

Same-machine reference while the preview is running:
`http://127.0.0.1:4178/?scenario=history-restore&recording=2026-10-27T14-26-24.968Z-5af61b24&actor=member&t=9.65`

## Recommended changes to the milestone intakes

These are recommendations, not edits to the issues or new product decisions.

| Issue | Smallest useful adjustment |
| --- | --- |
| [#2409 — player](https://github.com/uberblick-ai/uberblick-2/issues/2409) | Keep native media controls initially. Add an explicit readable expanded view with named moments still reachable, and an inspection check for transient UI under the native controls. Verify supported-browser codec playback. Keep HTTPS media/CSP and ordinary document/MCP roundtrip in this slice; the spike proved neither. |
| [#2410 — scenario pages](https://github.com/uberblick-ai/uberblick-2/issues/2410) | Make the real page the source of intent and snapshot its revision into each recording. State the actual variant, including the comparison step here. Decide how a missing/ambiguous annotation is reported; the on-demand command can validate Playwright registration without reinstating a mandatory unit gate deleted by #2043. Test discovery through the tag/index with the reader. |
| [#2412 — capture](https://github.com/uberblick-ai/uberblick-2/issues/2412) | Prefer the installed page-scoped screencast API; no recording-only project or regression exclusions are needed for this harness. Start after setup, stop at the intended outcome, use explicit actor/clip ids, keep optional reader dwell outside normal execution, and prove a failed assertion yields partial media plus a failed exit. Document interaction with tracing. Own local immutable run ids/manifests here. |
| [#2414 — facts and moments](https://github.com/uberblick-ai/uberblick-2/issues/2414) | Keep latest attempt, latest completed scenario, test result and media completion separate. Show stale scenario/test/build facts as differences, not proof of behavioral drift. Keep the original scenario snapshot available beside old evidence. A plain run list is enough initially. |
| [#2415 — copied feedback](https://github.com/uberblick-ai/uberblick-2/issues/2415) | Implement against the local immutable reference from #2412 first; do not make useful copy/reopen wait for hosted storage. Copy the recorded context, actor and time, then ask the person to supply observed/desired behavior. Require a missing reference to stay missing. Range selection remains unproven and can be evaluated after moments. |
| [#2413 — hosted publication](https://github.com/uberblick-ai/uberblick-2/issues/2413) | Preserve/resolve the ids already issued locally rather than inventing identity only at upload. Keep stable reference separate from playable URL. Keep provider, access, retention and expiry recovery explicit review choices; no hosted conclusion follows from loopback success. |
| [#2417 — pilot](https://github.com/uberblick-ai/uberblick-2/issues/2417) | Run this revision journey with the PM, then the genuinely two-actor invitation scenario. Measure whether they can find the target and describe a concrete adjustment without reading the test. Refresh twice and reopen the first request. Include legibility and brief-state inspection, not just whether video plays. |
| [#2411 — agent test generation](https://github.com/uberblick-ai/uberblick-2/issues/2411), [#2416 — automation](https://github.com/uberblick-ai/uberblick-2/issues/2416) | Leave deferred. This spike provides no evidence that either investment is needed. On-demand recording is already cheap enough for the next human experiment. |

The key boundary change is to put **local immutable identity and the run manifest in #2412**, let **#2415 consume that local reference**, and make **#2413 resolve/publish the same identity**. The current #2415 intake depends on identity owned by hosted publishing, even though local copy/reopen is already useful. Keep the next investment small: player + real page convention + on-demand capture + local feedback, followed by the independent-reader pilot.

## Validation and evidence limits

- `mise run lint`: passed (existing informational lint notices remain).
- `mise run typecheck`: passed across the workspace.
- The affected existing E2E test passed with ordinary Chromium and iPad WebKit runs. The first iPad attempt caught an error in the spike's full-text assertion: a narrow unified diff includes removed and added words. The corrected assertion checks the added word; the rerun passed. No production behavior changed.
- Two opt-in recordings passed; the deliberate failing recording exited nonzero and retained useful video. `scripts/scenario-spike/inspect.ts` passed against success and failure libraries: playback, all available moments, speed, clipboard, paused reopening, missing-run refusal, old-run warning and original media hash after refresh. It observed no browser page errors.
- `mise run test` did **not** fully pass. Web (2,320 tests) and CLI (1,438 passed, two skipped) passed. Schema failed at startup removing the shared `.vitest-cache` with `ENOTEMPTY`; its isolated rerun passed 1,299 tests. MCP's isolated rerun reproduced one `test/help.test.ts` failure expecting the installed wireframe version string `0.3.1`; 1,292 tests passed. Schema, MCP and the unit runner are byte-identical to the grounding revision. No unrelated fix was made. The chained script suites did not run after the failed unit command.
- No CI, independent review, merge, corpus update or release was requested for this disposable local spike. The ordinary product test stayed in regression; the broad browser suite was not rerun because no production code changed.

## Reproduce

From the repository root:

```sh
mise exec -- pnpm --filter @uberblick/web exec tsx scripts/scenario-spike/run.ts record
mise exec -- pnpm --filter @uberblick/web exec tsx scripts/scenario-spike/run.ts serve
```

Open `http://127.0.0.1:4178/?scenario=history-restore`. Ctrl-C stops the disposable workspace; a 45-minute deadline also closes it. The preview copies only these synthetic clips into a temporary app bundle. Nothing is added to the deployed app.

Recordings and manifests live under `packages/web/scenario-evidence/history-restore/<timestamp>-<id>/`, outside Playwright's disposable output directory, and are gitignored. Runs get new identities and never overwrite old evidence. For this short experiment they are retained until manually removed; no production retention policy is chosen.
