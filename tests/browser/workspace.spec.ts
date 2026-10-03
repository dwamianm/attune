import { expect, test, type Page } from "@playwright/test";

const panel = (page: Page, id: string) => page.locator(`[data-panel="${id}"]`);
const record = (page: Page, kind: string, id: string) => page.locator(`[data-item-kind="${kind}"][data-item-id="${id}"]`);

test("the full introduction can be read, explored, or left with Escape immediately", async ({ page }) => {
  await page.goto("/?welcome=1");
  const intro = page.getByRole("dialog", { name: "Welcome to Attune." });
  await expect(intro.getByRole("heading", { name: "What the interface promises" })).toBeAttached();
  await expect(intro.getByRole("button", { name: "Guide me", exact: true })).toBeEnabled();
  await expect(intro.getByRole("button", { name: "Explore on my own" })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(intro).toBeHidden();
  await expect(page.getByRole("textbox", { name: "Command bar" })).toBeEditable();
});

test("Guide me completes a real workflow and can be replayed or ended", async ({ page }) => {
  await page.goto("/?welcome=1");
  await page.getByRole("dialog").getByRole("button", { name: "Guide me", exact: true }).click();
  const guide = page.getByRole("region", { name: "Guided walkthrough" });
  const next = guide.getByRole("button", { name: "Continue", exact: true });
  await expect(guide.getByRole("heading", { name: "Start with the work" })).toBeFocused();
  await expect(next).toBeDisabled();
  await record(page, "message", "m-1").click();
  await expect(next).toBeEnabled();
  await next.click();
  await expect(guide.getByRole("heading", { name: "Notice the context" })).toBeVisible();
  await next.click();
  await guide.getByRole("button", { name: "Show me where" }).click();
  await record(page, "invoice", "INV-1042").click();
  await next.click();
  await guide.getByRole("button", { name: "Show me where" }).click();
  await page.locator('[data-guide-resend="INV-1042"]').click();
  await expect(guide.getByRole("status")).toHaveText("Invoice resent");
  await next.click();
  await guide.getByRole("button", { name: "Show me where" }).click();
  await record(page, "task", "t-1").getByRole("checkbox").check();
  await expect(guide.getByRole("status")).toHaveText("Task complete");
  await next.click();
  await guide.getByRole("button", { name: "Keep exploring" }).click();
  await expect(guide).toBeHidden();
  const replay = page.getByRole("button", { name: "Guide me", exact: true });
  await expect(replay).toBeFocused();
  await replay.click();
  await expect(guide.getByRole("heading", { name: "Start with the work" })).toBeVisible();
  await guide.getByRole("button", { name: "End walkthrough" }).click();
  await expect(guide).toBeHidden();
  expect(await page.locator("html").evaluate((el) => el.scrollWidth <= window.innerWidth)).toBe(true);
});

test("suggestions-only preserves panel cells and saved density across a reload", async ({ page }) => {
  await page.goto("/?welcome=0");
  await page.getByRole("button", { name: "Focus settings", exact: true }).click();
  await page.getByRole("combobox", { name: "Workspace behavior", exact: true }).selectOption("suggestions");
  await page.getByRole("combobox", { name: "Display density", exact: true }).selectOption("dense");
  await page.keyboard.press("Escape");
  const cells = () => page.locator("[data-panel]").evaluateAll((els) => els.map((el) => ({ id: el.getAttribute("data-panel"), column: (el as HTMLElement).style.gridColumn, row: (el as HTMLElement).style.gridRow })));
  const before = await cells();
  const response = page.waitForResponse("**/api/adapt");
  await record(page, "message", "m-1").click();
  await response;
  await expect(page.getByRole("banner").locator('[title^="Last answer from"]')).toBeVisible();
  await expect.poll(cells).toEqual(before);
  await page.reload();
  await page.getByRole("button", { name: "Focus settings", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Workspace behavior", exact: true })).toHaveValue("suggestions");
  await expect(page.getByRole("combobox", { name: "Display density", exact: true })).toHaveValue("dense");
  await expect(page.locator("[data-density]")).toHaveAttribute("data-density", "dense");
});

test("a delayed answer preserves the text field, focus, and selection", async ({ page }) => {
  let release!: () => void;
  let received!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { received = resolve; });
  await page.route("**/api/adapt", async (route) => {
    const response = await route.fetch();
    received();
    await held;
    await route.fulfill({ response });
  });
  await page.goto("/?welcome=0");
  const search = page.getByRole("textbox", { name: "Search messages", exact: true });
  await search.fill("Har");
  await started;
  await search.press("Home");
  await search.press("Shift+ArrowRight");
  await search.press("Shift+ArrowRight");
  const response = page.waitForResponse("**/api/adapt");
  release();
  await response;
  await expect(page.getByRole("banner").locator('[title^="Last answer from"]')).toBeVisible();
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("Har");
  expect(await search.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, 2]);
});

test("manual expansion can be undone while an earlier answer is in flight", async ({ page }) => {
  let release!: () => void;
  let received!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { received = resolve; });
  await page.route("**/api/adapt", async (route) => {
    const response = await route.fetch();
    received();
    await held;
    await route.fulfill({ response });
  });
  await page.goto("/?welcome=0");
  await record(page, "message", "m-1").click();
  await started;
  const cell = () => panel(page, "invoices").evaluate((el) => ({ column: (el as HTMLElement).style.gridColumn, row: (el as HTMLElement).style.gridRow }));
  const before = await cell();
  await page.getByRole("button", { name: "Make Invoices bigger", exact: true }).click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  const response = page.waitForResponse("**/api/adapt");
  release();
  await response;
  await expect(page.getByRole("banner").locator('[title^="Last answer from"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Make Invoices bigger", exact: true })).not.toHaveAttribute("aria-pressed", "true");
  await expect.poll(cell).toEqual(before);
});

test("a delayed adaptation preserves scroll position in the active list", async ({ page }) => {
  let release!: () => void;
  let received!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { received = resolve; });
  await page.route("**/api/adapt", async (route) => {
    const response = await route.fetch();
    received();
    await held;
    await route.fulfill({ response });
  });
  await page.goto("/?welcome=0");
  await record(page, "message", "m-1").click();
  await started;
  const messages = page.getByRole("list", { name: "Messages", exact: true });
  await messages.hover();
  await page.mouse.wheel(0, 140);
  await expect.poll(() => messages.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  const before = await messages.evaluate((el) => el.scrollTop);
  const response = page.waitForResponse("**/api/adapt");
  release();
  await response;
  await expect(page.getByRole("banner").locator('[title^="Last answer from"]')).toBeVisible();
  expect(await messages.evaluate((el) => el.scrollTop)).toBeCloseTo(before, 0);
});
