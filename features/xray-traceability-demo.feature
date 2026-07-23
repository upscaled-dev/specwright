Feature: Xray traceability demo
  Exercises the Xray Traceability panel: a requirement-tagged scenario,
  untraced scenarios, and an outline with a split Examples block.

  @REQ_DEMO-900
  Scenario: Mapped scenario with requirement coverage
    Given I am on the test page
    When I click the test button
    Then I should see the test result

  Scenario: Untraced scenario appears in the gap bucket
    Given I am on the test page
    When I click the test button
    Then I should see the test result

  Scenario Outline: One Xray test for the whole outline
    Given I have a "<input>" value
    When I process the input
    Then I should get "<output>" result

    Examples:
      | input | output |
      | alpha | alpha  |
      | beta  | beta   |

    Examples: edge cases split into their own test
      | input | output |
      | empty | empty  |
