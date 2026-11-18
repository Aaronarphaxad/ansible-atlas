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


class AtlasTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.model = atlas.Atlas(EXAMPLE).build()
        cls.E = cls.model["entities"]

    def test_parses_the_example_repo(self):
        c = self.model["meta"]["counts"]
        self.assertEqual((c["playbook"], c["role"], c["script"]), (4, 4, 3))
        self.assertTrue(self.E["inv:inventories/staging"]["default"])   # from ansible.cfg

    def test_host_patterns_and_variable_precedence(self):
        play = self.E["play:playbooks/web.yml#0"]   # hosts: web:!app-stg-web02
        self.assertEqual(play["resolved"]["inv:inventories/staging"]["hosts"],
                         ["host:inv:inventories/staging:app-stg-web01"])
        port = next(v for v in self.E["host:inv:inventories/staging:app-stg-web01"]["vars"] if v["k"] == "http_port")
        self.assertEqual(port["v"], 9090)            # host_vars beats the group value (8080)

    def test_variable_usage(self):
        ctxs = {u["ctx"] for u in self.E["var:http_port"]["uses"]}
        self.assertTrue({"template", "args.port"} <= ctxs)

    def test_tags_are_inherited(self):
        steps = self.model["plans"]["pb:playbooks/web.yml"][0]["steps"]
        deploy = next(s for s in steps if self.E[s["t"]]["label"] == "Deploy site config")
        self.assertEqual(deploy["tags"], ["config", "nginx"])   # task tag + roles: entry tag

    def test_scripts(self):
        how = {e["path"]: e["summary"][0] for e in self.E.values() if e["type"] == "script"}
        self.assertEqual(how["scripts/backup-db.sh"], "Run on the control node")
        self.assertIn("Not referenced", how["scripts/rotate-logs.sh"])

    def test_checks(self):
        rules = {f["rule"] for f in self.model["findings"]}
        self.assertTrue({"plaintext-secret", "undefined-var"} <= rules)

    def test_secrets_are_masked(self):
        text = self.model["files"]["inventories/staging/group_vars/all/main.yml"]["text"]
        self.assertIn("db_password: " + atlas.REDACTED, text)
        self.assertNotIn("text", self.model["files"]["inventories/staging/group_vars/all/vault.yml"])
        # PEM markers are built at runtime so this file never contains a literal key header.
        pem = "-----BEGIN RSA " + "PRIVATE KEY-----\nMIIE\n-----END RSA " + "PRIVATE KEY-----"
        out = atlas.redact_text("api_token: abc123\nuser: bob\n" + pem)
        self.assertNotIn("abc123", out)
        self.assertNotIn("MIIE", out)
        self.assertIn("user: bob", out)

    def test_writes_one_locked_down_html_file(self):
        with tempfile.TemporaryDirectory() as d:
            atlas.main([str(EXAMPLE), "-o", str(Path(d) / "map.html")])
            self.assertEqual([p.name for p in Path(d).iterdir()], ["map.html"])
            html = (Path(d) / "map.html").read_text(encoding="utf-8")
        self.assertIn("default-src 'none'", html)          # browser blocks all network requests
        self.assertIn(atlas.GENERATED_MARKER, html)        # so the hook/CI can refuse to commit it
        self.assertNotIn(atlas.GENERATED_MARKER, atlas.TEMPLATE.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
