Feature: Xray traceability demo
  Exercises the Xray Traceability panel: mapped scenarios, an untraced scenario,
  outline-level mapping, and an Examples-block split.

  @TEST_DEMO-101 @REQ_DEMO-900
  Scenario: Mapped scenario with requirement coverage
    Given I am on the test page
    When I click the test button
    Then I should see the test result

  Scenario: Untraced scenario appears in the gap bucket
    Given I am on the test page
    When I click the test button
    Then I should see the test result

  @TEST_DEMO-102
  Scenario Outline: One Xray test for the whole outline
    Given I have a "<input>" value
    When I process the input
    Then I should get "<output>" result

    Examples:
      | input | output |
      | alpha | alpha  |
      | beta  | beta   |

    @TEST_DEMO-103
    Examples: edge cases split into their own test
      | input | output |
      | empty | empty  |
