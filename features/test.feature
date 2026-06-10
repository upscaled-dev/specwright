@feature @test
Feature: Sample feature

  @smoke @passing
  Scenario: Passing scenario
    Given I am on the test page
    When I click the test button
    Then I should see the test result

  @smoke @outline
  Scenario Outline: Test scenario outline
    Given I have a "<input>" value
    When I process the input
    Then I should get "<expected>" result

    Examples:
      | input | expected |
      | hello | world    |
      | test  | pass     |
