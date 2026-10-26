"""Encrypted-at-rest storage for provider API keys.

Keys entered through the settings screen live in SQLite, sealed with AES-GCM
under a random 32-byte master key in ``<DATA_DIR>/master.key`` (mode 0600).
A copy of the database on its own is therefore useless: an attacker needs the
master key file too, exactly like today's ``.env``.

``APP_PASSWORD`` is deliberately *not* used as key material: rotating the
password would otherwise destroy every stored key.
"""
from __future__ import annotations

import os
import secrets as _secrets
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

MASTER_KEY_FILE = "master.key"
KEY_BYTES = 32
NONCE_BYTES = 12


class KeystoreError(RuntimeError):
    """The master key is missing or the ciphertext cannot be read."""


def master_key_path(data_dir: Path) -> Path:
    return data_dir / MASTER_KEY_FILE


def load_master_key(data_dir: Path, *, create: bool = True) -> bytes:
    """Return the master key, creating it on first use.

    The file is created with 0600 via ``os.open`` so the key is never briefly
    world-readable, and it is never regenerated silently: a lost key means the
    stored secrets are unreadable, which the UI reports instead of hiding.
    """
    path = master_key_path(data_dir)
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        if not create:
            raise KeystoreError("master key not initialised") from None
        raw = _secrets.token_bytes(KEY_BYTES)
        data_dir.mkdir(parents=True, exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(raw)
        os.chmod(path, 0o600)
        return raw
    if len(raw) != KEY_BYTES:
        raise KeystoreError("master key has the wrong length")
    return raw


def encrypt(plaintext: str, data_dir: Path, *, aad: str = "") -> bytes:
    """Seal ``plaintext``; returns nonce || ciphertext."""
    key = load_master_key(data_dir)
    nonce = _secrets.token_bytes(NONCE_BYTES)
    sealed = AESGCM(key).encrypt(nonce, plaintext.encode(), aad.encode())
    return nonce + sealed


def decrypt(blob: bytes, data_dir: Path, *, aad: str = "") -> str:
    """Open a value produced by :func:`encrypt`."""
    if len(blob) <= NONCE_BYTES:
        raise KeystoreError("ciphertext is truncated")
    key = load_master_key(data_dir, create=False)
    try:
        opened = AESGCM(key).decrypt(blob[:NONCE_BYTES], blob[NONCE_BYTES:], aad.encode())
    except Exception as exc:  # InvalidTag, wrong key, tampering
        raise KeystoreError(str(exc)) from exc
    return opened.decode()


def hint(value: str) -> str:
    """What the UI is allowed to show: the last four characters, nothing else."""
    tail = value[-4:] if len(value) >= 8 else ""
    return f"…{tail}" if tail else "…"
