@api
Feature: API health

  Scenario: Health check returns ok
    Given the API is running
    When I request the health endpoint
    Then I receive a 200 response
