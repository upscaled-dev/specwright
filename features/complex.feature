@kitchen @sink
Feature: Kitchen-sink widget management

  Background:
    Given I have 0 widgets

  Rule: Adding widgets

    Background:
      Given I add 1 widget

    @rule-scoped
    Scenario: Add one widget under the rule
      When I add 1 widget
      Then I have 2 widgets total

    Scenario: Add three widgets under the rule
      When I add 3 widgets
      Then I have 4 widgets total

  @outlineTag
  Scenario Outline: Feature-level outline for totals
    Given I have <start> widgets
    When I add <added> widgets
    Then I have <total> widgets total

    @critical
    Examples: tagged totals
      | start | added | total |
      |     0 |     1 |     1 |
      |     2 |     2 |     4 |
