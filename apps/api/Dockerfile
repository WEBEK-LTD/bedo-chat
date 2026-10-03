# syntax=docker/dockerfile:1
# Bedo Chat API (HTTP now, WebSocket gateway from Phase 3) for persistent backend hosting (D-15).
# Build from the repository root:   docker build -f apps/api/Dockerfile -t bedo-api .

FROM node:24-slim AS build
ENV TURBO_TELEMETRY_DISABLED=1 NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo
COPY . .
# Install scripts stay blocked (pnpm-workspace.yaml); the lockfile is the single source of versions.
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@bedo/api
# Self-contained production folder: the API, its workspace packages (built) and production dependencies only.
RUN pnpm --filter=@bedo/api deploy --prod --legacy /out \
 && cp -r supabase /out/supabase

FROM node:24-slim
ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    API_PORT=4000 \
    MIGRATIONS_DIR=/app/supabase/migrations
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Migrations (run once per release, as the table owner over a direct or session connection):
#   docker run --rm -e DATABASE_URL=... bedo-api node node_modules/@bedo/db/dist/cli.js migrate
CMD ["node", "--enable-source-maps", "dist/main.js"]
