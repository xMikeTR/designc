@tags
Feature: Tag sorting
  Background:
    Given a signed-in user

  Scenario: Sort tags by name
    Given 3 tags exist
    When the user sorts by name
    And clicks the header again
    Then the tags are in descending order
    But no tag is hidden

  Scenario Outline: Filter by <q>
    Given tags
    When filter <q>
    Then <n> shown
    Examples:
      | q | n |
      | a | 1 |

  Scenario: No steps
    Given only a given
