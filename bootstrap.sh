#!/usr/bin/env bash
# One-liner bootstrap for a clean Debian VM:
#   wget -O bootstrap.sh https://raw.githubusercontent.com/Korplin/forgejo-caddy-pages-bootstrap/main/bootstrap.sh && bash bootstrap.sh
#
# What it does (safe to run again, every step is idempotent):
#   1. becomes root (directly or via sudo)
#   2. installs git, ansible-core and a few helpers with apt
#   3. downloads/updates this repository to $INSTALL_DIR
#   4. runs bootstrap-playbook.yml with Ansible against the local machine
#
# Extra arguments are passed to ansible-playbook, e.g.:  bash bootstrap.sh -e pages_owner=mythemes
# Environment overrides: REPO_URL, BRANCH, INSTALL_DIR

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Korplin/forgejo-caddy-pages-bootstrap.git}"
BRANCH="${BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-/opt/forgejo-caddy-pages-bootstrap}"

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# --- 1. root ---------------------------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    log "Not root, re-running with sudo"
    exec sudo -E bash "$0" "$@"
  fi
  die "Run as root (netinst Debian has no sudo by default): su -  then run this script again."
fi

[ -r /etc/os-release ] || die "Cannot detect the OS (/etc/os-release missing)."
# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-}${ID_LIKE:-}" in
  *debian*) ;;
  *) die "This bootstrap supports Debian only (found: ${PRETTY_NAME:-unknown})." ;;
esac

export DEBIAN_FRONTEND=noninteractive

# --- 2. packages -----------------------------------------------------------------
# A netinst install can leave the installation medium as an apt source, which breaks 'apt-get update'.
if grep -qE '^deb cdrom:' /etc/apt/sources.list 2>/dev/null; then
  log "Disabling cdrom apt source"
  sed -i -E 's/^(deb cdrom:)/# \1/' /etc/apt/sources.list
fi

log "Installing git, ansible-core and helpers"
apt-get update -y
apt-get install -y --no-install-recommends \
  ca-certificates curl git gnupg python3 python3-apt python3-yaml python3-jinja2 ansible-core

# --- 3. repository ---------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/bootstrap-playbook.yml" ] && [ -d "$SCRIPT_DIR/pages-service" ]; then
  # Script was started from a full checkout (development): use it as is.
  WORK_DIR="$SCRIPT_DIR"
  log "Using local checkout in $WORK_DIR"
else
  WORK_DIR="$INSTALL_DIR"
  if [ -d "$WORK_DIR/.git" ]; then
    log "Updating $WORK_DIR from $REPO_URL ($BRANCH)"
    git -C "$WORK_DIR" fetch --depth 1 origin "$BRANCH"
    git -C "$WORK_DIR" reset --hard FETCH_HEAD
  else
    log "Cloning $REPO_URL ($BRANCH) to $WORK_DIR"
    rm -rf "$WORK_DIR"
    git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$WORK_DIR"
  fi
fi

[ -f "$WORK_DIR/bootstrap-playbook.yml" ] || die "bootstrap-playbook.yml not found in $WORK_DIR"

# --- 4. playbook -----------------------------------------------------------------
log "Running the playbook (this takes a few minutes on the first run)"
cd "$WORK_DIR"
export ANSIBLE_FORCE_COLOR=0 ANSIBLE_NOCOWS=1
ansible-playbook -i localhost, -c local bootstrap-playbook.yml "$@"

log "Done. Credentials are stored in /opt/forgejo-caddy-pages/credentials.txt (root only)."
