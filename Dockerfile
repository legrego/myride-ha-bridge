# Which image to produce: "runtime" (standalone/Portainer, non-root — the
# default) or "addon" (Home Assistant add-on). Selected with a build arg rather
# than --target because HA's builder actions have no target input.
ARG IMAGE_FLAVOR=runtime

# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# ── Base runtime stage (shared by the add-on and standalone images) ──────────
FROM node:22-alpine AS base

WORKDIR /app

# Non-root user for security
RUN addgroup -S bridge && adduser -S bridge -G bridge

# Copy production deps and source
COPY --from=deps /app/node_modules ./node_modules
COPY src/ ./src/
COPY public/ ./public/
COPY package.json ./

# Token persistence volume (mounted at TOKEN_FILE path)
RUN mkdir -p /data && chown bridge:bridge /data
VOLUME ["/data"]

# API server port
EXPOSE 8099

# Build version info (injected by CI; matches the pushed image tag)
ARG GIT_COMMIT=unknown
ARG BUILD_TIME=unknown

# Environment variable defaults (override via Portainer stack env)
ENV NODE_ENV=production \
    LOG_LEVEL=info \
    API_PORT=8099 \
    TOKEN_FILE=/data/refresh_token \
    COGNITO_CLIENT_ID=3c5382gsq7g13djnejo98p2d98 \
    COGNITO_REGION=us-east-1 \
    GIT_COMMIT=$GIT_COMMIT \
    BUILD_TIME=$BUILD_TIME

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -qO- http://localhost:${API_PORT}/status || exit 1

CMD ["node", "src/index.js"]

# ── Home Assistant add-on (--build-arg IMAGE_FLAVOR=addon) ────────────────────
# Runs as root: the Supervisor bind-mounts /data owned by root, and the bridge
# must write the refresh token there. The io.hass.* labels are added by the
# builder actions in CI.
FROM base AS addon

# ── Standalone runtime ────────────────────────────────────────────────────────
FROM base AS runtime

USER bridge

# ── Final image, chosen by IMAGE_FLAVOR ───────────────────────────────────────
FROM ${IMAGE_FLAVOR}
