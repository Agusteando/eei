EEI Control Worker v23

Restores the Worker-based gateway after the Zaraz/static handoff experiment.

This build is intentionally Worker-first:
- Broad Worker routes can inject EEI/ISV into HTML pages again.
- No Zaraz loader is required.
- No `EEI_PROXY_INJECTION` flag is required.
- `/eei-admin` and `/eei-admin.html` both serve the admin.
- The v21 admin fixes are preserved: reliable config load, correct save dirty state, explicit maintenance actions, diagnostics, admin key check, host summaries, and non-stub preview feedback.
- Birthday, Signia planteles, Mundial, ISV rules, maintenance, winter, New Year, ball physics, ambassadors, and blocked hosts remain Worker/KV-backed.

Deploy, then open:
/eei-admin?v=2026-07-02-v23-worker

For the paid Workers plan, keep the broad Worker routes only where you want automatic injection.
