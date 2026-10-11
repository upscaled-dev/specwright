Feature: Retry outline state

  Scenario Outline: Native retry state <row>
    Given native retry row "<row>" completes

    Examples:
      | row    |
      | first  |
      | second |
      | third  |
