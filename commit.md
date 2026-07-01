# EEI Admin Mobile Minimal v4

Changes:
- Rebuilt `eei-admin.html` as a mobile-first minimal control panel.
- Admin now auto-loads `/__eei/config` on page open, so reload shows the last saved KV config instead of defaults.
- Added local device storage for the Admin key using `localStorage`, with explicit "Guardar llave" and "Olvidar" controls.
- Renamed confusing labels: `Save KV` -> `Guardar cambios`, `Load KV` -> `Cargar actual`, `Admin token` -> `Admin key`.
- Simplified controls into: Admin access, EEI global, modules, safe preview, quick settings, hidden JSON avanzado.
- Preview birthday now uses a temporary mock record only inside admin preview and does not modify production config.
- Bumped cache-buster to `2026-07-01-v4`, config version to `4`, and engine version to `0.4.0`.

Validation:
- `node --check src/worker.js`
- `node --check public/eei-engine.js`
- Extracted admin module script and validated syntax with `node --check`.

Deployment check:
1. Push all files to `Agusteando/eei`.
2. Confirm Cloudflare deploys the active Worker.
3. Open `/eei-admin.html?v=2026-07-01-v4`.
4. The admin should immediately show "Config cargada" and display current saved KV settings.
5. Routed pages should request `/__eei/engine.js?v=2026-07-01-v4&autostart=1&config=...`.
