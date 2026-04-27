#!/usr/bin/env python3
"""
PJHB Pass 6c W2 — Clio OAuth secrets setup (one-shot, dual-storage).

Prompts for CLIO_CLIENT_ID and CLIO_CLIENT_SECRET (no echo), auto-generates
a strong SECRET_KEY, sets all 5 needed env vars via `setx`, and writes a
backup file with icacls permissions stripped to the current user.

Mirrors the safety model of RunWiki/scripts/set_secret.py:
  - bound to the local user (no network, no server)
  - ACL-tightened backup file (icacls on Windows; chmod 600 on POSIX)
  - no logging of secret values
  - exits cleanly after one run

Run via:
    python scripts/setup-clio-secrets.py

After running, OPEN A NEW PowerShell window so the env vars load before
running the OAuth server.
"""

from __future__ import annotations

import getpass
import os
import platform
import secrets
import string
import subprocess
import sys
from pathlib import Path


# ---- config (matches Pass 6c boot prompt + existing fork code expectations) ----

CLIO_REDIRECT_URI = "http://127.0.0.1:3789/clio/auth/callback"
CLIO_API_REGION = "us"  # Firm's Clio Manage runs on US infrastructure (verified Pass 6c)
SECRET_KEY_LEN = 48     # 48 chars from secrets.token_urlsafe gives ~32 bytes entropy
BACKUP_DIR = Path.home() / ".pjhb-secrets"
BACKUP_FILE = BACKUP_DIR / "clio_oauth_backup.txt"


def is_windows() -> bool:
    return platform.system() == "Windows"


def setx(name: str, value: str) -> None:
    """Run `setx NAME VALUE` to persist into Windows user environment.

    setx swallows quotes, so we pass via list-form to avoid quoting issues.
    Output is suppressed to avoid leaking the value into stdout/stderr logs.
    """
    if is_windows():
        result = subprocess.run(
            ["setx", name, value],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        if result.returncode != 0:
            print(f"[FAIL] setx {name}: {result.stderr.strip()}")
            sys.exit(1)
    else:
        # POSIX: write a shell-rc snippet (won't apply to the current shell)
        rc = Path.home() / ".pjhb-clio-env"
        with rc.open("a", encoding="utf-8") as f:
            f.write(f'export {name}="{value}"\n')
        os.chmod(rc, 0o600)


def write_backup(secrets_map: dict[str, str]) -> None:
    """Write the 3 secrets to BACKUP_FILE and tighten ACL to current user only."""
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    BACKUP_FILE.write_text(
        "# PJHB Pass 6c — Clio OAuth secrets backup\n"
        "# Generated: see file mtime. Created by setup-clio-secrets.py.\n"
        "# Restore-on-loss: re-run `setx` for each line below in a PowerShell shell.\n"
        "#\n"
        "# DO NOT commit, email, screenshot, or upload this file.\n"
        "# DO NOT delete unless you have a separate copy of the same values.\n"
        "#\n"
        + "\n".join(f"{k}={v}" for k, v in secrets_map.items())
        + "\n",
        encoding="utf-8",
    )

    if is_windows():
        # icacls: remove inheritance, then grant full control to current user only.
        # Username: %USERNAME%; we resolve via os.getlogin() but fall back to env.
        user = os.getenv("USERNAME") or os.getlogin()
        # /inheritance:r removes inherited ACEs; /grant gives full control to user
        subprocess.run(
            ["icacls", str(BACKUP_FILE), "/inheritance:r"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        subprocess.run(
            ["icacls", str(BACKUP_FILE), "/grant:r", f"{user}:F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    else:
        os.chmod(BACKUP_FILE, 0o600)


def prompt_secret(label: str, min_len: int = 8) -> str:
    """Prompt for a secret value with no echo. Re-prompt on too-short or empty."""
    while True:
        v = getpass.getpass(f"{label}: ").strip()
        if not v:
            print(f"  [retry] {label} is required.")
            continue
        if len(v) < min_len:
            print(f"  [retry] {label} is too short (got {len(v)}, need >={min_len}).")
            continue
        return v


def generate_secret_key(length: int = SECRET_KEY_LEN) -> str:
    """Cryptographically strong random URL-safe string.

    secrets.token_urlsafe(n) returns ~1.3 * n characters from a 32-byte alphabet,
    so 36 bytes -> 48-ish characters. Well above the 32-char minimum the existing
    tokenStorage.ts requires.
    """
    return secrets.token_urlsafe(36)


def main() -> int:
    print("=" * 72)
    print("PJHB Pass 6c W2 — Clio OAuth secrets setup")
    print("=" * 72)
    print()
    print("This script will:")
    print("  1. Prompt you for CLIO_CLIENT_ID and CLIO_CLIENT_SECRET (paste from")
    print("     your scratch buffer; values won't echo to the screen).")
    print("  2. Auto-generate a strong SECRET_KEY for token encryption at rest.")
    print("  3. Run `setx` for 5 env vars (3 secrets + CLIO_REDIRECT_URI +")
    print("     CLIO_API_REGION).")
    print(f"  4. Write a backup file at {BACKUP_FILE}")
    print("     with ACL stripped to your Windows user only.")
    print()
    print("After: close this terminal and open a NEW PowerShell window so the")
    print("env vars load. Then run the OAuth server (instructions on completion).")
    print()
    print("-" * 72)
    print()

    # Prompt for the two secrets the operator pasted from Clio Developer Portal
    client_id = prompt_secret("Paste CLIO_CLIENT_ID", min_len=10)
    client_secret = prompt_secret("Paste CLIO_CLIENT_SECRET", min_len=10)

    # Auto-generate SECRET_KEY (operator never sees or chooses it)
    secret_key = generate_secret_key()

    # Apply primary storage: setx for all 5 env vars
    print()
    print("Setting environment variables via `setx`...")
    setx("CLIO_CLIENT_ID", client_id)
    setx("CLIO_CLIENT_SECRET", client_secret)
    setx("SECRET_KEY", secret_key)
    setx("CLIO_REDIRECT_URI", CLIO_REDIRECT_URI)
    setx("CLIO_API_REGION", CLIO_API_REGION)
    print("  [OK] CLIO_CLIENT_ID")
    print("  [OK] CLIO_CLIENT_SECRET")
    print("  [OK] SECRET_KEY (auto-generated, 48-char URL-safe)")
    print(f"  [OK] CLIO_REDIRECT_URI = {CLIO_REDIRECT_URI}")
    print(f"  [OK] CLIO_API_REGION = {CLIO_API_REGION}")

    # Apply backup storage: ACL'd file
    print()
    print(f"Writing backup file to {BACKUP_FILE}...")
    write_backup({
        "CLIO_CLIENT_ID": client_id,
        "CLIO_CLIENT_SECRET": client_secret,
        "SECRET_KEY": secret_key,
    })
    print(f"  [OK] backup written; ACL stripped to current user only.")

    print()
    print("=" * 72)
    print("DONE. Next steps:")
    print("=" * 72)
    print()
    print("  1. Close this terminal completely.")
    print("  2. Open a NEW PowerShell window (so the new env vars load).")
    print("  3. From the fork directory:")
    print("        bun run src/server.ts")
    print("     OR if there's a dedicated OAuth start command, see fork README.")
    print("  4. Open the printed authorize URL in your browser (the same browser")
    print("     where you're logged into Clio Manage).")
    print("  5. Click 'Allow' on the consent screen. The browser redirects to")
    print(f"        {CLIO_REDIRECT_URI}?code=...")
    print("     and the server exchanges the code for tokens. Tokens land")
    print("     encrypted at rest in ~/.legalcontext/clio_tokens.")
    print("  6. Tell Claude Code 'browser flow done' and we'll proceed to W3")
    print("     verification (who_am_i call).")
    print()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nAborted.")
        sys.exit(1)
