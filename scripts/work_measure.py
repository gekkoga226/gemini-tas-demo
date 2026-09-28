"""Small, opt-in work measurement CLI. Stores counters only, never tool content."""

import argparse
import json
import os
import re
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = 1
STRATEGIES = ("pruning", "checkpoint", "repo_map")
METRICS = ("calls", "display_chars", "rereads", "reread_chars")
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,79}\Z")
LABEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,79}\Z")


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def git(repo, *args):
    # A temporary protected config permits read-only Git inspection when the
    # checkout is owned by another local account. Never change user config.
    with tempfile.TemporaryDirectory() as directory:
        config = Path(directory) / "gitconfig"
        config.write_text(f"[safe]\n    directory = {repo.as_posix()}\n", encoding="utf-8")
        env = os.environ.copy()
        env["GIT_CONFIG_GLOBAL"] = str(config)
        result = subprocess.run(["git", "-C", str(repo), *args], capture_output=True,
                                text=True, check=False, env=env)
    return result.stdout.strip() if result.returncode == 0 else None


def tree_state(repo):
    result = git(repo, "status", "--porcelain", "--untracked-files=normal")
    return "unknown" if result is None else ("dirty" if result else "clean")


def path_for(repo, work_id):
    if not ID.fullmatch(work_id):
        raise ValueError("work id must be a short ASCII identifier")
    return repo / ".work-measure" / (work_id + ".json")


def save(path, record):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def load(path):
    record = json.loads(path.read_text(encoding="utf-8"))
    if record.get("schema_version") != SCHEMA:
        raise ValueError("unsupported schema version")
    return record


def metric(value):
    if value == "unknown":
        return None
    number = int(value)
    if number < 0:
        raise ValueError("counter must be nonnegative")
    return number


def start(args, repo):
    path = path_for(repo, args.work_id)
    if path.exists():
        raise ValueError("work id already exists")
    for label in (args.model, args.reasoning, args.work_type, args.comparison_group):
        if not LABEL.fullmatch(label):
            raise ValueError("labels must be short ASCII identifiers")
    record = {
        "schema_version": SCHEMA, "work_id": args.work_id,
        "started_at_utc": now(), "ended_at_utc": None,
        "repository": repo.name,
        "conditions": {
            "commit": git(repo, "rev-parse", "HEAD") or "unknown",
            "tree_start": tree_state(repo), "tree_end": "unknown",
            "model": args.model, "reasoning": args.reasoning,
            "work_type": args.work_type, "comparison_group": args.comparison_group,
        },
        "outcome": {"success": "unknown", "rework": "unknown"},
        "usage": {"input_tokens": "unknown", "cache_read_tokens": "unknown",
                  "cache_write_tokens": "unknown"},
        "strategies": {name: {"status": "unmeasured", **{key: None for key in METRICS}}
                       for name in STRATEGIES},
    }
    save(path, record)
    print(path)


def event(args, repo):
    path = path_for(repo, args.work_id)
    record = load(path)
    if record["ended_at_utc"] is not None:
        raise ValueError("work is already ended")
    entry = record["strategies"][args.strategy]
    if entry["status"] in ("unused", "unavailable"):
        raise ValueError("strategy already closed as unused or unavailable")
    values = {key: metric(getattr(args, key)) for key in METRICS}
    for key, value in values.items():
        previous = entry[key]
        if value is None or (entry["status"] == "used" and previous is None):
            entry[key] = None
        else:
            entry[key] = (previous or 0) + value
    entry["status"] = "used"
    save(path, record)
    print(path)


def end(args, repo):
    path = path_for(repo, args.work_id)
    record = load(path)
    if record["ended_at_utc"] is not None:
        raise ValueError("work is already ended")
    for assignment in args.strategy_status:
        name, separator, status = assignment.partition("=")
        if not separator or name not in STRATEGIES or status not in ("unused", "unavailable", "unmeasured"):
            raise ValueError("strategy status must be pruning|checkpoint|repo_map=unused|unavailable|unmeasured")
        if record["strategies"][name]["status"] == "used":
            raise ValueError("cannot replace used strategy status")
        record["strategies"][name]["status"] = status
    record["conditions"]["tree_end"] = tree_state(repo)
    record["outcome"] = {"success": args.success, "rework": args.rework}
    record["ended_at_utc"] = now()
    save(path, record)
    print(path)


def summary(args, repo):
    totals = {name: {"statuses": {state: 0 for state in ("used", "unused", "unavailable", "unmeasured")},
                     "metrics": {key: {"known_sum": 0, "unknown_records": 0} for key in METRICS}}
              for name in STRATEGIES}
    outcomes = {"success": {key: 0 for key in ("yes", "no", "unknown")},
                "rework": {key: 0 for key in ("yes", "no", "unknown")}}
    conditions = {}
    count = 0
    for path in sorted((repo / ".work-measure").glob("*.json")):
        record = load(path)
        count += 1
        for name in STRATEGIES:
            entry = record["strategies"][name]
            totals[name]["statuses"][entry["status"]] += 1
            if entry["status"] == "used":
                for key in METRICS:
                    value = entry[key]
                    bucket = totals[name]["metrics"][key]
                    if value is None:
                        bucket["unknown_records"] += 1
                    else:
                        bucket["known_sum"] += value
        for key in outcomes:
            outcomes[key][record["outcome"][key]] += 1
        group = tuple(record["conditions"].get(key, "unknown") for key in
                      ("commit", "tree_start", "model", "reasoning", "work_type", "comparison_group"))
        conditions[group] = conditions.get(group, 0) + 1
    print(json.dumps({"schema_version": SCHEMA, "repository": repo.name, "work_count": count,
                      "strategies": totals, "outcomes": outcomes,
                      "condition_groups": [{"commit": key[0], "tree_start": key[1], "model": key[2],
                                            "reasoning": key[3], "work_type": key[4],
                                            "comparison_group": key[5], "count": value}
                                           for key, value in sorted(conditions.items())]},
                     ensure_ascii=False, indent=2))


def main(argv=None, repo=None):
    repo = Path(repo or Path(__file__).resolve().parents[1]).resolve()
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("start")
    p.add_argument("work_id")
    for name in ("model", "reasoning", "work_type", "comparison_group"):
        p.add_argument("--" + name.replace("_", "-"), default="unknown")
    p = sub.add_parser("event")
    p.add_argument("work_id")
    p.add_argument("strategy", choices=STRATEGIES)
    for name in METRICS:
        p.add_argument("--" + name.replace("_", "-"), required=True)
    p = sub.add_parser("end")
    p.add_argument("work_id")
    p.add_argument("--success", choices=("yes", "no", "unknown"), default="unknown")
    p.add_argument("--rework", choices=("yes", "no", "unknown"), default="unknown")
    p.add_argument("--strategy-status", action="append", default=[])
    sub.add_parser("summary")
    args = parser.parse_args(argv)
    try:
        {"start": start, "event": event, "end": end, "summary": summary}[args.command](args, repo)
    except (ValueError, OSError, KeyError, json.JSONDecodeError) as exc:
        parser.exit(2, f"error: {exc}\n")


if __name__ == "__main__":
    main()
