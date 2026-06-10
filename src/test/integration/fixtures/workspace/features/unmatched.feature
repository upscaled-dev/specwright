Feature: Unmatched-step diagnostics fixture

  Scenario: Steps that have no matching definitions
    Given I do something never defined
    When I press a brand new button
    Then I see the new outcome
