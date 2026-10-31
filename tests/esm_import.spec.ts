import { test, expect } from "@playwright/test";

test("starts the engine and reads users", async ({ page }) => {
  await page.goto("http://localhost:4713/tests");

  await page.getByRole("button", { name: "Start engine" }).click();

  await expect(page.locator("#output")).toHaveText("ready");
});

test("persists data in OPFS after page reload", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("http://localhost:4713/tests");

  await page.getByLabel("DB Name").fill("test-db");
  await page.getByRole("button", { name: "Start engine" }).click();
  await expect(page.locator("#output")).toHaveText("ready");

  await page.getByRole("button", { name: "Write data" }).click();
  await expect(page.locator("#output")).toHaveText("saved");

  await page.close();

  // same context
  const reopened = await context.newPage();
  await reopened.goto("http://localhost:4713/tests");

  await reopened.getByLabel("DB Name").fill("test-db");
  await reopened.getByRole("button", { name: "Start engine" }).click();
  await expect(reopened.locator("#output")).toHaveText("ready");

  await reopened.getByRole("button", { name: "Read data" }).click();
  await expect(reopened.locator("#output")).toHaveText('["Jane Doe"]');

  await context.close();
});
