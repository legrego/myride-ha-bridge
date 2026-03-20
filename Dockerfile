# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:22-alpine

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

# Environment variable defaults (override via Portainer stack env)
ENV NODE_ENV=production \
    LOG_LEVEL=info \
    API_PORT=8099 \
    TOKEN_FILE=/data/refresh_token \
    COGNITO_CLIENT_ID=3c5382gsq7g13djnejo98p2d98 \
    COGNITO_REGION=us-east-1

USER bridge

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -qO- http://localhost:${API_PORT}/status || exit 1

CMD ["node", "src/index.js"]
