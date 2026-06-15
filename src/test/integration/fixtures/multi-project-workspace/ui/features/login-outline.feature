@ui
Feature: UI login outline

  Scenario Outline: Login as <role> with <plan> plan
    Given I am on the login page
    When I sign in as "<role>"
    Then I land on the "<plan>" dashboard

    Examples:
      | role  | plan |
      | admin | pro  |
      | user  | free |
