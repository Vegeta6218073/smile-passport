# 0002: AI data handling (draft)

Status: open. Decision needed before Phase 2 starts (Jan 25). Confirm legal points with counsel.

## Requirements for any model provider
- Contract terms: no training on clinic data, stated retention, data location, sub-processor list, security terms.
- Fit with the DPDP Act: confirm with counsel.

## Design rules (from the roadmap)
- Identifier minimisation: remove or replace names, phone numbers and addresses before a prompt leaves our system. Send only the fields a task needs.
- Per-clinic isolation: one clinic's data is never used in another clinic's prompts, retrieval or tests.
- Every AI action is recorded in `ai_actions` (written by the server only).
- Humans approve anything patient-facing or clinical.

## To fill in
- Provider shortlist:
- Data-flow diagram:
- Launch languages:
- Decision and date:
