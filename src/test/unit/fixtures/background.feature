@background @widgets
Feature: Widgets with a feature-level Background

  Background:
    Given I have 0 widgets
    And I add 1 widget

  Scenario: Add a single widget
    When I add 1 widget
    Then I have 2 widgets total

  @critical
  Scenario: Add several widgets
    When I add 3 widgets
    Then I have 4 widgets total
    And I have a new widget
