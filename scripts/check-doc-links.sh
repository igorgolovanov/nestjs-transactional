#!/usr/bin/env bash
#
# Verify that every relative markdown link in tracked `.md` files points
# at something that exists.
#
# Exists because twenty links had rotted unnoticed — mostly example
# READMEs citing an ADR or DD by a guessed slug (`019-single-unit-atomicity.md`
# for `019-hybrid-delivery-atomicity.md`). Nothing failed, so nobody
# noticed until someone tried to follow one.
#
# Deliberately dependency-free: plain shell over `git ls-files`, so it
# runs identically in CI and locally with nothing to install.
#
# Scope and limits:
# - Relative links only. `http(s)://` targets are skipped — checking
#   them would make the run network-dependent and flaky.
# - Anchors are stripped, so `foo.md#section` only proves `foo.md`
#   exists, not that the heading does.
# - Reference-style links (`[text][ref]`) are not resolved.
#
# Usage: scripts/check-doc-links.sh   (from the repo root)

set -uo pipefail

broken=0

while IFS= read -r file; do
  base=$(dirname "$file")

  # Extract every `](target)` occurrence, drop the anchor, skip
  # absolute URLs and in-page anchors.
  while IFS= read -r target; do
    [ -n "$target" ] || continue
    case "$target" in
      http://* | https://* | mailto:* | '#'*) continue ;;
    esac

    if [ ! -e "$base/$target" ]; then
      printf '%s: broken link -> %s\n' "$file" "$target"
      broken=$((broken + 1))
    fi
  done < <(grep -oh ']([^)]*' "$file" | sed 's/^](//; s/#.*$//' | sort -u)
done < <(git ls-files '*.md' | grep -v node_modules)

if [ "$broken" -gt 0 ]; then
  printf '\n%d broken relative link(s) found.\n' "$broken" >&2
  exit 1
fi

echo 'All relative markdown links resolve.'
