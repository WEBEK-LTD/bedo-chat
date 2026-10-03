# syntax=docker/dockerfile:1
# Bedo Chat background worker (BullMQ) for persistent backend hosting (D-15).
# Build from the repository root:   docker build -f apps/worker/Dockerfile -t bedo-worker .

FROM node:24-slim AS build
ENV TURBO_TELEMETRY_DISABLED=1 NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@bedo/worker
RUN pnpm --filter=@bedo/worker deploy --prod --legacy /out

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
# Stops on SIGTERM after in-flight jobs finish; give the platform's stop timeout at least 30 seconds.
CMD ["node", "--enable-source-maps", "dist/main.js"]
