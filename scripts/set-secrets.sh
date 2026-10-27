#!/usr/bin/env bash
# Generates TOKEN_SECRET, ADMIN_TOKEN and CRON_SECRET, stores them on the
# linked Vercel project (production), sets PUBLIC_URL, appends the admin
# token to the hub's secrets.env as WEBCRAFT_MAIL_ADMIN_TOKEN, and gives the
# GitHub repo the same CRON_SECRET for the 5-minute tick (.github/workflows/tick.yml).
# Nothing is printed, so the values never show up in a terminal or a transcript.
#
#   scripts/set-secrets.sh [public-url]     (default https://mail.webcraftmn.com)
#
# Safe to rerun only if you mean to rotate: it replaces the Vercel values and
# the hub line, which signs out every unsubscribe/click link already sent
# (TOKEN_SECRET). It refuses to rotate TOKEN_SECRET unless ROTATE=1.
set -euo pipefail
cd "$(dirname "$0")/.."
url="${1:-https://mail.webcraftmn.com}"
hub_secrets="${HUB_DATA:-$HOME/hub-data}/secrets.env"

existing="$(npx vercel env ls production 2>/dev/null || true)"
if grep -q '\bTOKEN_SECRET\b' <<<"$existing" && [ "${ROTATE:-}" != 1 ]; then
  echo "TOKEN_SECRET is already set; rerun with ROTATE=1 to replace all three (old email links stop working)." >&2
  exit 1
fi

set_env() {
  npx vercel env rm "$1" production --yes >/dev/null 2>&1 || true
  printf '%s' "$2" | npx vercel env add "$1" production >/dev/null 2>&1
  echo "set $1"
}

admin="$(openssl rand -base64 32 | tr -d '\n')"
cron="$(openssl rand -base64 32 | tr -d '\n')"
set_env TOKEN_SECRET "$(openssl rand -base64 32 | tr -d '\n')"
set_env ADMIN_TOKEN "$admin"
set_env CRON_SECRET "$cron"
set_env PUBLIC_URL "$url"
printf '%s' "$cron" | gh secret set CRON_SECRET --repo toryradtke-star/webcraft-mail >/dev/null
echo "set CRON_SECRET on GitHub"


touch "$hub_secrets"
chmod 600 "$hub_secrets"
grep -v '^WEBCRAFT_MAIL_ADMIN_TOKEN=' "$hub_secrets" > "$hub_secrets.tmp" || true
printf 'WEBCRAFT_MAIL_ADMIN_TOKEN=%s\n' "$admin" >> "$hub_secrets.tmp"
mv "$hub_secrets.tmp" "$hub_secrets"
chmod 600 "$hub_secrets"
echo "set WEBCRAFT_MAIL_ADMIN_TOKEN in $hub_secrets"
