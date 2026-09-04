# Test fixture: @TC-7 matches the in-memory adapter grammar, so a run of this scenario seals an
# artifact result carrying a test key.
Feature: Mapped fixture feature

  @TC-7
  Scenario: Sealed run scenario
    Given I am on the test page
    When I click the test button
    Then I should see the test result
