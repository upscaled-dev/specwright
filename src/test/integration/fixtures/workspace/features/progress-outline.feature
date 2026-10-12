Feature: Native run progress

  Scenario Outline: Pay by card
    Given native progress row "<method>" completes

    Examples:
      | method |
      | card   |

  Scenario Outline: Pay by cash
    Given native progress row "<method>" completes

    Examples:
      | method |
      | cash   |

  Scenario Outline: Native progress <row>
    Given native progress row "<row>" completes

    Examples:
      | row   |
      | clean |
      | retry |
