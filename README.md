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

## v5 unified route owner: EEI + ISV

This patch keeps ISV as a separate Pages-hosted campaign and makes the EEI Worker the single Cloudflare route owner.

- EEI continues to inject `/__eei/engine.js`.
- EEI also injects `https://isv-ev2.pages.dev/isv-banner.js`.
- ISV code is not merged into EEI. EEI only adds the external ISV script tag.
- `casitaiedis.edu.mx` and `www.casitaiedis.edu.mx` are excluded by default as a safety guard.
- Header `X-ISV-Gateway-Injected: 1` is set when the ISV script is injected.

Migration rule: move routes from the old ISV Worker to the EEI Worker one by one after testing. Do not delete ISV Pages.
