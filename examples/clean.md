# Reader catalog

Every table below satisfies `examples/table-policy.json`.

| Name       | Status | Separator | Notes                                |
| :--------- | :----: | --------: | :----------------------------------- |
| Csv Reader | stable | `,`       | Splits on commas                     |
| Tsv Reader | beta   | `\t`      | Splits on tabs                       |
| Bar Reader | stable | `\|`      | A pipe escaped inside a code span    |
| Pair Feed  | beta   | a \| b    | An escaped pipe in ordinary cell text |

A table may leave off the outer pipes, as long as every row agrees.

Name | Status | Notes
---- | :----: | -----------------------------------
Grid | stable | Compact style without outer pipes
Mesh | beta   | Also fine, because every row matches

Text inside a fenced code block is never read as a table:

```markdown
| not | a | table |
| --- |
```
