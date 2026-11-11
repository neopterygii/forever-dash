#!/usr/bin/env python3
"""Bring an upstream Polestar Client release into our client (.github/workflows/dash-client-sync.yml).

  sync.py resolve            after `git merge` (diff3 style): settle the conflicts where upstream only
                             changed version lines, by keeping ours; take upstream's Cargo.lock (cargo
                             completes it); exit 1 naming any other conflict.
  sync.py bump <version>     set the client's version in package.json, Cargo.toml, tauri.conf.json and
                             Cargo.lock.
  sync.py next <version> <tag>...   print the next patch version above <version> and every client-v tag.
  sync.py notes <ours> <upstream> <body-file>   print our release notes from upstream's release body.
"""
import re
import subprocess
import sys

CLIENT = "apps/client"
LOCK = f"{CLIENT}/src-tauri/Cargo.lock"
VERSION_FILES = {
    f"{CLIENT}/package.json": re.compile(r'^(  "version": ")[^"]+(",)$', re.M),
    f"{CLIENT}/src-tauri/Cargo.toml": re.compile(r'^(version = ")[^"]+(")$', re.M),
    f"{CLIENT}/src-tauri/tauri.conf.json": re.compile(r'^(  "version": ")[^"]+(",)$', re.M),
    f"{CLIENT}/src-tauri/Cargo.lock": re.compile(r'^(name = "polestar-client"\r?\nversion = ")[^"]+(")$', re.M),
}
VERSION_LINE = re.compile(r'^\s*"?version"?\s*[:=]\s*"[^"]*",?\s*$')
HUNK = re.compile(
    r"^<{7} [^\n]*\n(.*?)^\|{7} [^\n]*\n(.*?)^={7}\n(.*?)^>{7} [^\n]*\n", re.S | re.M)


def _sans_versions(text):
    return [line for line in text.splitlines() if not VERSION_LINE.match(line)]


def resolve_text(text):
    """Keep ours in every hunk where theirs differs from the base only in version lines.
    Returns (text, unresolved hunk count)."""
    left = 0

    def one(m):
        nonlocal left
        ours, base, theirs = m.groups()
        if _sans_versions(base) == _sans_versions(theirs):
            return ours
        left += 1
        return m.group(0)

    return HUNK.sub(one, text), left


def resolve():
    out = subprocess.run(["git", "diff", "--name-only", "--diff-filter=U"],
                         check=True, capture_output=True, text=True).stdout.split()
    stuck = []
    for path in out:
        if path == LOCK:
            # Upstream's lockfile, then `cargo update --workspace` (the workflow) adds back what only ours
            # needs (forever-dash-proto) without moving any version upstream chose.
            subprocess.run(["git", "checkout", "--theirs", "--", path], check=True)
            subprocess.run(["git", "add", "--", path], check=True)
            print(f"took upstream's, for cargo to complete: {path}")
            continue
        with open(path, newline="") as f:
            text = f.read()
        new, left = resolve_text(text)
        if left or "<<<<<<< " in new:
            stuck.append(path)
            continue
        with open(path, "w", newline="") as f:
            f.write(new)
        subprocess.run(["git", "add", "--", path], check=True)
        print(f"kept ours (upstream changed only the version): {path}")
    for path in stuck:
        print(f"::error file={path}::conflict beyond the version lines; merge by hand")
    return 1 if stuck else 0


def bump(version):
    for path, pattern in VERSION_FILES.items():
        with open(path, newline="") as f:
            text = f.read()
        new, n = pattern.subn(lambda m: m.group(1) + version + m.group(2), text, count=1)
        if n != 1:
            sys.exit(f"no version line found in {path}")
        with open(path, "w", newline="") as f:
            f.write(new)
    return 0


def _key(v):
    return tuple(int(x) for x in v.split("."))


def next_version(current, tags):
    have = [current] + [t[len("client-v"):] for t in tags if re.fullmatch(r"client-v\d+\.\d+\.\d+", t)]
    top = max(have, key=_key)
    major, minor, patch = _key(top)
    return f"{major}.{minor}.{patch + 1}"


def notes(ours, upstream, body):
    m = re.search(r"^## What's new\s*\n(.*?)(?=^## |\Z)", body, re.S | re.M)
    new = m.group(1).strip() if m else "See upstream's release notes."
    url = f"https://github.com/fitzforge/polestar/releases/tag/client-v{upstream}"
    return (f"Forever Dash Client {ours}\n\n"
            f"Brings in [Polestar Client {upstream}]({url}). The dashboard upload and our settings are "
            f"unchanged. Installed copies update themselves.\n\n"
            f"## What's new upstream\n\n{new}\n")


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ""
    if cmd == "resolve" and len(argv) == 2:
        return resolve()
    if cmd == "bump" and len(argv) == 3:
        return bump(argv[2])
    if cmd == "next" and len(argv) >= 3:
        print(next_version(argv[2], argv[3:]))
        return 0
    if cmd == "notes" and len(argv) == 5:
        with open(argv[4], encoding="utf-8") as f:
            sys.stdout.write(notes(argv[2], argv[3], f.read()))
        return 0
    sys.exit(__doc__)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
