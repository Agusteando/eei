# EEI Mundial UX / Physics v3

Changes:
- Bumped EEI runtime/config version to `3` and asset cache-buster to `2026-07-01-v3`.
- Replaced the Mundial card with a tiny non-invasive flag-only pin.
- Added a close button; hiding the pin persists for the current day through `localStorage`.
- Mundial pin renders nothing when there are no matches.
- Added real ball behavior: gravity, drag, wall bounces, ball-to-ball collision response, spin damping, finite lifetime, and auto-exit cleanup.
- Added easter egg: click/tap a ball to kick it strongly out of the screen. It is removed and does not respawn.
- Updated Worker config normalization so older KV config is migrated to the v3 Mundial defaults.
- Added `homeTla`/`awayTla` fields from the Football-Data payload so flags are more reliable.

Validation:
- `node --check public/eei-engine.js`
- `node --check src/worker.js`

Deployment check:
1. Push all files to `Agusteando/eei`.
2. Confirm Cloudflare deploys the active Worker.
3. Open `/eei-admin.html?v=2026-07-01-v3`.
4. Confirm routed pages request `/__eei/engine.js?v=2026-07-01-v3`.
5. Open `/__eei/config`; it should report `version: 3` after normalization.
