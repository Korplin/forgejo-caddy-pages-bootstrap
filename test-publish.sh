#!/usr/bin/env bash
# Publish a tiny test site to the prototype and check that it is served.
# Run this from any machine in the LAN that has git and curl (not on the VM necessarily).
#
#   bash test-publish.sh <vm-ip> <pages-owner-password> [repo-name] [pages-owner]
#
# Example:
#   bash test-publish.sh 192.168.1.50 'Abc123...' hello-theme
#
# Password: see /opt/forgejo-caddy-pages/credentials.txt on the VM (line of the pages owner).

set -euo pipefail

HOST="${1:?usage: test-publish.sh <vm-ip> <pages-owner-password> [repo-name] [pages-owner]}"
PASSWORD="${2:?missing pages owner password}"
REPO="${3:-hello-theme}"
OWNER="${4:-themes}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"

git init -q -b main
git config user.name "$OWNER"
git config user.email "$OWNER@forgejo.local"

mkdir -p css
cat > index.html <<EOF
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${REPO}</title>
  <link rel="stylesheet" href="css/style.css">
</head>
<body>
  <h1>${REPO}</h1>
  <p>Served by the pages service at $(date -u +%Y-%m-%dT%H:%M:%SZ).</p>
</body>
</html>
EOF
printf 'body{font-family:system-ui,sans-serif;margin:3rem}h1{color:#0a6}\n' > css/style.css

git add -A
git commit -q -m "test site"

# Push-to-create: the repo is created on the first push (enabled by the playbook).
git push -q "http://${OWNER}:${PASSWORD}@${HOST}:3000/${OWNER}/${REPO}.git" main --force

URL="http://${HOST}/${REPO}/"
echo "Pushed. Fetching $URL (cache may delay updates by up to 30 s)"
curl -fsS -o /dev/null -w 'index.html -> HTTP %{http_code}\n' "$URL"
curl -fsS -o /dev/null -w 'css/style.css -> HTTP %{http_code}, %{content_type}\n' "${URL}css/style.css"
echo "OK: open $URL in a browser."
