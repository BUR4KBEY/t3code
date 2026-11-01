#!/usr/bin/env bash
# Rebases this fork's main onto the newest upstream nightly tag and points
# the PKGBUILD at that nightly. Then build with `makepkg -Cf` in this folder.
#
# A conflict stops the rebase. Fix it, `git rebase --continue`, and run this
# script again; it picks up where the rebase left the branch.
set -euo pipefail
cd "$(dirname "$0")"
repo=$(git rev-parse --show-toplevel)

if [[ -n $(git -C "$repo" status --porcelain) ]]; then
  echo 'Commit or stash your changes first.' >&2
  exit 1
fi
if [[ $(git -C "$repo" branch --show-current) != main ]]; then
  echo 'Check out main first.' >&2
  exit 1
fi

git -C "$repo" fetch --quiet --tags upstream
new_tag=$(git -C "$repo" tag -l 'v*-nightly.*' --sort=-creatordate | head -n 1)
current=$(sed -n 's/^pkgver=//p' PKGBUILD)
old_tag="v${current/_nightly./-nightly.}"

if ! git -C "$repo" merge-base --is-ancestor "$new_tag" main; then
  echo "Rebasing main from $old_tag onto $new_tag"
  git -C "$repo" rebase --onto "$new_tag" "$old_tag" main
fi

new_pkgver=${new_tag#v}
new_pkgver=${new_pkgver/-nightly./_nightly.}
if [[ $new_pkgver == "$current" ]]; then
  echo "Already on $new_tag"
  exit 0
fi

sed -i -e "s/^pkgver=.*/pkgver=$new_pkgver/" -e 's/^pkgrel=.*/pkgrel=1/' PKGBUILD
updpkgsums
git -C "$repo" commit --quiet -m "chore(packaging): build on $new_tag" -- PKGBUILD
echo "main is on $new_tag. Push with: git push --force-with-lease origin main"
