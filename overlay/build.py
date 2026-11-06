#!/usr/bin/env python3
"""Builds a forever-dash addon release from upstream's official zips (docs/plan.md, overlay).

    overlay/build.py <upstream-dir> <n> <out-dir>

<upstream-dir> holds Polestar-<x.y.z>.zip, Polestar_Recorder-<x.y.z>.zip and SHA256SUMS from
the upstream release. Writes Polestar-<x.y.z>.<n>.zip, Polestar_Recorder-<x.y.z>.<n>.zip and
SHA256SUMS to <out-dir>:
- every upstream entry kept in order, with its timestamp and compression;
- overlay/manifest.json patches applied, each only if upstream's file still has its base hash;
- overlay/addons/* folders added to the Polestar zip;
- every .toc's `## Version:` set to <x.y.z>.<n>.
Exits non-zero on any mismatch. Stdlib only.
"""
import hashlib, json, os, re, sys, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sha = lambda b: hashlib.sha256(b).hexdigest()


def fail(msg):
    sys.exit(f"overlay: {msg}")


def main(src, n, out):
    sums = {}
    for line in open(os.path.join(src, "SHA256SUMS")):
        h, name = line.split()
        sums[name.lstrip("*")] = h
    zips = sorted(k for k in sums if k.endswith(".zip"))
    m = re.fullmatch(r"Polestar-(\d+\.\d+\.\d+)\.zip", next((z for z in zips if z.startswith("Polestar-")), ""))
    if not m:
        fail("no Polestar-<x.y.z>.zip in SHA256SUMS")
    base = m.group(1)
    version = f"{base}.{int(n)}"
    manifest = json.load(open(os.path.join(ROOT, "overlay", "manifest.json")))
    patches = {p["path"]: p for p in manifest["patches"]}
    applied = set()
    os.makedirs(out, exist_ok=True)
    new_sums = []
    report = []
    for name in zips:
        data = open(os.path.join(src, name), "rb").read()
        if sha(data) != sums[name]:
            fail(f"{name}: sha256 does not match SHA256SUMS")
        zin = zipfile.ZipFile(os.path.join(src, name))
        out_name = name.replace(f"-{base}.zip", f"-{version}.zip")
        out_path = os.path.join(out, out_name)
        changed = 0
        with zipfile.ZipFile(out_path, "w") as zout:
            for info in zin.infolist():
                body = zin.read(info)
                if info.filename in patches:
                    p = patches[info.filename]
                    if sha(body) != p["base_sha256"]:
                        fail(f"{info.filename}: upstream changed it (sha256 {sha(body)[:12]}, patch based on {p['base_sha256'][:12]}); rebase or drop the patch")
                    body = open(os.path.join(ROOT, p["source"]), "rb").read()
                    applied.add(info.filename)
                    changed += 1
                if info.filename.endswith(".toc"):
                    new, k = re.subn(rb"^(## Version:)[^\r\n]*", b"\\1 " + version.encode(), body, flags=re.M)
                    if k != 1:
                        fail(f"{info.filename}: expected one ## Version line, found {k}")
                    body = new
                    changed += 1
                zout.writestr(info, body, compress_type=info.compress_type)
            if name.startswith("Polestar-"):
                date = zin.infolist()[0].date_time
                add_root = os.path.join(ROOT, "overlay", "addons")
                for folder in sorted(os.listdir(add_root)):
                    if not folder.startswith("Polestar_") or folder == "Polestar_Recorder":
                        fail(f"overlay/addons/{folder}: Polestar Client only installs Polestar_* folders")
                    # Same attributes as upstream's directory entries; without them unzip on Linux
                    # makes a folder no one can read.
                    zd = zipfile.ZipInfo(f"{folder}/", date)
                    zd.external_attr = (0o40755 << 16) | 0x10
                    zout.writestr(zd, b"")
                    for f in sorted(os.listdir(os.path.join(add_root, folder))):
                        body = open(os.path.join(add_root, folder, f), "rb").read()
                        if f.endswith(".toc"):
                            body = re.sub(rb"^(## Version:)[^\r\n]*", b"\\1 " + version.encode(), body, flags=re.M)
                        zi = zipfile.ZipInfo(f"{folder}/{f}", date)
                        zi.external_attr = 0o100644 << 16
                        zout.writestr(zi, body, compress_type=zipfile.ZIP_DEFLATED)
                        changed += 1
        new_sums.append(f"{sha(open(out_path, 'rb').read())}  {out_name}")
        report.append(f"{out_name}: {len(zin.infolist())} upstream entries, {changed} written differently or added")
    missing = set(patches) - applied
    if missing:
        fail(f"patches whose file is not in the zips: {sorted(missing)}")
    open(os.path.join(out, "SHA256SUMS"), "w").write("\n".join(new_sums) + "\n")
    print("\n".join(report))
    print(f"release v{version}: {len(applied)} patches applied")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])
