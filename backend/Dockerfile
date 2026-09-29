# syntax=docker/dockerfile:1
# Backend Nest.js + Prisma. Imagen de runtime chica: solo deps de producción
# más el CLI de Prisma (para `migrate deploy` al arrancar).

# ── build ────────────────────────────────────────────────────
FROM node:22-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npm run build \
    && node -p "require('prisma/package.json').version" > /prisma-version

# ── runtime ──────────────────────────────────────────────────
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# CLI de Prisma en la MISMA versión que resolvió el lockfile.
COPY --from=build /prisma-version /tmp/prisma-version
RUN npm install --no-save "prisma@$(cat /tmp/prisma-version)" && npm cache clean --force
COPY prisma ./prisma
RUN npx prisma generate
COPY --from=build /app/dist ./dist

USER node
EXPOSE 3002
ENV PORT=3002
# El backend no tiene endpoint de salud: se chequea que el puerto acepte conexiones.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "require('net').connect(process.env.PORT||3002,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"
# Migra la base y arranca. Si la migración falla, el contenedor no levanta.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/src/main.js"]
