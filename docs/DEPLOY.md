# Guía de deploy — Sillas masajeadoras

VPS en DonWeb + CapRover + GitHub Actions + imágenes en GitHub Container Registry (GHCR).
Dos ambientes: **producción** y **beta**. El ambiente lo decide el **nombre del tag**.

> Reemplazá `relaja.com.ar` por tu dominio real en toda la guía.

## 1. Cómo funciona

```
git tag vX.Y.Z[-beta.N] → GitHub Actions
   ├─ meta   : deduce el ambiente del tag (y exige que producción esté en main)
   ├─ test   : tsc + tests de backend y frontend
   └─ deploy : build de 2 imágenes → push a GHCR → CapRover las despliega → smoke test
```

| Tag | Ambiente | Ejemplo | Condición |
|---|---|---|---|
| `vX.Y.Z` | **producción** | `v1.0.0` | el commit debe estar en `main` |
| `vX.Y.Z-beta.N` | **beta** | `v1.1.0-beta.2` | cualquier rama |

Cualquier otro tag no dispara nada.

Piezas en CapRover (por ambiente):

| App CapRover | Producción | Beta | Puerto | Público |
|---|---|---|---|---|
| Frontend (Next.js + proxy `/api`) | `sillas-web-prod` | `beta` | 3003 | sí (`relaja.com.ar` / `beta.relaja.com.ar`) |
| Backend (Nest.js) | `sillas-back-prod` | `sillas-back-beta` | 3002 | **no** (solo red interna) |
| PostgreSQL | `sillas-db-prod` | `sillas-db-beta` | 5432 | **no** |

Un solo dominio público por ambiente: el navegador **y** el webhook de Mercado Pago entran
por el frontend, que reenvía `/api/*` al backend por la red interna
(`http://srv-captain--sillas-back-prod:3002`).

**Importante — Cloudflare es obligatorio.** El rate limit por IP solo confía en el header
`cf-connecting-ip` (ver `frontend/src/lib/resolver-ip-cliente.ts`). Si el dominio no pasa
por Cloudflare con el proxy activado (nube naranja), todos los clientes parecen la misma IP.
Turnstile también es de Cloudflare.

---

## 2. Setup inicial (una sola vez)

### 2.1 VPS en DonWeb

1. Contratar VPS con **Ubuntu 22.04 o 24.04**, mínimo **2 vCPU / 4 GB RAM / 40 GB** (corren 2 ambientes + 2 Postgres).
2. Agregar **swap** de 2 GB (evita que un build o pico mate contenedores):
   ```bash
   fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
   echo '/swapfile none swap sw 0 0' >> /etc/fstab
   ```
3. Puertos entrantes abiertos (firewall del panel de DonWeb): **22, 80, 443 y 3000** (3000 solo hasta terminar la instalación; después cerralo).
   > `ufw` **no** filtra puertos publicados por Docker. Si querés restringir, usá el firewall del panel de DonWeb.
4. Anotá la **IP pública** del VPS.

### 2.2 Dominio y Cloudflare

1. Agregar `relaja.com.ar` a Cloudflare (plan Free alcanza) y apuntar los nameservers desde el registrador.
2. Registros DNS (todos hacia la IP del VPS):

   | Tipo | Nombre | Proxy |
   |---|---|---|
   | A | `@` (relaja.com.ar) | naranja (proxied) |
   | A | `beta` | naranja |
   | A | `captain` | gris (DNS only) — panel de CapRover |
   | A | `*` | gris (DNS only) — CapRover exige wildcard |

3. **SSL/TLS → Overview → modo `Full (strict)`** (después de emitir los certificados, ver 2.3).
4. Turnstile (Cloudflare → Turnstile): crear widget(s) para `relaja.com.ar` y `beta.relaja.com.ar`. Guardar **site key** y **secret key** de cada ambiente.

### 2.3 Instalar CapRover

Por SSH en el VPS:

```bash
docker run -p 80:80 -p 443:443 -p 3000:3000 -v /var/run/docker.sock:/var/run/docker.sock \
  -v /captain:/captain caprover/caprover
```
(Si Docker no está instalado: `curl -fsSL https://get.docker.com | sh`.)

Luego, desde tu máquina:

```bash
npm install -g caprover
caprover serversetup
```
Responder: IP del VPS, root domain **`relaja.com.ar`**, contraseña nueva, email para Let's Encrypt.
El panel queda en `https://captain.relaja.com.ar`.

Después, en el panel, pestaña **Dashboard** (la primera): sección *CapRover Root Domain Configurations* → **Enable HTTPS** (pide un email para Let's Encrypt) y, una vez activo, **Force HTTPS**. Recién ahora cerrá el puerto 3000 y dejá los registros `@` y `beta` en naranja.

### 2.4 Registry (GHCR) en CapRover

1. GitHub → Settings → Developer settings → Personal access tokens (classic) → scope **`read:packages`**. Copiar.
2. CapRover → **Cluster → Docker Registry Configuration → Add Remote Registry**: Domain `ghcr.io`, Username = tu usuario de GitHub, Password = el token. **No** lo marques como *Default Push Registry*: CapRover avisa que un registry solo hace falta en clusters y vuelve más lento el deploy propio, pero acá solo se usa para bajar imágenes.

Así CapRover puede bajar imágenes privadas. (Alternativa: poner los paquetes públicos; las imágenes no llevan secretos.)

### 2.5 PostgreSQL (una por ambiente)

CapRover → **Apps → One-Click Apps → PostgreSQL**. Nombre `sillas-db-prod`, versión 16, contraseña fuerte.
Repetir con `sillas-db-beta`. **No** publiques el puerto al host. Los datos quedan en un volumen persistente.

Crear la base en cada una (Web Terminal de la app o por SSH con `docker exec`):

```bash
psql -U postgres -c 'CREATE DATABASE sillas;'
```

Cadena de conexión (ejemplo prod):
`postgresql://postgres:LA_PASSWORD@srv-captain--sillas-db-prod:5432/sillas`

### 2.6 Crear las 4 apps

CapRover → Apps → Create New App (sin "Has Persistent Data"):
`sillas-back-prod`, `sillas-web-prod`, `sillas-back-beta` y `beta` (el frontend de beta se llama `beta` a propósito, ver abajo).

**Backend** (`sillas-back-*`), pestaña *HTTP Settings*:
- Container HTTP Port: `3002`.
- Marcar **Do not expose as web-app** (queda solo en la red interna).
- Instance Count: **1** (siempre; hay timers de sesión en memoria, no escalar).

**Frontend** (`sillas-web-*`), pestaña *HTTP Settings*:
- Container HTTP Port: `3003`.
- **Producción** (`sillas-web-prod`): *Connect New Domain* → `relaja.com.ar` → **Enable HTTPS** → **Force HTTPS**.
- **Beta** (`beta`): **no** se conecta un dominio propio. CapRover rechaza (error 1104) un custom domain que sea subdominio del root domain, así que la app se llama `beta` y su dominio por defecto ya es `beta.relaja.com.ar`. Solo hay que activar **Enable HTTPS** y **Force HTTPS** sobre ese dominio.
- Si Let's Encrypt falla con el proxy naranja: poné el registro en gris, emití el certificado, volvé a naranja.

**Ambas**, pestaña *Deployment*: **Enable App Token** y copiar el token (lo usa GitHub Actions). Son 4 tokens.

### 2.7 Variables de entorno de las apps

Generar secretos (uno distinto por ambiente): `openssl rand -hex 32`.

**Backend** (App Configs → Environment Variables):

| Variable | Valor |
|---|---|
| `DATABASE_URL` | `postgresql://postgres:PASS@srv-captain--sillas-db-ENV:5432/sillas` |
| `PORT` | `3002` |
| `PROXY_SHARED_SECRET` | secreto (**igual** al del frontend) |
| `JWT_SECRET` | secreto |
| `JWT_EXPIRES_IN` | `8h` |
| `IP_HASH_SECRET` | secreto |
| `FRONTEND_URL` | `https://relaja.com.ar` (beta: `https://beta.relaja.com.ar`) |
| `MP_ACCESS_TOKEN` | prod: credencial real · beta: credencial de **prueba** |
| `MP_WEBHOOK_SECRET` | clave secreta del webhook de esa app de Mercado Pago |
| `SHELLY_SERVER` / `SHELLY_AUTH_KEY` | ver advertencia abajo |
| `TURNSTILE_SECRET_KEY` | secret key del widget del ambiente |
| `MAX_PENDIENTES_POR_IP` | `3` |
| `CORS_ORIGINS` | opcional, ej. `https://relaja.com.ar` |
| `APAGAR_RELES_HUERFANOS` | prod: sin definir · beta: `false` si comparte cuenta Shelly con prod |

`NODE_ENV=production` ya viene en la imagen. **Nunca** definir `LOADTEST` ni `MP_WEBHOOK_ALLOW_UNSIGNED` (el arranque aborta en producción).

> **Beta y el hardware real:** un device Shelly pertenece a una sola cuenta. Si beta usa la misma cuenta/`SHELLY_AUTH_KEY` y una silla con el device real, **probar en beta enciende la silla real**. En beta cargá sillas con un `deviceIdShelly` de prueba (o un Shelly de escritorio) y credenciales de Mercado Pago de prueba.
>
> Peor todavía: con el device real cargado en beta, el backend de beta ve el relé encendido por una sesión de **producción** como "relé sin sesión" y lo **apaga a los ~60–75 s** (la sesión sigue EN_USO en el panel de prod). Lo mismo pasa con un backend local corriendo con la misma `SHELLY_AUTH_KEY`. Si beta tiene que ver el equipo real, definí `APAGAR_RELES_HUERFANOS=false` en `sillas-back-beta`.

**Frontend**:

| Variable | Valor |
|---|---|
| `BACKEND_INTERNAL_URL` | `http://srv-captain--sillas-back-ENV:3002` (prod: `sillas-back-prod`, beta: `sillas-back-beta`) |
| `PROXY_SHARED_SECRET` | el mismo del backend |
| `ADMIN_SESSION_MAX_AGE_SECONDS` | `28800` (coincide con `JWT_EXPIRES_IN=8h`) |

`NEXT_PUBLIC_TURNSTILE_SITE_KEY` **no** va acá: se incorpora en el build (viene de GitHub, ver 2.8).

### 2.8 GitHub

**Settings → Environments** → crear `beta` y `production`.

En **cada** environment:

| Tipo | Nombre | Valor |
|---|---|---|
| Variable | `CAPROVER_URL` | `https://captain.relaja.com.ar` |
| Variable | `CAPROVER_BACKEND_APP` | `sillas-back-prod` / `sillas-back-beta` |
| Variable | `CAPROVER_FRONTEND_APP` | `sillas-web-prod` / `beta` |
| Variable | `SITE_URL` | `https://relaja.com.ar` / `https://beta.relaja.com.ar` |
| Variable | `TURNSTILE_SITE_KEY` | site key del ambiente (es pública) |
| Secret | `CAPROVER_BACKEND_TOKEN` | app token del backend |
| Secret | `CAPROVER_FRONTEND_TOKEN` | app token del frontend |

Recomendado:
- En `production` → **Required reviewers** (vos): el deploy espera tu aprobación.
- **Settings → Branches**: proteger `main` (PR obligatorio).
- **Settings → Tags → Rulesets**: restringir quién puede crear tags `v*`.

### 2.9 Mercado Pago

En cada aplicación de Mercado Pago (real para prod, de prueba para beta) → Webhooks → URL:
`https://relaja.com.ar/api/webhooks/mercadopago` (beta: `https://beta.relaja.com.ar/api/webhooks/mercadopago`), evento *Pagos*. La clave secreta que te da va en `MP_WEBHOOK_SECRET`.

### 2.10 Primer deploy

**Siempre empezar por beta.**

```bash
git checkout main && git pull
git tag v0.1.0-beta.1
git push origin v0.1.0-beta.1
```

1. GitHub → Actions → seguir el run *Deploy*. Deben pasar `meta`, `test`, `deploy`.
2. CapRover → `sillas-back-beta` → *App Logs*: debe verse `prisma migrate deploy` aplicando todas las migraciones y `Backend escuchando en puerto 3002`.
3. Crear el admin y la silla inicial (Web Terminal de `sillas-back-beta`):
   ```bash
   ADMIN_EMAIL=vos@relaja.com.ar ADMIN_PASSWORD='una-password-larga' node dist/prisma/seed.js
   ```
   (Crea también una "Silla 1" de ejemplo con `deviceIdShelly=CAMBIAR_DEVICE_ID`; editala desde el panel.)
4. Entrar a `https://beta.relaja.com.ar/admin`, loguearte y editar la silla.
5. Probar el flujo completo con Mercado Pago de prueba: QR → pago → confirmar → timer → corte.

Cuando beta está OK:

```bash
git tag v1.0.0          # el commit tiene que estar en main
git push origin v1.0.0
```
Aprobar el deploy en GitHub (si activaste reviewers) y repetir los pasos 2–4 en `sillas-back-prod`. En prod, cargá la silla con el `deviceIdShelly` real y usá el botón de verificar del formulario.

---

## 3. Deploys futuros (rutina)

1. Trabajás en una rama → PR → merge a `main`.
2. **Beta**: `git tag v1.1.0-beta.1 && git push origin v1.1.0-beta.1` (podés taggear desde la rama del PR antes de mergear). Si hay que corregir: `-beta.2`, `-beta.3`…
3. Validar en `https://beta.relaja.com.ar`.
4. Mergear a `main` y taggear producción:
   ```bash
   git checkout main && git pull
   git tag v1.1.0 && git push origin v1.1.0
   ```
5. Aprobar el deploy (si hay reviewers) y mirar el smoke test.

Versionado: `MAJOR.MINOR.PATCH` (fix → PATCH, funcionalidad → MINOR, cambio incompatible → MAJOR).
Los tags no se reutilizan ni se mueven: si un tag salió mal, se crea el siguiente.

### Migraciones de base

- Corren solas al arrancar el backend (`prisma migrate deploy`). Si una migración falla, el contenedor nuevo no levanta y se ve en los logs.
- Se crean en desarrollo con `npm run prisma:migrate` y se commitean.
- **El rollback de código no revierte la base.** Escribí migraciones compatibles hacia atrás: primero agregar (columnas nullable/valores de enum nuevos), desplegar, y recién después quitar lo viejo en un release posterior.
- Antes de una migración destructiva, hacé un backup manual (sección 5).

## 4. Rollback

Redeploy del tag anterior, sin tocar código:

- **GitHub**: Actions → run *Deploy* del tag bueno anterior → *Re-run all jobs* (usa las imágenes ya construidas de ese tag).
- **Manual**, desde tu máquina:
  ```bash
  caprover deploy --caproverUrl https://captain.relaja.com.ar \
    --appName sillas-back-prod --appToken TOKEN \
    --imageName ghcr.io/TU_USUARIO/silla-backend:v1.0.0
  ```
  (idem para `sillas-web-prod` con `silla-frontend`.)
- **CapRover**: app → *Deployment* → *Deploy via ImageName*.

Si el release incluía una migración incompatible con el código viejo, restaurá el backup (sección 5) además del rollback.

## 5. Backups

`scripts/backup-postgres.sh` hace `pg_dump` comprimido y borra los de más de 14 días. En el VPS:

```bash
sudo mkdir -p /opt/sillas && sudo cp scripts/backup-postgres.sh /opt/sillas/
sudo crontab -e
# todos los días 03:15
15 3 * * * /opt/sillas/backup-postgres.sh sillas-db-prod sillas >> /var/log/sillas-backup.log 2>&1
```

- Copiá los `.sql.gz` **fuera del VPS** (rclone a Drive/S3 o `scp`). Un backup en el mismo disco no sirve si se pierde el VPS.
- Activá también los backups/snapshots del VPS en DonWeb.
- Restaurar: `gunzip -c archivo.sql.gz | docker exec -i CONTENEDOR psql -U postgres -d sillas`. **Probá una restauración** en beta antes de necesitarla.

## 6. Operación

- Logs: CapRover → app → *App Logs*.
- Un **solo** contenedor de backend por ambiente (timers y cola en memoria).
- Shelly Cloud limita a ~1 request/segundo **por cuenta**: no uses la app/web de Shelly en paralelo ni compartas la cuenta con beta.
- Nunca corras `backend/loadtest` contra producción.
- Rotar secretos: cambiar la variable en CapRover y redeployar; si cambia `PROXY_SHARED_SECRET`, tiene que cambiar igual en backend y frontend.
- Hardening opcional: como el rate limit confía en `cf-connecting-ip`, alguien que le pegue directo a la IP del VPS con el header falsificado podría esquivarlo. Se mitiga limitando 80/443 a los rangos de Cloudflare (https://www.cloudflare.com/ips/) en el firewall del panel de DonWeb. Requiere dejar el panel `captain` también en naranja.

## 7. Problemas comunes

| Síntoma | Causa probable / solución |
|---|---|
| Workflow falla en `meta`: "no está en main" | Mergeá a main antes de taggear producción, o usá `-beta.N`. |
| `test` falla | Corré `npm test` y `npx tsc --noEmit` en `backend/` y `frontend/`. |
| Deploy: `unauthorized`/no puede bajar la imagen | Registry mal cargado en CapRover (2.4) o token vencido; o hacé el paquete público. |
| Deploy: error de autenticación | App token incorrecto o "Enable App Token" apagado. |
| Backend reinicia en bucle | Ver logs: falta una variable obligatoria en producción (`PROXY_SHARED_SECRET`, `TURNSTILE_SECRET_KEY`, `IP_HASH_SECRET`, `MP_WEBHOOK_SECRET`) o falló la migración. |
| Frontend responde 502 en `/api/*` | `BACKEND_INTERNAL_URL` mal (nombre `srv-captain--…`) o backend caído. |
| Turnstile no carga / falla en el navegador | La `TURNSTILE_SITE_KEY` del environment no corresponde al dominio, o hay que volver a deployar (se fija en el build). |
| Redirección infinita en HTTPS | Cloudflare en modo *Flexible*: pasarlo a *Full (strict)*. |
| Webhook de MP no llega | URL mal en Mercado Pago, o firma: `MP_WEBHOOK_SECRET` distinta a la de esa aplicación. |
| Rate limit afecta a todos por igual | El dominio no está detrás de Cloudflare (nube gris). |

## 8. Puntos a verificar en el primer intento

- Flags del CLI: `caprover deploy --help` (el workflow usa `--caproverUrl --appName --appToken --imageName`).
- Que CapRover use las credenciales de *Remote Registry* al desplegar por `imageName`; si no, hacer los paquetes públicos.
