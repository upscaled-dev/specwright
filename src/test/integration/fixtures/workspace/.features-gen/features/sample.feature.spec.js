// Generated from: features/sample.feature
import { test } from "playwright-bdd";

test.describe('Fixture feature', () => {

  test('Plain scenario', { tag: ['@feature', '@fixture', '@smoke'] }, async ({ Given, When, Then }) => {
    await Given('I am on the test page');
    await When('I click the test button');
    await Then('I should see the test result');
  });

  test.describe('Test scenario outline', () => {

    test('Example #1', { tag: ['@feature', '@fixture', '@outline'] }, async ({ Given, When, Then }) => {
      await Given('I have a "hello" value');
      await When('I process the input');
      await Then('I should get "world" result');
    });

    test('Example #2', { tag: ['@feature', '@fixture', '@outline'] }, async ({ Given, When, Then }) => {
      await Given('I have a "test" value');
      await When('I process the input');
      await Then('I should get "pass" result');
    });

  });

});

// == technical section ==

test.use({
  $test: [({}, use) => use(test), { scope: 'test', box: true }],
  $uri: [({}, use) => use('features/sample.feature'), { scope: 'test', box: true }],
  $bddFileData: [({}, use) => use(bddFileData), { scope: "test", box: true }],
});

const bddFileData = [ // bdd-data-start
  {"pwTestLine":6,"pickleLine":6,"tags":["@feature","@fixture","@smoke"],"steps":[{"pwStepLine":7,"gherkinStepLine":7,"keywordType":"Context","textWithKeyword":"Given I am on the test page","stepMatchArguments":[]},{"pwStepLine":8,"gherkinStepLine":8,"keywordType":"Action","textWithKeyword":"When I click the test button","stepMatchArguments":[]},{"pwStepLine":9,"gherkinStepLine":9,"keywordType":"Outcome","textWithKeyword":"Then I should see the test result","stepMatchArguments":[]}]},
  {"pwTestLine":14,"pickleLine":19,"tags":["@feature","@fixture","@outline"],"steps":[{"pwStepLine":15,"gherkinStepLine":13,"keywordType":"Context","textWithKeyword":"Given I have a \"hello\" value","stepMatchArguments":[]},{"pwStepLine":16,"gherkinStepLine":14,"keywordType":"Action","textWithKeyword":"When I process the input","stepMatchArguments":[]},{"pwStepLine":17,"gherkinStepLine":15,"keywordType":"Outcome","textWithKeyword":"Then I should get \"world\" result","stepMatchArguments":[]}]},
  {"pwTestLine":20,"pickleLine":20,"tags":["@feature","@fixture","@outline"],"steps":[{"pwStepLine":21,"gherkinStepLine":13,"keywordType":"Context","textWithKeyword":"Given I have a \"test\" value","stepMatchArguments":[]},{"pwStepLine":22,"gherkinStepLine":14,"keywordType":"Action","textWithKeyword":"When I process the input","stepMatchArguments":[]},{"pwStepLine":23,"gherkinStepLine":15,"keywordType":"Outcome","textWithKeyword":"Then I should get \"pass\" result","stepMatchArguments":[]}]},
]; // bdd-data-end
