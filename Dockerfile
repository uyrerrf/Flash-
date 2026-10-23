# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-slim AS deps

WORKDIR /app

# Build deps for sqlite3 native module
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-slim AS runtime

WORKDIR /app

# Non-root user for security
RUN groupadd -r nexus && useradd -r -g nexus nexus

# Copy only what's needed
COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN mkdir -p data && chown -R nexus:nexus /app

USER nexus

EXPOSE 3000

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/app/data/nexus.db

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+process.env.PORT+'/health', r => process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server/index.js"]
