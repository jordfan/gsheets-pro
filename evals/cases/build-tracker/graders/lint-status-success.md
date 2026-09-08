---
type: regex
name: lint-status-success
target: trace
pattern: '"status"\s*:\s*"success"'
match: contains
weight: 2
arm: with-only
---
