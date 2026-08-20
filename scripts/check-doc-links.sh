#!/usr/bin/env bash
#
# Verify that every markdown link that names a path inside this
# repository points at something that exists — whether it is written as a
# relative path or as a full github.com URL.
#
# Exists because twenty links had rotted unnoticed — mostly example
# READMEs citing an ADR or DD by a guessed slug (`019-single-unit-atomicity.md`
# for `019-hybrid-delivery-atomicity.md`). Nothing failed, so nobody
# noticed until someone tried to follow one.
#
# The github.com case was added when the published package READMEs moved
# to absolute URLs. They have to be absolute: npm renders a README
# outside the repository tree, so a relative link is dead on the package
# page. That would have left the most-read documents in the project as
# the only ones nothing checked.
#
# Deliberately dependency-free: plain shell over `git ls-files`, so it
# runs identically in CI and locally with nothing to install.
#
# Scope and limits:
# - Only paths inside this repository are resolved. Other `http(s)://`
#   targets are skipped — checking them would make the run
#   network-dependent and flaky.
# - Anchors are stripped, so `foo.md#section` only proves `foo.md`
#   exists, not that the heading does.
# - Reference-style links (`[text][ref]`) are not resolved.
#
# Usage: scripts/check-doc-links.sh   (from the repo root)

set -uo pipefail

# Matches both forms this repo uses for in-repo absolute links:
#   .../blob/main/<path>   for files
#   .../tree/main/<path>   for directories
readonly REPO_URL_PREFIX='https://github.com/igorgolovanov/nestjs-transactional'

broken=0

while IFS= read -r file; do
  base=$(dirname "$file")

  # Extract every `](target)` occurrence and drop the anchor.
  while IFS= read -r target; do
    [ -n "$target" ] || continue

    resolved=''
    case "$target" in
      "$REPO_URL_PREFIX"/blob/main/*)
        resolved="${target#"$REPO_URL_PREFIX"/blob/main/}"
        ;;
      "$REPO_URL_PREFIX"/tree/main/*)
        resolved="${target#"$REPO_URL_PREFIX"/tree/main/}"
        ;;
      # The bare repo URL, `#readme`, `/issues`, `/security/advisories/new`
      # and similar are GitHub features rather than paths in the tree.
      "$REPO_URL_PREFIX"*) continue ;;
      http://* | https://* | mailto:* | '#'*) continue ;;
      *)
        resolved="$base/$target"
        ;;
    esac

    if [ ! -e "$resolved" ]; then
      printf '%s: broken link -> %s\n' "$file" "$target"
      broken=$((broken + 1))
    fi
  done < <(grep -oh ']([^)]*' "$file" | sed 's/^](//; s/#.*$//' | sort -u)
done < <(git ls-files '*.md' | grep -v node_modules)

if [ "$broken" -gt 0 ]; then
  printf '\n%d broken link(s) found.\n' "$broken" >&2
  exit 1
fi

echo 'All in-repo markdown links resolve.'
