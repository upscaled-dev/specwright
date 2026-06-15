@ui
Feature: UI login

  Scenario: User logs in successfully
    Given I am on the login page
    When I submit valid credentials
    Then I see the dashboard
