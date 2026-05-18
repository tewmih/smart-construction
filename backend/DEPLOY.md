# Backend deployment — AWS (EC2 + RDS) with Docker + Caddy

End-to-end runbook for taking the Foresite backend from zero to `https://api.yourdomain.com`. Target: single-AZ, single-instance v1. Costs ~$30/mo on AWS.

---

## 1 — Prep before AWS

These should already be in place from earlier prod hardening:

- [x] `ENV=production` boots reject `*` CORS and the dev `SECRET_KEY`
- [x] `start.sh` does **not** run alembic — schema sync lives in the FastAPI lifespan handler
- [x] `/health` endpoint for HEALTHCHECK + Caddy
- [x] `docker-compose.yml` binds the container to `127.0.0.1:8000` (Caddy is the only public face)
- [x] `.env.example` documents every required var

Generate your production `SECRET_KEY` now:

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

Save it — you'll paste it into the EC2 `.env` shortly.

---

## 2 — RDS PostgreSQL

In the AWS Console → **RDS** → Create database:

| Field | Value |
|---|---|
| Engine | PostgreSQL 16 |
| Template | Free tier (or Production for prod) |
| Instance | `db.t4g.micro` (free tier eligible) |
| Storage | gp3, 20 GB |
| Multi-AZ | **Off** (v1) |
| Public access | **No** — only EC2 talks to it |
| VPC security group | create `foresite-rds-sg` |
| Backup retention | 7 days |
| Master username | `postgres` |
| Master password | generate + save in a password manager |

After it's `Available`, copy the **endpoint** — looks like `foresite-db.cxxxx.eu-west-1.rds.amazonaws.com`.

Build the DATABASE_URL:
```
postgresql://postgres:<password>@<endpoint>:5432/postgres
```

---

## 3 — EC2 instance

Console → **EC2** → Launch instance:

| Field | Value |
|---|---|
| AMI | Ubuntu 22.04 LTS |
| Instance type | `t3.small` (2 GB RAM — fits ML model) |
| Key pair | create + save the `.pem` locally |
| Network | default VPC, public subnet |
| Auto-assign public IP | yes |
| Security group | create `foresite-ec2-sg` (rules below) |
| Storage | 30 GB gp3 |

### Security group rules

**`foresite-ec2-sg` inbound:**

| Port | Source | Purpose |
|---|---|---|
| 22 | your IP/32 | SSH |
| 80 | 0.0.0.0/0 | HTTP (Caddy ACME challenge) |
| 443 | 0.0.0.0/0 | HTTPS |

**`foresite-rds-sg` inbound:**

| Port | Source | Purpose |
|---|---|---|
| 5432 | `foresite-ec2-sg` | EC2 → RDS only |

Never expose RDS to the internet.

---

## 4 — Install Docker + Caddy on EC2

SSH in:

```bash
ssh -i foresite.pem ubuntu@<ec2-public-ip>
```

Install Docker:

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-v2 caddy
sudo usermod -aG docker ubuntu
exit   # re-SSH so the group change takes effect
```

Re-SSH, verify:

```bash
docker --version          # 24+
docker compose version    # v2+
caddy version             # 2.7+
```

---

## 5 — Clone + configure the backend

```bash
sudo mkdir -p /opt/foresite
sudo chown -R ubuntu:ubuntu /opt/foresite
cd /opt/foresite
git clone https://github.com/temesgen-abebayehu/smart-construction.git .
cd backend
cp .env.example .env
nano .env
```

Fill in `.env` with the real values:

```ini
ENV=production
SECRET_KEY=<the urlsafe token you generated earlier>
DATABASE_URL=postgresql://postgres:<pw>@<rds-endpoint>:5432/postgres
BACKEND_CORS_ORIGINS=https://smart-construction-zeta.vercel.app
FRONTEND_URL=https://smart-construction-zeta.vercel.app
GOOGLE_CLIENT_ID=<same as Vercel NEXT_PUBLIC_GOOGLE_CLIENT_ID>
RESEND_API_KEY=<from resend.com>
RESEND_FROM_EMAIL=Foresite <onboarding@resend.dev>
CLOUDINARY_CLOUD_NAME=<from cloudinary.com>
CLOUDINARY_API_KEY=<from cloudinary>
CLOUDINARY_API_SECRET=<from cloudinary>
```

> **Tip:** if you later add a custom domain (e.g. `foresite.com`), update both
> `BACKEND_CORS_ORIGINS` and `FRONTEND_URL`. The Vercel preview URLs
> (`https://smart-construction-zeta-*-yourname.vercel.app`) won't match a fixed
> entry — if you want previews to call this API, add a comma-separated entry for
> the specific preview URL or temporarily widen CORS for testing.

Lock the file down (it has secrets):

```bash
chmod 600 .env
```

---

## 6 — First boot

```bash
cd /opt/foresite/backend
docker compose up -d --build
```

Wait ~60 seconds (Docker pulls Python image, downloads the 52MB ML model, runs migrations), then check:

```bash
docker compose ps                          # should show "healthy"
docker compose logs -f backend             # should see "Application startup complete."
curl http://localhost:8000/health          # {"status":"ok"}
```

If it crashed, check:

- `docker compose logs backend` — most failures are missing env vars
- `nano .env` to fix, then `docker compose up -d` to restart

---

## 7 — Domain + HTTPS via Caddy

Point your DNS:

| Record | Value | TTL |
|---|---|---|
| A | `api.yourdomain.com` → `<ec2 public ip>` | 300 |

Wait 1–5 min for DNS to propagate (`dig api.yourdomain.com` to verify).

Then write the Caddy config:

```bash
sudo nano /etc/caddy/Caddyfile
```

Replace its content with:

```
api.yourdomain.com {
    reverse_proxy localhost:8000
    encode gzip
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
    }
    log {
        output file /var/log/caddy/api.log
        format json
    }
}
```

Reload Caddy:

```bash
sudo systemctl reload caddy
sudo systemctl status caddy
```

Caddy automatically provisions a Let's Encrypt cert on first request. Verify:

```bash
curl https://api.yourdomain.com/health      # {"status":"ok"}
```

If you get a 502, check:
- `sudo journalctl -u caddy --since "5 min ago"` — usually a port mismatch or DNS not propagated yet

---

## 8 — Wire up Vercel

In the Vercel dashboard:

1. Project Settings → Environment Variables → set **all three environments**:
   ```
   NEXT_PUBLIC_API_BASE_URL = https://api.yourdomain.com/api/v1
   ```
2. Deployments → Redeploy (env changes need a fresh build).
3. Open `https://<your-project>.vercel.app` → try logging in.

Also update Google Cloud Console:
- OAuth client → **Authorized JavaScript origins**:
  - `https://smart-construction-zeta.vercel.app` (your production frontend)
  - Any custom domain you add later (e.g. `https://foresite.com`)

---

## 9 — Redeploys (going forward)

```bash
ssh ubuntu@<ec2>
cd /opt/foresite
git pull
cd backend
docker compose build --no-cache backend
docker compose up -d
```

Brief blip (~10s) while the new container starts. For zero-downtime later, see "Scaling up" below.

---

## 10 — Recommended hardening (do these after first user)

### CloudWatch logs (so you don't lose history when EC2 restarts)

```yaml
# in docker-compose.yml
logging:
  driver: awslogs
  options:
    awslogs-region: eu-west-1
    awslogs-group: foresite-backend
    awslogs-create-group: "true"
```

Plus IAM role on EC2 with `CloudWatchAgentServerPolicy` attached.

### Daily RDS snapshot

Console → RDS → your instance → Maintenance & backups → ensure 7-day retention. Done.

### Fail2ban for SSH brute-force

```bash
sudo apt install -y fail2ban
sudo systemctl enable --now fail2ban
```

### Restrict SSH to your IP only

Edit the EC2 security group → SSH rule → change source from your single IP to a small office range.

---

## Scaling up — when you outgrow v1

| Trigger | Move |
|---|---|
| > 100 concurrent users | EC2 `t3.medium` |
| Want zero-downtime deploys | ALB in front of 2× EC2 (auto-scaling group) |
| Reports getting slow | Move ML inference to a sidecar container |
| Database becoming bottleneck | RDS read replica + `db.t4g.medium` |
| Compliance / DR | RDS Multi-AZ |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `SECRET_KEY is still the public dev default` | `.env` SECRET_KEY blank | generate one + paste into `.env` |
| `BACKEND_CORS_ORIGINS contains '*' in production` | env not set | put your Vercel URL in `.env` |
| Caddy returns 502 | backend container not up | `docker compose logs backend` |
| API requests from Vercel fail with CORS | `BACKEND_CORS_ORIGINS` missing your exact Vercel URL | check the URL in browser network tab, copy verbatim |
| Login works but Google Sign-In fails | OAuth origins | add your Vercel URL to Google Cloud Console |
| Photo uploads return 500 | Cloudinary not configured | set CLOUDINARY_* in `.env` and `docker compose restart backend` |
| ML predictions wrong | model not loaded | look for "predictor: failed to load" in logs; check `ml/rf_classifier.pkl` exists |
