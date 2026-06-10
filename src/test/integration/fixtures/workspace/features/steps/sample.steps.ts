import { createBdd } from "playwright-bdd";

const { Given, When, Then } = createBdd();

Given("I am on the test page", async () => { /* stub */ });
When("I click the test button", async () => { /* stub */ });
Then("I should see the test result", async () => { /* stub */ });
Given("I have a {string} value", async (_ctx: unknown, _value: string) => { /* stub */ });
When("I process the input", async () => { /* stub */ });
Then("I should get {string} result", async (_ctx: unknown, _expected: string) => { /* stub */ });
