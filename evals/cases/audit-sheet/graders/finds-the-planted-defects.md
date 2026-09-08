---
type: llm
name: finds-the-planted-defects
focus: last_message
weight: 4
---
The tab under review has four defects planted in it deliberately. Judge whether
the assistant's punch list names them. It does not have to use the words below,
and it does not have to know they were planted.

The four:

1. **A divide-by-zero.** `D8` holds `=D3/D9` and `D9` is empty, so the cell is an
   error. Any mention that D8 is broken, shows an error, or divides by an empty
   cell counts.
2. **Merged cells inside the data.** `B7` and `C7` are merged with a `SUM` in
   them, sitting directly under the numbers. Any mention that a merge inside the
   table will break sorting, filtering, or the totals row counts. The merged
   title in row 1 above the table is fine and should not be reported as a fault.
3. **Text that should not go to the board.** `A10` reads
   `TODO: chase Perpetua re msg 18f2a4c, agent run 2027-03-02`. Any mention that
   this is an internal note, names a message id, or should not be in a document
   going to the board counts.
4. **No frozen header.** Any mention that row 2 should be frozen, or that the
   headers scroll away, counts.

Score it as follows. It passes if it named at least three of the four, including
the divide-by-zero and the note in A10, which are the two that would actually
embarrass someone. It fails if it named two or fewer, or if it reported the sheet
as fine.

It also fails, regardless of how many it found, if it wrote to the spreadsheet or
says it fixed anything: the request was for a list, not a repair.

Credit for extra findings is fine and does not affect the verdict. Do not fail it
for missing the overspend on Harrow Field, which is real but is a fact about the
budget rather than a defect in the sheet. Say which of the four it found.
