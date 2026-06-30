# Enterprise Experience Injector

EEI is a Cloudflare Worker injected WebGL overlay for internal PHP, Vue, and Nuxt SPAs. The Worker reads `EEI_CONFIG` from KV, injects `public/eei-engine.js` before `</body>`, and serves an admin console at `public/eei-admin.html`.

## Files

- `src/worker.js` - Worker proxy, KV config API, HTMLRewriter injection, Signia birthday proxy, mock World Cup match API.
- `public/eei-engine.js` - Vanilla JS + Three.js overlay engine with SPA-safe lifecycle and disposal.
- `public/eei-admin.html` - Command Center with live visual verification sandbox.
- `public/assets/ambassadors` - Curated Ambassador mappings.
- `public/assets/textures` - Generated WebGL textures for Trionda-style balls, balloons, snow, fireworks, and confetti.

## Local Run

```bash
npm install
npm run preview
```

Open `http://127.0.0.1:4173/eei-admin.html` for the admin sandbox.

For Worker behavior:

```bash
npm run dev
```

Then open the Wrangler URL and visit `/eei-admin.html`.

## KV Shape

The Worker reads and writes one JSON value at key `config` in the `EEI_CONFIG` KV namespace. Use the admin panel's advanced drawer to load/save it, or call:

```bash
curl -H "Authorization: Bearer $EEI_ADMIN_TOKEN" https://your-worker.example.com/__eei/config
```

## Deployment Notes

1. Create a KV namespace and replace the IDs in `wrangler.toml`.
2. Set `EEI_ADMIN_TOKEN` with `wrangler secret put EEI_ADMIN_TOKEN`.
3. Route the Worker in front of the internal app host. If the Worker is not bound directly to the origin route, set `UPSTREAM_ORIGIN` to the origin base URL.
4. Confirm the target apps allow the injected module and `/__eei/*` assets through CSP.

The WebGL canvas is always `pointer-events: none`, fixed to the viewport, and placed at `z-index: 2147483647`.
