#!/usr/bin/env python3
"""
Ansible Atlas - an offline, read-only map of an Ansible repository.

It scans a directory for the things Ansible knows about (ansible.cfg,
inventories in YAML or INI form, group_vars/host_vars, playbooks, roles,
task files, handlers, templates, scripts, requirements files) and writes ONE
self-contained HTML file that you open in a browser to explore the repo.
Nothing is executed, no Ansible code is imported, nothing connects to the
network, no server runs, and the page has no export features.

Usage:
    python3 atlas.py /path/to/repo                 # saves ~/ansible-atlas-maps/<repo>.html and opens it
    python3 atlas.py /path/to/repo -o ~/maps/x.html --no-open
    python3 atlas.py /path/to/repo --no-redact     # show secret-looking values
    python3 atlas.py /path/to/repo -w              # rebuild when files change
    python3 atlas.py /path/to/repo -l              # print checks in the terminal

Requires: Python 3.8+ and PyYAML (python3 -m pip install --user pyyaml).
"""
from __future__ import annotations

import argparse
import base64
import configparser
import datetime as _dt
import fnmatch
import hashlib
import itertools
import json
import os
import re
import shlex
import string
import sys
import tempfile
import webbrowser
from pathlib import Path

def _missing_pyyaml():  # pragma: no cover
    """Explain how to install PyYAML for the Python that is actually running this script."""
    py = sys.executable or "python3"
    ver = f"{sys.version_info.major}.{sys.version_info.minor}"
    msg = [f"Ansible Atlas needs PyYAML, which isn't installed for this Python ({py}, version {ver}).",
           "Install it one of these ways, then run the same command again:", ""]
    if os.name == "nt":
        msg += ["  py -m pip install --user pyyaml"]
    else:
        msg += [f"  {py} -m pip install --user pyyaml", "",
                "If pip refuses with 'externally-managed-environment' (Homebrew Python, Debian 12+, Ubuntu 23.04+),",
                "use a virtual environment instead:",
                "  python3 -m venv ~/.venvs/atlas && ~/.venvs/atlas/bin/pip install pyyaml",
                "  ~/.venvs/atlas/bin/python atlas.py <path-to-ansible-repo>", "",
                "or the system package:  sudo apt install python3-yaml   |   sudo dnf install python3-pyyaml"]
    msg += ["", "Tip: the Python that runs your Ansible usually has PyYAML already."]
    sys.exit("\n".join(msg))


try:
    import yaml
except ImportError:  # pragma: no cover
    _missing_pyyaml()

VERSION = "1.5.0"
HERE = Path(__file__).resolve().parent
VIEWER_DIR = HERE / "viewer"
TEMPLATE = VIEWER_DIR / "index.html"   # page shell; pulls in viewer/css/* and viewer/js/*

DEFAULT_EXCLUDES = {".git", ".hg", ".svn", "node_modules", ".venv", "venv", "env",
                    "__pycache__", ".tox", ".mypy_cache", ".pytest_cache", ".idea",
                    ".vscode", "ansible_collections", ".cache", "site-packages"}
YAML_EXT = {".yml", ".yaml"}
MAX_FILE_BYTES = 2_000_000
MAX_VALUE_CHARS = 4000
MAX_YAML_NODES = 1_000_000   # a YAML document may expand (via aliases) to at most this many nodes

SECRET_RE = re.compile(r"(pass(word|wd|phrase)?|secret|token|private|credential|api_?key|"
                       r"access_?key|secret_?key|auth|cert_?key|_key$|^key$)", re.I)
NOT_SECRET_RE = re.compile(r"(_file|_path|_dir|_url|_name|_user|keyserver|key_id|keyring|_length|_size)$", re.I)
JINJA_ONLY_RE = re.compile(r"^\s*\{\{[^{}]*\}\}\s*$")

# --------------------------------------------------------------------------- YAML

class VaultValue(str):
    pass


class Loader(yaml.SafeLoader):
    """SafeLoader that records line numbers and tolerates Ansible tags.

    SafeLoader never runs code or builds arbitrary Python objects. On top of that, each
    document is checked for "alias bombs" (a few lines of `&a`/`*a` anchors that expand to
    billions of nodes) before it is constructed, so a hostile repo can't hang the scan."""

    def compose_document(self):
        node = super().compose_document()
        if _expanded_size(node, MAX_YAML_NODES) > MAX_YAML_NODES:
            raise yaml.YAMLError(f"document expands to more than {MAX_YAML_NODES:,} nodes "
                                 "through aliases (YAML alias bomb?); skipped")
        return node


def _expanded_size(node, limit):
    """Number of nodes `node` turns into once every alias is expanded, stopping early past
    `limit`. Shared sub-trees are counted once per use (that's what expansion costs);
    recursive references count as one node."""
    memo, active = {}, set()

    def size(n):
        key = id(n)
        if key in memo:
            return memo[key]
        if key in active or isinstance(n, yaml.ScalarNode):
            return 1
        active.add(key)
        total = 1
        kids = n.value if isinstance(n, yaml.SequenceNode) else [x for kv in n.value for x in kv]
        for k in kids:
            total += size(k)
            if total > limit:
                break
        active.discard(key)
        memo[key] = total
        return total

    return size(node) if node is not None else 0


def _construct_mapping(loader, node, deep=False):
    loader.flatten_mapping(node)
    m = {}
    lines = {}
    for knode, vnode in node.value:
        try:
            k = loader.construct_object(knode, deep=deep)
        except Exception:
            k = str(knode.value)
        if isinstance(k, (list, dict)):
            k = json.dumps(k, default=str)
        m[k] = loader.construct_object(vnode, deep=deep)
        lines[k] = knode.start_mark.line + 1
    m["__line__"] = node.start_mark.line + 1
    m["__lines__"] = lines
    return m


def _tag_multi(loader, suffix, node):
    tag = node.tag
    if tag.startswith("!vault"):
        return VaultValue("<vault encrypted>")
    if isinstance(node, yaml.ScalarNode):
        return loader.construct_scalar(node)
    if isinstance(node, yaml.SequenceNode):
        return loader.construct_sequence(node, deep=True)
    return _construct_mapping(loader, node, deep=True)


Loader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _construct_mapping)
Loader.add_multi_constructor("!", _tag_multi)


def clean(v, depth=0):
    """Strip loader bookkeeping and make values JSON-safe."""
    if depth > 40:
        return "…"
    if isinstance(v, dict):
        return {str(k): clean(x, depth + 1) for k, x in v.items() if k not in ("__line__", "__lines__")}
    if isinstance(v, (list, tuple, set)):
        return [clean(x, depth + 1) for x in v]
    if isinstance(v, (_dt.date, _dt.datetime)):
        return v.isoformat()
    if isinstance(v, bytes):
        return "<binary>"
    if isinstance(v, str) and len(v) > MAX_VALUE_CHARS:
        return v[:MAX_VALUE_CHARS] + "…(truncated)"
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    return str(v)


def keys(d):
    return [k for k in d if k not in ("__line__", "__lines__")] if isinstance(d, dict) else []


def kline(d, k):
    if isinstance(d, dict):
        return d.get("__lines__", {}).get(k) or d.get("__line__")
    return None


# --------------------------------------------------------------------------- helpers

def is_secret_name(name):
    name = str(name)
    return bool(SECRET_RE.search(name)) and not NOT_SECRET_RE.search(name)


def redact_value(name, value, enabled):
    if isinstance(value, VaultValue):
        return "<vault encrypted>"
    if not enabled or not is_secret_name(name):
        return value
    if isinstance(value, str) and (JINJA_ONLY_RE.match(value) or value.strip() in ("", "<vault encrypted>")):
        return value
    if value in (None, "", [], {}) or isinstance(value, bool):
        return value
    return "•••• redacted (secret-looking name; run with --no-redact to show)"


def redact_tree(v, enabled, parent_key=""):
    if isinstance(v, dict):
        return {k: (redact_value(k, x, enabled) if not isinstance(x, (dict, list)) else redact_tree(x, enabled, k))
                for k, x in v.items()}
    if isinstance(v, list):
        return [redact_tree(x, enabled, parent_key) for x in v]
    return redact_value(parent_key, v, enabled) if parent_key else v


def short_module(m):
    if not m:
        return m
    parts = m.split(".")
    return parts[-1] if len(parts) >= 3 else m


def as_list(v):
    if v is None:
        return []
    if isinstance(v, list):
        return v
    return [v]


def tagset(v):
    """Normalise a tags: value (list, comma string or scalar) to a set of strings."""
    out = set()
    for t in as_list(v):
        if isinstance(t, str):
            out.update(x.strip() for x in t.split(",") if x.strip())
        elif t is not None:
            out.add(str(t))
    return out


def expand_host_range(pattern):
    """web[01:03].x -> web01.x web02.x web03.x ; also [a:c] and [1:9:2]."""
    m = re.search(r"\[([^\]]+)\]", pattern)
    if not m:
        return [pattern]
    inner = m.group(1).split(":")
    if len(inner) < 2:
        return [pattern]
    beg, end = inner[0], inner[1]
    step = int(inner[2]) if len(inner) > 2 and inner[2].isdigit() else 1
    pre, post = pattern[: m.start()], pattern[m.end():]
    out = []
    if beg.isdigit() and end.isdigit():
        width = len(beg) if beg.startswith("0") else 0
        for i in range(int(beg), int(end) + 1, step):
            out.append(f"{pre}{str(i).zfill(width)}{post}")
    elif len(beg) == 1 and len(end) == 1 and beg.isalpha():
        letters = string.ascii_letters
        for c in letters[letters.index(beg): letters.index(end) + 1: step]:
            out.append(f"{pre}{c}{post}")
    else:
        return [pattern]
    res = []
    for o in out:
        res.extend(expand_host_range(o))
    return res


def parse_kv(s):
    """Parse 'a=1 b="x y"' free-form module args."""
    out, free = {}, []
    try:
        toks = shlex.split(s, posix=True)
    except ValueError:
        toks = s.split()
    for t in toks:
        if "=" in t and not t.startswith("="):
            k, v = t.split("=", 1)
            out[k] = v
        else:
            free.append(t)
    if free:
        out["_raw_params"] = " ".join(free)
    return out



# --------------------------------------------------------------------------- Jinja references

JINJA_BLOCK_RE = re.compile(r"\{\{(.*?)\}\}|\{%-?(.*?)-?%\}", re.S)
JINJA_STR_RE = re.compile(r"'(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\"")
JINJA_WORDS = set("""and or not in is if else elif endif for endfor true false none True False None set endset macro
endmacro call endcall filter endfilter block endblock extends include import from as with endwith without context
recursive loop item self caller super varargs kwargs raw endraw do break continue""".split())
MAGIC_VARS = set("""hostvars groups group_names inventory_hostname inventory_hostname_short inventory_dir inventory_file
play_hosts playbook_dir role_path role_name role_names omit environment vars lookup query q now undef range dict
lipsum cycler joiner namespace zip""".split())


def expr_refs(expr, local=()):
    """Variable names referenced by a bare Jinja expression (e.g. a `when:`)."""
    expr = JINJA_STR_RE.sub("''", str(expr))
    out = set()
    for m in re.finditer(r"[A-Za-z_][A-Za-z0-9_]*", expr):
        name = m.group(0)
        if m.start() and (expr[m.start() - 1].isdigit() or expr[m.start() - 1] in "._"):
            continue
        before = expr[:m.start()].rstrip()
        after = expr[m.end():].lstrip()
        if before.endswith((".", "|")) or re.search(r"\bis(?:\s+not)?$", before):
            continue
        if after.startswith("(") or (after.startswith("=") and not after.startswith("==")):
            continue
        if name in JINJA_WORDS or name in local:
            continue
        out.add(name)
    return out


def text_refs(text):
    """{name: [line, ...]} for every {{ }} / {% %} in a string or template."""
    text = str(text)
    found, local = {}, set()
    if "{{" not in text and "{%" not in text:
        return found
    for m in JINJA_BLOCK_RE.finditer(text):
        line = text.count("\n", 0, m.start()) + 1
        if m.group(1) is not None:
            names = expr_refs(m.group(1), local)
        else:
            stmt = m.group(2).strip()
            names = set()
            fm = re.match(r"for\s+([\w\s,()]+?)\s+in\s+(.*)$", stmt, re.S)
            sm = re.match(r"set\s+([\w\s,]+?)\s*(?:=\s*(.*))?$", stmt, re.S)
            mm = re.match(r"macro\s+(\w+)\s*\(([^)]*)\)", stmt)
            if fm:
                local |= set(re.findall(r"\w+", fm.group(1)))
                names = expr_refs(fm.group(2), local)
            elif sm:
                local |= set(re.findall(r"\w+", sm.group(1)))
                names = expr_refs(sm.group(2) or "", local)
            elif mm:
                local |= {mm.group(1)} | set(re.findall(r"\w+", mm.group(2)))
            else:
                kw = re.match(r"(\w+)\s*(.*)$", stmt, re.S)
                if kw and kw.group(1) not in ("end" + x for x in ("if", "for", "set", "macro", "raw", "with", "block", "filter", "call")):
                    names = expr_refs(kw.group(2), local) if kw.group(1) in JINJA_WORDS else expr_refs(stmt, local)
        for n in names:
            found.setdefault(n, [])
            if line not in found[n]:
                found[n].append(line)
    return found


def value_refs(v):
    """Names referenced inside {{ }} anywhere in a (nested) value."""
    out = set()
    if isinstance(v, str):
        out |= set(text_refs(v))
    elif isinstance(v, dict):
        for x in v.values():
            out |= value_refs(x)
    elif isinstance(v, list):
        for x in v:
            out |= value_refs(x)
    return out


def bare_refs(v):
    """when:/until:/that: are bare expressions (no braces), possibly a list."""
    out = set()
    for x in as_list(v):
        if isinstance(x, str):
            out |= set(text_refs(x)) if "{{" in x else expr_refs(x)
        elif isinstance(x, (dict, list)):
            out |= value_refs(x)
    return out



# --------------------------------------------------------------------------- file contents (redacted)

TEXT_EXT = {".yml", ".yaml", ".j2", ".jinja", ".jinja2", ".cfg", ".ini", ".conf", ".sh", ".bash", ".zsh", ".ksh",
            ".ps1", ".py", ".pl", ".rb", ".json", ".md", ".markdown", ".mdown", ".mkd", ".txt", ".toml", ".service", ".timer", ".socket",
            ".xml", ".properties", ".sql", ".rst", ".csv", ".tf", ".hcl", ".env.example"}
SCRIPT_EXT = {".sh", ".bash", ".zsh", ".ksh", ".ps1"}
SCRIPT_DIR_EXT = {".py", ".pl", ".rb"}          # scripts only when inside scripts/, bin/ or files/
SENSITIVE_NAME_RE = re.compile(r"(^\.env($|\.)|\.pem$|\.key$|\.p12$|\.pfx$|\.kdbx$|^id_(rsa|dsa|ecdsa|ed25519)|"
                               r"vault[_-]?pass|\.vault_pass|^known_hosts$|\.keystore$|\.jks$)", re.I)
MAX_EMBED_FILE = 300_000
MAX_EMBED_TOTAL = 30_000_000
REDACTED = "•••• redacted"
_YAML_KV = re.compile(r"""^(\s*(?:-\s+)?["']?)([\w.\-]+)(["']?\s*:\s+)(.*?)\s*$""")
_INLINE_KV = re.compile(r"""(?<![\w.\-])([\w.\-]+)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;#]+)""")
_PEM_BEGIN = re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")
_PEM_END = re.compile(r"-----END [A-Z ]*PRIVATE KEY-----")


def _secret_value_ok_to_show(v):
    v = v.strip().strip('"').strip("'")
    return (not v or JINJA_ONLY_RE.match(v) or v.startswith(("!vault", "$ANSIBLE_VAULT", "{{")) or
            v.lower() in ("null", "~", "true", "false", "yes", "no", "|", ">", "|-", ">-", "[]", "{}"))


def redact_text(text):
    """Mask secret-looking values in raw file text (YAML keys, key=value pairs, PEM private keys)."""
    out, in_pem, block_indent = [], False, None
    for line in text.split("\n"):
        if in_pem:
            if _PEM_END.search(line):
                in_pem = False
                out.append(line)
            else:
                out.append(REDACTED if line.strip() else line)
            continue
        if _PEM_BEGIN.search(line):
            in_pem = True
            out.append(line)
            continue
        if block_indent is not None:                      # inside `secret_key: |` block scalar
            ind = len(line) - len(line.lstrip())
            if line.strip() and ind > block_indent:
                out.append(" " * ind + REDACTED)
                continue
            block_indent = None
        m = _YAML_KV.match(line)
        if m and is_secret_name(m.group(2)):
            val = m.group(4)
            if val.strip() in ("|", ">", "|-", ">-", "|+", ">+"):
                block_indent = len(line) - len(line.lstrip())
                out.append(line)
                continue
            if not _secret_value_ok_to_show(val):
                out.append(m.group(1) + m.group(2) + m.group(3) + REDACTED)
                continue
        def kv(mm):
            if is_secret_name(mm.group(1)) and not _secret_value_ok_to_show(mm.group(3)):
                return mm.group(1) + mm.group(2) + REDACTED
            return mm.group(0)
        if "=" in line or ":" in line:
            line = _INLINE_KV.sub(kv, line)
        out.append(line)
    return "\n".join(out)


# --------------------------------------------------------------------------- checks (lint)

CHECK_RULES = {
    "yaml-error": ("error", "YAML that Ansible can't parse"),
    "missing-file": ("error", "Referenced file, role or playbook not found"),
    "unknown-handler": ("error", "notify: names a handler that doesn't exist"),
    "external-role": ("warning", "Role not in this repo (Galaxy/collection?)"),
    "no-hosts": ("warning", "Play matches no hosts in the default inventory"),
    "undefined-var": ("warning", "Variable used but never defined in the repo"),
    "plaintext-secret": ("warning", "Secret-looking value stored in plain text"),
    "command-instead-of-module": ("warning", "Shell command where an Ansible module exists"),
    "script-missing": ("warning", "script: points to a file that isn't in the repo"),
    "no-changed-when": ("info", "command/shell always reports 'changed'"),
    "package-latest": ("info", "Package state: latest (unpinned upgrades)"),
    "risky-file-permissions": ("info", "File written without an explicit mode"),
    "ignore-errors": ("info", "ignore_errors hides failures"),
    "no-name": ("info", "Task has no name"),
    "unused-var": ("info", "Variable defined but never used"),
    "unused-role": ("info", "Role not used by any play"),
    "unnotified-handler": ("info", "Handler never notified"),
}
CMD_MODULES = {"apt": "apt", "apt-get": "apt", "yum": "yum", "dnf": "dnf", "systemctl": "systemd / service",
               "service": "service", "git": "git", "curl": "get_url / uri", "wget": "get_url", "mkdir": "file",
               "rm": "file", "rmdir": "file", "chmod": "file", "chown": "file", "ln": "file", "touch": "file",
               "cp": "copy", "tar": "unarchive", "unzip": "unarchive", "useradd": "user", "usermod": "user",
               "groupadd": "group", "crontab": "cron", "pip": "pip", "pip3": "pip", "npm": "npm",
               "mount": "mount", "sed": "lineinfile / replace", "hostnamectl": "hostname",
               "timedatectl": "timezone", "sysctl": "sysctl", "ufw": "ufw", "firewall-cmd": "firewalld"}
PKG_MODULES = {"apt", "yum", "dnf", "package", "pip", "npm", "zypper", "apk", "gem", "homebrew", "snap"}
FILE_WRITE_MODULES = {"copy", "template", "get_url", "unarchive"}

# --------------------------------------------------------------------------- module descriptions

def _j(v, n=4):
    if isinstance(v, list):
        s = ", ".join(str(x) for x in v[:n])
        return s + (f" (+{len(v)-n} more)" if len(v) > n else "")
    if isinstance(v, dict):
        return ", ".join(f"{k}={v[k]}" for k in list(v)[:n])
    return str(v)


def describe(module, a):
    """Offline, rule-based plain-English summary of what a task does."""
    m = short_module(module or "")
    a = a if isinstance(a, dict) else {}
    g = lambda *ks, d=None: next((a[k] for k in ks if k in a and a[k] not in (None, "")), d)
    state = g("state")
    name = g("name", "pkg", "package")

    def pkg(mgr):
        verb = {"absent": "Remove", "latest": "Install/upgrade to latest", "removed": "Remove"}.get(str(state), "Install")
        if not name and (g("update_cache") or g("upgrade")):
            return f"Refresh the {mgr} package cache" + (f" and upgrade packages ({g('upgrade')})" if g("upgrade") else "")
        s = f"{verb} {mgr} package(s): {_j(name)}" if name else f"Manage {mgr} packages"
        if g("update_cache"):
            s += " (refreshing cache first)"
        return s

    def svc():
        verbs = {"started": "Start", "stopped": "Stop", "restarted": "Restart", "reloaded": "Reload"}
        s = f"{verbs.get(str(state), 'Manage')} service '{name}'" if name else "Manage a service"
        if g("enabled") is not None:
            s += f"; enabled at boot: {g('enabled')}"
        if g("daemon_reload"):
            s += "; reload systemd units"
        return s

    def file_():
        p = g("path", "dest", "name")
        st = str(state or "file")
        if st == "directory":
            return f"Ensure directory {p} exists" + (f" (mode {g('mode')})" if g("mode") else "")
        if st == "absent":
            return f"Delete {p}"
        if st == "link":
            return f"Create symlink {p} → {g('src')}"
        if st == "touch":
            return f"Touch file {p}"
        return f"Set attributes on {p}" + (f" (owner {g('owner')}, mode {g('mode')})" if g("owner") or g("mode") else "")

    table = {
        "apt": lambda: pkg("apt"), "yum": lambda: pkg("yum"), "dnf": lambda: pkg("dnf"),
        "package": lambda: pkg("system"), "pip": lambda: pkg("pip"), "apk": lambda: pkg("apk"),
        "snap": lambda: pkg("snap"), "homebrew": lambda: pkg("brew"), "zypper": lambda: pkg("zypper"),
        "npm": lambda: f"Install npm packages" + (f" '{name}'" if name else "") + (f" in {g('path')}" if g("path") else ""),
        "gem": lambda: pkg("gem"),
        "apt_key": lambda: f"Add apt signing key" + (f" from {g('url')}" if g("url") else (f" id {g('id')}" if g("id") else "")),
        "apt_repository": lambda: f"{'Remove' if state == 'absent' else 'Add'} apt repository {g('repo')}",
        "yum_repository": lambda: f"Configure yum repository {name}",
        "deb822_repository": lambda: f"Configure apt (deb822) repository {name}",
        "service": svc, "systemd": svc, "systemd_service": svc, "sysvinit": svc,
        "template": lambda: f"Render Jinja2 template {g('src')} to {g('dest')}" + (f" (mode {g('mode')})" if g("mode") else ""),
        "copy": lambda: (f"Write inline content to {g('dest')}" if "content" in a else f"Copy {g('src')} to {g('dest')}") + (f" (mode {g('mode')})" if g("mode") else ""),
        "fetch": lambda: f"Download {g('src')} from the host to the controller at {g('dest')}",
        "file": file_,
        "lineinfile": lambda: (f"Remove lines matching '{g('regexp')}' from {g('path','dest')}" if state == "absent"
                                else f"Ensure line '{g('line')}' in {g('path','dest')}" + (f" (replacing /{g('regexp')}/)" if g("regexp") else "")),
        "blockinfile": lambda: f"Manage a marked text block in {g('path','dest')}",
        "replace": lambda: f"Replace /{g('regexp')}/ with '{g('replace','')}' in {g('path','dest')}",
        "ini_file": lambda: f"Set [{g('section')}] {g('option')}={g('value')} in {g('path','dest')}",
        "user": lambda: (f"Remove user '{name}'" if state == "absent" else f"Ensure user '{name}' exists") + (f" in groups {g('groups')}" if g("groups") else ""),
        "group": lambda: (f"Remove group '{name}'" if state == "absent" else f"Ensure group '{name}' exists"),
        "authorized_key": lambda: f"{'Remove' if state == 'absent' else 'Add'} SSH authorized key for user '{g('user')}'",
        "command": lambda: f"Run command: {g('_raw_params','cmd', d=_j(g('argv','')))}",
        "shell": lambda: f"Run shell command: {g('_raw_params','cmd')}",
        "raw": lambda: f"Run raw SSH command: {g('_raw_params')}",
        "script": lambda: f"Upload and run local script {g('_raw_params','cmd')}",
        "debug": lambda: f"Print debug output: {g('msg', d=g('var'))}",
        "fail": lambda: f"Fail the play with message: {g('msg')}",
        "assert": lambda: f"Assert conditions: {_j(g('that'))}",
        "set_fact": lambda: f"Set facts: {', '.join(k for k in a if not k.startswith('_') and k != 'cacheable')}",
        "include_vars": lambda: f"Load variables from {g('_raw_params','file','dir', d=g('name'))}",
        "setup": lambda: "Gather facts about the host",
        "gather_facts": lambda: "Gather facts about the host",
        "pause": lambda: f"Pause" + (f" {g('seconds')}s" if g("seconds") else (f" {g('minutes')}m" if g("minutes") else " for operator input")),
        "wait_for": lambda: f"Wait for " + (f"port {g('port')}" if g("port") else (f"path {g('path')}" if g("path") else "a condition")) + (f" (timeout {g('timeout')}s)" if g("timeout") else ""),
        "wait_for_connection": lambda: "Wait until the host is reachable again",
        "reboot": lambda: "Reboot the host and wait for it to come back",
        "uri": lambda: f"HTTP {g('method', d='GET')} {g('url')}" + (f", expect status {g('status_code')}" if g("status_code") else ""),
        "get_url": lambda: f"Download {g('url')} to {g('dest')}",
        "unarchive": lambda: f"Extract archive {g('src')} into {g('dest')}",
        "git": lambda: f"Clone/update git repo {g('repo')} into {g('dest')}" + (f" at {g('version')}" if g("version") else ""),
        "cron": lambda: f"{'Remove' if state == 'absent' else 'Ensure'} cron job '{name}'" + (f": {g('job')}" if g("job") and state != "absent" else ""),
        "mount": lambda: f"Mount {g('src')} at {g('path','name')} ({g('fstype','?')}, state {state})",
        "sysctl": lambda: f"Set kernel parameter {name} = {g('value')}",
        "hostname": lambda: f"Set hostname to {name}",
        "timezone": lambda: f"Set timezone to {name}",
        "locale_gen": lambda: f"Generate locale {name}",
        "ufw": lambda: f"Firewall (ufw): {g('rule', d=state)} {g('port','')} {g('proto','')}".strip(),
        "firewalld": lambda: f"Firewall (firewalld): {g('service', d=g('port'))} {state}",
        "iptables": lambda: f"iptables rule on chain {g('chain')}: {g('jump')}",
        "selinux": lambda: f"Set SELinux state to {state}",
        "seboolean": lambda: f"Set SELinux boolean {name} = {g('state')}",
        "modprobe": lambda: f"Load kernel module {name}",
        "stat": lambda: f"Check whether {g('path')} exists / read its attributes",
        "find": lambda: f"Find files in {_j(g('paths'))}" + (f" matching {g('patterns')}" if g("patterns") else ""),
        "slurp": lambda: f"Read file {g('src','path')} from the host",
        "archive": lambda: f"Create archive {g('dest')} from {_j(g('path'))}",
        "synchronize": lambda: f"rsync {g('src')} → {g('dest')}",
        "docker_container": lambda: f"{'Remove' if state == 'absent' else 'Run'} Docker container '{name}'" + (f" from image {g('image')}" if g("image") else ""),
        "docker_image": lambda: f"Pull/build Docker image {name}",
        "docker_compose": lambda: f"Docker Compose project in {g('project_src')}",
        "docker_compose_v2": lambda: f"Docker Compose project in {g('project_src')} (state {state or 'present'})",
        "docker_network": lambda: f"Docker network '{name}'",
        "docker_volume": lambda: f"Docker volume '{name}'",
        "mysql_db": lambda: f"MySQL database '{name}' ({state or 'present'})",
        "mysql_user": lambda: f"MySQL user '{name}'",
        "postgresql_db": lambda: f"PostgreSQL database '{name}'",
        "postgresql_user": lambda: f"PostgreSQL user '{name}'",
        "mongodb_user": lambda: f"MongoDB user '{name}' on db {g('database')}",
        "openssl_privatekey": lambda: f"Generate private key {g('path')}",
        "x509_certificate": lambda: f"Generate/check certificate {g('path')}",
        "acme_certificate": lambda: f"Obtain ACME (Let's Encrypt) certificate {g('dest')}",
        "nfs_exports": lambda: "Manage NFS exports",
        "add_host": lambda: f"Add host '{name}' to the in-memory inventory",
        "group_by": lambda: f"Create dynamic groups from key '{g('key')}'",
        "meta": lambda: f"Ansible control action: {g('_raw_params')}",
        "include_tasks": lambda: "Dynamically include a task file at runtime",
        "import_tasks": lambda: "Statically import a task file",
        "include_role": lambda: f"Dynamically run role '{name}'" + (f" (tasks_from {g('tasks_from')})" if g("tasks_from") else ""),
        "import_role": lambda: f"Statically import role '{name}'" + (f" (tasks_from {g('tasks_from')})" if g("tasks_from") else ""),
        "win_shell": lambda: f"Run PowerShell: {g('_raw_params')}",
        "win_service": svc,
        "k8s": lambda: f"Apply Kubernetes object(s)" + (f" from {g('src')}" if g("src") else ""),
        "helm": lambda: f"Helm release '{name}' from chart {g('chart_ref')}",
        "pm2": lambda: f"pm2 process '{name}'",
    }
    fn = table.get(m)
    try:
        if fn:
            return re.sub(r"\s+", " ", fn()).strip()
    except Exception:
        pass
    return f"Runs module '{module}'" if module else ""


# --------------------------------------------------------------------------- task model

TASK_KEYWORDS = {
    "name", "action", "local_action", "args", "async", "become", "become_exe", "become_flags",
    "become_method", "become_user", "changed_when", "check_mode", "collections", "connection",
    "debugger", "delay", "delegate_facts", "delegate_to", "diff", "environment", "failed_when",
    "ignore_errors", "ignore_unreachable", "loop", "loop_control", "module_defaults", "no_log",
    "notify", "poll", "port", "register", "remote_user", "retries", "run_once", "tags",
    "throttle", "timeout", "until", "vars", "when", "listen", "any_errors_fatal",
    "block", "rescue", "always",
}
INCLUDE_TASK_MODS = {"include_tasks", "import_tasks", "include"}
ROLE_MODS = {"include_role", "import_role"}
PLAY_KEYS_SECTIONS = ["pre_tasks", "roles", "tasks", "post_tasks", "handlers"]


class Atlas:
    def __init__(self, root: Path, redact=True, excludes=(), sources=True):
        self.root = root.resolve()
        self.redact = redact
        self.sources = sources
        self.excludes = set(DEFAULT_EXCLUDES) | set(excludes)
        self.entities = {}
        self.warnings = []
        self.yaml_cache = {}
        self.taskfile_cache = {}
        self.task_seq = itertools.count(1)
        self.sec_seq = itertools.count(1)
        self.cfg = {}
        self.cfg_path = None
        self.roles_paths = []
        self.files = []
        self.encrypted_files = []
        self.yaml_errors = []
        self.findings = []

    # ---------------- basics
    def rel(self, p: Path):
        try:
            return Path(p).resolve().relative_to(self.root).as_posix()   # "/" on every OS, incl. Windows
        except ValueError:
            return str(p)

    def warn(self, msg):
        if msg not in self.warnings:
            self.warnings.append(msg)

    def ent(self, eid, **kw):
        e = self.entities.get(eid)
        if e is None:
            e = {"id": eid}
            self.entities[eid] = e
        e.update(kw)
        return e

    def allowed(self, p: Path):
        """True if p (after following symlinks) is inside the repo or a configured roles_path.
        Stops a repo from pulling in files from elsewhere on this machine, e.g. via a symlink
        to ~/.ssh or `include_vars: /etc/...`, and embedding them in a map that gets shared."""
        try:
            r = Path(p).resolve()
        except (OSError, RuntimeError):
            return False
        return any(r == b or b in r.parents for b in [self.root, *self.roles_paths])

    def load_yaml(self, path: Path):
        path = Path(path)
        key = str(path)
        if key in self.yaml_cache:
            return self.yaml_cache[key]
        data = None
        try:
            if not self.allowed(path):
                self.warn(f"Skipped {path}: outside the repo")
            elif path.stat().st_size > MAX_FILE_BYTES:
                self.warn(f"Skipped large file {self.rel(path)}")
            else:
                text = path.read_text(encoding="utf-8", errors="replace")
                if text.lstrip().startswith("$ANSIBLE_VAULT"):
                    data = VaultValue("<vault encrypted file>")
                    if self.rel(path) not in self.encrypted_files:
                        self.encrypted_files.append(self.rel(path))
                else:
                    docs = [d for d in yaml.load_all(text, Loader=Loader) if d is not None]
                    data = docs[0] if len(docs) == 1 else (docs or None)
        except yaml.YAMLError as ex:
            mark = getattr(ex, "problem_mark", None)
            self.yaml_errors.append((self.rel(path), mark.line + 1 if mark else None, str(getattr(ex, "problem", ex))))
            self.warn(f"YAML error in {self.rel(path)}" + (f" line {mark.line+1}" if mark else "") + f": {getattr(ex, 'problem', ex)}")
        except OSError as ex:
            self.warn(f"Cannot read {self.rel(path)}: {ex}")
        except RecursionError:
            self.warn(f"Skipped {self.rel(path)}: nested too deeply")
        self.yaml_cache[key] = data
        return data

    def walk(self):
        for dp, dns, fns in os.walk(self.root):
            dns[:] = sorted(d for d in dns if d not in self.excludes and not d.startswith("."))
            for f in sorted(fns):
                p = Path(dp) / f
                if p.is_symlink() and not self.allowed(p):
                    self.warn(f"Skipped symlink {self.rel(p)}: points outside the repo")
                    continue
                self.files.append(p)

    # ---------------- ansible.cfg
    def parse_cfg(self):
        cands = [self.root / "ansible.cfg"] + [f for f in self.files if f.name == "ansible.cfg" and f.parent != self.root]
        for c in cands:
            if c.exists():
                self.cfg_path = c
                break
        if not self.cfg_path:
            return
        cp = configparser.ConfigParser(interpolation=None, strict=False, inline_comment_prefixes=(";", "#"))
        try:
            cp.read(self.cfg_path, encoding="utf-8")
        except configparser.Error as ex:
            self.warn(f"ansible.cfg parse error: {ex}")
            return
        self.cfg = {s: dict(cp[s]) for s in cp.sections()}
        rp = self.cfg.get("defaults", {}).get("roles_path")
        if rp:
            for p in re.split(r"[:,]", rp):
                p = p.strip()
                if p:
                    rp_dir = (self.cfg_path.parent / os.path.expanduser(p)).resolve()
                    # A roles_path of "/" or your home folder would let the repo read anything.
                    if rp_dir == Path(rp_dir.anchor) or rp_dir in (Path.home(), *Path.home().parents):
                        self.warn(f"Ignored roles_path {p}: too broad to scan safely")
                    else:
                        self.roles_paths.append(rp_dir)

    # ---------------- inventories
    def is_vars_dir_file(self, f: Path):
        parts = set(Path(self.rel(f)).parts)
        return bool(parts & {"group_vars", "host_vars", "roles", "tasks", "handlers", "templates",
                             "files", "defaults", "vars", "meta", "molecule", "tests"})

    def looks_like_yaml_inventory(self, data):
        if not isinstance(data, dict):
            return False
        ks = keys(data)
        if not ks:
            return False
        if "all" in ks and isinstance(data["all"], dict) and set(keys(data["all"])) & {"hosts", "children", "vars"}:
            return True
        groupish = [k for k in ks if isinstance(data[k], dict) and set(keys(data[k])) & {"hosts", "children"}
                    and set(keys(data[k])) <= {"hosts", "children", "vars"}]
        return len(groupish) > 0 and len(groupish) == len(ks)

    def looks_like_ini_inventory(self, f: Path):
        name = f.name.lower()
        if name == "ansible.cfg" or f.suffix.lower() not in ("", ".ini", ".cfg", ".txt", ".hosts", ".inv"):
            return False
        hinted = (name.startswith("hosts") or name.startswith("inventory") or f.suffix.lower() in (".ini", ".inv", ".hosts")
                  or f.parent.name.lower() in ("inventory", "inventories")
                  or f.parent.parent.name.lower() in ("inventory", "inventories"))
        if not hinted:
            return False
        try:
            if f.stat().st_size > MAX_FILE_BYTES:
                return False
            text = f.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return False
        if text.lstrip().startswith("$ANSIBLE_VAULT") or text.startswith("#!"):
            return False
        lines = [l.strip() for l in text.splitlines() if l.strip() and not l.strip().startswith(("#", ";"))]
        if not lines:
            return False
        if any(re.match(r"^\[[^\]]+\]$", l) for l in lines):
            return True
        return all(re.match(r"^[\w.\-\[\]:]+(\s+\w+=.*)?$", l) for l in lines[:20])

    def find_inventory_files(self):
        found = []
        for f in self.files:
            if self.is_vars_dir_file(f):
                continue
            if f.suffix.lower() in YAML_EXT:
                d = self.load_yaml(f)
                if self.looks_like_yaml_inventory(d):
                    found.append((f, "yaml"))
            elif self.looks_like_ini_inventory(f):
                found.append((f, "ini"))
        return found

    def group_inventory_units(self, found):
        cfg_dirs, cfg_files = set(), set()
        inv = self.cfg.get("defaults", {}).get("inventory")
        if inv and self.cfg_path:
            for p in inv.split(","):
                p = (self.cfg_path.parent / os.path.expanduser(p.strip())).resolve()
                (cfg_dirs if p.is_dir() else cfg_files).add(p)
        by_dir = {}
        for f, kind in found:
            by_dir.setdefault(f.parent.resolve(), []).append((f, kind))
        units = []
        for d, fl in sorted(by_dir.items()):
            mergeable = (d in cfg_dirs or d.name.lower() in ("inventory", "inventories")
                         or d.parent.name.lower() in ("inventory", "inventories"))
            if mergeable:
                units.append((d, fl))
            else:
                for item in fl:
                    units.append((item[0], [item]))
        default_ids = {self.rel(p) for p in cfg_dirs | cfg_files}
        return units, default_ids

    def parse_inventories(self):
        found = self.find_inventory_files()
        units, default_ids = self.group_inventory_units(found)
        self.inventories = []
        pb_dirs = {self.root}
        for unit_path, files in units:
            iid = "inv:" + self.rel(unit_path)
            inv = {"groups": {}, "hosts": {}}
            G = inv["groups"]

            def grp(n):
                return G.setdefault(n, {"vars": [], "children": [], "parents": [], "hosts": []})

            def host(n):
                return inv["hosts"].setdefault(n, {"vars": [], "groups": []})

            grp("all")
            for f, kind in files:
                src = self.rel(f)
                if kind == "yaml":
                    self._parse_yaml_inv(self.load_yaml(f), src, grp, host)
                else:
                    self._parse_ini_inv(f, src, grp, host)
            # wire implicit memberships
            for gname, g in G.items():
                for c in g["children"]:
                    if gname not in grp(c)["parents"]:
                        grp(c)["parents"].append(gname)
                for h in g["hosts"]:
                    if gname not in host(h)["groups"]:
                        host(h)["groups"].append(gname)
            for gname, g in G.items():
                if gname != "all" and not g["parents"]:
                    g["parents"].append("all")
                    if gname not in G["all"]["children"]:
                        G["all"]["children"].append(gname)
            ungrouped = [h for h, hv in inv["hosts"].items() if not [x for x in hv["groups"] if x not in ("all", "ungrouped")]]
            if ungrouped or "ungrouped" in G:
                ug = grp("ungrouped")
                for h in ungrouped:
                    if h not in ug["hosts"]:
                        ug["hosts"].append(h)
                    if "ungrouped" not in host(h)["groups"]:
                        host(h)["groups"].append("ungrouped")
                if "all" not in ug["parents"]:
                    ug["parents"].append("all")
                if "ungrouped" not in G["all"]["children"]:
                    G["all"]["children"].append("ungrouped")
            # group_vars / host_vars next to the inventory
            base = unit_path if Path(unit_path).is_dir() else Path(unit_path).parent
            inv["gv_inv"] = self._load_vars_dir(base / "group_vars")
            inv["hv_inv"] = self._load_vars_dir(base / "host_vars")
            for n in inv["gv_inv"]:
                if n not in G:
                    self.warn(f"group_vars for unknown group '{n}' in {self.rel(base / 'group_vars')}")
            inv["id"] = iid
            inv["path"] = self.rel(unit_path)
            inv["files"] = [self.rel(f) for f, _ in files]
            inv["default"] = self.rel(unit_path) in default_ids or any(x in default_ids for x in inv["files"])
            self.inventories.append(inv)
        # playbook-adjacent group_vars/host_vars (any group_vars dir not beside an inventory)
        inv_bases = {(Path(self.root / i["path"]) if (self.root / i["path"]).is_dir() else (self.root / i["path"]).parent).resolve()
                     for i in self.inventories}
        self.pb_gv, self.pb_hv = {}, {}
        for f in self.files:
            if f.parent.name in ("group_vars", "host_vars") or (f.parent.parent.name in ("group_vars", "host_vars")):
                vd = f.parent if f.parent.name in ("group_vars", "host_vars") else f.parent.parent
                if vd.parent.resolve() in inv_bases or "roles" in Path(self.rel(vd)).parts:
                    continue
                target = self.pb_gv if vd.name == "group_vars" else self.pb_hv
                key = self.rel(vd)
                if key not in target:
                    target[key] = self._load_vars_dir(vd)
        self.inventories.sort(key=lambda i: (not i["default"], i["path"]))
        if not self.inventories:
            self.warn("No inventory found. Play host patterns cannot be resolved.")
        for inv in self.inventories:
            self._build_inventory_entities(inv)

    def _var_entries(self, d, src, base_line=None):
        out = []
        if isinstance(d, VaultValue):
            return [{"k": "(encrypted file)", "v": "<vault encrypted file>", "src": src, "line": None}]
        if not isinstance(d, dict):
            return out
        for k in keys(d):
            raw = d[k]
            ent = {"k": str(k), "v": redact_value(k, clean(raw), self.redact) if not isinstance(raw, dict)
                   else redact_tree(clean(raw), self.redact, str(k)),
                   "src": src, "line": kline(d, k)}
            if (is_secret_name(k) and isinstance(raw, (str, int)) and not isinstance(raw, (bool, VaultValue))
                    and str(raw).strip() and not JINJA_ONLY_RE.match(str(raw))):
                ent["secret_plain"] = True
            out.append(ent)
        return out

    def _parse_yaml_inv(self, data, src, grp, host, seen=None):
        if not isinstance(data, dict):
            return
        for gname in keys(data):
            self._yaml_group(gname, data[gname], src, grp, host, None)

    def _yaml_group(self, gname, body, src, grp, host, parent):
        g = grp(gname)
        if parent and parent not in g["parents"]:
            g["parents"].append(parent)
            if gname not in grp(parent)["children"]:
                grp(parent)["children"].append(gname)
        if not isinstance(body, dict):
            return
        hosts = body.get("hosts")
        if isinstance(hosts, dict):
            for hpat in keys(hosts):
                for h in expand_host_range(str(hpat)):
                    hv = host(h)
                    if h not in g["hosts"]:
                        g["hosts"].append(h)
                    hv["vars"].extend(self._var_entries(hosts[hpat], src))
        elif isinstance(hosts, list):
            for hpat in hosts:
                for h in expand_host_range(str(hpat)):
                    host(h)
                    if h not in g["hosts"]:
                        g["hosts"].append(h)
        g["vars"].extend(self._var_entries(body.get("vars"), src))
        ch = body.get("children")
        if isinstance(ch, dict):
            for c in keys(ch):
                self._yaml_group(str(c), ch[c], src, grp, host, gname)
        elif isinstance(ch, list):
            for c in ch:
                self._yaml_group(str(c), None, src, grp, host, gname)

    def _parse_ini_inv(self, f, src, grp, host):
        section, mode = "ungrouped", "hosts"
        try:
            lines = f.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            return
        for ln, raw in enumerate(lines, 1):
            line = raw.strip()
            if not line or line.startswith(("#", ";")):
                continue
            m = re.match(r"^\[([^\]:]+)(?::(\w+))?\]$", line)
            if m:
                section, mode = m.group(1), (m.group(2) or "hosts")
                grp(section)
                continue
            if mode == "vars":
                if "=" in line:
                    k, v = line.split("=", 1)
                    k, v = k.strip(), v.strip().strip('"').strip("'")
                    grp(section)["vars"].append({"k": k, "v": redact_value(k, v, self.redact), "src": src, "line": ln})
            elif mode == "children":
                c = line.split()[0]
                grp(c)
                if c not in grp(section)["children"]:
                    grp(section)["children"].append(c)
            else:
                parts = parse_kv(line)
                hpat = parts.pop("_raw_params", "").split()[0] if "_raw_params" in parts else line.split()[0]
                for h in expand_host_range(hpat):
                    hv = host(h)
                    g = grp(section)
                    if h not in g["hosts"]:
                        g["hosts"].append(h)
                    for k, v in parts.items():
                        hv["vars"].append({"k": k, "v": redact_value(k, v, self.redact), "src": src, "line": ln})

    def _load_vars_dir(self, d: Path):
        """group_vars/<name>.yml | <name> | <name>/*.yml -> {name: [var entries]}"""
        out = {}
        if not d.is_dir():
            return out
        for p in sorted(d.iterdir()):
            if p.name.startswith("."):
                continue
            if p.is_dir():
                name = p.name
                for f in sorted(p.rglob("*")):
                    if f.is_file() and (f.suffix.lower() in YAML_EXT or f.suffix == "" or f.suffix == ".json"):
                        out.setdefault(name, []).extend(self._var_entries(self.load_yaml(f), self.rel(f)))
            elif p.suffix.lower() in YAML_EXT or p.suffix in ("", ".json"):
                name = p.stem if p.suffix else p.name
                out.setdefault(name, []).extend(self._var_entries(self.load_yaml(p), self.rel(p)))
        return out

    def group_depths(self, inv):
        G = inv["groups"]
        memo = {}

        def depth(g, stack=()):
            if g == "all":
                return 0
            if g in memo:
                return memo[g]
            if g in stack:
                return 1
            ps = G.get(g, {}).get("parents") or ["all"]
            memo[g] = 1 + max(depth(p, stack + (g,)) for p in ps)
            return memo[g]

        return {g: depth(g) for g in G}

    def ancestors(self, inv, groups):
        G = inv["groups"]
        seen, stack = set(), list(groups)
        while stack:
            g = stack.pop()
            if g in seen:
                continue
            seen.add(g)
            stack.extend(G.get(g, {}).get("parents", []))
        seen.add("all")
        return seen

    def descendants_hosts(self, inv, gname, seen=None):
        G = inv["groups"]
        seen = seen if seen is not None else set()
        if gname in seen:
            return set()
        seen.add(gname)
        hs = set(G.get(gname, {}).get("hosts", []))
        if gname == "all":
            return set(inv["hosts"])
        for c in G.get(gname, {}).get("children", []):
            hs |= self.descendants_hosts(inv, c, seen)
        return hs

    def effective_vars(self, inv, hname):
        """Approximates Ansible inventory variable precedence (low -> high)."""
        h = inv["hosts"][hname]
        depths = self.group_depths(inv)
        groups = sorted(self.ancestors(inv, h["groups"]), key=lambda g: (depths.get(g, 1), g))
        layers = []
        for g in groups:
            layers.append(("inventory file · group " + g, inv["groups"][g]["vars"]))
        layers.append(("group_vars/all (inventory)", inv["gv_inv"].get("all", [])))
        for k, gv in self.pb_gv.items():
            layers.append((f"group_vars/all ({k})", gv.get("all", [])))
        for g in groups:
            if g == "all":
                continue
            layers.append((f"group_vars/{g} (inventory)", inv["gv_inv"].get(g, [])))
            for k, gv in self.pb_gv.items():
                layers.append((f"group_vars/{g} ({k})", gv.get(g, [])))
        layers.append(("inventory file · host", h["vars"]))
        layers.append(("host_vars (inventory)", inv["hv_inv"].get(hname, [])))
        for k, hv in self.pb_hv.items():
            layers.append((f"host_vars ({k})", hv.get(hname, [])))
        eff, order = {}, []
        for prec, (layer, entries) in enumerate(layers):
            for e in entries:
                rec = dict(e, layer=layer, prec=prec)
                if e["k"] not in eff:
                    order.append(e["k"])
                    eff[e["k"]] = []
                eff[e["k"]].append(rec)
        out = []
        for k in sorted(order):
            hist = eff[k]
            win = hist[-1]
            out.append({"k": k, "v": win["v"], "src": win["src"], "line": win.get("line"), "layer": win["layer"],
                        "overridden": [{"v": x["v"], "src": x["src"], "line": x.get("line"), "layer": x["layer"]} for x in hist[:-1]]})
        return out

    def _build_inventory_entities(self, inv):
        iid = inv["id"]
        G = inv["groups"]
        for gname, g in G.items():
            gv = list(g["vars"]) + inv["gv_inv"].get(gname, [])
            for k, pgv in self.pb_gv.items():
                gv += pgv.get(gname, [])
            self.ent(f"group:{iid}:{gname}", type="group", label=gname, inventory=iid,
                     parents=[f"group:{iid}:{p}" for p in g["parents"]],
                     children=[f"group:{iid}:{c}" for c in g["children"]],
                     hosts=[f"host:{iid}:{h}" for h in g["hosts"]],
                     all_hosts=sorted(f"host:{iid}:{h}" for h in self.descendants_hosts(inv, gname)),
                     vars=gv)
        for hname, h in inv["hosts"].items():
            anc = self.ancestors(inv, h["groups"])
            hv = h["vars"]
            ah = next((e["v"] for e in reversed(hv) if e["k"] == "ansible_host"), None)
            self.ent(f"host:{iid}:{hname}", type="host", label=hname, inventory=iid, sub=str(ah) if ah else None,
                     groups=[f"group:{iid}:{g}" for g in h["groups"]],
                     all_groups=sorted(f"group:{iid}:{g}" for g in anc),
                     vars=self.effective_vars(inv, hname), plays=[])
        self.ent(iid, type="inventory", label=inv["path"], path=inv["path"], files=inv["files"], default=inv["default"],
                 counts={"groups": len(G), "hosts": len(inv["hosts"])},
                 group_vars=sorted(inv["gv_inv"]), host_vars=sorted(inv["hv_inv"]))

    # host pattern resolution ------------------------------------------------
    def resolve_pattern(self, inv, pattern):
        if pattern is None:
            return None, "no hosts"
        if isinstance(pattern, list):
            pattern = ",".join(str(p) for p in pattern)
        pattern = str(pattern).strip()
        if "{{" in pattern or "{%" in pattern:
            return None, "contains Jinja; resolved at runtime"
        allh = list(inv["hosts"])
        toks = [t.strip() for t in re.split(r"[,:](?![^\[]*\])", pattern) if t.strip()]
        result, order = set(), []

        def match(t):
            if t in ("all", "*"):
                return set(allh)
            if t in inv["groups"]:
                return self.descendants_hosts(inv, t)
            if t.startswith("~"):
                try:
                    rx = re.compile(t[1:])
                except re.error:
                    return set()
                s = {h for h in allh if rx.search(h)}
                for g in inv["groups"]:
                    if rx.search(g):
                        s |= self.descendants_hosts(inv, g)
                return s
            if any(c in t for c in "*?["):
                s = {h for h in allh if fnmatch.fnmatch(h, t)}
                for g in inv["groups"]:
                    if fnmatch.fnmatch(g, t):
                        s |= self.descendants_hosts(inv, g)
                return s
            return {t} if t in inv["hosts"] else set()

        plus = [t for t in toks if not t.startswith(("&", "!"))]
        for t in plus:
            result |= match(t)
        for t in toks:
            if t.startswith("&"):
                result &= match(t[1:])
        for t in toks:
            if t.startswith("!"):
                result -= match(t[1:])
        return sorted(result), None

    # ---------------- roles
    def discover_roles(self):
        self.roles = {}
        dirs = list(self.roles_paths) + [self.root / "roles"]
        for f in self.files:
            if f.parent.name == "roles" or Path(self.rel(f)).parts[:1] == ("roles",):
                pass
        for dp in {p.parent for p in self.files}:
            if dp.name in ("tasks", "handlers", "defaults", "meta", "vars") and dp.parent.parent.name == "roles":
                dirs.append(dp.parent.parent)
        seen = set()
        for d in dirs:
            d = Path(d)
            if not d.is_dir() or d.resolve() in seen:
                continue
            seen.add(d.resolve())
            for r in sorted(d.iterdir()):
                if r.is_dir() and any((r / s).is_dir() for s in ("tasks", "handlers", "defaults", "meta", "vars", "templates")):
                    self.roles.setdefault(r.name, r)

    def role_entity(self, name):
        name = str(name)
        rid = f"role:{name}"
        if rid in self.entities:
            return rid
        short = name.split(".")[-1] if name.count(".") >= 2 else name
        path = self.roles.get(name) or self.roles.get(short) or self.roles.get(name.split("/")[-1])
        if not path:
            self.ent(rid, type="role", label=name, external=True, deps=[], task_files={}, handlers=[],
                     defaults=[], vars=[], templates=[], files=[], used_by=[],
                     note="Role not found in this repo (external: Galaxy, collection, or another roles_path).")
            self.warn(f"Role '{name}' is referenced but not found in the repo")
            return rid
        e = self.ent(rid, type="role", label=name, path=self.rel(path), external=False, used_by=[])
        meta = None
        for mf in ("meta/main.yml", "meta/main.yaml", "meta/main"):
            if (path / mf).exists():
                meta = self.load_yaml(path / mf)
                break
        deps = []
        if isinstance(meta, dict):
            gi = meta.get("galaxy_info") if isinstance(meta.get("galaxy_info"), dict) else {}
            e["description"] = clean(gi.get("description"))
            for d in as_list(meta.get("dependencies")):
                dn = d if isinstance(d, str) else (d.get("role") or d.get("name") if isinstance(d, dict) else None)
                if dn:
                    deps.append(str(dn))
        e["dep_names"] = deps
        e["deps"] = [self.role_entity(d) for d in deps]
        for d in e["deps"]:
            self.entities[d].setdefault("used_by", []).append(rid)
        e["defaults"] = self._role_vars(path / "defaults")
        e["vars"] = self._role_vars(path / "vars")
        tf = {}
        tdir = path / "tasks"
        if tdir.is_dir():
            for f in sorted(tdir.rglob("*")):
                if f.is_file() and f.suffix.lower() in YAML_EXT:
                    tf[str(f.relative_to(tdir))] = self.rel(f)
        e["task_files"] = tf
        hfile = next((path / "handlers" / n for n in ("main.yml", "main.yaml") if (path / "handlers" / n).exists()), None)
        e["handlers"] = self.parse_task_list(hfile, ctx={"role": name, "role_path": path, "handler": True}) if hfile else []
        e["templates"] = sorted(self.rel(f) for f in (path / "templates").rglob("*") if f.is_file()) if (path / "templates").is_dir() else []
        e["files"] = sorted(self.rel(f) for f in (path / "files").rglob("*") if f.is_file()) if (path / "files").is_dir() else []
        main = next((path / "tasks" / n for n in ("main.yml", "main.yaml") if (path / "tasks" / n).exists()), None)
        e["tasks"] = self.parse_task_list(main, ctx={"role": name, "role_path": path}) if main else []
        return rid

    def _role_vars(self, d: Path):
        out = []
        if not d.is_dir():
            return out
        for f in sorted(d.rglob("*")):
            if f.is_file() and (f.suffix.lower() in YAML_EXT or f.suffix == ""):
                out.extend(self._var_entries(self.load_yaml(f), self.rel(f)))
        return out

    def role_tasks_from(self, rid, tasks_from):
        e = self.entities[rid]
        if e.get("external") or not tasks_from:
            return e.get("tasks", [])
        path = self.root / e["path"]
        for cand in (tasks_from, f"{tasks_from}.yml", f"{tasks_from}.yaml"):
            f = path / "tasks" / cand
            if f.is_file():
                return self.parse_task_list(f, ctx={"role": e["label"], "role_path": path})
        self.warn(f"tasks_from '{tasks_from}' not found in role {e['label']}")
        return []

    # ---------------- tasks
    def parse_task_list(self, f: Path, ctx, stack=()):
        if f is None:
            return []
        f = Path(f).resolve()
        key = (str(f), bool(ctx.get("handler")))
        if key in self.taskfile_cache:
            return self.taskfile_cache[key]
        if str(f) in stack:
            self.warn(f"Include loop detected at {self.rel(f)}")
            return []
        self.taskfile_cache[key] = []  # placeholder against recursion
        data = self.load_yaml(f)
        res = []
        if isinstance(data, list):
            res = [t for t in (self.parse_task(x, f, ctx, stack + (str(f),)) for x in data) if t]
        elif data is not None and not isinstance(data, VaultValue):
            self.warn(f"Expected a list of tasks in {self.rel(f)}")
        self.taskfile_cache[key] = res
        return res

    def parse_task(self, t, f: Path, ctx, stack, section=None):
        if not isinstance(t, dict):
            return None
        tid = f"task:{next(self.task_seq)}"
        base = {"src": self.rel(f), "line": t.get("__line__"), "role": ctx.get("role"), "owner": ctx.get("owner")}
        if ctx.get("local_play"):
            base["local_play"] = True
        common = {}
        for k in ("when", "tags", "loop", "register", "become", "become_user", "delegate_to", "notify", "listen",
                  "ignore_errors", "changed_when", "failed_when", "until", "retries", "delay", "run_once",
                  "no_log", "vars", "environment", "loop_control", "check_mode", "async", "poll", "throttle"):
            if k in t:
                common[k] = clean(t[k])
        for k in keys(t):
            if str(k).startswith("with_"):
                common["loop"] = {str(k): clean(t[k])}
        if "vars" in common:
            common["vars"] = redact_tree(common["vars"], self.redact)
        if "block" in t:
            e = self.ent(tid, type="block", label=str(t.get("name") or "block"), **base, **common)
            parts = []
            for sec in ("block", "rescue", "always"):
                if isinstance(t.get(sec), list):
                    kids = [x for x in (self.parse_task(y, f, ctx, stack) for y in t[sec]) if x]
                    sid = f"sec:{next(self.sec_seq)}"
                    self.ent(sid, type="section", label=sec, count=len(kids), note={
                        "block": "Tasks run in order.", "rescue": "Runs only if a task in the block fails.",
                        "always": "Runs whether the block succeeded or failed."}[sec])
                    parts.append({"sec": sid, "name": sec, "tasks": kids})
            e["parts"] = parts
            return tid
        module, args = None, {}
        if "action" in t or "local_action" in t:
            av = t.get("action") or t.get("local_action")
            if isinstance(av, dict):
                module = str(av.get("module"))
                args = {k: v for k, v in av.items() if k not in ("module", "__line__", "__lines__")}
            elif isinstance(av, str):
                parts = av.split(None, 1)
                module = parts[0]
                args = parse_kv(parts[1]) if len(parts) > 1 else {}
            if "local_action" in t:
                common["delegate_to"] = "localhost"
        else:
            for k in keys(t):
                if k not in TASK_KEYWORDS and not str(k).startswith("with_"):
                    module = str(k)
                    v = t[k]
                    if isinstance(v, dict):
                        args = v
                    elif isinstance(v, str):
                        short = module.split(".")[-1]
                        if short in ("shell", "command", "raw", "script", "meta"):
                            args = {"_raw_params": v}
                        elif "=" in v and "{{" not in v.split("=", 1)[0]:
                            args = parse_kv(v)
                        else:
                            args = {"_raw_params": v}
                    elif v is not None:
                        args = {"_raw_params": v}
                    break
        if isinstance(t.get("args"), dict):
            args = dict(args, **{k: v for k, v in t["args"].items() if k not in ("__line__", "__lines__")})
        args = redact_tree(clean(args), self.redact)
        sm = short_module(module) if module else None
        name = t.get("name")
        e = self.ent(tid, type="handler" if ctx.get("handler") else "task", module=module, args=args,
                     **base, **common)
        e["desc"] = describe(module, args)
        if sm == "include_vars":
            target = args.get("file") or args.get("_raw_params")
            if isinstance(target, str) and "{{" not in target:
                cands = ([Path(ctx["role_path"]) / "vars" / target] if ctx.get("role_path") else []) + [f.parent / target, f.parent / "vars" / target]
                hit = next((c for c in cands if c.is_file()), None)
                if hit:
                    e["include_vars_path"] = self.rel(hit)
                    e["include_vars_vars"] = self._var_entries(self.load_yaml(hit), self.rel(hit))
        if sm in ("template", "win_template") and isinstance(args.get("src"), str) and "{{" not in args["src"]:
            srcp = args["src"]
            cands = []
            if ctx.get("role_path"):
                cands += [Path(ctx["role_path"]) / "templates" / srcp, Path(ctx["role_path"]) / srcp]
            cands += [f.parent / "templates" / srcp, f.parent / srcp, self.root / "templates" / srcp, self.root / srcp]
            hit = next((c for c in cands if c.is_file()), None)
            if hit:
                e["template_path"] = self.rel(hit)
        e["label"] = str(name) if name else (f"{sm}: {_j(args.get('_raw_params') or args.get('name') or args.get('file') or '', 2)}" if sm else "(unnamed)")
        e["named"] = bool(name)
        if not name and not ctx.get("handler") and sm not in INCLUDE_TASK_MODS | ROLE_MODS | {"meta"}:
            pass
        # includes
        if sm in INCLUDE_TASK_MODS:
            target = args.get("_raw_params") or args.get("file")
            e["type"] = sm if sm != "include" else "include_tasks"
            e["include_target"] = target
            if target and "{{" not in str(target):
                cands = []
                if ctx.get("role_path"):
                    cands.append(Path(ctx["role_path"]) / "tasks" / str(target))
                cands += [f.parent / str(target), self.root / str(target)]
                tf = next((c for c in cands if c.is_file()), None)
                if tf:
                    e["include_src"] = self.rel(tf)
                    e["children"] = self.parse_task_list(tf, ctx, stack)
                else:
                    e["unresolved"] = f"Task file '{target}' not found"
                    self.warn(f"{self.rel(f)}: included file '{target}' not found")
            else:
                e["unresolved"] = "Path is templated; resolved at runtime" if target else "No file given"
            if not name:
                e["label"] = f"{e['type']}: {target}"
        elif sm in ROLE_MODS:
            rn = args.get("name") or args.get("role")
            e["type"] = sm
            if rn and "{{" not in str(rn):
                rid = self.role_entity(rn)
                e["role_ref"] = rid
                e["tasks_from"] = args.get("tasks_from")
                self.entities[rid].setdefault("used_by", [])
                if tid not in self.entities[rid]["used_by"]:
                    self.entities[rid]["used_by"].append(tid)
            if not name:
                e["label"] = f"{sm}: {rn}" + (f" ({args.get('tasks_from')})" if args.get("tasks_from") else "")
        return tid

    # ---------------- playbooks
    def is_playbook(self, data):
        if not isinstance(data, list) or not data:
            return False
        ok = 0
        for p in data:
            if not isinstance(p, dict):
                return False
            ks = set(keys(p))
            if ks & {"hosts", "import_playbook", "ansible.builtin.import_playbook", "include"} and not (ks & {"block"}):
                if "include" in ks and "hosts" not in ks and len(data) and not any("hosts" in x or "import_playbook" in x for x in data if isinstance(x, dict)):
                    return False
                ok += 1
        return ok > 0

    def parse_playbooks(self):
        self.playbooks = []
        for f in self.files:
            if f.suffix.lower() not in YAML_EXT or self.is_vars_dir_file(f):
                continue
            d = self.load_yaml(f)
            if self.is_playbook(d):
                self.playbooks.append(f)
        for f in self.playbooks:
            self._parse_playbook(f)
        imported = set()
        for f in self.playbooks:
            for it in self.entities[f"pb:{self.rel(f)}"]["items"]:
                if it.startswith("pb:"):
                    imported.add(it)
        for f in self.playbooks:
            pid = f"pb:{self.rel(f)}"
            self.entities[pid]["root"] = pid not in imported

    def _parse_playbook(self, f: Path):
        pid = f"pb:{self.rel(f)}"
        e = self.ent(pid, type="playbook", label=self.rel(f), path=self.rel(f), items=[], imported_by=[])
        data = self.load_yaml(f)
        for i, p in enumerate(data):
            if not isinstance(p, dict):
                continue
            imp = p.get("import_playbook") or p.get("ansible.builtin.import_playbook") or (p.get("include") if "hosts" not in p else None)
            if imp:
                target = (f.parent / str(imp)).resolve()
                tid = f"pb:{self.rel(target)}"
                if target.is_file():
                    if tid not in self.entities:
                        self.ent(tid, type="playbook", label=self.rel(target), path=self.rel(target), items=[], imported_by=[])
                    self.entities[tid]["imported_by"].append(pid)
                    e["items"].append(tid)
                else:
                    xid = f"missing:{self.rel(f)}:{i}"
                    self.ent(xid, type="missing", label=f"import_playbook: {imp}", note="Target file not found or templated", src=self.rel(f), line=p.get("__line__"))
                    e["items"].append(xid)
                    self.warn(f"{self.rel(f)}: import_playbook target '{imp}' not found")
                continue
            e["items"].append(self._parse_play(p, f, i, pid))

    def _parse_play(self, p, f, i, pid):
        plid = f"play:{self.rel(f)}#{i}"
        hosts = clean(p.get("hosts"))
        name = p.get("name") or f"Play on {hosts}"
        e = self.ent(plid, type="play", label=str(name), playbook=pid, hosts=hosts, src=self.rel(f), line=p.get("__line__"))
        for k in ("become", "become_user", "gather_facts", "serial", "strategy", "tags", "connection", "remote_user",
                  "any_errors_fatal", "max_fail_percentage", "order", "environment", "collections", "vars_prompt", "vars_files", "when"):
            if k in p:
                e[k] = clean(p[k])
        e["vars"] = self._var_entries(p.get("vars"), self.rel(f)) if isinstance(p.get("vars"), dict) else []
        vf_entries, vf_files = [], []
        for vf in as_list(p.get("vars_files")):
            for cand in as_list(vf):          # a list item may itself be a list of alternatives
                if isinstance(cand, str) and "{{" not in cand:
                    path = (f.parent / cand)
                    if path.is_file():
                        vf_files.append(self.rel(path))
                        vf_entries += self._var_entries(self.load_yaml(path), self.rel(path))
                        break
        e["vars_files_vars"] = vf_entries
        e["vars_files_paths"] = vf_files
        ctx = {"owner": pid, "play_dir": f.parent,
               "local_play": str(hosts).strip() in ("localhost", "127.0.0.1") or p.get("connection") == "local"}
        sections = []
        for sec in PLAY_KEYS_SECTIONS:
            if sec not in p:
                continue
            sid = f"sec:{next(self.sec_seq)}"
            if sec == "roles":
                refs = []
                for r in as_list(p.get("roles")):
                    rn = r if isinstance(r, str) else (r.get("role") or r.get("name") if isinstance(r, dict) else None)
                    if not rn:
                        continue
                    rid = self.role_entity(rn)
                    if plid not in self.entities[rid]["used_by"]:
                        self.entities[rid]["used_by"].append(plid)
                    ref = {"role": rid}
                    if isinstance(r, dict):
                        extra = {k: clean(v) for k, v in r.items() if k not in ("role", "name", "__line__", "__lines__")}
                        if extra:
                            ref["params"] = redact_tree(extra, self.redact)
                    refs.append(ref)
                self.ent(sid, type="section", label="roles", count=len(refs), note="Roles run after pre_tasks and before tasks. Each role's meta dependencies run first.")
                sections.append({"sec": sid, "name": sec, "roles": refs})
            else:
                c = dict(ctx, handler=(sec == "handlers"))
                kids = [x for x in (self.parse_task(t, f, c, (str(f),)) for t in as_list(p.get(sec))) if x]
                note = {"pre_tasks": "Run first, before roles.", "tasks": "Run after roles.",
                        "post_tasks": "Run last, after tasks (and after handlers notified so far).",
                        "handlers": "Run at the end of each section, only when notified by a task that changed something."}[sec]
                self.ent(sid, type="section", label=sec.replace("_", "-"), count=len(kids), note=note)
                sections.append({"sec": sid, "name": sec, "tasks": kids})
        e["sections"] = sections
        # host resolution per inventory
        res = {}
        implicit_local = str(hosts).strip() in ("localhost", "127.0.0.1")
        for inv in self.inventories:
            if implicit_local and str(hosts).strip() not in inv["hosts"]:
                res[inv["id"]] = {"hosts": None, "note": "Runs on the control node (Ansible's implicit localhost)."}
                continue
            hs, why = self.resolve_pattern(inv, hosts)
            res[inv["id"]] = {"hosts": [f"host:{inv['id']}:{h}" for h in hs] if hs is not None else None, "note": why}
            for h in hs or []:
                he = self.entities.get(f"host:{inv['id']}:{h}")
                if he is not None and plid not in he["plays"]:
                    he["plays"].append(plid)
        e["resolved"] = res
        return plid

    # ---------------- trees & run plans
    def task_tree(self, tid, stack=()):
        e = self.entities[tid]
        kids = []
        if e["type"] == "block":
            for part in e.get("parts", []):
                kids.append([part["sec"], [self.task_tree(x, stack) for x in part["tasks"]]])
        elif e.get("children"):
            kids = [self.task_tree(x, stack) for x in e["children"]]
        elif e.get("role_ref"):
            kids = [self.role_tree(e["role_ref"], stack, e.get("tasks_from"))]
        return [tid, kids] if kids else tid

    def role_tree(self, rid, stack=(), tasks_from=None):
        if rid in stack:
            return [rid, []]
        e = self.entities[rid]
        st = stack + (rid,)
        kids = [self.role_tree(d, st) for d in e.get("deps", [])]
        tasks = self.role_tasks_from(rid, tasks_from) if tasks_from else e.get("tasks", [])
        kids += [self.task_tree(t, st) for t in tasks]
        if e.get("handlers"):
            sid = f"sec:{next(self.sec_seq)}"
            self.ent(sid, type="section", label="handlers", count=len(e["handlers"]),
                     note="Run only when notified, at the end of the section that notified them.")
            kids.append([sid, [self.task_tree(t, st) for t in e["handlers"]]])
        return [rid, kids]

    def play_tree(self, plid):
        e = self.entities[plid]
        kids = []
        for s in e["sections"]:
            if "roles" in s:
                kids.append([s["sec"], [self.role_tree(r["role"]) for r in s["roles"]]])
            else:
                kids.append([s["sec"], [self.task_tree(t) for t in s["tasks"]]])
        return [plid, kids]

    def playbook_tree(self, pid, stack=()):
        if pid in stack:
            return [pid, []]
        e = self.entities[pid]
        kids = []
        for it in e.get("items", []):
            if it.startswith("pb:"):
                kids.append(self.playbook_tree(it, stack + (pid,)))
            elif it.startswith("play:"):
                kids.append(self.play_tree(it))
            else:
                kids.append(it)
        return [pid, kids]

    def inventory_tree(self, inv):
        iid = inv["id"]

        def gtree(g, stack=()):
            if g in stack:
                return f"group:{iid}:{g}"
            G = inv["groups"][g]
            kids = [gtree(c, stack + (g,)) for c in sorted(G["children"])]
            kids += [f"host:{iid}:{h}" for h in sorted(G["hosts"])]
            return [f"group:{iid}:{g}", kids]

        return [iid, [gtree("all")]]

    def run_plan(self, pid):
        """Flatten a playbook into the order Ansible would execute things."""
        plays = []

        def walk_pb(p, stack=()):
            if p in stack:
                return
            for it in self.entities[p].get("items", []):
                if it.startswith("pb:"):
                    walk_pb(it, stack + (p,))
                elif it.startswith("play:"):
                    plays.append(self._plan_play(it))

        walk_pb(pid)
        return plays

    def _plan_play(self, plid):
        """Flatten one play in execution order.

        Every step records its *effective* tags (inherited from the play, the
        roles: entry, blocks and static imports, as Ansible does) and, for
        steps inside a dynamic include, the index of that include step
        ("gate"): if the include itself is skipped by --tags, so are they.
        """
        e = self.entities[plid]
        steps, ran_roles = [], set()
        handlers_index = {}
        play_tags = tagset(e.get("tags"))

        def add(tid, phase, via, depth, tags, gate, note=None):
            t = self.entities[tid]
            eff = sorted(tags | tagset(t.get("tags")))
            steps.append({"t": tid, "phase": phase, "via": list(via), "depth": depth, "note": note,
                          "tags": eff, "gate": gate})
            return len(steps) - 1, set(eff)

        def flat_tasks(tids, phase, via, depth, tags, gate, stack=()):
            for tid in tids:
                t = self.entities[tid]
                typ = t["type"]
                if typ == "block":
                    _, eff = add(tid, phase, via, depth, tags, gate)
                    for part in t.get("parts", []):
                        flat_tasks(part["tasks"], phase, via + [part["name"]], depth + 1, eff, gate, stack)
                elif typ in ("include_tasks", "import_tasks") and t.get("children") is not None:
                    idx, eff = add(tid, phase, via, depth, tags, gate)
                    if typ == "import_tasks":       # static: children inherit the import's tags
                        flat_tasks(t["children"], phase, via, depth + 1, eff, gate, stack)
                    else:                           # dynamic: include must be selected; tags not inherited
                        flat_tasks(t["children"], phase, via, depth + 1, tags, idx, stack)
                elif t.get("role_ref"):
                    idx, eff = add(tid, phase, via, depth, tags, gate)
                    if typ == "import_role":
                        flat_role(t["role_ref"], phase, via, depth + 1, eff, gate, stack, t.get("tasks_from"), dedupe=False)
                    else:
                        flat_role(t["role_ref"], phase, via, depth + 1, tags, idx, stack, t.get("tasks_from"), dedupe=False)
                else:
                    add(tid, phase, via, depth, tags, gate)

        def flat_role(rid, phase, via, depth, tags, gate, stack=(), tasks_from=None, dedupe=True):
            if rid in stack:
                return
            re_ = self.entities[rid]
            key = (rid, tasks_from)
            if dedupe and key in ran_roles:
                steps.append({"t": rid, "phase": phase, "via": list(via), "depth": depth, "tags": sorted(tags), "gate": gate,
                              "note": "Role already ran in this play; Ansible skips it (same parameters)."})
                return
            ran_roles.add(key)
            for d in re_.get("deps", []):
                flat_role(d, phase, via + [re_["label"]], depth, tags, gate, stack + (rid,))
            tasks = self.role_tasks_from(rid, tasks_from) if tasks_from else re_.get("tasks", [])
            if re_.get("external"):
                steps.append({"t": rid, "phase": phase, "via": list(via), "depth": depth, "tags": sorted(tags), "gate": gate,
                              "note": "External role: tasks not in this repo."})
            flat_tasks(tasks, phase, via + [re_["label"]], depth, tags, gate, stack + (rid,))
            for h in re_.get("handlers", []):
                handlers_index.setdefault(h, None)

        for s in e["sections"]:
            if s["name"] == "handlers":
                for h in s["tasks"]:
                    handlers_index.setdefault(h, None)
                continue
            if "roles" in s:
                for r in s["roles"]:
                    rtags = play_tags | tagset((r.get("params") or {}).get("tags"))
                    flat_role(r["role"], "roles", [], 0, rtags, None)
            else:
                flat_tasks(s["tasks"], s["name"], [], 0, play_tags, None)
        # handlers: which steps notify them
        notifiers = {}
        for i, st in enumerate(steps):
            t = self.entities[st["t"]]
            for n in as_list(t.get("notify")):
                notifiers.setdefault(str(n), []).append(i)
        hsteps = []
        for h in handlers_index:
            he = self.entities[h]
            names = {he.get("label")} | set(str(x) for x in as_list(he.get("listen")))
            idxs = sorted({i for n in names for i in notifiers.get(n, [])})
            hsteps.append({"t": h, "phase": "handlers", "via": [he["role"]] if he.get("role") else [], "depth": 0,
                           "tags": sorted(tagset(he.get("tags"))), "gate": None,
                           "notified_by": [steps[i]["t"] for i in idxs], "notified_by_steps": idxs,
                           "note": None if idxs else "Not notified by any task in this play."})
        return {"play": plid, "steps": steps, "handlers": hsteps, "play_tags": sorted(play_tags)}

    def link_handlers(self):
        """Resolve notify -> handler entity ids (by name or listen)."""
        hmap = {}
        for e in self.entities.values():
            if e.get("type") == "handler":
                for n in {e.get("label")} | set(str(x) for x in as_list(e.get("listen"))):
                    hmap.setdefault(n, []).append(e["id"])
        unknown = {}
        for e in self.entities.values():
            if e.get("type") in ("task", "handler") and e.get("notify"):
                e["notify_ids"] = {str(n): hmap.get(str(n), []) for n in as_list(e["notify"])}
                for n, ids in e["notify_ids"].items():
                    if not ids:
                        unknown.setdefault(n, []).append(f"{e.get('src')}:{e.get('line')}")
                    for h in ids:
                        self.entities[h].setdefault("notified_by", []).append(e["id"])
        for n, where in sorted(unknown.items()):
            more = f" (+{len(where) - 3} more)" if len(where) > 3 else ""
            self.warn(f"Handler '{n}' is notified but not defined (may be templated or come from an external role): "
                      f"{', '.join(where[:3])}{more}")

    # ---------------- templates
    def discover_templates(self):
        for f in self.files:
            rp = Path(self.rel(f)).parts
            if not ("templates" in rp[:-1] or f.suffix == ".j2"):
                continue
            try:
                raw = f.read_bytes()[:400_000]
            except OSError:
                continue
            if b"\0" in raw[:4096]:
                continue
            text = raw.decode("utf-8", errors="replace")
            role = rp[rp.index("roles") + 1] if "roles" in rp and rp.index("roles") + 1 < len(rp) - 1 else None
            rel = self.rel(f)
            self.ent(f"tpl:{rel}", type="template", label=f.name, path=rel, role=role,
                     lines=text.count("\n") + 1,
                     refs=text_refs(text), used_by=[])
        for e in list(self.entities.values()):
            if e.get("template_path"):
                tid = f"tpl:{e['template_path']}"
                if tid in self.entities:
                    e["template_ref"] = tid
                    self.entities[tid]["used_by"].append(e["id"])
        for e in self.entities.values():
            if e.get("type") == "role" and e.get("templates"):
                e["templates"] = [f"tpl:{t}" if f"tpl:{t}" in self.entities else t for t in e["templates"]]

    # ---------------- variable index: who defines and who uses each variable
    def build_var_index(self):
        defs, uses = {}, {}
        dseen, useen = set(), set()

        def add_def(name, owner, kind, value, src, line):
            name = str(name)
            k = (name, src, line, kind)
            if k in dseen:
                for d in defs[name]:
                    if (d["src"], d["line"], d["kind"]) == (src, line, kind) and owner not in d["owners"]:
                        d["owners"].append(owner)
                return
            dseen.add(k)
            defs.setdefault(name, []).append({"owners": [owner], "kind": kind, "v": value, "src": src, "line": line})
            return defs[name][-1]

        def add_use(names, owner, ctx, src, line, lines=None):
            for n in names:
                k = (n, owner, ctx)
                if k in useen:
                    continue
                useen.add(k)
                u = {"o": owner, "ctx": ctx, "src": src, "line": line}
                if lines:
                    u["lines"] = lines
                uses.setdefault(n, []).append(u)

        def var_list(owner, entries, kind):
            for v in entries or []:
                if v["k"] == "(encrypted file)":
                    continue
                dd = add_def(v["k"], owner, kind, v["v"], v["src"], v.get("line"))
                if dd is not None and v.get("secret_plain"):
                    dd["secret_plain"] = True
                add_use(value_refs(v["v"]), owner, f"value of {v['k']}", v["src"], v.get("line"))

        for e in self.entities.values():
            t = e.get("type")
            if t == "group":
                var_list(e["id"], e.get("vars"), "group var")
            elif t == "host":
                own = [v for v in e.get("vars", []) if "host" in v.get("layer", "")]
                own += [dict(o, k=v["k"]) for v in e.get("vars", []) for o in v.get("overridden", []) if "host" in o.get("layer", "")]
                var_list(e["id"], own, "host var")
            elif t == "role":
                var_list(e["id"], e.get("defaults"), "role default")
                var_list(e["id"], e.get("vars"), "role var")
            elif t == "play":
                var_list(e["id"], e.get("vars"), "play var")
                var_list(e["id"], e.get("vars_files_vars"), "vars_files")
                add_use(value_refs(e.get("hosts")), e["id"], "hosts:", e.get("src"), e.get("line"))
                add_use(bare_refs(e.get("when")), e["id"], "when:", e.get("src"), e.get("line"))
                add_use(value_refs(e.get("vars_files")), e["id"], "vars_files:", e.get("src"), e.get("line"))
            elif t in ("task", "handler", "block", "include_tasks", "import_tasks", "include_role", "import_role"):
                src, line, oid = e.get("src"), e.get("line"), e["id"]
                var_list(oid, e.get("include_vars_vars"), "include_vars")
                if e.get("register"):
                    add_def(e["register"], oid, "registered result", None, src, line)
                if isinstance(e.get("vars"), dict):
                    for k, v in e["vars"].items():
                        add_def(k, oid, "task var", v, src, line)
                        add_use(value_refs(v), oid, f"vars.{k}", src, line)
                lc = e.get("loop_control")
                if isinstance(lc, dict) and lc.get("loop_var"):
                    add_def(lc["loop_var"], oid, "loop var", None, src, line)
                args = e.get("args") or {}
                sm = short_module(e.get("module") or "")
                if sm == "set_fact":
                    for k, v in args.items():
                        if k not in ("cacheable", "_raw_params"):
                            add_def(k, oid, "set_fact", v, src, line)
                if sm == "include_vars":
                    add_use(value_refs(args), oid, "include_vars", src, line)
                for k, v in args.items():
                    if sm == "assert" and k == "that" or sm == "debug" and k == "var":
                        add_use(bare_refs(v), oid, f"args.{k}", src, line)
                    else:
                        add_use(value_refs(v), oid, "args" if k == "_raw_params" else f"args.{k}", src, line)
                if e.get("named"):
                    add_use(value_refs(e.get("label")), oid, "name", src, line)
                for k in ("when", "until", "changed_when", "failed_when"):
                    add_use(bare_refs(e.get(k)), oid, f"{k}:", src, line)
                for k in ("loop", "delegate_to", "become_user", "environment", "notify", "include_target"):
                    add_use(value_refs(e.get(k)), oid, f"{k}:", src, line)
            elif t == "template":
                for n, lines in (e.get("refs") or {}).items():
                    add_use([n], e["id"], "template", e["path"], lines[0], lines)
        for name in sorted(set(defs) | set(uses)):
            d, u = defs.get(name, []), uses.get(name, [])
            builtin = not d and (name in MAGIC_VARS or name.startswith("ansible_"))
            self.ent(f"var:{name}", type="var", label=name, defs=d, uses=u, builtin=builtin)

    # ---------------- files & scripts
    def collect_files(self):
        """Every scanned file, with (redacted) text for the in-browser viewer."""
        self.file_map, budget = {}, MAX_EMBED_TOTAL
        for f in self.files:
            rel = self.rel(f)
            try:
                size = f.stat().st_size
            except OSError:
                continue
            info = {"size": size}
            name = f.name
            if SENSITIVE_NAME_RE.search(name):
                info["note"] = "Not embedded: file name suggests key material or credentials."
                self.file_map[rel] = info
                continue
            try:
                raw = f.read_bytes()[:MAX_EMBED_FILE + 1]
            except OSError:
                continue
            if b"\0" in raw[:4096]:
                info["note"] = "Binary file."
                self.file_map[rel] = info
                continue
            text = raw[:MAX_EMBED_FILE].decode("utf-8", errors="replace")
            ext = f.suffix.lower()
            texty = ext in TEXT_EXT or not ext or text.startswith("#!") or rel in self.file_kinds
            if not texty:
                info["note"] = "Not a recognised text file type."
                self.file_map[rel] = info
                continue
            info["lines"] = text.count("\n") + 1
            if text.lstrip().startswith("$ANSIBLE_VAULT"):
                info["note"] = "Vault-encrypted: contents are never decrypted."
                info["encrypted"] = True
            elif not self.sources:
                info["note"] = "Contents not embedded (--no-sources)."
            elif budget - len(text) < 0:
                info["note"] = "Not embedded: total size budget reached."
            else:
                info["text"] = redact_text(text) if self.redact else text
                info["truncated"] = size > MAX_EMBED_FILE
                budget -= len(text)
            self.file_map[rel] = info
        for rel, kind in self.file_kinds.items():
            if rel in self.file_map:
                self.file_map[rel]["kind"] = kind

    def classify_files(self):
        kinds = {}
        for e in self.entities.values():
            t = e.get("type")
            if t == "playbook":
                kinds[e["path"]] = "playbook"
            elif t in ("task", "handler", "block", "include_tasks", "import_tasks", "include_role", "import_role"):
                if e.get("src") and e["src"] not in kinds:
                    kinds[e["src"]] = "tasks"
            elif t == "template":
                kinds[e["path"]] = "template"
            elif t == "inventory":
                for x in e.get("files", []):
                    kinds[x] = "inventory"
        for rel in [self.rel(f) for f in self.files]:
            parts = Path(rel).parts
            if rel not in kinds and ("group_vars" in parts or "host_vars" in parts or
                                     (len(parts) > 2 and parts[-2] in ("defaults", "vars"))):
                kinds[rel] = "vars"
            elif rel not in kinds and Path(rel).suffix.lower() in (".md", ".markdown", ".mdown", ".mkd"):
                kinds[rel] = "notes"
            elif rel not in kinds and Path(rel).name == "ansible.cfg":
                kinds[rel] = "config"
            elif rel not in kinds and Path(rel).parts[-2:-1] == ("meta",):
                kinds[rel] = "meta"
        self.file_kinds = kinds

    def discover_scripts(self):
        task_strings = []
        for e in self.entities.values():
            if e.get("type") in ("task", "handler") and e.get("module"):
                strs = []

                def walk(v):
                    if isinstance(v, str):
                        strs.append(v)
                    elif isinstance(v, dict):
                        for x in v.values():
                            walk(x)
                    elif isinstance(v, list):
                        for x in v:
                            walk(x)
                walk(e.get("args"))
                walk(e.get("loop"))
                task_strings.append((e, " ".join(strs)))
        for f in self.files:
            rel = self.rel(f)
            parts = Path(rel).parts
            ext = f.suffix.lower()
            shebang = ""
            try:
                with f.open("rb") as fh:
                    head = fh.read(200)
                if head.startswith(b"#!"):
                    shebang = head.split(b"\n", 1)[0][2:].decode("utf-8", "replace").strip()
            except OSError:
                continue
            is_script = ext in SCRIPT_EXT or (not ext and shebang) or \
                (ext in SCRIPT_DIR_EXT and set(parts[:-1]) & {"scripts", "bin", "files", "script", "tools"})
            if not is_script or "templates" in parts[:-1]:
                continue
            interp = (shebang.split()[-1].split("/")[-1] if shebang else
                      {".sh": "sh", ".bash": "bash", ".zsh": "zsh", ".ksh": "ksh", ".ps1": "powershell",
                       ".py": "python", ".pl": "perl", ".rb": "ruby"}.get(ext, "?"))
            refs = []
            pat = re.compile(r"(?<![\w.-])" + re.escape(f.name) + r"(?![\w.-])")
            for e, text in task_strings:
                if not pat.search(text):
                    continue
                sm = short_module(e["module"])
                local = (str(e.get("delegate_to", "")).strip() in ("localhost", "127.0.0.1") or
                         e.get("connection") == "local" or bool(e.get("local_play")))
                if sm == "script":
                    how = "Uploaded to and run on the target hosts" if not local else "Run on the control node"
                elif sm in ("command", "shell", "raw"):
                    how = "Run on the control node" if local else "Run on the target hosts (must already be there)"
                elif sm in ("copy", "template", "synchronize"):
                    how = "Copied to the target hosts"
                elif sm == "cron":
                    how = "Scheduled with cron on the target hosts"
                else:
                    how = f"Mentioned in a {sm} task"
                refs.append({"t": e["id"], "how": how})
                e.setdefault("script_refs", []).append(f"script:{rel}")
            self.ent(f"script:{rel}", type="script", label=f.name, path=rel, interpreter=interp,
                     shebang=shebang or None, refs=refs,
                     summary=(sorted({r["how"] for r in refs}) if refs else
                              ["Not referenced by any task: probably run by hand on the control node"]))
            self.file_kinds[rel] = "script"

    # ---------------- checks
    def add_finding(self, rule, msg, eid=None, src=None, line=None):
        sev = CHECK_RULES[rule][0]
        self.findings.append({"rule": rule, "sev": sev, "msg": msg, "e": eid, "src": src, "line": line})

    def run_checks(self):
        E = self.entities
        default_inv = next((i for i in self.inventories if i["default"]), self.inventories[0] if self.inventories else None)
        for path, line, problem in self.yaml_errors:
            self.add_finding("yaml-error", problem, src=path, line=line)
        for e in list(E.values()):
            t, eid, src, line = e.get("type"), e["id"], e.get("src"), e.get("line")
            if t == "missing":
                self.add_finding("missing-file", e["label"] + " — target not found", eid, src, line)
            elif t == "role":
                if e.get("external"):
                    self.add_finding("external-role", f"Role '{e['label']}' isn't in this repo", eid)
                elif not e.get("used_by"):
                    self.add_finding("unused-role", f"Role '{e['label']}' isn't used by any play, role or include", eid, e.get("path"))
            elif t == "play" and default_inv:
                r = e.get("resolved", {}).get(default_inv["id"])
                if r and r.get("hosts") == []:
                    self.add_finding("no-hosts", f"hosts: {e.get('hosts')} matches nothing in {default_inv['path']}", eid, src, line)
            elif t in ("include_tasks", "import_tasks") and "not found" in str(e.get("unresolved", "")):
                self.add_finding("missing-file", e["unresolved"], eid, src, line)
            elif t == "handler" and not e.get("notified_by"):
                self.add_finding("unnotified-handler", f"Handler '{e['label']}' is never notified", eid, src, line)
            if t in ("task", "handler"):
                sm = short_module(e.get("module") or "")
                args = e.get("args") or {}
                for n, ids in (e.get("notify_ids") or {}).items():
                    if not ids:
                        self.add_finding("unknown-handler", f"notify: '{n}' has no matching handler", eid, src, line)
                if t == "task" and not e.get("named"):
                    self.add_finding("no-name", f"Unnamed {sm or 'task'} task", eid, src, line)
                if sm in ("command", "shell"):
                    cmd = str(args.get("_raw_params") or args.get("cmd") or "").strip()
                    words = cmd.split()
                    first = words[1] if words[:1] == ["sudo"] and len(words) > 1 else (words[0] if words else "")
                    first = first.split("/")[-1]
                    if first in CMD_MODULES:
                        self.add_finding("command-instead-of-module", f"Runs `{first}`: consider the {CMD_MODULES[first]} module", eid, src, line)
                    if not any(k in e for k in ("changed_when",)) and not any(k in args for k in ("creates", "removes")):
                        self.add_finding("no-changed-when", f"{sm} task has no changed_when / creates / removes", eid, src, line)
                if sm in PKG_MODULES and str(args.get("state")) == "latest":
                    self.add_finding("package-latest", "state: latest upgrades whenever a new version appears", eid, src, line)
                if (sm in FILE_WRITE_MODULES or (sm == "file" and str(args.get("state", "file")) in ("file", "directory", "touch"))) \
                        and "mode" not in args:
                    self.add_finding("risky-file-permissions", f"{sm} without mode:", eid, src, line)
                if e.get("ignore_errors") in (True, "yes", "true", "True"):
                    self.add_finding("ignore-errors", "ignore_errors: true", eid, src, line)
                if sm == "script":
                    target = str(args.get("_raw_params") or args.get("cmd") or "").split()
                    if target and "{{" not in target[0] and not e.get("script_refs"):
                        self.add_finding("script-missing", f"script: {target[0]} not found in the repo", eid, src, line)
            elif t == "var":
                if e.get("uses") and not e.get("defs") and not e.get("builtin"):
                    u = e["uses"][0]
                    self.add_finding("undefined-var", f"'{e['label']}' is used but not defined in the repo "
                                     f"(may come from facts, --extra-vars or an external role)", eid, u.get("src"), u.get("line"))
                if e.get("defs") and not e.get("uses") and not e["label"].startswith("ansible_") and \
                        any(d["kind"] in ("group var", "role default", "role var", "play var", "vars_files", "include_vars") for d in e["defs"]):
                    d = e["defs"][0]
                    self.add_finding("unused-var", f"'{e['label']}' is defined but never used", eid, d.get("src"), d.get("line"))
                for d in e.get("defs", []):
                    if d.get("secret_plain"):
                        self.add_finding("plaintext-secret", f"'{e['label']}' looks like a secret but isn't vault-encrypted", eid, d.get("src"), d.get("line"))
        order = {"error": 0, "warning": 1, "info": 2}
        self.findings.sort(key=lambda x: (order[x["sev"]], x["rule"], x.get("src") or "", x.get("line") or 0))

    def requirements(self):
        reqs = []
        for f in self.files:
            if f.name in ("requirements.yml", "requirements.yaml") and "roles" not in Path(self.rel(f)).parts[:-2]:
                d = self.load_yaml(f)
                items = []
                if isinstance(d, dict):
                    for k in ("roles", "collections"):
                        for x in as_list(d.get(k)):
                            items.append({"kind": k[:-1], "name": clean(x.get("name") or x.get("src")) if isinstance(x, dict) else clean(x),
                                          "version": clean(x.get("version")) if isinstance(x, dict) else None})
                elif isinstance(d, list):
                    for x in d:
                        items.append({"kind": "role", "name": clean(x.get("name") or x.get("src")) if isinstance(x, dict) else clean(x),
                                      "version": clean(x.get("version")) if isinstance(x, dict) else None})
                reqs.append({"file": self.rel(f), "items": items})
        return reqs

    # ---------------- main
    def build(self):
        self.walk()
        self.parse_cfg()
        self.parse_inventories()
        self.discover_roles()
        self.parse_playbooks()
        for name in sorted(self.roles):
            self.role_entity(name)
        self.link_handlers()
        self.discover_templates()
        self.build_var_index()
        self.classify_files()
        self.discover_scripts()
        self.collect_files()
        self.run_checks()
        pb_roots = [f"pb:{self.rel(f)}" for f in self.playbooks if self.entities[f"pb:{self.rel(f)}"].get("root")]
        trees = {
            "playbooks": ["root:playbooks", [self.playbook_tree(p) for p in pb_roots]],
            "inventory": ["root:inventory", [self.inventory_tree(i) for i in self.inventories]],
            "roles": ["root:roles", [self.role_tree(f"role:{n}") for n in sorted(
                {e["label"] for e in self.entities.values() if e.get("type") == "role"})]],
        }
        self.ent("root:playbooks", type="root", label=f"Playbooks ({len(pb_roots)} entry points)")
        self.ent("root:inventory", type="root", label=f"Inventories ({len(self.inventories)})")
        self.ent("root:roles", type="root", label=f"Roles ({sum(1 for e in self.entities.values() if e.get('type') == 'role')})")
        plans = {f"pb:{self.rel(f)}": self.run_plan(f"pb:{self.rel(f)}") for f in self.playbooks}
        counts = {"script": 0, "template": 0}
        for e in self.entities.values():
            counts[e["type"]] = counts.get(e["type"], 0) + 1
        return {
            "meta": {"tool": "Ansible Atlas", "version": VERSION, "repo": self.root.name, "repo_path": _home_relative(self.root),
                     "generated": _dt.datetime.now().isoformat(timespec="seconds"), "redacted": self.redact,
                     "cfg_path": self.rel(self.cfg_path) if self.cfg_path else None,
                     "cfg": redact_tree(self.cfg, self.redact),
                     "warnings": self.warnings, "encrypted_files": self.encrypted_files,
                     "requirements": self.requirements(), "counts": counts,
                     "playbook_group_vars": sorted(self.pb_gv), "playbook_host_vars": sorted(self.pb_hv),
                     "scanned_files": len(self.files)},
            "entities": self.entities, "trees": trees, "plans": plans,
            "files": self.file_map, "findings": self.findings, "rules": CHECK_RULES,
        }


# Every generated file carries this marker so the repo's pre-commit hook and CI can
# refuse to commit it. Built from parts so this source file itself never matches.
GENERATED_MARKER = "ansible-atlas-" + "generated-output"


def _home_relative(p: Path) -> str:
    """'/Users/alice/src/infra' → '~/src/infra', so a shared map doesn't reveal your username."""
    try:
        return "~/" + p.relative_to(Path.home()).as_posix()
    except ValueError:
        return str(p)


INCLUDE_RE = re.compile(r"^[ \t]*/\* @include ([\w./-]+) \*/[ \t]*$", re.M)


def load_template(template: Path = None) -> str:
    """Assemble the viewer: replace each `/* @include path */` line in viewer/index.html with
    that file's contents (CSS inside <style>, JS inside the one <script>)."""
    template = template or TEMPLATE
    base = template.parent.resolve()

    def inline(m):
        path = (base / m.group(1)).resolve()
        if base not in path.parents or not path.is_file():
            sys.exit(f"viewer: cannot include {m.group(1)}")
        text = path.read_text(encoding="utf-8")
        if "</script" in text.lower() or "</style" in text.lower():
            sys.exit(f"viewer: {m.group(1)} must not contain a closing </script> or </style> tag")
        return f"/* ---- {m.group(1)} ---- */\n{text.rstrip()}\n"

    return INCLUDE_RE.sub(inline, template.read_text(encoding="utf-8"))


def render_html(model, template: Path = None):
    html = load_template(template)
    data = json.dumps(model, ensure_ascii=False, separators=(",", ":"), default=str)
    data = data.replace("</", "<\\/").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029").replace("<!--", "<\\!--")
    marker = "/*__ATLAS_DATA__*/null"
    if marker not in html:
        sys.exit("viewer/js/core.js is missing the data marker")
    html = html.replace(marker, data, 1)
    html = lock_scripts(html)
    # The repo name is a directory name, which can contain anything (even "-->"), so keep it
    # to safe characters before it goes into an HTML comment.
    repo = re.sub(r"[^\w .@+-]", "_", str(model["meta"]["repo"]))
    tag = (f'<meta name="generator" content="{GENERATED_MARKER}">\n'
           f'<!-- {GENERATED_MARKER}: contains data from {repo}. Do not commit or publish. -->\n')
    return html.replace("<head>", "<head>\n" + tag, 1)


SCRIPT_RE = re.compile(r"<script>(.*?)</script>", re.S)


def lock_scripts(html: str) -> str:
    """Replace script-src 'unsafe-inline' in the page's CSP with the SHA-256 hash of the
    viewer's own <script>. The browser then runs that exact script and nothing else, so
    even if some repo text ever slipped past escaping as markup, it could not execute."""
    scripts = SCRIPT_RE.findall(html)
    if len(scripts) != 1 or "script-src 'unsafe-inline'" not in html:
        sys.exit("viewer/index.html must have exactly one inline <script> and a script-src 'unsafe-inline' CSP")
    digest = base64.b64encode(hashlib.sha256(scripts[0].encode("utf-8")).digest()).decode()
    return html.replace("script-src 'unsafe-inline'", f"script-src 'sha256-{digest}'", 1)


def atomic_write(path: Path, text: str):
    """Write via a fresh temp file in the same folder, then rename over the target.
    mkstemp never follows an existing symlink and creates the file readable only by you
    (0600): the map can contain hostnames, IPs and, with --no-redact, secrets."""
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.resolve().parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


DEFAULT_MAP_DIR = "ansible-atlas-maps"      # created in your home folder


def resolve_output(root: Path, output):
    """Where to save the map: -o FILE, -o DIR/ (uses <repo>.html), or ~/ansible-atlas-maps/<repo>.html."""
    name = (re.sub(r"[^\w.-]+", "-", root.resolve().name).strip("-") or "repo") + ".html"
    if not output:
        d = Path.home() / DEFAULT_MAP_DIR
        if not d.exists():
            d.mkdir(mode=0o700, parents=True)
            try:
                d.chmod(0o700)                  # private: only you can open the folder
            except OSError:
                pass
        return d / name
    out = Path(output).expanduser()
    if out.is_dir() or str(output).endswith(("/", "\\")):
        out.mkdir(parents=True, exist_ok=True)
        return out / name
    out.parent.mkdir(parents=True, exist_ok=True)
    return out


def git_exposure(path: Path):
    """Return a warning if `path` is inside a git work tree and NOT ignored."""
    import subprocess
    d = path.resolve().parent
    try:
        top = subprocess.run(["git", "-C", str(d), "rev-parse", "--show-toplevel"], capture_output=True, text=True, timeout=5)
        if top.returncode != 0:
            return None
        ign = subprocess.run(["git", "-C", str(d), "check-ignore", "-q", str(path.resolve())], capture_output=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return None
    if ign.returncode == 0:
        return None
    return (f"WARNING: {path} is inside the git repo {top.stdout.strip()} and is NOT git-ignored.\n"
            f"         It contains hostnames, IPs and variable values. Add it to .gitignore or write it elsewhere\n"
            f"         (leave out -o to use ~/ansible-atlas-maps/).")


def snapshot(root: Path, excludes):
    """Cheap fingerprint of the repo: (path, mtime, size) of every scanned file."""
    out = []
    for dp, dns, fns in os.walk(root):
        dns[:] = sorted(d for d in dns if d not in excludes and not d.startswith("."))
        for f in fns:
            try:
                st = os.stat(os.path.join(dp, f))
                out.append((dp, f, st.st_mtime_ns, st.st_size))
            except OSError:
                pass
    return hash(tuple(sorted(out)))


def print_findings(model, limit=200):
    fs = model["findings"]
    if not fs:
        print("Checks: no issues found.")
        return
    n = {k: sum(1 for f in fs if f["sev"] == k) for k in ("error", "warning", "info")}
    print(f"Checks: {n['error']} error(s), {n['warning']} warning(s), {n['info']} info")
    for f in fs[:limit]:
        loc = f"{f['src']}:{f['line']}" if f.get("src") and f.get("line") else (f.get("src") or "")
        print(f"  {f['sev']:<7} {f['rule']:<26} {loc}  {f['msg']}")
    if len(fs) > limit:
        print(f"  … {len(fs) - limit} more (see the Overview tab)")


def main(argv=None):
    ap = argparse.ArgumentParser(description="Build an offline, interactive map of an Ansible repository.")
    ap.add_argument("repo", nargs="?", default=".", help="Path to the Ansible repo (default: current dir)")
    ap.add_argument("-o", "--output", metavar="PATH",
                    help=f"Where to save the map: a file, or a folder (default: ~/{DEFAULT_MAP_DIR}/<repo-name>.html)")
    ap.add_argument("--no-open", dest="open", action="store_false", help="Don't open the map in the browser")
    ap.add_argument("--open", dest="open", action="store_true", help=argparse.SUPPRESS)   # old flag, now the default
    ap.add_argument("-l", "--lint", action="store_true", help="Print checks to the terminal; exit code 2 if any error-level finding")
    ap.add_argument("-w", "--watch", action="store_true", help="Keep running and rebuild when files change (the page reloads itself)")
    ap.add_argument("--interval", type=float, default=2.0, help="Seconds between change checks in --watch mode (default 2)")
    ap.add_argument("--no-redact", action="store_true", help="Show values of secret-looking variables")
    ap.add_argument("--no-sources", action="store_true", help="Don't embed file contents (file viewer shows names only)")
    ap.add_argument("--exclude", action="append", default=[], help="Directory name to skip (repeatable)")
    a = ap.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):        # Windows consoles may not be UTF-8
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    root = Path(a.repo).expanduser()
    if not root.is_dir():
        sys.exit(f"Not a directory: {root}")
    out = resolve_output(root, a.output)
    excludes = set(DEFAULT_EXCLUDES) | set(a.exclude)

    def build_once(quiet=False):
        atlas = Atlas(root, redact=not a.no_redact, excludes=a.exclude, sources=not a.no_sources)
        model = atlas.build()
        model["meta"]["generated_marker"] = GENERATED_MARKER
        if a.watch:
            model["meta"]["watch"] = {"interval": a.interval}
        atomic_write(out, render_html(model, TEMPLATE))
        written = [out]
        if not quiet:
            c = model["meta"]["counts"]
            print(f"Ansible Atlas {VERSION}: {c.get('playbook', 0)} playbooks, {c.get('play', 0)} plays, {c.get('role', 0)} roles, "
                  f"{c.get('task', 0) + c.get('handler', 0)} tasks/handlers, {c.get('template', 0)} templates, "
                  f"{c.get('script', 0)} scripts, {c.get('var', 0)} variables, {c.get('host', 0)} host entries")
            if model["meta"]["warnings"]:
                print(f"{len(model['meta']['warnings'])} parser warning(s) - see the Overview tab.")
            for w in written:
                msg = git_exposure(w)
                if msg:
                    print(msg, file=sys.stderr)
            for w in written:
                print(f"Map saved to {w.resolve()}")
        return model

    model = build_once()
    if a.lint:
        print_findings(model)
    if a.open:
        try:
            opened = webbrowser.open(out.resolve().as_uri())
        except Exception:
            opened = False
        if not opened:
            print("Couldn't open a browser automatically; open the file above yourself.")
    if a.watch:
        import time
        print(f"Watching {root.resolve()} every {a.interval:g}s. The open page reloads itself. Ctrl-C to stop.")
        last = snapshot(root, excludes)
        try:
            while True:
                time.sleep(a.interval)
                cur = snapshot(root, excludes)
                if cur != last:
                    last = cur
                    try:
                        build_once(quiet=True)
                        print(f"[{_dt.datetime.now():%H:%M:%S}] change detected, rebuilt {out.name}")
                    except Exception as ex:  # keep watching even if a file is mid-edit
                        print(f"[{_dt.datetime.now():%H:%M:%S}] rebuild failed: {ex}", file=sys.stderr)
        except KeyboardInterrupt:
            print("\nStopped watching.")
        return
    if a.lint and any(f["sev"] == "error" for f in model["findings"]):
        sys.exit(2)


if __name__ == "__main__":
    main()
