# syntax=docker/dockerfile:1

# MongoExplorer production image.
# Node.js LTS on Alpine keeps the image small and the attack surface minimal.
FROM node:22-alpine

# Container defaults. HOST must be 0.0.0.0 so the app is reachable through the
# published port mapping (server.js otherwise binds to loopback only).
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

WORKDIR /app

# Install production dependencies first so this layer stays cached across code
# changes. The lockfile gives deterministic, reproducible installs.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy application source explicitly (allowlist) rather than the whole context.
COPY server.js ./
COPY src ./src
COPY public ./public

# Drop root privileges — run as the unprivileged "node" user from the base image.
USER node

EXPOSE 3000

# Dependency-free health probe against the static index route.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
