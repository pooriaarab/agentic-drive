import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createClient } from "../src/client.js";

const ADA = "ada-token-for-the-ui-tests";
const HELPER = "helper-token-for-the-ui-tests";
const shots = "docs/ui";
const schemes = ["light", "dark"] as const;

/** Runs axe against WCAG 2.2 AA in both themes and saves a screenshot of each. */
async function audit(page: Page, name: string) {
  for (const colorScheme of schemes) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), `${name} (${colorScheme})`).toEqual([]);
    await page.screenshot({ path: `${shots}/${name}-${colorScheme}.png` });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

const row = (page: Page, name: string) => page.locator(".ad-file-row").filter({ has: page.getByRole("link", { name, exact: true }) });
async function pick(page: Page, name: string, action: string) {
  await page.getByRole("button", { name: `Actions for ${name}` }).click();
  await page.getByRole("menuitem", { name: action, exact: true }).click();
}

test.describe.configure({ mode: "serial" });

test("a person manages files, and the changes persist", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await audit(page, "01-sign-in");

  await page.getByLabel("Access token").fill("wrong-token");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("This token is not valid.")).toBeVisible();
  await page.getByLabel("Access token").fill(ADA);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByText("This folder is empty")).toBeVisible();
  await audit(page, "02-empty");

  await page.getByRole("button", { name: "New folder" }).click();
  await page.getByLabel("Folder name").fill("Reports");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("link", { name: "Reports", exact: true }).first()).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello drive") });
  await expect(row(page, "notes.txt")).toBeVisible();

  await pick(page, "notes.txt", "Rename");
  await page.getByLabel("New name").fill("plan.txt");
  await page.getByRole("button", { name: "Rename" }).click();
  await expect(row(page, "plan.txt")).toBeVisible();
  await expect(row(page, "notes.txt")).toHaveCount(0);

  await pick(page, "plan.txt", "Move");
  await page.getByLabel("Move to").selectOption({ label: "/Reports" });
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await expect(row(page, "plan.txt")).toHaveCount(0);
  await audit(page, "03-list");

  await page.getByRole("navigation", { name: "Folders" }).getByRole("link", { name: "Reports" }).click();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByText("Reports")).toBeVisible();
  await expect(row(page, "plan.txt")).toBeVisible();

  await pick(page, "plan.txt", "Move to trash");
  await expect(page.getByText("This folder is empty")).toBeVisible();
  await page.getByRole("link", { name: "Trash" }).click();
  await expect(row(page, "plan.txt")).toBeVisible();
  await audit(page, "04-trash");
  await page.getByRole("button", { name: "Restore plan.txt" }).click();
  await expect(page.getByText("The trash is empty")).toBeVisible();
  await audit(page, "05-trash-empty");

  await page.getByRole("link", { name: "My files" }).first().click();
  await page.getByRole("link", { name: "Reports", exact: true }).first().click();
  await expect(row(page, "plan.txt")).toBeVisible();
  await page.reload();
  await expect(row(page, "plan.txt")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByText("Reports")).toBeVisible();
});

test("an item made by an agent carries a marker, in the list and in the grid", async ({ page }) => {
  const agent = createClient({ baseUrl: "http://127.0.0.1:8788", token: HELPER });
  await agent.upload("/agent-notes.txt", "written by a helper", { mime: "text/plain" });
  await page.goto("/");
  await page.getByLabel("Access token").fill(ADA);
  await page.getByRole("button", { name: "Sign in" }).click();
  const made = row(page, "agent-notes.txt");
  await expect(made.getByText("Agent", { exact: true })).toBeVisible();
  await expect(made).toContainText("helper");
  await expect(row(page, "Reports")).not.toContainText("Agent");
  await audit(page, "06-agent-marker");

  await page.getByRole("button", { name: "Grid view" }).click();
  await expect(page.getByRole("button", { name: "Grid view" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("list", { name: /Items in/ }).getByText("Agent", { exact: true })).toBeVisible();
  await audit(page, "07-grid");
});

test("drag and drop uploads a file", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Access token").fill(ADA);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "New folder" })).toBeVisible();
  const transfer = await page.evaluateHandle(() => {
    const t = new DataTransfer();
    t.items.add(new File(["dropped"], "dropped.txt", { type: "text/plain" }));
    return t;
  });
  await page.getByRole("region", { name: "Files" }).dispatchEvent("drop", { dataTransfer: transfer });
  await expect(page.getByRole("link", { name: "dropped.txt" }).first()).toBeVisible();
});

test("the share dialog shares by link and by invite, and the keyboard reaches it", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Access token").fill(ADA);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Actions for agent-notes.txt" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "Share" }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Invite a person or an agent").fill("grace@example.com");
  await dialog.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(page.getByText("Invite created")).toBeVisible();
  await audit(page, "08-share");
  await dialog.getByRole("tab", { name: /link/i }).first().click();
  await dialog.getByLabel("Anyone with the link").click();
  await expect(dialog.getByLabel("Anyone with the link")).toBeChecked();
  const url = dialog.getByRole("textbox", { name: "Link", exact: true });
  await expect(url).toHaveValue(/#\/s\//);
  const shared = await url.inputValue();
  await audit(page, "09-share-link");
  // The first Escape closes the open toast, and the second closes the dialog.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // A visitor opens the link with no token of their own.
  await page.evaluate(() => sessionStorage.clear());
  await page.goto(shared);
  await page.reload();
  await expect(page.getByRole("heading", { name: "agent-notes.txt" })).toBeVisible();
  await audit(page, "10-shared");
});

test("an error from the server shows a message and a retry", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Access token").fill(ADA);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("region", { name: "Files" })).toBeVisible();
  await page.route("**/api/v1/drive/**", (route) => route.fulfill({ status: 500, json: { error: { code: "INTERNAL", message: "the server could not finish the request" } } }));
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("the server could not finish the request");
  await audit(page, "11-error");
  await page.unroute("**/api/v1/drive/**");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("region", { name: "Files" })).toBeVisible();
});
