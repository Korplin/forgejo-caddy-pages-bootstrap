# forgejo-caddy-pages-bootstrap

One-liner bootstrap that turns a clean Debian VM into a self-hosted "GitHub Pages / Codeberg Pages" alternative:

- **Forgejo** hosts git repositories.
- A small **Node pages service** serves every repository of **one** Forgejo user as a static website, straight from the `main` branch, via the Forgejo API (no checkout, no webhook, no second copy of the files).
- **Caddy** is the public entry point and reverse-proxies to the pages service.
- Everything runs in **Docker Compose** and is installed by an **Ansible** playbook that bootstrap.sh sets up for you.

Status: **prototype for local-network testing.** No security hardening on purpose (HTTP only, default ports, generated passwords in a root-only file). See [Known limitations](#known-limitations) and [Next steps](#next-steps).

## Quick start

On a clean Debian VM (12 "bookworm" or 13 "trixie", netinst + ssh, internet access), as root:

```bash
wget -O bootstrap.sh https://raw.githubusercontent.com/Korplin/forgejo-caddy-pages-bootstrap/main/bootstrap.sh && bash bootstrap.sh
```

Without `sudo` on the VM, become root first with `su -`. The first run takes a few minutes (apt, Docker, image pulls, one small image build). At the end the playbook prints a summary like:

```
Forgejo:        http://192.168.1.50:3000/
Pages:          http://192.168.1.50/<repo>/   (owner 'themes', branch 'main')
Push a site:    git push http://192.168.1.50:3000/themes/<repo>.git main
Accounts (also in /opt/forgejo-caddy-pages/credentials.txt): ...
```

Then, from any machine in the LAN with `git` and `curl`, publish and check a test site (use the password of the `themes` account from the summary):

```bash
bash test-publish.sh <vm-ip> '<themes-password>' hello-theme
# -> http://<vm-ip>/hello-theme/
```

## How it works

```
 browser ──HTTP :80──▶ Caddy ──▶ pages service (Node) ──Forgejo API──▶ Forgejo ──▶ repo themes/<repo>, branch main
                                       ▲                                 ▲
                                       │ in-memory cache (30 s)          │ git push (pipeline)
```

1. Your pipeline pushes a site to `http://<vm-ip>:3000/themes/<repo>.git`. The repository is created automatically on the first push (Forgejo "push to create" is enabled) and is public.
2. A request for `http://<vm-ip>/<repo>/some/path` reaches Caddy, which forwards it to the pages service.
3. The pages service maps it to the raw file `some/path` of `themes/<repo>` on branch `main` (`GET /api/v1/repos/themes/<repo>/raw/some/path?ref=main`), sets the correct `Content-Type`, and answers. Responses are cached in memory for `pages_cache_ttl_ms` (default 30 s), so a push is visible within about 30 seconds.
4. No configuration is needed per site: a new repo is a new website.

Pages service behaviour (`pages-service/server.js`, no npm dependencies, Node 18+):

| Request | Result |
|---|---|
| `/repo` | 301 to `/repo/` (relative asset links need the slash) |
| `/repo/` | `index.html` of the repo root |
| `/repo/about/` | `about/index.html` |
| `/repo/about` | 301 to `/repo/about/` if `about/index.html` exists, else the file `about` |
| missing file | `404.html` from the repo if present (status 404), else plain 404 |
| `/healthz` | `ok` (reserved name, so a repo cannot be called `healthz`) |
| not GET/HEAD | 405 |
| Forgejo unreachable | 502 |

Repo names are validated (`[A-Za-z0-9._-]`, must start with a letter or digit) and path traversal is rejected.

## Repository layout

| Path | Purpose |
|---|---|
| `bootstrap.sh` | The one-liner target. Becomes root, installs `git` + `ansible-core`, clones/updates this repo to `/opt/forgejo-caddy-pages-bootstrap`, runs the playbook. Extra arguments are passed to `ansible-playbook`. |
| `bootstrap-playbook.yml` | The single playbook (no roles). Installs Docker, writes the compose file and Caddyfile, starts the stack, creates the Forgejo accounts. Variables are at the top. |
| `pages-service/` | The Node service (`server.js`, `package.json`, `Dockerfile`). Built on the VM by Docker Compose. |
| `vars.example.yml` | Example variable overrides (copy to `vars.yml`, git-ignored). |
| `test-publish.sh` | Pushes a tiny test site and checks that it is served. |
| `README.md` | This file. Also the context document for further development. |

Files created on the VM:

| Path | Purpose |
|---|---|
| `/opt/forgejo-caddy-pages-bootstrap/` | Clone of this repository (what bootstrap.sh runs). |
| `/opt/forgejo-caddy-pages/compose.yml` | Generated compose file (do not edit, it is overwritten). |
| `/opt/forgejo-caddy-pages/caddy/Caddyfile` | Generated Caddyfile (do not edit, it is overwritten). |
| `/opt/forgejo-caddy-pages/pages-service/` | Copy of the service source used for the image build. |
| `/opt/forgejo-caddy-pages/data/forgejo/` | All Forgejo data: SQLite DB, repos, `app.ini`. **Back this up.** |
| `/opt/forgejo-caddy-pages/secrets/` | Generated secrets (Forgejo secret key, account passwords), mode 0700. |
| `/opt/forgejo-caddy-pages/credentials.txt` | Readable list of the account passwords, mode 0600. |

## Configuration

Defaults live in the `vars:` section of `bootstrap-playbook.yml`. Override with extra vars; both forms work through the bootstrap script:

```bash
bash bootstrap.sh -e pages_owner=mythemes -e pages_branch=main
bash bootstrap.sh -e @vars.yml        # file copied from vars.example.yml
```

| Variable | Default | Meaning |
|---|---|---|
| `stack_dir` | `/opt/forgejo-caddy-pages` | Where the stack lives on the VM. |
| `forgejo_image` | `codeberg.org/forgejo/forgejo:11` | Forgejo image/tag. Pin an exact version for production. |
| `caddy_image` | `caddy:2` | Caddy image. |
| `forgejo_http_port` | `3000` | Host port for the Forgejo web UI and git over HTTP. |
| `forgejo_admin_user` | `forgejo-admin` | Site administrator account (`admin` is a reserved name in Forgejo). |
| `pages_owner` | `themes` | The one user whose repos are served as websites. Created as a normal user. |
| `pages_branch` | `main` | Branch that is served. |
| `pages_cache_ttl_ms` | `30000` | Cache time in the pages service; also the maximum publish delay. |
| `host_ip` | detected default IPv4 | Used in generated URLs. |
| `forgejo_root_url` | `http://<host_ip>:3000/` | Forgejo `ROOT_URL`. |
| `pages_site_address` | `:80` | Caddy site address. `:80` = plain HTTP on the VM IP. A hostname enables automatic HTTPS. |
| `forgejo_site_address` | empty | If set (e.g. `git.example.com`), Caddy also reverse-proxies Forgejo on that name. |

Service-level settings of the pages service are environment variables (set in the compose template inside the playbook): `PAGES_OWNER`, `PAGES_BRANCH`, `FORGEJO_URL`, `CACHE_TTL_MS`; optional `FORGEJO_TOKEN` (for private repos), `MISS_TTL_MS`, `BROWSER_MAX_AGE_SECONDS`, `CACHE_MAX_BYTES`, `PORT`.

## Idempotency and re-running

`bash bootstrap.sh` can be run any number of times. Each step checks state first: apt packages and the Docker repo are declarative, generated files are only rewritten when their content changes, secrets are generated once and then reused, Forgejo accounts are only created if missing, the pages image is only rebuilt when its source changed, and Caddy is only reloaded when the Caddyfile changed. A second run without changes should report `changed=0`.

Updating to a new version of this repository = running the one-liner again (it fetches the latest `main` and re-applies).

## Operating the VM

```bash
cd /opt/forgejo-caddy-pages
docker compose ps
docker compose logs -f pages          # request log of the pages service
docker compose logs -f forgejo
docker compose logs -f caddy
docker compose restart pages
cat credentials.txt                   # account passwords
```

Reset everything (destroys all repos): `cd /opt/forgejo-caddy-pages && docker compose down -v && rm -rf data secrets credentials.txt`, then run the bootstrap again.

## Publishing from a pipeline

```bash
git init -b main && git add -A && git commit -m "site"
git push http://themes:<password>@<vm-ip>:3000/themes/<repo-name>.git main
# live at http://<vm-ip>/<repo-name>/ within ~30 s
```

Requirements for generated sites:

- Static files only; `index.html` at the repo root.
- Use **relative** asset links (`css/style.css`, not `/css/style.css`), because every site lives under `/<repo>/`.
- **Tailwind** is built per site in the pipeline, before the commit (for example `npx @tailwindcss/cli -i input.css -o css/style.css --minify`), and the built CSS is committed next to `index.html`. The server never builds anything.
- Repo name = URL path segment: letters, digits, `.`, `_`, `-`.
- Repos must be public (the default here), unless `FORGEJO_TOKEN` is configured for the pages service.

## Verification status

Honest state of this repository at the time it was written:

- Tested locally: the pages service (`node --check`, and behaviour against a mock Forgejo API: routing, redirects, 404 page, MIME types, method handling, path traversal), YAML syntax of the playbook, rendering of the generated compose file and Caddyfile, `bash -n` for both shell scripts.
- **Not yet tested on a real Debian VM:** the full bootstrap run, Docker installation, the Forgejo container configuration and the account creation. The first real run is the real test. Things most likely to need a fix, in this order:
  1. The Forgejo image tag in `forgejo_image` (check that it exists; override with `-e forgejo_image=...`).
  2. Forgejo environment settings (`FORGEJO__...` keys) and `INSTALL_LOCK` with a pre-set `SECRET_KEY` (a first-start error in `docker compose logs forgejo` would show it).
  3. `forgejo admin user create` flags (`--admin=true|false`, `--must-change-password=false`) for the chosen Forgejo version.
  4. The raw-file API path `/api/v1/repos/{owner}/{repo}/raw/{path}?ref={branch}` (check with `curl -i` against the VM).
  5. Push-to-create (`ENABLE_PUSH_CREATE_USER`) behaviour; fallback is creating the repo once via API/UI.

## Known limitations

- HTTP only, no TLS, no firewall, passwords in a root-only text file: intentional for the prototype.
- Single owner, single branch, hard wired. No custom domains per repo, no `gh-pages`-style branch selection.
- Forgejo is in the request path: if Forgejo is down, sites that are not in the cache return 502. Cache is per process and cleared on restart.
- Large files: files over 5 MB are not cached (set `CACHE_MAX_FILE_BYTES`) and are fully buffered in memory.
- No directory listing, no SPA fallback, no custom headers per site.
- Anything committed to a public repo is public (the `.git` folder itself is never served, because the service reads the Forgejo API).

## Next steps

Ordered roughly by value:

1. Run the first real bootstrap on the Proxmox VM and fix whatever the verification list above reveals.
2. Real domain + TLS: set `pages_site_address: themes.corepixen.com` and `forgejo_site_address: git.corepixen.com` plus `forgejo_root_url`, open ports 80/443, DNS records (Caddy then gets certificates automatically). Consider Cloudflare in front for caching.
3. Pipeline integration: API token for the pipeline instead of the account password; repo naming rules; Tailwind build step before the commit.
4. Security hardening: firewall, remove published port 3000 when Forgejo is proxied, restrict who can push, non-default admin name, backups of `data/forgejo`, pinned image versions.
5. Optional: cache invalidation by Forgejo webhook instead of TTL; ETag/conditional requests; per-repo config file (e.g. different published branch or folder).

## Conventions (for further development)

- Scripting languages: Bash and Node only. The service has no npm dependencies on purpose.
- One playbook file, no roles. Only `ansible.builtin` modules, so `ansible-core` is enough (no collections to install).
- Everything must stay idempotent; use `changed_when` honestly.
- Target: clean Debian netinst. `bootstrap.sh` is the only thing a human runs on the VM.
- Source of truth for deployed files is this repository; generated files on the VM are overwritten on every run.
