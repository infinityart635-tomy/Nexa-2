# NEXA POS

Esta version queda preparada para correr localmente con archivos o en Railway usando PostgreSQL.

## Modos de persistencia

- Sin `DATABASE_URL`: sigue usando `data/db.json`, `data/menu.json` y `data/images/`.
- Con `DATABASE_URL`: guarda el documento principal y los archivos subidos dentro de PostgreSQL.

## Migrar tu estado actual a Railway PostgreSQL

1. Creá la base PostgreSQL en Railway.
2. Configurá `DATABASE_URL` en tu entorno local o en `.env`.
3. Ejecutá:

```bash
npm install
npm run migrate:postgres
```

Si querés forzar una resubida completa de `data/`:

```bash
npm run migrate:postgres -- --overwrite
```

## Deploy en Railway

1. Subí este proyecto a GitHub.
2. En Railway, creá un servicio desde ese repo.
3. Agregá la variable `DATABASE_URL` del PostgreSQL de Railway.
4. Railway va a usar `npm start`.

## Importante para produccion

- Ejecutá una sola replica. La app mantiene estado en memoria y usa WebSockets; varias replicas pueden pisarse entre si.
- No subas `data/`, `.env` ni `node_modules/` al repo.
- Si ya migraste los datos a PostgreSQL, el deploy no necesita los archivos locales.
