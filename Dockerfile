# syntax=docker/dockerfile:1.7

# ---------- builder ----------
FROM node:24-bookworm-slim AS builder
WORKDIR /app

# Force a development install in the builder regardless of any NODE_ENV
# build-arg the host (e.g. Coolify) may inject. We need typescript/tsx/etc.
# from devDependencies to run `npm run build`. Setting NODE_ENV here overrides
# any inherited value, and `--include=dev` is belt-and-braces in case some
# npm config still pretends production.
ENV NODE_ENV=development \
    PUPPETEER_SKIP_DOWNLOAD=true

# Copy the things postinstall (copy:monaco) needs FIRST, so they exist at the
# moment `npm ci` triggers the lifecycle script.
COPY package.json package-lock.json* ./
COPY scripts ./scripts
COPY public ./public

RUN --mount=type=cache,target=/root/.npm \
    npm ci --include=dev

# Now compile the TypeScript sources.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---------- runtime ----------
# Official Puppeteer image — Chromium + system libs + non-root user pre-baked.
FROM ghcr.io/puppeteer/puppeteer:24.15.0 AS runtime

WORKDIR /home/pptruser/app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    TEMPLATES_DIR=/data/templates \
    FILES_DIR=/data/files \
    PUPPETEER_SANDBOX=true
# Do NOT set PUPPETEER_EXECUTABLE_PATH or PUPPETEER_SKIP_DOWNLOAD here. The
# official Puppeteer base image ships Chromium in the puppeteer cache
# (PUPPETEER_CACHE_DIR=/home/pptruser/.cache/puppeteer) and the puppeteer
# library auto-discovers it. Overriding the path to /usr/bin/google-chrome-stable
# breaks because that binary isn't installed in this image.

# Run as root through this stage so we can pre-create dirs and so the
# entrypoint can chown freshly-mounted volumes at start time. The entrypoint
# drops privileges to pptruser before exec'ing node.
USER root

RUN mkdir -p /data/templates /data/files \
    && chown -R pptruser:pptruser /data \
    && chmod -R 750 /data

COPY --chown=pptruser:pptruser package.json package-lock.json* ./
COPY --from=builder --chown=pptruser:pptruser /app/node_modules ./node_modules
COPY --from=builder --chown=pptruser:pptruser /app/dist ./dist
# public/ from the builder includes vendor/monaco populated by postinstall
COPY --from=builder --chown=pptruser:pptruser /app/public ./public

# Entrypoint chowns mounted volumes (Coolify et al. often create them as root)
# and switches to pptruser. Required so saves don't silently fail on a
# root-owned bind mount.
COPY scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

# Persistent volumes:
# - /data/templates  → JSON template definitions
# - /data/files      → rendered PNG/PDF outputs from ?store=true
VOLUME ["/data/templates", "/data/files"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/server.js"]
