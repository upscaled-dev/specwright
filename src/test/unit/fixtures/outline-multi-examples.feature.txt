@outline
Feature: Widget arithmetic via Scenario Outline

  @outlineTag
  Scenario Outline: Adding widgets
    Given I have <start> widgets
    When I add <added> widgets
    Then I have <total> widgets total

    Examples: happy path
      | start | added | total |
      | 0     | 1     | 1     |
      | 1     | 2     | 3     |

    @critical
    Examples: edge cases
      | start | added | total |
      | 0     | 0     | 0     |
      | 10    | 5     | 15    |
      | 99    | 1     | 100   |
