const data = await fetch("/_spike/index.json").then(response => response.json());
const params = new URLSearchParams(location.search);
const requested = params.get("recording");
const selected = params.has("actor") && params.get("actor") !== "member" ? undefined :
  requested === null ? data.runs[0] : data.runs.find(run => run.id === requested);
const seconds = Math.max(0, Number(params.get("t")) || 0);

// The app resolves its workspace on first load. Keep the evidence identity in the query.
function mount() {
  const editor = document.querySelector(".ub-editor");
  if (!editor || document.querySelector("#scenario-player")) return;
  if (!location.pathname.endsWith(`/${data.uuid}`)) return;
  const panel = document.createElement("section");
  panel.id = "scenario-player";
  panel.setAttribute("aria-label", "Scenario recording");
  panel.style.cssText = "margin:24px auto;padding:20px;max-width:1100px;border:1px solid #888;border-radius:8px;background:var(--ub-bg,#fff);color:var(--ub-text,#222);font:14px system-ui";
  const add = (tag, text) => { const element = document.createElement(tag); if (text) element.textContent = text; panel.append(element); return element; };
  add("h2", "Local recording prototype");
  if (!selected) { add("p", "That recording is unavailable. No newer recording has been substituted."); editor.after(panel); return; }
  const run = selected;
  const facts = add("p", `${run.recordedAt} · ${run.variant} · ${run.browser} · ${run.viewport?.width}×${run.viewport?.height} · actor: ${run.actor}`);
  facts.style.opacity = "0.8";
  add("p", `Test: ${run.testStatus}. Scenario completed: ${run.scenarioCompleted ? "yes" : "no"}. Media: ${run.media}. ${run.publication}.`);
  add("p", `Build ${run.commit.slice(0, 12)}${run.dirty ? " + uncommitted changes" : ""}; test ${run.testSha256.slice(0, 12)}; scenario ${run.scenarioSha256.slice(0, 12)}.`);
  const warnings = [];
  if (run.id !== data.runs[0].id) warnings.push(`A newer recording exists (${data.runs[0].testStatus}). This still shows the original evidence.`);
  for (const [key, name] of [["commit", "commit"], ["diffSha256", "working tree"], ["testSha256", "test"], ["recorderSha256", "recorder"], ["scenarioSha256", "scenario"]]) {
    if (run[key] !== data.current[key]) warnings.push(`Current ${name} differs from this recording.`);
  }
  add("p", warnings.join(" ") || "Historical evidence from this recorded build; not a claim about subsequent builds.");
  const video = add("video");
  video.controls = true;
  video.preload = "metadata";
  video.setAttribute("aria-label", "Recorded revision history journey");
  video.style.cssText = "display:block;width:100%;background:#111";
  video.src = `/_spike/${encodeURIComponent(run.id)}/member.webm`;
  video.addEventListener("loadedmetadata", () => { video.currentTime = Math.min(seconds, video.duration); video.pause(); });
  video.addEventListener("error", () => add("p", "The media could not be loaded. The test result alone does not establish that the recording is watchable."));
  const moments = add("p");
  for (const moment of run.moments) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = moment.title;
    button.style.margin = "4px";
    button.addEventListener("click", () => { video.pause(); video.currentTime = moment.seconds; });
    moments.append(button);
  }
  const speedLabel = add("label", "Playback speed ");
  const speed = document.createElement("select");
  for (const rate of [0.25, 0.5, 1, 1.5, 2]) { const option = new Option(`${rate}×`, String(rate), rate === 1, rate === 1); speed.add(option); }
  speed.onchange = () => { video.playbackRate = Number(speed.value); };
  speedLabel.append(speed);
  const button = add("button", "Copy paused moment into a request");
  button.type = "button";
  button.style.margin = "12px";
  const request = add("textarea");
  request.setAttribute("aria-label", "Request text");
  request.rows = 12;
  request.style.cssText = "display:block;width:100%;box-sizing:border-box";
  const status = add("p");
  status.setAttribute("role", "status");
  button.onclick = async () => {
    video.pause();
    const time = Number(video.currentTime.toFixed(3));
    const link = new URL("/", location.origin);
    link.search = new URLSearchParams({ scenario: data.scenario.id, recording: run.id, actor: run.actor, t: String(time) }).toString();
    request.value = `${run.scenario.title}\n\nStarting state: ${run.scenario.startingState}\nActor: ${run.scenario.actor} (${run.actor})\nMoment: ${time}s in ${run.id}/${run.clip}\nEvidence (same machine): ${link.href}\nBuild: ${run.commit}${run.dirty ? " + uncommitted changes" : ""}; diff ${run.diffSha256}\nTest: ${run.testStatus}; scenario completed: ${run.scenarioCompleted}; media: ${run.media}\n\nObserved: [describe what is visible at this moment]\nDesired: [describe the change you want]\n`;
    try { await navigator.clipboard.writeText(request.value); status.textContent = "Copied. Add observed and desired behavior before filing."; }
    catch { request.focus(); request.select(); status.textContent = "Clipboard unavailable. Copy the selected request text."; }
  };
  const history = add("details");
  const summary = document.createElement("summary"); summary.textContent = "Other recordings"; history.append(summary);
  for (const other of data.runs) {
    const p = document.createElement("p"); const link = document.createElement("a");
    link.href = `/?scenario=${data.scenario.id}&recording=${other.id}`;
    link.textContent = `${other.recordedAt} — ${other.testStatus}`; p.append(link); history.append(p);
  }
  editor.after(panel);
  panel.scrollIntoView({ block: "start" });
}

function navigate() {
  const workspace = location.pathname.split("/")[1];
  if (!workspace || workspace === "_spike") return;
  if (!location.pathname.endsWith(`/${data.uuid}`)) {
    const destination = new URL(`/${workspace}/${data.uuid}`, location.origin);
    destination.search = params.toString();
    location.replace(destination);
  } else mount();
}
const observer = new MutationObserver(navigate);
observer.observe(document.body, { childList: true, subtree: true });
navigate();
