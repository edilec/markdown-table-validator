# Broken tables

Rows that do not have the declared number of cells:

| Name       | Status | Notes             |
| :--------- | :----: | :---------------- |
| Csv Reader | stable | Correct row       |
| Tsv Reader | beta   | Extra cell | oops |
| Bad Reader | shaky  |
| Csv Reader | stable | Duplicate name    |
| lowercase  |        | Status is empty   |

An unescaped pipe inside a code span:

| Name      | Status | Separator |
| :-------- | :----: | :-------- |
| Pipe Feed | stable | `a|b`     |

A delimiter row that is not a delimiter row:

| Name | Status |
| ---- | -x-    |
| Grid | stable |

A header the delimiter row does not match:

| Name | Status | Notes |
| ---- | ------ |

A required column missing, a duplicated heading and an empty heading:

| Name | Name |     |
| ---- | ---- | --- |
| Grid | Grid | ... |

Rows that do not use the same outer pipes as the header:

| Name | Status |
| ---- | :----: |
| Grid | stable |
Mesh | beta
