import { createBdd } from "playwright-bdd";

const { Given, When, Then } = createBdd();

Given("the API is running", async () => { /* stub */ });
When("I request the health endpoint", async () => { /* stub */ });
Then("I receive a 200 response", async () => { /* stub */ });
