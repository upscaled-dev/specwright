import { createBdd } from "playwright-bdd";

const { Given, When, Then } = createBdd();

Given("I am on the login page", async () => { /* stub */ });
When("I submit valid credentials", async () => { /* stub */ });
Then("I see the dashboard", async () => { /* stub */ });
When("I sign in as {string}", async ({}, _role: string) => { /* stub */ });
Then("I land on the {string} dashboard", async ({}, _plan: string) => { /* stub */ });
