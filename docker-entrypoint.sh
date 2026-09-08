#!/bin/sh
# Some hosts inject secrets only as environment variables, never as mounted
# files. GSHEETS_PRO_TOKEN_JSON and GSHEETS_PRO_OAUTH_JSON, when set, are the
# raw JSON contents of the token file and the OAuth client file that
# src/lib/auth.ts otherwise expects to find on disk. This script writes each
# to the path the server will read (GSHEETS_PRO_TOKEN_FILE / GSHEETS_PRO_OAUTH_CLIENT,
# defaulting under GSHEETS_PRO_DATA_DIR, same as the server's own defaults),
# mode 600, then unsets the variable before handing off. Only a byte count is
# ever printed; the secret itself never reaches a log line.
#
# Hosts that mount the files directly instead need nothing from this script:
# it is a no-op when neither variable is set.
set -eu

data_dir="${GSHEETS_PRO_DATA_DIR:-/app/secrets}"
token_file="${GSHEETS_PRO_TOKEN_FILE:-$data_dir/token.json}"
oauth_file="${GSHEETS_PRO_OAUTH_CLIENT:-$data_dir/credentials.json}"

write_secret() {
  path="$1"
  content="$2"
  label="$3"
  mkdir -p "$(dirname "$path")"
  printf '%s' "$content" >"$path"
  chmod 600 "$path"
  bytes=$(wc -c <"$path" | tr -d ' ')
  echo "docker-entrypoint: wrote ${label} to ${path} (${bytes} bytes)"
}

if [ -n "${GSHEETS_PRO_TOKEN_JSON:-}" ]; then
  write_secret "$token_file" "$GSHEETS_PRO_TOKEN_JSON" "GSHEETS_PRO_TOKEN_JSON"
  unset GSHEETS_PRO_TOKEN_JSON
fi

if [ -n "${GSHEETS_PRO_OAUTH_JSON:-}" ]; then
  write_secret "$oauth_file" "$GSHEETS_PRO_OAUTH_JSON" "GSHEETS_PRO_OAUTH_JSON"
  unset GSHEETS_PRO_OAUTH_JSON
fi

exec "$@"
