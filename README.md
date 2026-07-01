EEI unified configurable gateway v6

- Removes hardcoded ISV hostname exclusions.
- Adds configurable ISV include/exclude host lists in admin UI.
- Empty include list means ISV applies to every hostname routed to eei.
- Supports exact hosts and wildcard patterns such as *.casitaapps.com.
- Bumps engine/cache to 2026-07-01-v6 / 0.6.0 / config version 6.

Deployment target remains Worker name: eei.
