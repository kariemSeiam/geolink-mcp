# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────
# Stage 1: build
# ─────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ─────────────────────────────────────────────
# Stage 2: runtime (lean, no devDeps)
# ─────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    TRANSPORT=http \
    PORT=3010 \
    HOST=0.0.0.0 \
    GEOLINK_BASE_URL=https://www.geolink-eg.com \
    GEOLINK_DEFAULT_LANGUAGE=en \
    GEOLINK_TIMEOUT_MS=30000

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist ./dist

EXPOSE 3010

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3010/healthz || exit 1

USER node
CMD ["node", "dist/index.js"]
