# Commit sugerido

```bash
git add .
git commit -m "Refina debug de APIs y anuncios EEI"
git push
```

Validar después de deploy:

- Abrir `/eei-admin.html?v=2026-07-01-v8`.
- Usar Debug APIs → Ver API cumpleaños.
- Usar Debug APIs → Ver API Mundial.
- Confirmar que las respuestas muestran `payload`, status HTTP y endpoint.
- Confirmar que Año Nuevo no muestra toast.
- Confirmar que cumpleaños muestra anuncios individuales.
```
