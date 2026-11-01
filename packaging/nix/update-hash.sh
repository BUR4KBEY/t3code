#!/usr/bin/env bash
# Refreshes the pnpm dependency hash in t3-server.nix. Run it after
# pnpm-lock.yaml changes; sync-upstream.sh runs it after each rebase.
set -euo pipefail
cd "$(dirname "$0")"
repo=$(git rev-parse --show-toplevel)
fake=sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=

old=$(sed -n 's/^    hash = "\(sha256-[^"]*\)";$/\1/p' t3-server.nix)
if [[ -z $old ]]; then
  echo 'Could not find the pnpmDeps hash in t3-server.nix.' >&2
  exit 1
fi

sed -i "s|$old|$fake|" t3-server.nix
log=$(nix build --no-link "$repo#t3-server.pnpmDeps" 2>&1) || true
got=$(sed -n 's/^ *got: *\(sha256-[^ ]*\)$/\1/p' <<<"$log")
if [[ -z $got ]]; then
  sed -i "s|$fake|$old|" t3-server.nix
  echo "$log" >&2
  echo 'Fetching the pnpm dependencies did not report a hash.' >&2
  exit 1
fi

sed -i "s|$fake|$got|" t3-server.nix
if [[ $got == "$old" ]]; then
  echo 'pnpm dependency hash unchanged.'
else
  echo "pnpm dependency hash: $got"
fi
