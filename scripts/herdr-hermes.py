#!/usr/bin/env python3
"""Install HerdrChat's narrow Hermes detection override.

Herdr's remote Hermes manifest 2026.07.24.1 recognizes the classic idle prompt
only when the old "ctrl+c cancel" hint is visible. Current Hermes can be ready
with a status bar and the `❯` prompt while that hint is absent, so Herdr drops
the agent kind and rejects first prompts. This script installs a local manifest
override only for that known upstream shape. It leaves blocker and working rules
unchanged, refuses unrelated local overrides, and rolls back if Herdr does not
reload the new manifest.
"""

from __future__ import annotations

import argparse
import ast
import json
import os
from pathlib import Path
import subprocess
import sys
from typing import Any


MANAGED_RULE_ID = "herdrchat_classic_prompt_idle"
MANAGED_VERSION = "2026.10.03.1"
KNOWN_REMOTE_VERSION = "2026.07.24.1"
MANAGED_LAUNCHER_MARKER = "# herdrchat-managed-hermes-launcher-v1"

PATCH = f"""
# Installed by HerdrChat: Hermes classic idle prompts can omit the old shortcut
# hint while still showing the Hermes status bar and input prompt.
[[rules]]
id = "{MANAGED_RULE_ID}"
state = "idle"
priority = 50
region = "bottom_non_empty_lines(8)"
visible_idle = true
all = [
  {{ line_regex = ['^\\s*☤\\s+.*\\s│\\s+ctx\\s'] }},
  {{ line_regex = ['^\\s*❯(?:\\s|$)'] }},
]

""".lstrip()


def main() -> int:
    parser = argparse.ArgumentParser(description="Install HerdrChat Hermes detection compatibility.")
    parser.add_argument("--herdr", default="herdr", help="herdr executable or absolute path")
    parser.add_argument("--hermes", default="hermes", help="Hermes executable used to derive the launch wrapper")
    parser.add_argument("--session", default="", help="optional herdr session name")
    args = parser.parse_args()

    try:
        result = install(args.herdr, args.hermes, args.session.strip() or None)
    except Exception as exc:  # pragma: no cover - defensive JSON surface for hosts
        result = {"ok": False, "status": "failed", "reason": "unexpected_error", "detail": str(exc)}
        print(json.dumps(result, ensure_ascii=False))
        return 1

    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("status") in {"installed", "already_installed", "not_needed", "refused"} else 1


def install(herdr: str, hermes: str, session: str | None) -> dict[str, Any]:
    override_path = local_override_path()
    if override_path.exists():
        text = override_path.read_text(encoding="utf-8")
        if is_managed_override(text):
            reloaded = run_herdr(herdr, session, ["server", "reload-agent-manifests"])
            if reloaded.returncode != 0:
                return {
                    "ok": False,
                    "status": "failed",
                    "reason": "reload_failed",
                    "rollback": False,
                    "stderr": first_line(reloaded.stderr),
                }
            verify = manifest_status(herdr, session)
            active = find_hermes(verify)
            active_source = source_file(active) if active else None
            if (
                active
                and active.get("local_override_shadowing_remote") is True
                and active.get("active_version") == MANAGED_VERSION
                and active_source == override_path
            ):
                launcher = install_launch_wrapper(hermes)
                return {
                    "ok": True,
                    "status": "already_installed",
                    "path": str(override_path),
                    "launcher": launcher,
                }
            return {"ok": False, "status": "failed", "reason": "override_not_active", "rollback": False}
        return {"ok": False, "status": "refused", "reason": "custom_override_exists", "path": str(override_path)}

    status = manifest_status(herdr, session)
    manifest = find_hermes(status)
    if manifest is None:
        return {"ok": False, "status": "refused", "reason": "hermes_manifest_missing"}

    if manifest.get("local_override_shadowing_remote") is True:
        return {"ok": False, "status": "refused", "reason": "unknown_local_override", "path": str(override_path)}

    source_path = source_file(manifest)
    if source_path is None:
        return {"ok": False, "status": "refused", "reason": "manifest_source_unavailable"}
    try:
        source = source_path.read_text(encoding="utf-8")
    except OSError as exc:
        return {"ok": False, "status": "refused", "reason": "manifest_source_unreadable", "detail": str(exc)}

    if MANAGED_RULE_ID in source:
        launcher = install_launch_wrapper(hermes)
        return {"ok": True, "status": "not_needed", "path": str(source_path), "launcher": launcher}
    if not is_known_obsolete_manifest(source):
        return {"ok": False, "status": "refused", "reason": "unfamiliar_manifest", "path": str(source_path)}

    patched = patch_manifest(source)
    previous = override_path.read_text(encoding="utf-8") if override_path.exists() else None
    write_atomic(override_path, patched)
    reloaded = run_herdr(herdr, session, ["server", "reload-agent-manifests"])
    if reloaded.returncode != 0:
        rollback(override_path, previous)
        run_herdr(herdr, session, ["server", "reload-agent-manifests"])
        return {
            "ok": False,
            "status": "failed",
            "reason": "reload_failed",
            "rollback": True,
            "stderr": first_line(reloaded.stderr),
        }

    verify = manifest_status(herdr, session)
    active = find_hermes(verify)
    active_source = source_file(active) if active else None
    if (
        not active
        or active.get("local_override_shadowing_remote") is not True
        or active.get("active_version") != MANAGED_VERSION
        or active_source != override_path
    ):
        rollback(override_path, previous)
        run_herdr(herdr, session, ["server", "reload-agent-manifests"])
        return {"ok": False, "status": "failed", "reason": "override_not_active", "rollback": True}

    launcher = install_launch_wrapper(hermes)
    return {
        "ok": True,
        "status": "installed",
        "path": str(override_path),
        "version": MANAGED_VERSION,
        "launcher": launcher,
    }


def install_launch_wrapper(hermes: str) -> dict[str, Any]:
    resolved = shutil_which(hermes)
    if resolved is None:
        return {"ok": False, "status": "unavailable", "reason": "hermes_not_found"}
    printed = subprocess.run(
        [resolved, "--print-runtime-command"],
        text=True,
        capture_output=True,
        timeout=20,
    )
    if printed.returncode != 0:
        return {"ok": False, "status": "unavailable", "reason": "runtime_command_failed", "stderr": first_line(printed.stderr)}
    try:
        command = json.loads(printed.stdout)
    except json.JSONDecodeError:
        return {"ok": False, "status": "unavailable", "reason": "runtime_command_not_json"}
    if not isinstance(command, list) or not command or not all(isinstance(part, str) for part in command):
        return {"ok": False, "status": "unavailable", "reason": "runtime_command_bad_shape"}
    python = command[0]
    agent_root = hermes_agent_root_from_runtime_command(command)
    if agent_root is None:
        return {"ok": False, "status": "unavailable", "reason": "agent_root_missing"}
    script = Path(agent_root) / "hermes"
    if not script.exists():
        return {"ok": False, "status": "unavailable", "reason": "hermes_script_missing", "script": str(script)}
    bin_dir = Path.home() / ".local" / "bin"
    target = bin_dir / "herdrchat-hermes"
    content = "\n".join([
        "#!/bin/sh",
        MANAGED_LAUNCHER_MARKER,
        "# Launch Hermes in the argv shape Herdr 0.9.x detects: python .../hermes.",
        f"exec {sh_quote(python)} {sh_quote(str(script))} \"$@\"",
        "",
    ])
    if target.exists() or target.is_symlink():
        try:
            existing = target.read_text(encoding="utf-8")
        except OSError:
            return {"ok": False, "status": "conflict", "path": str(target)}
        if MANAGED_LAUNCHER_MARKER not in existing:
            return {"ok": False, "status": "conflict", "path": str(target)}
        if existing == content:
            return {"ok": True, "status": "already_installed", "path": str(target), "command": str(target)}
    bin_dir.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f".{target.name}.tmp.{os.getpid()}")
    tmp.write_text(content, encoding="utf-8")
    tmp.chmod(0o755)
    os.replace(tmp, target)
    return {"ok": True, "status": "installed", "path": str(target), "command": str(target)}


def hermes_agent_root_from_runtime_command(command: list[str]) -> str | None:
    for part in command:
        marker = "sys.path.insert(0, "
        index = part.find(marker)
        if index < 0:
            continue
        rest = part[index + len(marker):]
        close = rest.find(")")
        if close < 0:
            continue
        try:
            value = ast.literal_eval(rest[:close].strip())
        except (SyntaxError, ValueError):
            continue
        if isinstance(value, str) and value:
            return value
    return None


def shutil_which(command: str) -> str | None:
    if "/" in command:
        path = Path(command).expanduser()
        return str(path) if path.is_file() and os.access(path, os.X_OK) else None
    for directory in os.environ.get("PATH", "").split(os.pathsep):
        path = Path(directory) / command
        if path.exists() and os.access(path, os.X_OK):
            return str(path)
    return None


def sh_quote(value: str) -> str:
    return "'" + value.replace("'", "'\\''") + "'"


def manifest_status(herdr: str, session: str | None) -> dict[str, Any]:
    result = run_herdr(herdr, session, ["server", "agent-manifests", "--json"])
    if result.returncode != 0:
        raise RuntimeError(f"herdr agent-manifests failed: {first_line(result.stderr)}")
    try:
        parsed = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"herdr agent-manifests did not return JSON: {exc}") from exc
    if isinstance(parsed, dict) and isinstance(parsed.get("result"), dict):
        return parsed["result"]
    if isinstance(parsed, dict):
        return parsed
    raise RuntimeError("herdr agent-manifests returned an unexpected shape")


def run_herdr(herdr: str, session: str | None, args: list[str]) -> subprocess.CompletedProcess[str]:
    command = [herdr]
    if session:
        command.extend(["--session", session])
    command.extend(args)
    return subprocess.run(command, text=True, capture_output=True, timeout=20)


def find_hermes(status: dict[str, Any]) -> dict[str, Any] | None:
    candidates = status.get("manifests")
    if not isinstance(candidates, list):
        candidates = status.get("agent_manifests")
    if not isinstance(candidates, list):
        return None
    for item in candidates:
        if isinstance(item, dict) and (item.get("agent") == "hermes" or item.get("id") == "hermes"):
            return item
    return None


def source_file(manifest: dict[str, Any]) -> Path | None:
    raw = manifest.get("source") or manifest.get("path") or manifest.get("source_path")
    if not isinstance(raw, str):
        return None
    if raw.startswith("remote:") or raw.startswith("local:") or raw.startswith("bundled:"):
        raw = raw.split(":", 1)[1]
    path = Path(raw).expanduser()
    return path if path.is_absolute() else None


def local_override_path() -> Path:
    xdg_config = os.environ.get("XDG_CONFIG_HOME")
    if xdg_config:
        config_dir = Path(xdg_config).expanduser() / "herdr"
    else:
        config_dir = Path.home() / ".config" / "herdr"
    return config_dir / "agent-detection" / "hermes.toml"


def is_known_obsolete_manifest(text: str) -> bool:
    required = [
        'id = "hermes"',
        f'version = "{KNOWN_REMOTE_VERSION}"',
        'id = "dangerous_command_approval"',
        'id = "clarification_prompt"',
        'id = "credential_prompt"',
        'id = "confirmation_prompt"',
        'id = "interrupt_status_working"',
        'id = "classic_cancel_working"',
        'contains = ["ctrl+c cancel"]',
        'id = "osc_title_idle"',
        'regex = [\'^✓[\\u{fe0e}\\u{fe0f}]?(?:\\s|$)\']',
    ]
    return all(token in text for token in required) and MANAGED_RULE_ID not in text


def is_managed_override(text: str) -> bool:
    return (
        'id = "hermes"' in text
        and f'version = "{MANAGED_VERSION}"' in text
        and f'id = "{MANAGED_RULE_ID}"' in text
        and "Installed by HerdrChat" in text
    )


def patch_manifest(text: str) -> str:
    patched = text.replace(f'version = "{KNOWN_REMOTE_VERSION}"', f'version = "{MANAGED_VERSION}"', 1)
    patched = patched.replace(
        'updated_at = "2026-07-24T19:12:54Z"',
        'updated_at = "2026-10-03T00:00:00Z"',
        1,
    )
    marker = '[[rules]]\nid = "osc_title_idle"'
    if marker not in patched:
        raise RuntimeError("known manifest marker missing")
    return patched.replace(marker, PATCH + marker, 1)


def write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp.{os.getpid()}")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def rollback(path: Path, previous: str | None) -> None:
    if previous is None:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        return
    write_atomic(path, previous)


def first_line(text: str) -> str:
    return text.strip().splitlines()[0] if text.strip() else ""


if __name__ == "__main__":
    sys.exit(main())
