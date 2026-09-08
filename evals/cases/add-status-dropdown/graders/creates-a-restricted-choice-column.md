---
type: regex
name: creates-a-restricted-choice-column
target: trace
pattern: '"(DROPDOWN|ONE_OF_LIST)"'
match: contains
weight: 2
arm: with-only
---
