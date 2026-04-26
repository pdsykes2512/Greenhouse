# Greenhouse — Cloudflare Tunnel setup

This exposes the local Node dashboard (port 3000) at a public hostname over
HTTPS, with no port forwarding and no public IP needed. You also get free
DDoS / rate-limiting protection and the option to put Cloudflare Access auth
in front of it later.

## Prerequisites

- Cloudflare account (free tier is fine)
- A domain on Cloudflare (also free if you transfer one in or use a Cloudflare
  Registrar domain)
- Root / sudo on the box that runs the Node server

## One-time setup

### 1. Install `cloudflared`

```bash
# Debian/Ubuntu
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb
sudo dpkg -i /tmp/cloudflared.deb

# Or pull the static binary directly
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
     -o /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared
```

### 2. Authenticate (browser interactive — needs to happen on your machine)

```bash
cloudflared tunnel login
```

This opens a browser to your Cloudflare account, where you pick which zone
(domain) the tunnel will live under. A cert is dropped into `~/.cloudflared/`.

### 3. Create the tunnel

```bash
cloudflared tunnel create greenhouse
```

Note the **UUID** it prints — you'll need it in the config. The credentials
file lands at `~/.cloudflared/<UUID>.json`.

### 4. Configure ingress

Copy the template and edit:

```bash
sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/<UUID>.json /etc/cloudflared/
sudo cp cloudflare/config.yml.example /etc/cloudflared/config.yml
sudo nano /etc/cloudflared/config.yml
```

In the file, replace:
- `<UUID>` (twice — `tunnel:` and `credentials-file:`) with the UUID from step 3
- `greenhouse.example.com` with your chosen public hostname

### 5. Route DNS to the tunnel

```bash
cloudflared tunnel route dns greenhouse greenhouse.example.com
```

This creates a CNAME record in Cloudflare DNS pointing your hostname at the
tunnel. Replace the hostname with whatever you used in `config.yml`.

### 6. Test in foreground first

```bash
sudo cloudflared --config /etc/cloudflared/config.yml tunnel run
```

Visit `https://greenhouse.example.com` in a browser. You should see the
dashboard. Ctrl+C to stop.

### 7. Install as a systemd service

```bash
sudo cp cloudflare/cloudflared.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cloudflared
sudo systemctl status cloudflared
```

It will now start on boot and restart on failure.

## Useful commands

```bash
# View live tunnel logs
sudo journalctl -u cloudflared -f

# List tunnels
cloudflared tunnel list

# Delete tunnel (e.g. if recreating)
cloudflared tunnel delete greenhouse
```

## Optional: Cloudflare Access (auth in front of the dashboard)

Cloudflare's free Zero Trust tier lets you require email-based one-time-PIN
or Google/GitHub OAuth before anyone can reach the dashboard. Setup is in
the Cloudflare dashboard → Zero Trust → Access → Applications → Add an
application → Self-hosted, then add your hostname and a policy (e.g.
"emails ending in @yourdomain.com").

Once enabled, the tunnel itself is unchanged — Cloudflare Access enforces
auth at the edge before traffic reaches your server.
