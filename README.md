EEI Control v21

Fixes the broken admin state contract from v20.

Highlights:
- The admin no longer becomes editable when /__eei/config fails to load.
- Save state is derived from real loaded config + dirty state; disabled buttons now have a reason.
- Maintenance presets prepare a draft; activation explicitly saves.
- Preview/Vista now produces visible feedback and scrolls to the preview card.
- Integration checks use configured endpoints and diagnose Cloudflare 1027, missing tokens, provider statuses, and HTTP errors.
- Raw JSON actions stay disabled until a response exists.
- Reload warns before discarding unsaved changes.
- Key saving validates against a new /__eei/admin-check endpoint.
- Hosts now summarize global blocked hosts and ISV host rules.
- World Cup debug no longer sends dateTo unless explicitly requested.

Deploy, then open /eei-admin.html?v=2026-07-01-v21.
