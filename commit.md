# EEI cache bust + runtime version update

Changes:
- Bumped EEI runtime config version to 2.
- Bumped engine version to 0.2.0.
- Added asset cache-buster `2026-07-01-v2` to the injected `/__eei/engine.js` module URL.
- Updated admin import to load `eei-engine.js?v=2026-07-01-v2`.
- Set `/__eei/engine.js` Cache-Control to `no-cache` when served through the Worker.
- Adjusted admin static birthday metric from 1 to 0.

Why:
The previous deploy changed code, but the browser could keep using the old module URL because it was served as an immutable asset. This patch forces a fresh engine load after deployment.

Deploy:
1. Copy these files over the repo.
2. Commit and push to `main`.
3. Confirm Cloudflare created a new Worker deployment.
4. Hard refresh `/eei-admin.html` or open with `?v=2026-07-01-v2`.
5. Confirm routed pages request `/__eei/engine.js?v=2026-07-01-v2` in DevTools Network.
