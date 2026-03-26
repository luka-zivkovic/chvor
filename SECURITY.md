# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| latest  | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in Chvor, please report it responsibly.

**Do not open a public issue.**

Instead, please email **luka@chvor.dev** with:

1. A description of the vulnerability
2. Steps to reproduce it
3. The potential impact
4. Any suggested fix (optional)

### What to expect

- **Acknowledgment** within 48 hours
- **Initial assessment** within 7 days
- **Fix or mitigation** for confirmed vulnerabilities as soon as possible, typically within 30 days

We will credit reporters in the release notes unless they prefer to remain anonymous.

## Security Design

Chvor takes security seriously as a self-hosted personal AI:

- **Authentication** is opt-in via the Settings UI (password or PIN/passphrase)
  - Sessions use HttpOnly cookies with 30-day expiry
  - API keys for programmatic access (format: `chvor_...`)
  - Recovery key generated at setup for password reset
  - Brute-force protection: 5 failed attempts triggers 5-minute lockout
  - CLI reset available: `chvor auth reset`
- **Credentials** are encrypted at rest with AES-256-GCM
- **CORS** is configurable via `ALLOWED_ORIGINS` (with credentials support)
- **Sensitive data** is automatically redacted from logs and chat output
- **File uploads** are authenticated and size-limited
- **SSRF protection** blocks requests to private/internal IP ranges
- **Backup & Recovery**: Full instance snapshots (DB + encryption key + skills + tools) with optional scheduled auto-backup
- **CSRF protection**: Session cookies use `SameSite=Strict`, which prevents cross-origin request forgery in all modern browsers. For deployments on shared domains or subdomains, consider adding a reverse proxy with additional CSRF headers.

## Best Practices for Self-Hosting

1. Enable authentication in Settings > Security (especially if exposed to a network)
2. Configure `ALLOWED_ORIGINS` to your domain
3. Run behind a reverse proxy (nginx, Caddy) with TLS
4. Keep the `.encryption-key` file secure and backed up
5. Save your recovery key in a safe location
6. Enable scheduled backups in Settings > Backup
7. Regularly update to the latest version
