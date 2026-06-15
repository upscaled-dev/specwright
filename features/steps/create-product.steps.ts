import { expect } from "@playwright/test";
import { createBdd } from "playwright-bdd";

const { Given, When, Then } = createBdd();

// A tiny in-memory product store. These steps are browserless on purpose: this feature exists as a
// regression fixture for Scenario Outline targeting (running/debugging a single example row by
// `<spec>:<pwTestLine>`), not as a UI test — so it stays fast and deterministic, and every row passes.
interface Product {
  template: string;
  quantity: number;
}

let catalog: Map<string, Product>;

Given("I am on the product page", async ({}) => {
  catalog = new Map();
});

When(
  "I create a product {string} from template {string} with quantity {string}",
  async ({}, name: string, template: string, quantity: string) => {
    const count = Number(quantity);
    expect(name, "product name must not be empty").not.toBe("");
    expect(Number.isInteger(count) && count > 0, `quantity "${quantity}" must be a positive integer`).toBe(true);
    catalog.set(name, { template, quantity: count });
  }
);

Then("the product {string} is listed", async ({}, name: string) => {
  expect(catalog.has(name), `product "${name}" should be listed after creation`).toBe(true);
});
