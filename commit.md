EEI Zaraz handoff build

- Adds /eei-admin alias for the requested workers.dev admin URL.
- Adds /__eei/public-config with absolute runtime endpoints.
- Adds /__eei/zaraz-loader.js for Cloudflare Zaraz script injection.
- Stops engine autostart from falling back to default config on config-load failure.
- Sets EEI_PUBLIC_BASE_URL to https://eei.desarrollo-tecnologico.workers.dev.
- Updates cache/version to 2026-07-01-v22-zaraz / engine 0.22.0.
- Disables legacy proxy injection by default unless `EEI_PROXY_INJECTION=1` is explicitly set.
