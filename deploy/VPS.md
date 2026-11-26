# Hosting Plimsoll di VPS

Panduan untuk VPS Ubuntu 22.04 atau 24.04. Website disajikan oleh Nginx dengan HTTPS dari Let's Encrypt, dan agen berjalan sebagai service systemd.

Ganti `domainmu.com` dan `IP_VPS` dengan milikmu.

## 1. Arahkan domain ke VPS

Di panel registrar domain, buat dua record DNS:

| Type | Name | Value |
|---|---|---|
| A | `@` | IP_VPS |
| A | `www` | IP_VPS |

Perubahan DNS bisa butuh beberapa menit sampai beberapa jam. Cek dari PowerShell, hasilnya harus menunjukkan IP VPS:

```powershell
Resolve-DnsName domainmu.com
```

## 2. Kirim file ke VPS

Dari folder proyek di komputermu, bungkus proyek tanpa `node_modules` dan tanpa file rahasia, lalu kirim ke VPS:

```powershell
tar -czf plimsoll.tgz --exclude=node_modules --exclude=.env --exclude=artifacts --exclude=cache --exclude=agent/state .
```

```powershell
scp plimsoll.tgz root@IP_VPS:/tmp/
```

## 3. Setup VPS (sekali saja)

Masuk ke VPS:

```powershell
ssh root@IP_VPS
```

Lalu jalankan di VPS:

```bash
mkdir -p /tmp/plimsoll && tar -xzf /tmp/plimsoll.tgz -C /tmp/plimsoll
bash /tmp/plimsoll/deploy/setup-vps.sh domainmu.com emailmu@contoh.com
```

Script ini memasang Nginx, Node.js 22, dan certbot, mengaktifkan firewall, lalu mengambil sertifikat HTTPS. Langkah ini hanya berhasil kalau DNS di langkah 1 sudah mengarah ke VPS.

## 4. Deploy kontrak (dari komputermu, bukan dari VPS)

Private key deployer tidak perlu ada di VPS. Jalankan di komputermu:

```powershell
npx hardhat run scripts/deploy.js --network robinhood
```

```powershell
node scripts/sync-web-config.js robinhood
```

Ulangi langkah 2 (bungkus dan kirim) supaya `web/config.js` di VPS berisi alamat vault.

## 5. Pasang website dan agen di VPS

```bash
rm -rf /tmp/plimsoll && mkdir -p /tmp/plimsoll && tar -xzf /tmp/plimsoll.tgz -C /tmp/plimsoll
cp -r /tmp/plimsoll/web/* /var/www/plimsoll/
rsync -a --exclude agent/state /tmp/plimsoll/ /opt/plimsoll/
cd /opt/plimsoll && npm ci --omit=optional && npx hardhat compile
chown -R plimsoll:plimsoll /opt/plimsoll
```

Buat file rahasia agen. File ini hanya bisa dibaca user `plimsoll`:

```bash
nano /opt/plimsoll/.env.agent
```

Isinya, dengan nilai milikmu:

```
AGENT_KEY=private key wallet agen
VAULT_ADDRESS=alamat vault dari deployments/robinhood.json
ANTHROPIC_API_KEY=API key Anthropic
ROBINHOOD_RPC=https://rpc.nodeflare.app/robinhood/public
```

```bash
chown plimsoll:plimsoll /opt/plimsoll/.env.agent && chmod 600 /opt/plimsoll/.env.agent
```

Coba dulu agen tanpa mengirim transaksi:

```bash
cd /opt/plimsoll && sudo -u plimsoll env $(cat .env.agent | xargs) DRY_RUN=1 ONCE=1 node agent/agent.mjs
```

Kalau rencananya masuk akal, nyalakan service-nya:

```bash
systemctl enable --now plimsoll-agent
journalctl -u plimsoll-agent -f
```

## 6. Update berikutnya

Untuk memperbarui website: bungkus dan kirim ulang (langkah 2), lalu jalankan `cp -r /tmp/plimsoll/web/* /var/www/plimsoll/`.

Untuk memperbarui agen: jalankan ulang perintah `rsync` di langkah 5, lalu `systemctl restart plimsoll-agent`. Folder `agent/state` tidak ikut tertimpa, jadi rencana yang sudah disegel tetap aman.
