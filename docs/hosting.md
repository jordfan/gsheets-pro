# Hosting gsheets-pro

This is for anyone running `gsheets-pro serve --http` for a team rather than
for themselves: a laptop user runs `gsheets-pro-local` over stdio instead and
never needs this page. Everything below is generic; put your own hostnames,
tokens, and project names in where the examples show a placeholder.

## Why HTTP at all

Claude Code cloud sessions and scheduled routines cannot start a stdio server.
`docs/cloud.md` covers that in detail. The fix is the same server, running as a
stateless HTTP process somewhere reachable, with a bearer token standing in for
"who is allowed to call this."

## Running it

### `docker run`

```sh
docker build -t gsheets-pro .

docker run -d \
  --name gsheets-pro \
  -p 8080:8080 \
  -e GSHEETS_PRO_TOKEN=<a long random bearer> \
  -v gsheets-pro-secrets:/app/secrets \
  gsheets-pro
```

Put credentials in the container one of three ways:

- **Mount files.** Put a token file and, if you are using Path A OAuth, a
  client file inside the `/app/secrets` volume, at the paths
  `GSHEETS_PRO_TOKEN_FILE` and `GSHEETS_PRO_OAUTH_CLIENT` point to (they
  default to `/app/secrets/token.json` and `/app/secrets/credentials.json`).
  This is the right choice when you can get files onto the host, for example a
  VM you provisioned yourself.
- **Inject as environment variables.** Some hosts only offer environment
  variables for secrets, never a filesystem you can write to ahead of time. Set
  `GSHEETS_PRO_TOKEN_JSON` and, if applicable, `GSHEETS_PRO_OAUTH_JSON` to the
  raw JSON contents of those same two files. The image's entrypoint writes them
  to the paths above at container start, mode 600, and logs only how many bytes
  it wrote, never the contents. Unset both once the container is up if your
  platform lets you edit the running environment; they are not read again after
  startup.
- **Application Default Credentials.** If the host already has a Google
  identity attached (a service account on the VM, for instance), skip both of
  the above and let `google-auth-library` find it. `gsheets-pro doctor` inside
  the container says which path it resolved.

`GSHEETS_PRO_TOKEN` is the bearer every MCP request must carry. Generate it
with something like `openssl rand -hex 32`. Leaving it unset means the server
accepts unauthenticated requests, which `doctor` will point out; do that only
if the host is unreachable from outside its own network in the first place.

### `docker compose`

```yaml
services:
  gsheets-pro:
    build: .
    # or: image: ghcr.io/<you>/gsheets-pro:<tag>
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      GSHEETS_PRO_TOKEN: ${GSHEETS_PRO_TOKEN}
      # One of these two, matching whichever credential path you chose above.
      # GSHEETS_PRO_TOKEN_JSON: ${GSHEETS_PRO_TOKEN_JSON}
      # GSHEETS_PRO_OAUTH_JSON: ${GSHEETS_PRO_OAUTH_JSON}
    volumes:
      - gsheets-pro-secrets:/app/secrets
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://127.0.0.1:8080/health', r => process.exit(r.statusCode===200?0:1)).on('error', () => process.exit(1))"]
      interval: 30s
      timeout: 3s
      retries: 3

volumes:
  gsheets-pro-secrets:
```

Keep `GSHEETS_PRO_TOKEN` and any `*_JSON` values in a `.env` file next to the
compose file, outside version control, or in whatever secret store your
orchestrator offers. Compose reads `.env` automatically for `${...}`
interpolation.

## Memory

A small VM is fine. Renders (`sheets_render`) are serialized on purpose, one
PDF export and one `pdftoppm` call at a time, so memory does not scale with
concurrent callers the way it would for an unserialized renderer. The image
sets `NODE_OPTIONS=--max-old-space-size=460` as a conservative default for a
1 GB instance; raise it with `-e NODE_OPTIONS=--max-old-space-size=<n>` on a
bigger box, or lower it further on something smaller. Watch container RSS for
the first few days under real traffic before trusting a number; the actual
ceiling depends on how many large reads and batch writes your team runs
concurrently, not just tool count.

## Behind a reverse proxy

Terminate TLS in front of the container; the server itself speaks plain HTTP.
Any reverse proxy works (Caddy, nginx, an existing load balancer). Three things
matter regardless of which one you pick:

- Forward `POST` to `/mcp` (or `/`, both accept MCP traffic) and pass the
  `Authorization` header through unmodified. The bearer check happens inside
  the server, not the proxy, so the proxy does not need to know the token.
- Point the proxy's own health check at `GET /health`. It answers before the
  bearer check runs, so a load balancer can probe it without a token, and it
  never touches Google.
- Forward `GET` to `/renders/` and do **not** put proxy-level authentication in
  front of it. That path serves rendered PNGs, and whatever fetches one sends a
  plain GET with no header to attach a bearer to, so the URL carries its own
  signature instead. Blanket basic auth on the proxy breaks every render.
- The server is stateless: no sticky sessions, no in-memory state tied to a
  connection. A proxy is free to round-robin across replicas, including for
  render URLs, because the signing secret defaults to `GSHEETS_PRO_TOKEN` and
  every replica has the same one.

## Renders

`sheets_render` writes a PNG to disk and returns a signed URL rather than image
bytes. Three settings decide whether that URL is usable.

- **`GSHEETS_PRO_PUBLIC_URL`**, the origin the server is reachable at, for
  example `https://sheets.example.com`. Without it the tool has no way to know
  its own address and returns a path rather than a full URL, with a warning
  saying so. Set it.
- **`GSHEETS_PRO_RENDER_SECRET`**, optional. URLs are signed with this, falling
  back to `GSHEETS_PRO_TOKEN`, so replicas already agree without it. Set it only
  if you want render URLs to survive rotating the bearer.
- **`GSHEETS_PRO_RENDER_DIR`**, optional, where the PNGs are written. It
  defaults to a directory under the system temp dir, which is right for a
  disposable container. Point it at a mounted volume only if you want renders to
  outlive a restart, and prune it yourself if you do: nothing deletes old
  renders, and a long-lived container accumulates them.

A URL is good for five minutes and then answers 404 like any other bad
signature. That is deliberate: a render URL in a transcript is worthless by the
time anybody reads the transcript. It also means whoever asked for the render
has to fetch it in the same turn, which the tool's own response says.

Rendering needs `pdftoppm`; the image installs `poppler-utils` for it. On a host
without it every other tool works and `sheets_render` returns an error naming
the package. `gsheets-pro doctor` reports which case you are in.

## Reaching it from a Claude Code cloud session

Add an HTTP entry to the repository's `.mcp.json`, with the bearer pulled from
whatever your cloud session's environment settings mechanism is (Claude Code
substitutes `${VAR_NAME}` placeholders from the session's configured
environment variables at connect time; put the actual token there, never in
the committed file):

```json
{
  "mcpServers": {
    "gsheets-pro": {
      "type": "http",
      "url": "https://<your-reachable-hostname>/mcp",
      "headers": {
        "Authorization": "Bearer ${GSHEETS_PRO_TOKEN}"
      }
    }
  }
}
```

Set `GSHEETS_PRO_TOKEN` in the cloud session or scheduled routine's
environment configuration, matching the value the server was started with.
Tools then arrive as `mcp__gsheets-pro__sheets_<tool>`; every hook matcher and
every line of the skill matches on the `sheets_<tool>` suffix, so nothing else
needs to change between this path and any other transport.

## Fronting it with an aggregator

If you already run an MCP aggregator (something that fans one connector out to
several backend servers and forwards `tools/call`), point one of its backend
entries at this server's `/mcp` URL with the bearer attached the same way a
direct `.mcp.json` entry would. Two things the server relies on, and that an
aggregator built for a stateful server might not do by default:

- **No `initialize` handshake is required before `tools/call`.** The server is
  stateless HTTP: no session id, a fresh transport and a fresh in-process MCP
  server per request, module-scoped state shared across requests. It is built
  and tested to accept bare `tools/call` posts, including several at once, with
  no prior handshake on the same connection.
- **Every request is independent.** There is nothing to pin a client to a
  particular backend instance for; any request can go to any healthy replica.

An aggregator that already fronts other stateless HTTP MCP servers this way
needs nothing special for this one beyond the URL and the bearer.
