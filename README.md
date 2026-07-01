# EEI v12 — Signia birthdays + plantel subscriptions

Base: EEI v10, not EEI v11 fallback.

Changes:

- EEI continues to call only the Signia birthday endpoint:
  - `/__eei/signia-birthdays`
  - upstream default: `https://signia.casitaapps.com/api/export/employees/today-birthdays`
- Removed the heavy `/api/export/employees` fallback path from this EEI package.
- Normalizes the Signia v12 response fields:
  - `displayName`
  - `colaborador`
  - `plantel`
  - `plantelFisico`
  - `fechaNacimiento`
  - `cumpleanos`
- Birthday notifications are filtered by plantel subscription before effects/announcements run.
- Added a bottom-corner ambassador prompt for birthday plantel preferences.
- Modal lets users choose planteles.
- Default behavior remains all planteles subscribed.
- Preferences are stored in localStorage for the current origin and mirrored to a parent-domain cookie for cross-subdomain behavior under:
  - `.casitaapps.com`
  - `.casitaiedis.edu.mx`

Note: browser localStorage is origin-scoped and cannot be shared across subdomains by itself. The domain cookie mirror is what makes the setting follow subdomains under the same parent domain.

Version:

- EEI engine: 0.12.0
- Config version: 12
- Cache key: 2026-07-01-v12
