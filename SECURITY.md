# Security

## Reporting a vulnerability

Please report security issues privately, using GitHub's **Report a vulnerability** button on this repository's *Security* tab, rather than in a public issue. Include the steps to reproduce the issue and, if you can, a minimal Ansible repo that triggers it. Don't attach real inventories or generated maps.

## What Ansible Atlas protects against

| Threat | Protection |
|---|---|
| The page contacting the network | CSP `default-src 'none'`: the browser blocks every request. |
| Repo content running as code in the page | All repo text is inserted as text, never as HTML. The CSP also allows only the viewer's own script (by SHA-256 hash), and the embedded JSON escapes `</` and `<!--`. |
| A repo reading files outside itself | Symlinks and include paths that resolve outside the repo (or its `ansible.cfg` `roles_path`) are skipped. A `roles_path` of `/` or your home folder is ignored. |
| A repo hanging or crashing the scan | `SafeLoader` only; YAML alias bombs and very deeply nested documents are rejected; files over 2 MB are skipped; embedded sources are capped. |
| Secrets ending up in the map | Vault is never decrypted. Key and `.env` files are never embedded. Secret-looking values are masked unless you pass `--no-redact`. |
| A map being committed or shared by accident | Output is `0600` and marked as generated. The `.gitignore` allowlist, `.githooks/pre-commit`, CI and a warning from `atlas.py` all block committing it. |
| A compromised dependency in CI | Read-only token; the action is pinned to a commit hash; the token isn't kept after checkout. |

## Limits to be aware of

- **Redaction is a best-effort safety net, not a guarantee.** It works on variable *names* (`password`, `token`, `*_key` …). A secret stored under an innocent name, such as `db_conn: "postgres://u:hunter2@…"`, is shown. Treat every map as confidential, and use `--no-sources` to leave file contents out entirely.
- A generated map holds real hostnames, IPs and values. Anyone who has the file can read them. Share it only as you would share the repo itself.
- `atlas.py` runs with your permissions. Point it at repos you'd be willing to open in an editor.
- The only runtime dependency is PyYAML, used through `SafeLoader` (the known PyYAML vulnerabilities affect `FullLoader` / `yaml.load` without a safe loader). Use an up-to-date PyYAML anyway, e.g. the one that ships with Ansible.
