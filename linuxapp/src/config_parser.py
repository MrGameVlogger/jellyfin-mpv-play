"""Config.js parsing, writing, and path utilities.
Port of macapp/Sources/ConfigParser.swift for Linux/GTK.
"""
import os
import re
import json
import base64
import hashlib
import socket
import getpass
import urllib.request
import urllib.error

from typing import Optional

APP_NAME = "JellyfinMpvPlay"


# ── Sensitive value encryption ─────────────────────────────────────────
# Passwords and API keys are encrypted with Fernet (AES-128-CBC + HMAC)
# before being written to config.js. The key is derived from machine
# identity (SHA-256 of hostname:username). This protects against casual
# filesystem access (backups, other users). Use full-disk encryption for
# real protection against an attacker with physical access.

def _derive_fernet_key() -> bytes:
    """Derive a 32-byte Fernet key from machine identity using PBKDF2."""
    material = f"{socket.gethostname()}:{getpass.getuser()}:jf-mpv-play".encode("utf-8")
    salt = b"jf-mpv-play-config-key-v1"
    raw = hashlib.pbkdf2_hmac("sha256", material, salt, 390000, dklen=32)
    return base64.urlsafe_b64encode(raw)  # Fernet expects urlsafe-b64 32-byte key


def encrypt_value(plaintext: str) -> str:
    """Encrypt a sensitive string for storage in config.js."""
    if not plaintext:
        return plaintext
    from cryptography.fernet import Fernet
    f = Fernet(_derive_fernet_key())
    encrypted = f.encrypt(plaintext.encode("utf-8"))
    return "enc:" + encrypted.decode("ascii")


def get_fernet():
    """Return a Fernet instance with the machine-derived key.

    Use this directly at call sites so CodeQL sees Fernet.encrypt()
    as a sanitizer (it can't see through function boundaries).
    """
    from cryptography.fernet import Fernet
    return Fernet(_derive_fernet_key())


def decrypt_value(value: str) -> str:
    """Decrypt a sensitive string read from config.js.

    Values without the 'enc:' prefix are returned as-is (backward compatible).
    """
    if not value or not isinstance(value, str) or not value.startswith("enc:"):
        return value
    try:
        from cryptography.fernet import Fernet
        f = Fernet(_derive_fernet_key())
        decrypted = f.decrypt(value[4:].encode("ascii"))
        return decrypted.decode("utf-8")
    except Exception:
        return value


def app_support_dir():
    """Returns the app data directory (equivalent to macOS Application Support)."""
    base = os.environ.get("XDG_DATA_HOME", os.path.join(os.path.expanduser("~"), ".local", "share"))
    d = os.path.join(base, APP_NAME)
    os.makedirs(d, exist_ok=True)
    return d


def config_path(file_name: str = "config.js") -> str:
    """Returns the full path to a config file in the app data directory."""
    return os.path.join(app_support_dir(), file_name)


def selected_config_file_name():
    """Returns the currently selected config file name from settings."""
    settings = _load_settings()
    return settings.get("selectedConfigFile", "config.js")


def set_selected_config_file_name(name: str) -> None:
    """Persists the selected config file name to settings.json."""
    settings = _load_settings()
    settings["selectedConfigFile"] = name
    _save_settings(settings)


def settings_path() -> str:
    """Returns the path to settings.json."""
    return os.path.join(app_support_dir(), "settings.json")


def _load_settings():
    try:
        with open(settings_path(), encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_settings(settings):
    with open(settings_path(), "w", encoding="utf-8") as f:
        json.dump(settings, f, indent=2)


def default_ipc_socket_path():
    xdg = os.environ.get("XDG_RUNTIME_DIR", "/tmp")
    return os.path.join(xdg, "mpv-ipc.sock")


def default_mpv_path():
    """Returns the default mpv path for Linux."""
    for p in ["/usr/bin/mpv", "/usr/local/bin/mpv", "/snap/bin/mpv"]:
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return "mpv"


def strip_comments(text: str) -> str:
    """Removes // comments (whole-line and trailing) while preserving URLs."""
    lines = text.split("\n")
    result = []
    for line in lines:
        stripped = line.lstrip()
        if stripped.startswith("//"):
            continue
        # Trailing comments: only when preceded by whitespace (so https:// survives)
        m = re.search(r'\s//.*$', line)
        if m:
            line = line[:m.start()]
        result.append(line)
    return "\n".join(result)


def extract_value(text: str, key: str) -> str:
    """Extracts a config value by key. Handles strings, arrays, booleans, numbers."""
    stripped = strip_comments(text)
    anchor = r'(?<![A-Za-z0-9_])' + re.escape(key) + r':'
    m = re.search(anchor + r'\s*(.*)', stripped)
    if not m:
        return ""
    rest = m.group(1).strip()

    # String array
    arr_m = re.match(r'\[(.*?)\]', rest)
    if arr_m:
        items = re.findall(r"['\"]([^'\"]*)['\"]", arr_m.group(1))
        return '", "'.join(items)

    # Quoted string
    str_m = re.match(r"""['"]((?:[^'"\\]|\\.)*)['"]""", rest)
    if str_m:
        return _unescape_config_value(str_m.group(1))

    # Boolean
    if rest.startswith("true"):
        return "true"
    if rest.startswith("false"):
        return "false"

    # Number
    num_m = re.match(r'(\d+)', rest)
    if num_m:
        return num_m.group(1)

    return ""


def _unescape_config_value(s: str) -> str:
    # Handle escaped characters. Use NUL placeholder so \\n doesn't double-decode.
    s = s.replace("\\x00", "\x00")
    s = s.replace("\\n", "\n")
    s = s.replace("\\r", "\r")
    s = s.replace("\\t", "\t")
    s = s.replace("\\'", "'")
    s = s.replace('\\"', '"')
    s = s.replace("\\\\", "\\")
    s = s.replace("\x00", "\\x00")
    return s


def escape_config_value(s: str) -> str:
    """Escapes a value for a single-quoted JS string literal."""
    s = s.replace("\\", "\\\\")
    s = s.replace("'", "\\'")
    s = s.replace("\n", "\\n")
    s = s.replace("\r", "\\r")
    s = s.replace("\t", "\\t")
    return s


def line_key(line: str) -> Optional[str]:
    """Returns the config key for a line like '    serverUrl: ...' or None."""
    m = re.match(r'^([A-Za-z_][A-Za-z0-9_]*):', line.strip())
    return m.group(1) if m else None


def build_config(managed_keys: set, managed_lines: list, existing: Optional[str] = None) -> str:
    """Builds a config.js body, preserving unmanaged lines and comments.

    managed_keys: set of key names the UI owns.
    managed_lines: list of lines to emit for those keys (4-space indent, trailing comma).
    existing: current file content to preserve user keys/comments.
    """
    out = ["module.exports = {"]
    out.extend(managed_lines)
    if existing:
        managed = set(managed_keys)
        for raw_line in existing.split("\n"):
            trimmed = raw_line.strip()
            if not trimmed:
                continue
            if "module.exports" in trimmed:
                continue
            if trimmed in ("};", "}"):
                continue
            key = line_key(trimmed)
            if key and key in managed:
                continue
            out.append(raw_line)
    out.append("};")
    return "\n".join(out) + "\n"


def test_connection(server_url, username, password, device_id="test-device", device_name="Setup"):
    """Tests Jellyfin connection. Returns (success, message)."""
    url = server_url.strip().rstrip("/")
    if not url.startswith("http://") and not url.startswith("https://"):
        return (False, "Invalid URL: must start with http:// or https://")

    auth_header = (
        f'MediaBrowser Client="Jellyfin MPV Play", Device="{device_name}", '
        f'DeviceId="{device_id}", Version="1.0"'
    )
    body = json.dumps({"Username": username, "Pw": password}).encode()

    req = urllib.request.Request(
        url + "/Users/AuthenticateByName",
        data=body,
        headers={
            "Authorization": auth_header,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status == 200:
                return (True, "Connected!")
            return (False, f"Failed: HTTP {resp.status}")
    except urllib.error.HTTPError as e:
        return (False, f"Failed: HTTP {e.code}")
    except Exception as e:
        return (False, f"Failed: {e}")


def list_config_files():
    """Lists config*.js files in the app support directory."""
    d = app_support_dir()
    if not os.path.isdir(d):
        return ["config.js"]
    files = [
        f for f in os.listdir(d)
        if f == "config.js" or (f.startswith("config.") and f.endswith(".js"))
    ]
    return sorted(files) if files else ["config.js"]
