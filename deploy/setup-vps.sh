#!/usr/bin/env bash
# Adds the Plimsoll site and agent to an Ubuntu VPS. Additive only: it never removes or edits
# other Nginx sites, certificates, firewall rules or services. Run with sudo:
#   sudo bash setup-vps.sh plimsollvault.com [email-for-certbot]
set -euo pipefail

DOMAIN="${1:?usage: sudo bash setup-vps.sh <domain> [email-for-certbot]}"
EMAIL="${2:-}"   # optional when certbot already has an account on this server
SRC="${SRC:-/tmp/plimsoll}"

command -v nginx >/dev/null || { apt-get update; apt-get install -y nginx; }
command -v certbot >/dev/null || { apt-get update; apt-get install -y certbot python3-certbot-nginx; }
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "Node.js 20+ is required for the agent. Install it, then rerun." >&2; exit 1
fi

id plimsoll >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin plimsoll
mkdir -p /var/www/plimsoll /opt/plimsoll/agent/state
chown -R plimsoll:plimsoll /opt/plimsoll

# Nginx: one new snippet and one new site file, checked before reload
cp "$SRC/deploy/plimsoll-headers.conf" /etc/nginx/snippets/plimsoll-headers.conf
if [ ! -f /etc/nginx/sites-available/plimsoll ]; then
  sed "s/example.com/${DOMAIN}/g" "$SRC/deploy/nginx-plimsoll.conf" > /etc/nginx/sites-available/plimsoll
fi
ln -sf /etc/nginx/sites-available/plimsoll /etc/nginx/sites-enabled/plimsoll
[ -f /var/www/plimsoll/index.html ] || cp -r "$SRC/web/"* /var/www/plimsoll/
nginx -t
systemctl reload nginx

# Firewall: only add the web rule if ufw is active and lacks it
if ufw status | grep -q "Status: active" && ! ufw status | grep -q "Nginx Full"; then ufw allow 'Nginx Full'; fi

# HTTPS for this domain only
if [ ! -d "/etc/letsencrypt/live/${DOMAIN}" ]; then
  certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" --non-interactive --agree-tos ${EMAIL:+-m "$EMAIL"} --redirect
fi

cp "$SRC/deploy/plimsoll-agent.service" /etc/systemd/system/plimsoll-agent.service
systemctl daemon-reload
echo "Plimsoll site is set up for ${DOMAIN}. The agent service is installed but not started."
