# EEI Control — Zaraz handoff build

This build moves public injection away from wildcard Worker routes.

Deploy this Worker, then use:

- Admin: https://eei.desarrollo-tecnologico.workers.dev/eei-admin
- Public config: https://eei.desarrollo-tecnologico.workers.dev/__eei/public-config
- Zaraz loader: https://eei.desarrollo-tecnologico.workers.dev/__eei/zaraz-loader.js?v=2026-07-01-v22-zaraz

Important: remove broad Worker routes from casitaapps.com and casitaiedis.edu.mx. Zaraz becomes the public injection layer.

Proxy injection is disabled by default (`EEI_PROXY_INJECTION = "0"`). Public injection must come from Zaraz.
