import { expect, test } from "@playwright/test";
import { activateControl, createDoc, docTitle, setupHarness } from "./app-helpers.js";
import { placeCaret } from "./harness.js";

const { harness, openApp } = setupHarness();

test("main repository settings normalize, follow remote changes and repaint every reader without document edits", { tag: "@webkit" }, async ({ browser }) => {
  const local = await openApp(browser);
  if ((local.viewportSize()?.width ?? 1280) < 1280) {
    await activateControl(local.getByRole("button", { name: "Show document list", exact: true }));
  }
  const uuid = await createDoc(local, docTitle("Main repository"));
  await placeCaret(local);
  await local.keyboard.type(
    "[#12](https://github.com/Example/SomeRepo/pull/12) · " +
    "[#9](https://github.com/Other/SomeRepo/issues/9) · " +
    "[#7](https://github.com/Example/Elsewhere/issues/7)",
  );
  await local.locator(".ub-title").click();
  const remote = await openApp(browser, `/${harness().workspace}/${uuid}`, { upstream: true });
  for (const page of [local, remote]) await expect(page.locator(".ub-github-pill-repo")).toHaveText(["SomeRepo", "SomeRepo", "Elsewhere"]);
  const revisions = await Promise.all([local, remote].map(page => page.locator(".ub-doc-rev").innerText()));
  const settingsPath = `/${harness().workspace}/settings`;
  const settings = await openApp(browser, settingsPath);
  const remoteSettings = await openApp(browser, settingsPath, { upstream: true });
  const field = settings.getByLabel("Main repository", { exact: true });
  const remoteField = remoteSettings.getByLabel("Main repository", { exact: true });
  await expect(field).toBeEnabled();
  await expect(field).toHaveValue("");
  const save = settings.getByRole("button", { name: "Save main repository", exact: true });

  for (const address of [
    "example/somerepo", "https://github.com/example/somerepo",
    "https://github.com/example/somerepo.git", "https://github.com/example/somerepo.git/",
  ]) {
    await field.fill(address);
    await activateControl(save);
    await expect(field).toHaveValue("example/somerepo");
    await expect(remoteField).toHaveValue("example/somerepo");
    for (const page of [local, remote]) {
      const links = page.locator(".ub-editor a.ub-link");
      await expect(links.nth(0).locator(".ub-github-pill-repo")).toHaveCount(0);
      await expect(links.nth(0)).toHaveAccessibleName("Pull request Example/SomeRepo#12");
      await expect(links.nth(0)).toHaveAttribute("title", "Pull request Example/SomeRepo#12");
      await expect(links.nth(1).locator(".ub-github-pill-repo")).toHaveText("SomeRepo");
      await expect(links.nth(2).locator(".ub-github-pill-repo")).toHaveText("Elsewhere");
    }
  }

  await field.fill("https://github.example.com/Example/SomeRepo");
  await field.press("Enter");
  await expect(settings.getByRole("alert")).toContainText("owner/repo or a github.com repository address");
  await expect(remoteField).toHaveValue("example/somerepo");
  await field.fill("example/somerepo");
  await expect(settings.getByRole("alert")).toHaveCount(0);
  await remoteField.fill("Other/SomeRepo");
  await remoteField.press("Enter");
  await expect(remoteField).toBeFocused();
  await expect(field).toHaveValue("Other/SomeRepo");
  for (const page of [local, remote]) {
    const links = page.locator(".ub-editor a.ub-link");
    await expect(links.nth(0).locator(".ub-github-pill-repo")).toHaveText("SomeRepo");
    await expect(links.nth(1).locator(".ub-github-pill-repo")).toHaveCount(0);
    await expect(links.nth(1)).toHaveAccessibleName("Issue Other/SomeRepo#9");
  }

  await field.fill("Draft/repository");
  await remoteField.fill("Example/Elsewhere");
  await remoteField.press("Enter");
  for (const page of [local, remote]) {
    const links = page.locator(".ub-editor a.ub-link");
    await expect(links.nth(1).locator(".ub-github-pill-repo")).toHaveText("SomeRepo");
    await expect(links.nth(2).locator(".ub-github-pill-repo")).toHaveCount(0);
  }
  await expect(field).toHaveValue("Draft/repository");
  await field.fill("Example/Elsewhere");
  await remoteField.fill("");
  await remoteField.press("Enter");
  await expect(field).toHaveValue("");
  for (const [index, page] of [local, remote].entries()) {
    await expect(page.locator(".ub-github-pill-repo")).toHaveText(["SomeRepo", "SomeRepo", "Elsewhere"]);
    await expect(page.locator(".ub-doc-rev")).toHaveText(revisions[index] ?? "");
  }
});
