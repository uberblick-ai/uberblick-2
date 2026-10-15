"""Check the temporary CI fixture's traces using only the standard library."""

from pathlib import Path
import zipfile


root = Path(__file__).resolve().parent.parent / "packages/web/test-results"
traces = list(root.rglob("trace.zip"))
assert len(traces) == 2, f"expected one failed trace per project, got {traces}"
for project in ["chromium", "webkit-ipad"]:
    project_traces = [trace for trace in traces if trace.parent.name.endswith(f"-{project}")]
    assert len(project_traces) == 1, f"expected one trace for {project}: {project_traces}"
    trace = project_traces[0]
    assert "failure-keeps-explicit-contexts" in trace.parent.name, trace
    assert "pass-discards" not in trace.parent.name, trace
    with zipfile.ZipFile(trace) as archive:
        streams = [name for name in archive.namelist() if name.endswith(".trace")]
        assert len(streams) == 3, f"expected runner plus two browser streams for {project}: {streams}"
        context_streams = [archive.read(name).decode("utf8") for name in streams if name != "test.trace"]
        for marker in ["explicit-context-one", "explicit-context-two"]:
            assert any(marker in stream for stream in context_streams), f"missing {marker} in {project}"
    print(f"PASS: {project} failed trace contains both explicit contexts; passing test retained no trace")
