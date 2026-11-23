#!/usr/bin/env bash
# mint-dev-env.sh — seed deploy/compose/.env from .env.example and MINT every secret the stack
# refuses to run without. Since 0.12.27 the services refuse to boot on an empty or published
# placeholder for these keys (config.v1 `forbidden_values`); a fresh checkout therefore needs real
# values before `docker compose up`. `make up` / `make all` / `make dev`, CI's value leg and
# release-validate call this instead of a bare `cp` — it never overwrites an existing non-empty value.
set -euo pipefail
umask 077
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_file="${1:-$here/.env}"
if [ ! -f "$env_file" ]; then
  if [ "${2:-}" = "--voice-release" ]; then
    sed -e 's/^TINA_MEETING_VOICE=0$/TINA_MEETING_VOICE=1/' \
        -e 's/^COMPOSE_PROFILES=$/COMPOSE_PROFILES=asr/' \
        -e 's|^TRANSCRIPTION_SERVICE_URL=$|TRANSCRIPTION_SERVICE_URL=http://gipformer:8000|' \
        "$here/.env.example" > "$env_file"
  else
    cp "$here/.env.example" "$env_file"
  fi
fi
repo_root="$(cd "$here/../.." && pwd)"
if [[ "$env_file" == /* ]]; then env_abs="$env_file"; else env_abs="$(pwd)/$env_file"; fi
tracked=0
if [[ "$env_abs" == "$repo_root/"* ]]; then
  rel="${env_abs#"$repo_root"/}"
  git -C "$repo_root" ls-files --error-unmatch -- "$rel" >/dev/null 2>&1 && tracked=1 || true
fi
dotenvx_managed=0
if grep -q '^DOTENV_PUBLIC_KEY=' "$env_file" || grep -q 'encrypted:' "$env_file"; then dotenvx_managed=1; fi
protect_env=0
if [ "$tracked" -eq 1 ] || [ "$dotenvx_managed" -eq 1 ]; then protect_env=1; fi
dotenvx_bin="${DOTENVX_BIN:-$(command -v dotenvx || true)}"
key_file="${DOTENVX_KEY_FILE:-}"
if [ -n "$key_file" ] && [[ "$key_file" != /* ]]; then key_file="$repo_root/$key_file"; fi
if [ -z "$key_file" ]; then
  for candidate in "$(dirname "$env_abs")/.env.keys" "$repo_root/.env.keys"; do
    if [ -f "$candidate" ]; then key_file="$candidate"; break; fi
  done
fi
dotenvx_key_args=()
if [ -n "$key_file" ]; then dotenvx_key_args=(-fk "$key_file"); fi
if [ "$protect_env" -eq 1 ] && [ -z "$dotenvx_bin" ]; then
  echo "This env file is tracked or Dotenvx-managed. Install dotenvx before minting secrets; no values were changed." >&2
  exit 1
fi
check_file="$env_file"
dotenvx_tmp_dir=""
if grep -q 'encrypted:' "$env_file"; then
  dotenvx_tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/tina-env.XXXXXX")"
  chmod 700 "$dotenvx_tmp_dir"
  check_file="$dotenvx_tmp_dir/plain.env"
  "$dotenvx_bin" decrypt --stdout -f "$env_file" "${dotenvx_key_args[@]}" > "$check_file" || {
    rm -rf "$dotenvx_tmp_dir"
    echo "Dotenvx could not read the env file; no secret values were changed." >&2
    exit 1
  }
  chmod 600 "$check_file"
  trap 'rm -rf "$dotenvx_tmp_dir"' EXIT
fi
# Do not silently rotate an existing administrator/signing credential. Old published
# placeholders require an explicit migration; a fresh template leaves this empty.
admin=$(sed -n 's/^ADMIN_TOKEN=//p' "$check_file" | head -1 | sed -E 's/[[:space:]]+#.*$//; s/^[[:space:]]*//; s/[[:space:]]*$//' | tr -d "\"'")
case "$admin" in
  dev-admin-token|tina-internal-secret|lite-internal-secret|changeme|change-me|CHANGE-ME|default|secret)
    echo "ADMIN_TOKEN is a published placeholder. Replace it explicitly on the existing deployment; no secrets were rotated." >&2
    exit 1;;
esac
mint() { openssl rand -hex 32; }
keys=(ADMIN_TOKEN INTERNAL_API_SECRET TINA_FLOWS_API_KEY TINA_FLOWS_TIMELINE_KEY NEXTAUTH_SECRET)
if [ "${2:-}" = "--voice-release" ] && grep -qx 'TRANSCRIPTION_SERVICE_URL=http://gipformer:8000' "$check_file"; then
  keys+=(TRANSCRIPTION_SERVICE_TOKEN)
fi
for key in "${keys[@]}"; do
  if grep -qE "^${key}=[[:space:]]*(\"\"|'')?[[:space:]]*$" "$check_file"; then
    v="$(mint)"
    if [ "$protect_env" -eq 1 ]; then
      "$dotenvx_bin" set "$key" "$v" -f "$env_file" "${dotenvx_key_args[@]}" >/dev/null || {
        echo "Dotenvx could not store ${key}; no secret value was printed." >&2
        exit 1
      }
    else
      # portable in-place edit (GNU and BSD sed)
      sed -i.bak "s|^${key}=.*|${key}=${v}|" "$env_file" && rm -f "$env_file.bak"
    fi
    echo "minted ${key}"
  elif ! grep -qE "^${key}=" "$check_file"; then
    v="$(mint)"
    if [ "$protect_env" -eq 1 ]; then
      "$dotenvx_bin" set "$key" "$v" -f "$env_file" "${dotenvx_key_args[@]}" >/dev/null || {
        echo "Dotenvx could not store ${key}; no secret value was printed." >&2
        exit 1
      }
    else
      echo "${key}=${v}" >> "$env_file"
    fi
    echo "appended ${key}"
  else
    echo "kept ${key}"
  fi
done
if [ "$protect_env" -eq 1 ]; then
  "$dotenvx_bin" encrypt -f "$env_file" "${dotenvx_key_args[@]}" >/dev/null || {
    echo "Dotenvx could not encrypt this env file; no secret value was printed." >&2
    exit 1
  }
fi
chmod 600 "$env_file"
