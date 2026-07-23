Feature: Create product

  @TEST_APEX-5
  Scenario Outline: User should be able to create a product with the following specifications: (<productName>, <productTemplate>, <quantity>)
    Given I am on the product page
    When I create a product "<productName>" from template "<productTemplate>" with quantity "<quantity>"
    Then the product "<productName>" is listed

    Examples:
      | productName | productTemplate | quantity |
      | Widget      | basic           |       10 |
      | Gadget      | premium         |        5 |


  Scenario Outline: User should be able to create a product with the following specifications: (<productName>, <productTemplate>, <quantity>)
    Given I am on the product page
    When I create a product "<productName>" from template "<productTemplate>" with quantity "<quantity>"
    Then the product "<productName>" is listed

    Examples:
      | productName | productTemplate | quantity |
      | Cassette    | casseteTemplate |       10 |
      | SSD         | ssdTemplate     |        5 |