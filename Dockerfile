# ── Build stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS base

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install --omit=dev --frozen-lockfile 2>/dev/null || npm install --omit=dev

# ── Production image ─────────────────────────────────────────────────────────
FROM node:20-alpine AS production

# Create non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S nodeapp -u 1001 -G nodejs

WORKDIR /app

# Copy node_modules from base
COPY --from=base /app/node_modules ./node_modules
COPY --chown=nodeapp:nodejs . .

USER nodeapp

EXPOSE 3000

ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "src/index.js"]
