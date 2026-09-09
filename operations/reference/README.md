# Reviewed local source snapshots

These are selected actual files from the operator's canonical Stanley workspace, captured on 2026-09-09. The [manifest](../source-manifest.json) records exact source hashes and LF-normalized hashes. Source logic is unchanged.

**This directory is for code review.** It is not a second live workspace. Files retain operator-specific paths, authorized-owner constants, calendar/signature recognition markers, historical corpus hashes, and the production bridge origin. These are implementation details, not transferable credentials or execution authorization. Do not execute write-capable helpers against the operator's live state from this copy.

| Source | Role |
|---|---|
| `browser-automation-lock.ps1` | Cross-workflow Chrome lease |
| `linkedin-cadence-lock.ps1` | Single LinkedIn coordinator lock |
| `linkedin_followup_state_fast.py` | Bounded state queries, provenance/eligibility gates, counters, atomic checkpoint mutations |
| `tools/outlook_cadence_state_fast.py` | Read-only bounded cadence queries |
| `tools/outlook_initial_render_guard.py` | Initial copy order/count validation |
| `tools/outlook_reply_render_guard.py` | Current follow-up-1 rendering and quote checks |
| `tools/mmtt_state_fast.py` | Bounded MMTT batch queries |
| `tools/run_tam_single_record.py` | Explicit-ID claim, complete reader/validator passes, publish/readback |
| `tools/tam_record_core.py` | Evidence validation, prompts, model invocation, provenance |
| `tools/stage_tam_final_grades.py` | Deterministic final staging and conflicts |
| `tools/tam_v9_*_schema.json` | Structured reader, independent validator, and oversized-chunk outputs |
| `tests/` | Existing synthetic render-guard regression tests |

The TAM runner additionally requires private mission/live-state files, explicitly enabled automation control, exact membership, verified PDFs and record text, a configured Codex executable/certificate bundle, and existing bridge access. It deliberately fails closed when these are absent or inconsistent.

Signature strings in the render guards are recognition markers; the helpers do not append a signature or send mail. Adaptation for a different operator must preserve the automatic-signature and exact-thread gates rather than reuse these markers blindly.

For offline render tests only, from this directory in an isolated Python environment with pytest:

```bash
python -m pytest tests
```

Do not run the TAM/LinkedIn write commands merely to explore the repository. Read the functions and use synthetic fixtures. None of these snapshots is imported by the Next.js application; `.vercelignore` excludes this directory from hosted deployment.
