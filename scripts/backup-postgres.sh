#!/usr/bin/env bash
# Backup diario de Postgres de CapRover. Correr en el VPS (cron del host).
# Uso: ./backup-postgres.sh <nombre-app-postgres> <base> [usuario]
# Ej.: ./backup-postgres.sh sillas-db-prod sillas postgres
set -euo pipefail
APP="${1:?app}"; DB="${2:?base}"; USER="${3:-postgres}"
DIR="${BACKUP_DIR:-/var/backups/sillas}"; KEEP_DAYS="${KEEP_DAYS:-14}"
mkdir -p "$DIR"
CONT=$(docker ps --filter "name=srv-captain--${APP}" --format '{{.ID}}' | head -n1)
[ -n "$CONT" ] || { echo "No encuentro el contenedor de $APP" >&2; exit 1; }
OUT="$DIR/${APP}_${DB}_$(date +%Y%m%d_%H%M%S).sql.gz"
docker exec "$CONT" pg_dump -U "$USER" -d "$DB" | gzip > "$OUT"
find "$DIR" -name "${APP}_${DB}_*.sql.gz" -mtime +"$KEEP_DAYS" -delete
echo "OK $OUT"
