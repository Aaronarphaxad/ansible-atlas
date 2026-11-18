"""Smoke tests for Ansible Atlas, run against example-repo/.

    python -m unittest discover -s tests -v
"""
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import atlas  # noqa: E402

EXAMPLE = ROOT / "example-repo"
# Fake PEM markers, assembled at runtime so this file never contains a literal
# private-key header (the pre-commit hook and CI would rightly block it).
PEM_BEGIN = "-----BEGIN RSA " + "PRIVATE KEY-----"
PEM_END = "-----END RSA " + "PRIVATE KEY-----"


class AtlasTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.model = atlas.Atlas(EXAMPLE).build()
        cls.E = cls.model["entities"]

    def test_counts(self):
        c = self.model["meta"]["counts"]
        self.assertEqual(c["script"], 3)
        self.assertEqual(c["playbook"], 4)
        self.assertEqual(c["play"], 5)
        self.assertEqual(c["role"], 4)
        self.assertGreaterEqual(c["template"], 3)

    def test_default_inventory_from_cfg(self):
        self.assertTrue(self.E["inv:inventories/staging"]["default"])

    def test_host_pattern_exclusion(self):
        play = self.E["play:playbooks/web.yml#0"]
        hosts = play["resolved"]["inv:inventories/staging"]["hosts"]
        self.assertEqual(hosts, ["host:inv:inventories/staging:app-stg-web01"])

    def test_host_var_precedence(self):
        h = self.E["host:inv:inventories/staging:app-stg-web01"]
        port = next(v for v in h["vars"] if v["k"] == "http_port")
        self.assertEqual(port["v"], 9090)            # host_vars beats group var
        self.assertEqual(port["overridden"][0]["v"], 8080)

    def test_redaction_and_vault(self):
        h = self.E["host:inv:inventories/staging:app-stg-web01"]
        pw = next(v for v in h["vars"] if v["k"] == "db_password")
        self.assertIn("redacted", pw["v"])
        self.assertIn("inventories/staging/group_vars/all/vault.yml", self.model["meta"]["encrypted_files"])

    def test_variable_usage_index(self):
        v = self.E["var:http_port"]
        self.assertEqual(len(v["defs"]), 3)
        ctxs = {u["ctx"] for u in v["uses"]}
        self.assertIn("template", ctxs)
        self.assertIn("args.port", ctxs)
        reg = self.E["var:pm2_out"]
        self.assertEqual(reg["defs"][0]["kind"], "registered result")
        self.assertEqual(reg["uses"][0]["ctx"], "changed_when:")

    def test_template_refs_exclude_loop_vars(self):
        t = self.E["tpl:roles/nginx/templates/site.conf.j2"]
        self.assertIn("app_port", t["refs"])
        self.assertNotIn("host", t["refs"])           # {% for host in ... %}
        self.assertTrue(t["used_by"])

    def test_tag_inheritance(self):
        steps = self.model["plans"]["pb:playbooks/web.yml"][0]["steps"]
        by_label = {self.E[s["t"]]["label"]: s for s in steps}
        self.assertEqual(by_label["Deploy site config"]["tags"], ["config", "nginx"])  # task + roles: entry
        self.assertIn("never", by_label["Open firewall for HTTP"]["tags"])

    def test_role_dependency_runs_once(self):
        steps = self.model["plans"]["pb:playbooks/web.yml"][0]["steps"]
        notes = [s.get("note") or "" for s in steps]
        self.assertTrue(any("already ran" in n for n in notes))

    def test_jinja_refs(self):
        self.assertEqual(atlas.expr_refs("foo | default(bar) and baz is defined"), {"foo", "bar", "baz"})
        self.assertEqual(atlas.expr_refs("x.y['z'] + lookup('env', 'HOME')"), {"x"})
        self.assertEqual(set(atlas.text_refs("{% for a in items %}{{ a.b }}{{ c }}{% endfor %}")), {"items", "c"})

    def test_render_marks_and_locks_down_output(self):
        html = atlas.render_html(self.model, atlas.TEMPLATE)
        self.assertIn(atlas.GENERATED_MARKER, html)
        self.assertIn("default-src 'none'", html)
        self.assertNotIn(atlas.GENERATED_MARKER, atlas.TEMPLATE.read_text())

    def test_scripts_and_how_they_run(self):
        sc = {e["path"]: e for e in self.E.values() if e["type"] == "script"}
        self.assertEqual(sc["roles/app/files/healthcheck.sh"]["summary"], ["Uploaded to and run on the target hosts"])
        self.assertEqual(sc["scripts/backup-db.sh"]["summary"], ["Run on the control node"])
        self.assertIn("Not referenced", sc["scripts/rotate-logs.sh"]["summary"][0])

    def test_localhost_play_is_control_node(self):
        play = next(e for e in self.E.values() if e["type"] == "play" and e.get("hosts") == "localhost")
        self.assertIsNone(play["resolved"]["inv:inventories/staging"]["hosts"])
        self.assertNotIn("no-hosts", {f["rule"] for f in self.model["findings"]})

    def test_checks(self):
        rules = {f["rule"] for f in self.model["findings"]}
        self.assertIn("plaintext-secret", rules)
        self.assertIn("undefined-var", rules)
        self.assertIn("unused-var", rules)
        self.assertNotIn("unknown-handler", rules)

    def test_files_embedded_and_redacted(self):
        f = self.model["files"]["inventories/staging/group_vars/all/main.yml"]
        self.assertIn("db_password: " + atlas.REDACTED, f["text"])
        self.assertTrue(self.model["files"]["inventories/staging/group_vars/all/vault.yml"]["encrypted"])
        self.assertNotIn("text", self.model["files"]["inventories/staging/group_vars/all/vault.yml"])

    def test_redact_text(self):
        src = ("api_token: abc123\nuser: bob\nDB_PASSWORD=hunter2 ./run.sh\nkey: \"{{ vault_key }}\"\n"
               "private_key: |\n  line1\n  line2\nnext: 1\n" + PEM_BEGIN + "\nMIIE\n" + PEM_END)
        out = atlas.redact_text(src)
        self.assertNotIn("abc123", out)
        self.assertNotIn("hunter2", out)
        self.assertNotIn("line1", out)
        self.assertNotIn("MIIE", out)
        self.assertIn("user: bob", out)
        self.assertIn("{{ vault_key }}", out)
        self.assertIn("next: 1", out)

    def test_cli_writes_file(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "map.html"
            atlas.main([str(EXAMPLE), "-o", str(out)])
            html = out.read_text(encoding="utf-8")
            self.assertIn(atlas.GENERATED_MARKER, html)
            self.assertEqual(sorted(x.name for x in Path(d).iterdir()), ["map.html"])   # nothing else written

    def test_no_export_options(self):
        for flag in ("--markdown", "--json"):
            with self.assertRaises(SystemExit):
                atlas.main([str(EXAMPLE), flag, "x"])

    def test_paths_use_forward_slashes(self):
        self.assertTrue(all("\\" not in k for k in self.model["files"]))


if __name__ == "__main__":
    unittest.main()
