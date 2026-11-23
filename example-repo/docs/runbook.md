---
owner: ops
reviewed: 2026-11-01
---

# Web tier runbook

Notes for the **staging web tier**. See also the [database notes](db-notes.md) and the
[site playbook](../site.yml). External references like the
[Ansible docs](https://docs.ansible.com) are shown but never opened from the map.

<!-- internal: remember to update after the next release -->

## Deploy

1. Check the inventory: `inventories/staging/hosts.yml`
2. Run the playbook:

   ```bash
   ansible-playbook -i inventories/staging site.yml --tags config
   ```

3. Confirm the health check passes
   - `curl -f http://localhost:3000/health`
   - see [roles/app/files/healthcheck.sh](../roles/app/files/healthcheck.sh)

## Checklist

- [x] TLS certs renewed
- [ ] Firewall rules reviewed (`--tags firewall`, tagged *never*)
- [ ] Backups verified with `scripts/backup-db.sh`

## Hosts

| Host | Role | Port |
|:-----|:----:|-----:|
| app-stg-web01 | primary | 9090 |
| app-stg-web02 | standby | 8080 |

> **Note:** web02 is excluded from `playbooks/web.yml` on purpose
> (`hosts: web:!app-stg-web02`).

---

Raw HTML is shown as text, not run: <script>alert(1)</script>

Jump back to [Deploy](#deploy). ~~Old procedure~~ retired.
