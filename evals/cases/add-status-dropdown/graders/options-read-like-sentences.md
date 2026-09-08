---
type: llm
name: options-read-like-sentences
focus: trace
weight: 3
---
Find the status choices the assistant put in the dropdown it created. They will
appear in the arguments of a tool call, as a list of option strings.

The choices pass if a Saturday volunteer who had never seen this sheet could read
any one of them in a cell and know what it means about that repair. All of these
must hold.

1. Each option is ordinary English. A phrase or a short sentence, not an
   abbreviation, not a code, not SCREAMING_SNAKE_CASE, not a bare adjective that
   only means something inside a workflow someone explained to you.
2. The options are distinguishable from each other by reading them. Two options
   that a reasonable person could not tell apart is a failure.
3. They cover the five rows in the request without forcing any of them into an
   option that does not fit. Note that one item is waiting on its owner, which is
   a different state from waiting on a part.
4. They say where the repair is, and do not silently mix in a second dimension
   like urgency, priority, or who is at fault.

Fail it if the options are things like "Open", "WIP", "Blocked", "Done", or if a
volunteer would have to be told what one of them means. Do not fail it over the
number of options, over ordering, or because you would have phrased one
differently. Quote the options you found and say which of the four failed.
