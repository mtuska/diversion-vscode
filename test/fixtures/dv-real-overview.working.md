# Sample Overview

This file is a synthetic fixture for the unified-diff reverse-apply
regression test. It does not contain real project content — the original
captures from a private repo were redacted from history.

## Sections

The file has enough structure to exercise the parser:

- A markdown heading
- A bullet list above the table
- A wide markdown table
- A second prose paragraph below the table
- A horizontal-rule line at the end

## Sample table

The hunk under test edits two rows in this table and inserts a
multi-line paragraph below it. The reverse-apply must reconstruct the
pre-edit version exactly.

| Item | Owner | Status | Notes |
|---|---|---|---|
| **Alpha** | sampler-a | TBD (likely Q4 2026 / Q1 2027) | Item alpha — *deferred*; placeholder text in lieu of real content. |
| **Bravo** | sampler-a | Q2 2026 | Item bravo — second row, untouched by the test diff. |
| **Charlie** | sampler-b | Q2 2026 | Item charlie — third row, untouched by the test diff. |
| **Delta** | sampler-b | Q2 2026 | Item delta — fourth row, untouched by the test diff. |
| **Echo** | sampler-a | TBD | Item echo — fifth row, untouched. |
| **Foxtrot** | TBD | TBD | Item foxtrot — sixth row, untouched. |
| **Interactive Sample item** | sampler-a | Q2 2026 (starting late Q2, into Q3) | Replacement row exercising multi-word edits. |
| **Hotel** | TBD | TBD | Item hotel — eighth row, untouched. |
| **India** | TBD | TBD | Item india — ninth row, untouched. |
| **Juliet** | TBD | TBD | Item juliet — tenth row, untouched. |
| **Kilo** | TBD | TBD | Item kilo — eleventh row, untouched. |
| **Lima** | TBD | TBD | Item lima — twelfth row, untouched. |

Specs for the planned items live in [refs/](../refs/) once written. Active-quarter
design coverage per workstream — what each item is actually exercising right now
versus what's still scoped — lives in the current quarterly plan ([sample.md](sample.md)),
not here.

---

