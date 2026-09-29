# syntax=docker/dockerfile:1
# Frontend Next.js. NEXT_PUBLIC_* se incorpora en BUILD (queda dentro del
# JS del navegador), por eso la site key de Turnstile entra como build-arg y
# cada ambiente (beta/producción) genera su propia imagen.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY
ENV NEXT_PUBLIC_TURNSTILE_SITE_KEY=$NEXT_PUBLIC_TURNSTILE_SITE_KEY \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/next.config.ts ./next.config.ts
USER node
EXPOSE 3003
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3003/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "next", "start", "-p", "3003"]
