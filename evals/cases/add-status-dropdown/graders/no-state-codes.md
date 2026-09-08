---
type: regex
name: no-state-codes
target: trace
pattern: '"(TODO|WIP|IN_PROGRESS|PENDING|BLOCKED|DONE|N/A|OPEN|CLOSED|P[0-3])"'
flags: i
match: not_contains
weight: 2
---
