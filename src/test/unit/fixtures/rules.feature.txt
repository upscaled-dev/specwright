@rules
Feature: Widget operations grouped by Rule

  Background:
    Given I have 0 widgets

  Rule: Adding widgets

    Background:
      Given I add 1 widget

    Scenario: Add one more widget
      When I add 1 widget
      Then I have 2 widgets total

    Scenario: Add multiple widgets
      When I add 2 widgets
      Then I have 3 widgets total

  Rule: Removing widgets

    Scenario: Remove a widget
      When I remove 0 widgets
      Then I have 0 widgets total
