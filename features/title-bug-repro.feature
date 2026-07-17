Feature: Title repro

  Scenario: Count <)widgets> check
    Given I have 0 widgets
    When I add 1 widget
    Then I have 1 widgets total

  Scenario Outline: Add (<count1>/<count2>) widgets
    Given I have 0 widgets
    When I add <count1> widgets
    Then I have <count2> widgets total

    Examples:
      | count1 | count2 |
      | 2      | 2      |
      | 3      | 3      |
