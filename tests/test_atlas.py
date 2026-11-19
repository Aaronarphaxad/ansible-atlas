"""Smoke tests for Ansible Atlas, run against example-repo/.

    python -m unittest discover -s tests -v
"""
import base64
import hashlib
import json
import os
import re
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
            atlas.main([str(EXAMPLE), "-o", str(Path(d) / "map.html"), "--no-open"])
            self.assertEqual([p.name for p in Path(d).iterdir()], ["map.html"])
            html = (Path(d) / "map.html").read_text(encoding="utf-8")
        self.assertIn("default-src 'none'", html)          # browser blocks all network requests
        self.assertIn(atlas.GENERATED_MARKER, html)        # so the hook/CI can refuse to commit it
        self.assertNotIn(atlas.GENERATED_MARKER, atlas.load_template())
        self.assertNotIn("@include", html)                  # every viewer component was inlined

    def test_csp_allows_only_the_viewer_script(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "map.html"
            atlas.main([str(EXAMPLE), "-o", str(out), "--no-open"])
            html = out.read_text(encoding="utf-8")
            if os.name == "posix":
                self.assertEqual(out.stat().st_mode & 0o777, 0o600)   # only you can read it
        self.assertNotIn("'unsafe-inline'; style", html)
        script = re.search(r"<script>(.*?)</script>", html, re.S).group(1)
        digest = base64.b64encode(hashlib.sha256(script.encode()).digest()).decode()
        self.assertIn(f"script-src 'sha256-{digest}'", html)

    def test_hostile_repo_cannot_read_outside_or_hang(self):
        with tempfile.TemporaryDirectory() as outside, tempfile.TemporaryDirectory() as repo:
            secret = Path(outside) / "secret.yml"
            secret.write_text("stolen: TOPSECRETVALUE\n")
            r = Path(repo)
            (r / "site.yml").write_text(
                "- hosts: all\n  tasks:\n    - include_vars: " + str(secret) + "\n"
                "    - import_tasks: ../" + Path(outside).name + "/secret.yml\n")
            (r / "link.yml").symlink_to(secret)
            bomb = "a: &a [x,x,x,x,x,x,x,x,x,x]\n" + "".join(
                f"{c}: &{c} [*{p},*{p},*{p},*{p},*{p},*{p},*{p},*{p},*{p},*{p}]\n"
                for p, c in zip("abcdefgh", "bcdefghi"))
            (r / "bomb.yml").write_text(bomb)
            (Path(repo) / "x-->").mkdir()
            model = atlas.Atlas(r).build()
            dumped = json.dumps(model, default=str)
            self.assertNotIn("TOPSECRETVALUE", dumped)
            self.assertNotIn("link.yml", model["files"])                          # symlink out of the repo
            self.assertTrue(any("bomb.yml" in w and "alias" in w for w in model["meta"]["warnings"]))
            html = atlas.render_html(dict(model, meta=dict(model["meta"], repo="evil--><b>x")))
            head = html.split("<script>")[0]                 # the comment; data inside the script is JSON-escaped
            self.assertNotIn("--><b>", head)
            self.assertIn("evil--__b_x", head)

    def test_default_output_is_a_private_folder_in_home(self):
        with tempfile.TemporaryDirectory() as d:
            old = {k: os.environ.get(k) for k in ("HOME", "USERPROFILE")}
            os.environ["HOME"] = os.environ["USERPROFILE"] = d
            try:
                atlas.main([str(EXAMPLE), "--no-open"])
            finally:
                for k, v in old.items():
                    if v is None:
                        os.environ.pop(k, None)
                    else:
                        os.environ[k] = v
            out = Path(d) / "ansible-atlas-maps" / "example-repo.html"
            self.assertTrue(out.is_file())
            if os.name == "posix":
                self.assertEqual(out.stat().st_mode & 0o777, 0o600)
                self.assertEqual(out.parent.stat().st_mode & 0o777, 0o700)


if __name__ == "__main__":
    unittest.main()
