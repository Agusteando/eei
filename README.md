# EEI

Enterprise Experience Injector.

This package includes the v4 mobile-first admin UI update.

## Admin behavior

Open:

```txt
/eei-admin.html?v=2026-07-01-v4
```

The admin loads `/__eei/config` automatically on startup. This means a reload shows the last saved KV config, not the static defaults bundled with the page.

The Admin key can be saved on the current device through `localStorage`. Use **Olvidar** on shared computers.

## Validation

```bash
node --check src/worker.js
node --check public/eei-engine.js
```
