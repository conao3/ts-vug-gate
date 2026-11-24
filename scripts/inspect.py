import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tomllib
from urllib.parse import urlsplit
from urllib.request import urlopen

TEMP = Path(os.environ["RUNNER_TEMP"])
OBJECTS = TEMP / "objects.git"
POLICY = Path("policy/provenance.json")
VUG = TEMP / "vug/bin/vug"
VERIFIED = TEMP / "verified-inputs"
SOURCES = VERIFIED / "sources"
PIN = "221f987cea759e0bab03d8f4bc37825d38656183"
SEED = "3a67c035370f4bc2a65c394165f53b6ca6e604947bce32f6b26d7c9723c584c9"
SCRIPT = "fe8edd578fa0e5a5e2b89cab43f5dc7f121317fd601124bf823fd4192cdb549c"
IDENTITY = ("base_sha", "head_sha", "tree_oid", "policy_digest")
HEX = re.compile("[0-9a-f]{40}")
PACKAGE = re.compile("[a-z0-9][a-z0-9+._-]{0,63}")
CORE = ["binutils", "make", "musl", "vug"]


def command(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def git(*args, **kwargs):
    return command("git", "--git-dir", OBJECTS, *args, **kwargs).stdout


def object_bytes(oid):
    return git("cat-file", "blob", oid, capture_output=True)


def tree(sha):
    data = git("ls-tree", "-r", "-z", sha, capture_output=True)
    entries = {}
    for row in data.split(b"\0")[:-1]:
        header, path = row.split(b"\t", 1)
        mode, _, oid = header.decode("ascii").split()
        entries[path.decode("utf-8")] = (mode, oid)
    return entries


def materialize(entries, destination):
    for path, (mode, oid) in entries.items():
        if not path.startswith(("packages/", "services/", "systems/")) and path != "seed.toml":
            continue
        if mode not in ("100644", "100755") or any(
            part.lower() in ("", ".", "..", ".git") for part in path.split("/")
        ):
            raise ValueError("Unsupported Git path or mode")
        target = destination / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(object_bytes(oid))


def side(path, entry):
    if entry is None:
        return None
    mode, oid = entry
    value = {"mode": mode}
    if mode in ("100644", "100755") and re.fullmatch(
        r"packages/[^/]+/[^/]+/(?:package\.toml|versions/[^/]+\.toml)", path
    ):
        value["text"] = object_bytes(oid).decode("utf-8")
    return value


def prepare(request):
    repo = request["repo"]
    base, head = (request[k] for k in IDENTITY[:2])
    if not re.fullmatch(r"[a-zA-Z0-9-]+/[a-zA-Z0-9_.-]+", repo):
        raise ValueError("Expected a GitHub repository")
    if not HEX.fullmatch(base) or not HEX.fullmatch(head):
        raise ValueError("Expected full Git commit IDs")
    command("git", "init", "--bare", OBJECTS, stdout=subprocess.DEVNULL)
    git("fetch", "--no-tags", f"https://github.com/{repo}.git", base, head)
    git("merge-base", "--is-ancestor", base, head)
    tree_oid = git("rev-parse", f"{head}^{{tree}}", text=True, capture_output=True).strip()
    policy_digest = hashlib.sha256(POLICY.read_bytes()).hexdigest()
    identity = dict(base_sha=base, head_sha=head, tree_oid=tree_oid, policy_digest=policy_digest)
    if request.get("id") and any(request[k] != v for k, v in identity.items()):
        raise ValueError("Candidate identity mismatch")
    before, after = tree(base), tree(head)
    changes = [
        dict(path=path, before=side(path, before.get(path)), after=side(path, after.get(path)))
        for path in sorted(before.keys() | after.keys())
        if before.get(path) != after.get(path)
    ]
    materialize(after, TEMP / "candidate")
    materialize(before, TEMP / "base")
    return identity, changes


def tools(download=False):
    path = VERIFIED / "package-builds.py"
    if download:
        with urlopen(f"https://raw.githubusercontent.com/conao3/vug-packages/{PIN}/.github/scripts/package-builds.py",
                     timeout=30) as response:
            data = response.read(64 * 1024)
    else:
        data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != SCRIPT:
        raise ValueError("Build script checksum mismatch")
    if download:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    import runpy
    return runpy.run_path(str(path))


def record(check, target, identity, status):
    return dict(check=check, target=target, identity=identity, status=status)


def vug(*args, request, path):
    path.write_text(json.dumps(request))
    result = command(VUG, "record", *args, "--input", f"file://{path}", capture_output=True)
    return json.loads(result.stdout)


def decide(data):
    return vug("decide-merge", request=data, path=TEMP / "decision-input.json")


def emit(**values):
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        for key, value in values.items():
            output.write(f"{key}={json.dumps(value, separators=(',', ':'))}\n")


def package_dir(root, name):
    if not PACKAGE.fullmatch(name):
        raise ValueError("Invalid package name")
    return root / "packages" / (name[:2] if len(name) > 1 else name + "_") / name


def seed_bytes(root):
    data = (root / "seed.toml").read_bytes()
    if hashlib.sha256(data).hexdigest() != SEED:
        raise ValueError("Candidate seed does not match policy")
    return data


def trusted_source(url, digest):
    if not re.fullmatch(r"[0-9a-f]{64}", digest) or urlsplit(url).scheme != "https":
        raise ValueError("Expected an HTTPS source with a SHA-256 digest")
    destination = SOURCES / digest
    if destination.is_file():
        return
    with urlopen(url, timeout=30) as response, destination.open("xb") as output:
        checksum = hashlib.sha256()
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
            checksum.update(chunk)
    if checksum.hexdigest() != digest:
        raise ValueError("Trusted source checksum mismatch")


def source_plan(identity, targets, changed, current_record):
    SOURCES.mkdir(parents=True, exist_ok=True)
    manifest = []

    def record_input(kind, name, version, digest, commit, path):
        if not (SOURCES / digest).is_file():
            raise ValueError(f"Missing verified bytes for {name} {version}: {path}")
        manifest.append(dict(kind=kind, name=name, version=version, sha256=digest,
                             commit=commit, path=path))

    candidate_root = TEMP / "candidate"
    for name, source in sorted(tomllib.loads(seed_bytes(candidate_root).decode()).items()):
        digest = source["sha256"]
        trusted_source(source["url"], digest)
        record_input("seed", name, None, digest, identity["base_sha"], "seed.toml")

    pending = list(reversed(targets))
    visited = set()
    while pending:
        name = pending.pop()
        if name in visited:
            continue
        visited.add(name)
        candidate = package_dir(candidate_root, name)
        version, entry = current_record(candidate)
        version_path = f"versions/{version}.toml"
        if name in changed:
            kind, commit = "candidate", identity["head_sha"]
            directory = candidate
        else:
            kind, commit = "base", identity["base_sha"]
            directory = package_dir(TEMP / "base", name)
            original = (directory / version_path).read_bytes()
            if original != (candidate / version_path).read_bytes():
                raise ValueError(f"Candidate differs from the trusted base record for {name}")
            entry = tomllib.loads(original.decode())
            trusted_source(entry["source"]["url"], entry["source"]["sha256"])
        digest = entry["source"]["sha256"]
        record_input(kind, name, version, digest, commit, version_path)
        for patch in entry.get("patches", []):
            path = f"patches/{patch}"
            payload = (directory / path).read_bytes()
            digest = hashlib.sha256(payload).hexdigest()
            if kind == "base":
                if payload != (candidate / path).read_bytes():
                    raise ValueError(f"Candidate differs from the trusted base patch for {name}")
                (SOURCES / digest).write_bytes(payload)
            record_input(kind, name, version, digest, commit, path)

        dependencies = entry.get("dependencies", {})
        selectors = [
            *dependencies.get("build", []),
            *dependencies.get("run", []),
            *dependencies.get("expose", []),
        ]
        for output in entry.get("outputs", {}).values():
            selectors.extend(output.get("run", []))
        for selector in selectors:
            dependency = selector.partition(":")[0]
            if dependency:
                pending.append(dependency)

    for name in targets:
        candidate = package_dir(candidate_root, name)
        version, _ = current_record(candidate)
        historical = package_dir(TEMP / "base", name) / "versions"
        for file in (candidate / "versions").glob("*.toml"):
            original = historical / file.name
            if file.stem != version and (
                not original.is_file() or file.read_bytes() != original.read_bytes()
            ):
                raise ValueError("A changed version is outside the selected build plan")

    shutil.move(candidate_root, VERIFIED / "candidate")
    (VERIFIED / "manifest.json").write_text(
        json.dumps(dict(identity=identity, targets=targets, inputs=manifest))
    )
    blobs = list(SOURCES.iterdir())
    size = sum(path.stat().st_size for path in blobs)
    print(f"Verified source payload: {len(blobs)} blobs, {size} bytes")


def inspect(request):
    identity, changes = prepare(request)
    data = dict(schema_version=1, identity=identity, core_packages=CORE,
                changes=changes, required_checks=[], results=[])
    scope = decide(data)
    changed = scope["AffectedPackages"]
    outside = any(not change["path"].startswith("packages/") for change in changes)
    code = subprocess.run([VUG, "record", "check-tree", "--root", TEMP / "candidate"],
                          stdout=subprocess.PIPE).returncode
    result = "passed" if code == 0 else "failed"
    format_targets = changed + (["."] if outside or not changed else [])
    data["required_checks"] = [
        dict(check=check, target=target)
        for target in changed
        for check in (3, 4, 5, 6, 7, 8)
    ] + [dict(check=1, target=target) for target in format_targets]
    data["results"] = [record(1, target, identity, result) for target in format_targets]
    provenance = vug("verify-provenance", "--root", OBJECTS, "--policy",
                     f"file://{POLICY.resolve()}", "--source-cache-dir", SOURCES, request=dict(schema_version=1, identity=identity),
                     path=TEMP / "provenance-input.json")
    data["results"].extend(provenance["Results"])
    for row in data["results"]:
        print(f"Check {row['check']} · {row['target']} · {row['status']}")
    print(f"Check 2 · {scope['Scope']}")
    tools_api = tools(download=True)
    targets = []
    if scope["ChangeClass"] == "record_change" and scope["Scope"] == "passed" and all(
        row["status"] == "passed" for row in data["results"]
    ):
        names = set(changed)
        reverse = tools_api["reverse_dependencies"]
        dependent = reverse(TEMP / "base", names) | reverse(TEMP / "candidate", names)
        if names and len(names | dependent) <= 12:
            targets = sorted(names) + sorted(dependent)
            source_plan(identity, targets, names, tools_api["current_record"])
    data["changes"] = changes
    (TEMP / "inspection.json").write_text(json.dumps(data))
    emit(changed=changed, targets=targets)


def build(request, targets):
    manifest = json.loads((VERIFIED / "manifest.json").read_text())
    identity = manifest["identity"]
    expected = {key: request[key] for key in IDENTITY if key in request}
    expected["policy_digest"] = hashlib.sha256(POLICY.read_bytes()).hexdigest()
    if any(identity[key] != value for key, value in expected.items()):
        raise ValueError("Verified source artifact identity mismatch")
    if not set(targets) <= set(manifest["targets"]):
        raise ValueError("Build targets are outside the verified source plan")
    root = VERIFIED / "candidate"
    seed_bytes(root)
    api = tools()
    namespace = api["build"].__globals__

    def build_and_read(name, data, log):
        version, entry = api["current_record"](package_dir(root, name))
        tests = entry.get("check", {})
        if tests.get("enabled") is not True or tests.get("skip", []):
            raise ValueError("Required tests are disabled or skipped")
        with log.open("wb") as stderr:
            result = subprocess.run(
                [VUG, "package", "build-package", "--root", root, "--name", name,
                 "--package-version", version, "--jobs", "3", "--data-dir", data,
                 "--source-cache-dir", SOURCES],
                stdout=subprocess.DEVNULL, stderr=stderr,
            )
        if result.returncode:
            raise ValueError(f"Package build exited with status {result.returncode}")
        manifest = data / "index-outputs" / name / version
        if manifest.is_file():
            return {key: row["id"] for key, row in json.loads(manifest.read_text())["outputs"].items()}
        return {"out": (data / "index" / name / version).read_text().split()[1]}

    namespace["build_package"] = build_and_read
    os.environ["PACKAGES"] = json.dumps(targets)
    status = api["build"]()
    emit(ids=json.loads((TEMP / "package-results/ids.json").read_text()))
    if status:
        sys.exit(status)


def report():
    data = json.loads((TEMP / "inspection.json").read_text())
    primary, repeat = (json.loads(os.environ[key] or "{}") for key in ("PRIMARY", "REPEAT"))
    targets = json.loads(os.environ["TARGETS"])
    changed = json.loads(os.environ["CHANGED"])
    for name in changed:
        statuses = {
            6: "passed" if primary.get(name) else "incomplete",
            7: "passed" if targets and all(primary.get(t) for t in targets) else "incomplete",
            8: ("passed" if primary[name] == repeat[name] else "failed")
                if primary.get(name) and repeat.get(name) else "incomplete",
        }
        for check, status in statuses.items():
            data["results"].append(record(check, name, data["identity"], status))
            print(f"Check {check} · {name} · {status}")
    verdict = decide(data)
    print(f"Decision · {verdict['Decision']}")
    emit(decision=verdict["Decision"])
    if not json.loads(os.environ["CANDIDATE"]).get("id") and verdict["Decision"] != "auto_merge":
        sys.exit(1)


if __name__ == "__main__":
    candidate = json.loads(os.environ["CANDIDATE"])
    match sys.argv[1]:
        case "inspect":
            inspect(candidate)
        case "build":
            build(candidate, json.loads(os.environ["PACKAGES"]))
        case "report":
            report()
        case _:
            sys.exit("Unknown operation")
