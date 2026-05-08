# syntax=docker/dockerfile:1.7

# ---------- builder ----------
FROM node:24-bookworm-slim AS builder
WORKDIR /app

# Skip Chromium download in the builder — we use the official Puppeteer image
# at runtime, which already ships Chromium.
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Copy the things postinstall (copy:monaco) needs FIRST, so they exist at the
# moment `npm ci` triggers the lifecycle script.
COPY package.json package-lock.json* ./
COPY scripts ./scripts
COPY public ./public

RUN --mount=type=cache,target=/root/.npm \
    npm ci

# Now compile the TypeScript sources.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---------- runtime ----------
# Official Puppeteer image — Chromium + system libs + non-root user pre-baked.
FROM ghcr.io/puppeteer/puppeteer:24.15.0 AS runtime

USER pptruser
WORKDIR /home/pptruser/app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    TEMPLATES_DIR=/data/templates \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
    PUPPETEER_SANDBOX=true

COPY --chown=pptruser:pptruser package.json package-lock.json* ./
COPY --from=builder --chown=pptruser:pptruser /app/node_modules ./node_modules
COPY --from=builder --chown=pptruser:pptruser /app/dist ./dist
# public/ from the builder includes vendor/monaco populated by postinstall
COPY --from=builder --chown=pptruser:pptruser /app/public ./public

VOLUME ["/data/templates"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
