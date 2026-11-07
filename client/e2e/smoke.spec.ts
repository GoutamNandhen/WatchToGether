import { expect, test, type Page } from "@playwright/test";

// Answer every API call so pages render without a backend, and fail on any uncaught page error.
const setup = async (page: Page) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.route(/\/api\//, (route) => {
    const url = route.request().url();
    if (url.endsWith("/api/health")) return route.fulfill({ json: { ok: true } });
    return route.fulfill({ status: 401, json: { message: "Not signed in" } });
  });
  return errors;
};

test("landing page renders the hero and a way in", async ({ page }) => {
  const errors = await setup(page);
  await page.goto("/");
  await expect(page.locator("h1").first()).toBeVisible();
  await expect(page.getByRole("link", { name: /sign up|get started|start/i }).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("login form has email and password fields", async ({ page }) => {
  const errors = await setup(page);
  await page.goto("/login");
  await expect(page.locator('input[type="email"]')).toBeVisible();
  await expect(page.locator('input[type="password"]')).toBeVisible();
  expect(errors).toEqual([]);
});

test("signed-out visitors are sent from the dashboard to login", async ({ page }) => {
  await setup(page);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login/);
});

test("privacy and terms pages load", async ({ page }) => {
  const errors = await setup(page);
  for (const path of ["/privacy", "/terms"]) {
    await page.goto(path);
    await expect(page.locator("h1")).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test("unknown routes show the 404 page", async ({ page }) => {
  await setup(page);
  await page.goto("/definitely-not-a-page");
  await expect(page.getByText("404")).toBeVisible();
});

test("no horizontal scroll on the landing page", async ({ page }) => {
  await setup(page);
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
