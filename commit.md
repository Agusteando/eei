# Commit: unify EEI gateway with ISV injection

Purpose: make the EEI Worker the single route owner for domains that need both EEI and ISV.

Changes:
- Bump EEI asset cache key to `2026-07-01-v5`.
- Bump engine version to `0.5.0`.
- Bump default runtime config to version `5`.
- Add `campaigns.isv` config block.
- Inject `https://isv-ev2.pages.dev/isv-banner.js` from the EEI Worker.
- Add root-domain safety exclusions for `casitaiedis.edu.mx` and `www.casitaiedis.edu.mx`.
- Add `X-ISV-Gateway-Injected: 1` response header when ISV is injected.
- Add ISV toggle and script URL to the mobile admin UI.

No full codebase merge: ISV remains hosted by ISV Pages; EEI only loads its script.
