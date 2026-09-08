# syntax=docker/dockerfile:1
#
# Two stages: the build stage installs full dependencies (including
# devDependencies) to compile TypeScript, then prunes down to production
# dependencies only; the runtime stage copies just dist/, node_modules, and
# package.json, and never sees a devDependency. See docs/hosting.md for how to
# run the resulting image.

########################################
# build
########################################
FROM node:24-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
# package.json's "prepare" script (scripts/prepare.mjs) runs on this npm ci.
# It builds only when src/ is present, which it deliberately is not yet at
# this point (src/ is copied in below, kept separate so this dependency-only
# layer caches independently of source changes) — but the script itself has
# to exist for npm to run it at all, so it comes along with package.json.
COPY scripts/prepare.mjs ./scripts/prepare.mjs
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop devDependencies now that dist/ exists, so the runtime stage only ever
# copies production node_modules.
RUN npm prune --omit=dev

########################################
# runtime
########################################
FROM node:24-slim AS runtime

# poppler-utils provides pdftoppm, which sheets_render and `gsheets-pro doctor`
# look for on PATH.
RUN apt-get update \
    && apt-get install --no-install-recommends -y poppler-utils \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 1001 gsheets \
    && useradd --uid 1001 --gid gsheets --shell /usr/sbin/nologin --create-home gsheets

WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Where credential files live by default (src/lib/auth.ts: dataDir()). A host
# that injects credentials as environment variables rather than mounting files
# gets them written here by the entrypoint, at startup, mode 600. Token and
# OAuth client files can also be mounted directly at GSHEETS_PRO_TOKEN_FILE /
# GSHEETS_PRO_OAUTH_CLIENT (or their default paths under this directory).
ENV GSHEETS_PRO_DATA_DIR=/app/secrets
RUN mkdir -p /app/secrets && chown -R gsheets:gsheets /app /app/secrets

# A conservative default for a small host; override with
# `docker run -e NODE_OPTIONS=...` on a bigger box.
ENV NODE_OPTIONS="--max-old-space-size=460"

USER gsheets

# GSHEETS_PRO_PORT (falling back to 8080) is what the server actually binds;
# this is documentation for `docker run -p` and orchestrators that read it.
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e " \
      const port = process.env.PORT || process.env.GSHEETS_PRO_PORT || 8080; \
      require('http') \
        .get({ host: '127.0.0.1', port, path: '/health', timeout: 2000 }, (res) => { \
          process.exit(res.statusCode === 200 ? 0 : 1); \
        }) \
        .on('error', () => process.exit(1)); \
    "

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/cli.js", "serve", "--http"]
