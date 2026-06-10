import { createBdd } from "playwright-bdd";

const { Given, When, Then, Step } = createBdd();

Given("I am on the test page", async ({ page }) => {
  await page.goto("https://playwright.dev/");
});

When("I click the test button", async ({ page }) => {
  await page.getByRole("link", { name: "Get started" }).click();
});

Then("I should see the test result", async ({ page }) => {
  await page.getByRole("heading", { name: "Installation" }).waitFor();
});

Given("I have a {string} value", async ({}, value: string) => {
  // Store value for later steps via fixtures or world; trivial sample.
  void value;
});

When("I process the input", async ({}) => {
  // no-op
});

Then("I should get {string} result", async ({}, _expected: string) => {
  // no-op
});

// Widget helpers used by fixture features under any keyword (Given/When/Then/And/But).
// playwright-bdd's `Step` matches on text alone, so declaring them as Step makes the
// keyword-agnostic intent explicit instead of relying on Given/When semantics.
Step("I have {int} widgets", async ({}, _count: number) => {});
Step("I add {int} widget", async ({}, _count: number) => {});
Step("I add {int} widgets", async ({}, _count: number) => {});
Step("I remove {int} widgets", async ({}, _count: number) => {});
Step("I have {int} widgets total", async ({}, _count: number) => {});


Then("I simulate a missing step definition", async ({}) => {
  // TODO: implement
});
