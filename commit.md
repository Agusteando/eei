fix: add birthday plantel subscriptions without Signia fallback

- keep Signia upstream on /api/export/employees/today-birthdays
- do not call heavy /api/export/employees fallback from EEI
- normalize Signia birthday records with colaborador and plantel metadata
- filter birthday effects by subscribed planteles
- add user-facing ambassador prompt and plantel selection modal
- store birthday plantel preference in localStorage and parent-domain cookie
- bump EEI to v12 / engine 0.12.0
