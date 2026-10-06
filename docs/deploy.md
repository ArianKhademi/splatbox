# Hosting the demo

The cheapest way to put the whole thing on a public URL is a machine you already own, kept on,
with a Cloudflare Tunnel in front of it. Nothing is exposed except the web container (nginx
serving the app and proxying `/api`); uploads and downloads go straight between the browser and
S3 as they do locally. Everything below runs on the host machine.

Before anything is public:

- **Rotate the secrets.** `API_TOKEN` and `SESSION_SECRET` in `.env` must not be the values from
  `docker-compose.yml` or the README. Anyone can browse; only the token can upload or delete.
- **Point `.env` at Amazon S3** (bucket, region, keys), as described in the README.

## 1. The stack, in Docker, on S3

```bash
docker compose -f docker-compose.yml -f docker-compose.aws.yml up -d --build
```

`docker-compose.aws.yml` swaps the MinIO container for the bucket in `.env`. Every service has
`restart: unless-stopped`, so the stack comes back when Docker does; turn on "Start Docker Desktop
when you sign in" and keep the machine from sleeping (Mac: System Settings → Energy → prevent
automatic sleeping when the display is off, and wake for network access).

The app is now on `http://localhost:${WEB_PORT:-8080}`. Browsing needs no sign-in; the token from
`.env` unlocks uploads.

Assets that were processed earlier by a native api and worker live in `./data/splatbox.sqlite`,
while the containers keep theirs in a Docker volume. To carry the existing catalogue over, stop
the native api and worker first (so the WAL is checkpointed), then:

```bash
docker compose cp data/splatbox.sqlite api:/data/splatbox.sqlite
```

```bash
docker compose restart api worker
```

The objects themselves are already in the bucket under the same asset ids.

On Apple Silicon the worker runs under emulation with CPU rendering: fine for a demo where only
the owner uploads, but expect a few minutes per turntable. `TURNTABLE_ENGINE=workbench` in `.env`
makes that about half a minute with flat shading.

## 2. The tunnel

Requires the domain's DNS to be on Cloudflare (free plan is enough). If it is not, Tailscale
Funnel or ngrok do the same job with their own hostnames.

```bash
brew install cloudflared
```

```bash
cloudflared tunnel login
```

```bash
cloudflared tunnel create splatbox
```

Note the tunnel id it prints and the credentials file it wrote (`~/.cloudflared/<id>.json`), then
give it a hostname:

```bash
cloudflared tunnel route dns splatbox splatbox.example.com
```

Write `~/.cloudflared/config.yml` (replace the id, hostname, and the port if `WEB_PORT` differs):

```yaml
tunnel: <tunnel id>
credentials-file: /Users/you/.cloudflared/<tunnel id>.json
ingress:
  - hostname: splatbox.example.com
    service: http://localhost:8080
  - service: http_status:404
```

Try it in the foreground first:

```bash
cloudflared tunnel run splatbox
```

When `https://splatbox.example.com` loads, install it as a system service so it survives reboots.
The service runs as root and reads `/etc/cloudflared/config.yml`, so copy the config there first:

```bash
sudo mkdir -p /etc/cloudflared && sudo cp ~/.cloudflared/config.yml /etc/cloudflared/config.yml
```

```bash
sudo cloudflared service install
```

Check `cloudflared tunnel info <name>` lists a connector. If it does not, and
`/Library/Logs/com.cloudflare.cloudflared.err.log` repeats `use cloudflared tunnel run to start
tunnel`, the launch item (cloudflared 2026.10 on macOS) was written without the `tunnel run`
arguments. Add them and reload it:

```bash
sudo /usr/libexec/PlistBuddy -c "Add :ProgramArguments:1 string tunnel" -c "Add :ProgramArguments:2 string run" /Library/LaunchDaemons/com.cloudflare.cloudflared.plist
```

```bash
sudo launchctl bootout system/com.cloudflare.cloudflared && sudo launchctl bootstrap system /Library/LaunchDaemons/com.cloudflare.cloudflared.plist
```

(`launchctl kickstart` is not enough after editing a plist; it restarts the definition launchd
already has loaded.) One tunnel can carry several hostnames, each as its own `ingress` entry
pointing at a different local port, so a second app on the same machine needs no second tunnel.

## 3. Let the browser talk to the bucket from the new origin

Add the public origin to `AllowedOrigins` in `docs/s3-cors.json` and apply it again:

```bash
aws s3api put-bucket-cors --bucket "$S3_BUCKET" --cors-configuration file://docs/s3-cors.json
```

Without this the grid still shows thumbnails (plain `<img>` loads are not subject to CORS), but
the viewer cannot fetch models and uploads fail.

## 4. Check it the way a visitor would

Open the URL from another device: the grid should load without signing in, an asset should open
in the viewer, and hovering a card should play its turntable. Then prove the write path once:

```bash
STACK_URL=https://splatbox.example.com API_TOKEN=<token from .env> npx playwright test stack --config web/playwright.config.ts
```

That uploads a small rigged model, waits for the convert and turntable jobs, opens it, and deletes it.
