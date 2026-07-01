# EEI v8 — debug APIs y anuncios limpios

Cambios principales:

- El Worker sigue usando `football-data.org` con competencia `WC` para FIFA World Cup.
- Corrige el rango de fecha de Mundial: `dateTo` se manda como el día siguiente porque Football-Data excluye `dateTo`.
- Agrega debug visual en el admin para ver la respuesta real de `/__eei/signia-birthdays` y `/__eei/worldcup-matches`.
- Quita toasts genéricos de Navidad/Año Nuevo. Los fuegos artificiales simplemente aparecen y terminan.
- Cumpleaños ahora anuncia a cada persona una por una, con su nombre.
- El filtro de cumpleaños ya no trata entradas sin fecha o fecha inválida como cumpleaños.

Versión: `2026-07-01-v8` / engine `0.8.0`.
