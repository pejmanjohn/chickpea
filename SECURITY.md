# Security policy

## Reporting a vulnerability

Use [GitHub's private vulnerability report form](https://github.com/pejmanjohn/chickpea/security/advisories/new).
Do not put vulnerabilities, working credentials, private Slack content, or
exploit details in a public issue or pull request.

Include the affected commit or release, deployment target (Node or Cloudflare),
reproduction steps using synthetic data, expected and actual behavior, and the
security impact. Redact tokens, setup links, cookies, workspace identities, and
tool inputs/outputs. Keep any proof of concept confined to a deployment you own.

If private reporting is unavailable, open a public issue asking for a private
contact channel without disclosing the vulnerability.

## Supported versions

Before the first tagged release, fixes target `main` on a best-effort basis.
After release, security fixes target the latest published release; older 0.x
versions do not have a separate maintenance branch. There is no response-time
SLA. Review release notes and the [upgrade procedure](docs/runbooks/operations.md)
before upgrading a stateful deployment.

## Operator responsibilities

Chickpea holds Slack and provider credentials and can execute authorized tool
actions. Use HTTPS, least-privilege connections, protected backups, and a
dedicated deployment identity. Retain the auth secret and credential keyring
across restarts. Restrict access to logs, local databases, and Cloudflare account
resources. Rotate exposed credentials even if a commit containing them is
removed from Git history.

See [authentication](docs/authentication.md), [gateway data handling](docs/shared-gateway-data-handling.md),
and [telemetry](TELEMETRY.md) for the applicable trust and retention boundaries.
