"""Git operations for the active project workspace.

Commands run the git CLI via asyncio subprocesses, serialized by a
module-level lock so two operations never touch the same work tree at the
same time. Only safe, non-destructive operations are exposed: clone, pull,
push, and create-and-publish a new branch. Nothing here force-pushes, resets,
cleans, deletes, or discards uncommitted changes.
"""
import asyncio
import os
import re
import sqlite3
import stat
import tempfile
from pathlib import Path

from backend.config import settings
import backend.workspace as ws

TIMEOUT = 180  # seconds for network-bound commands
FAST = 15      # seconds for local-only commands


class GitError(Exception):
    """User-presentable Git failure."""


class GitConflictError(GitError):
    """Operation refused because it would overwrite or duplicate existing state."""


_lock = asyncio.Lock()

# ── Credential storage ───────────────────────────────────────────────────────
# Stored in a dedicated SQLite file next to the app database, never inside any
# project directory (so it cannot be committed), with 0600 permissions on Unix.
_CRED_DB = Path(settings.database_url).parent / "git-credentials.db"


def _cred_conn():
    conn = sqlite3.connect(str(_CRED_DB))
    conn.row_factory = sqlite3.Row
    conn.execute(
        "CREATE TABLE IF NOT EXISTS git_credentials ("
        " id INTEGER PRIMARY KEY CHECK (id = 1), username TEXT NOT NULL, token TEXT NOT NULL)"
    )
    return conn


def has_stored_credentials() -> bool:
    try:
        row = _cred_conn().execute("SELECT 1 FROM git_credentials WHERE id=1").fetchone()
    except sqlite3.Error:
        return False
    return row is not None


def get_stored_credentials():
    """Backend-only. Never returned by any API endpoint."""
    try:
        row = _cred_conn().execute("SELECT username, token FROM git_credentials WHERE id=1").fetchone()
    except sqlite3.Error:
        return None
    if not row or not row["token"]:
        return None
    return {"username": row["username"], "token": row["token"]}


def save_credentials(username: str, token: str) -> None:
    username = (username or "").strip()
    token = (token or "").strip()
    if not username or not token:
        raise ValueError("Both a GitHub username and a personal access token are required.")
    with _cred_conn() as conn:
        conn.execute(
            "INSERT INTO git_credentials(id, username, token) VALUES(1, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET username=excluded.username, token=excluded.token",
            (username, token),
        )
    try:
        os.chmod(_CRED_DB, stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        pass


def clear_credentials() -> bool:
    with _cred_conn() as conn:
        return conn.execute("DELETE FROM git_credentials WHERE id=1").rowcount > 0


async def test_github_credentials(username: str, token: str):
    """Validate a GitHub PAT against api.github.com without performing any Git operation."""
    import httpx

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get("https://api.github.com/user", headers={"Authorization": "Bearer " + token})
    except httpx.HTTPError as error:
        raise GitError("Could not reach GitHub to test the credentials (network error).") from error
    if resp.status_code == 401:
        raise GitError("GitHub rejected these credentials. Check that the personal access token is valid and not expired.")
    if resp.status_code >= 400:
        raise GitError(f"GitHub returned an unexpected response ({resp.status_code}) while testing the credentials.")
    login = (resp.json() or {}).get("login") or username
    return {"ok": True, "message": f"Credentials work — authenticated as @{login}."}


# ── Authenticated command execution ──────────────────────────────────────────
# Credentials are handed to git through a one-shot credential helper that reads
# them from environment variables, plus a temporary GIT_CONFIG_GLOBAL. The token
# therefore never appears in the process listing, in URLs persisted by git,
# or in any log; it is also stripped from every string this module returns.
# One-shot Git credential helper. Git's `get` protocol sends protocol/host/path
# on stdin and expects the helper to PRINT the credentials back — it is not a
# per-line request/response. We answer unconditionally with the injected pair;
# the process dies with the git command, so nothing is left behind.
_HELPER_SOURCE = '''
import os, sys
if len(sys.argv) > 1 and sys.argv[1] == "get":
    sys.stdin.read()
    print("username=" + (os.environ.get("NODEAI_GIT_USER") or ""))
    print("password=" + (os.environ.get("NODEAI_GIT_TOKEN") or ""))
'''


async def _git_auth(cwd, *args, credentials: dict | None, timeout: int = TIMEOUT):
    if not credentials:
        return await _git(cwd, *args, timeout=timeout)
    tmpdir = tempfile.mkdtemp(prefix="nodeai-git-")
    helper = Path(tmpdir) / "cred-helper.py"
    config = Path(tmpdir) / "gitconfig"
    try:
        if os.name != "nt":
            os.chmod(tmpdir, 0o700)
        helper.write_text(_HELPER_SOURCE, encoding="utf-8")
        config.write_text(
            "[credential]\n\thelper = python " + str(helper) + "\n",
            encoding="utf-8",
        )
        if os.name != "nt":
            os.chmod(config, stat.S_IRUSR | stat.S_IWUSR)
        env = dict(os.environ)
        env["GIT_CONFIG_GLOBAL"] = str(config)
        env["NODEAI_GIT_USER"] = credentials["username"]
        env["NODEAI_GIT_TOKEN"] = credentials["token"]
        try:
            proc = await asyncio.create_subprocess_exec(
                "git", "-C", str(cwd), *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
            )
        except (FileNotFoundError, OSError) as error:
            raise GitError("Git is not installed or is not on the server PATH.") from error
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            raise GitError(f"Git command timed out after {timeout} s.")
        return (
            proc.returncode or 0,
            _sanitize(out.decode(errors="replace"), credentials["token"]).strip(),
            _sanitize(err.decode(errors="replace"), credentials["token"]).strip(),
        )
    finally:
        for p in (config, helper):
            try:
                p.unlink()
            except OSError:
                pass
        try:
            os.rmdir(tmpdir)
        except OSError:
            pass


def _sanitize(text: str, token: str) -> str:
    if not text or not token:
        return text or ""
    out = text.replace(token, "*****")
    # Cover https://user:token@host/... forms in case git echoes a URL.
    out = re.sub(r"(https?://[^/:@\s]+:)[^@\s]+(@)", r"\1*****\2", out)
    return out


async def _git(cwd, *args, timeout: int = TIMEOUT):
    try:
        proc = await asyncio.create_subprocess_exec(
            "git", "-C", str(cwd), *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except (FileNotFoundError, OSError) as error:
        raise GitError("Git is not installed or is not on the server PATH.") from error
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise GitError(f"Git command timed out after {timeout} s.")
    return (
        proc.returncode or 0,
        out.decode(errors="replace").strip(),
        err.decode(errors="replace").strip(),
    )


def _short(text: str, limit: int = 600) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit] + " …"


def _root():
    root = ws.ROOT  # module lookup: set_root() reassigns ws.ROOT
    if not root.is_dir():
        raise GitError(f"Active project directory does not exist: {root}")
    return root


async def _require_repo(root) -> None:
    code, out, _ = await _git(root, "rev-parse", "--is-inside-work-tree", timeout=FAST)
    if code != 0 or out.strip() != "true":
        raise GitError("Current project directory is not a Git repository.")


def _clone_name(url: str, git_out: str) -> str:
    m = re.search(r"Cloning into '([^']+)'", git_out)
    if m:
        return m.group(1)
    return url.rstrip("/").rsplit("/", 1)[-1].removesuffix(".git") or "repository"


def _pull_error(detail: str) -> GitError:
    d = detail.lower()
    if "no tracking information" in d or "does not have any tracking branch" in d:
        return GitError("This branch has no upstream to pull from. Use Publish Branch, or set one manually: git push -u origin <branch>")
    if "couldn't find remote" in d:
        return GitError("The remote branch for the current branch was not found on the remote.\n" + _short(detail))
    if "conflict" in d or "merge" in d:
        return GitError("Pull stopped because of merge conflicts or uncommitted local changes. Resolve them locally, then pull again.\n" + _short(detail))
    return GitError("Pull failed.\n" + _short(detail))


class GitAuthRequiredError(GitError):
    """Operation needs credentials; `auth_required` tells the UI to prompt for them."""

    def __init__(self, message: str, auth_required: bool = True):
        super().__init__(message)
        self.auth_required = auth_required


def _is_auth_failure(detail: str) -> bool:
    d = detail.lower()
    return any(
        s in d
        for s in (
            "authentication failed",
            "could not read username",
            "terminal prompts disabled",
            "access denied",
            "invalid username or password",
            "support for password authentication was removed",
            "401",
            "403",
        )
    )


def _auth_error(detail: str, had_credentials: bool) -> GitError:
    if not had_credentials:
        raise GitAuthRequiredError(
            "This operation requires GitHub credentials, but none are configured. "
            "Enter them in the dialog, or save them under Settings → Git.",
            auth_required=True,
        )
    return GitError(
        "Git authentication failed.\n\n"
        "Your stored GitHub credentials may be invalid or expired. Update them in Settings → Git.\n\n"
        + _short(detail)
    )


def _push_error(detail: str) -> GitError:
    d = detail.lower()
    if "no upstream branch" in d or "no tracking information" in d:
        return GitError("The current branch has no upstream branch. Use Publish Branch, or run: git push -u origin <branch>")
    if "no configured push destination" in d:
        return GitError("No Git remote is configured for this repository (e.g. git remote add origin <url>).")
    if "rejected" in d:
        return GitError("The remote rejected the push — the remote branch contains changes that are not present locally. Pull (and merge) first, then push again.\n" + _short(detail))
    if any(s in d for s in ("authentication failed", "could not read username", "terminal prompts disabled", "access denied", "401", "403")):
        return GitError("Git authentication failed. Check credentials and permissions for this remote.\n" + _short(detail))
    if any(s in d for s in ("unable to access", "could not resolve host", "connection", "network", "timed out")):
        return GitError("Network error while contacting the remote.\n" + _short(detail))
    return GitError("Push failed.\n" + _short(detail))


async def status() -> dict:
    root = _root()
    code, out, _ = await _git(root, "rev-parse", "--is-inside-work-tree", timeout=FAST)
    if code != 0 or out.strip() != "true":
        return {"is_repo": False, "branch": None, "remotes": []}
    code, out, _ = await _git(root, "rev-parse", "--abbrev-ref", "HEAD", timeout=FAST)
    branch = out.strip() or None
    if branch == "HEAD":  # detached HEAD
        code, out, _ = await _git(root, "rev-parse", "--short", "HEAD", timeout=FAST)
        branch = "(detached at " + (out.strip() or "?") + ")"
    code, out, _ = await _git(root, "remote", timeout=FAST)
    remotes = [x.strip() for x in out.splitlines() if x.strip()]
    return {"is_repo": True, "branch": branch, "remotes": remotes, "has_credentials": has_stored_credentials()}


async def clone(url: str) -> dict:
    url = url.strip()
    if not url:
        raise GitError("Enter a repository URL to clone.")
    root = _root()
    async with _lock:
        code, out, err = await _git(root, "clone", url)
    if code != 0:
        combined = f"{err}\n{out}".lower()
        if "destination path already exists" in combined:
            raise GitConflictError("A folder with that repository name already exists in the project directory. Nothing was deleted or modified.")
        raise GitError("Clone failed.\n" + _short(err or out))
    name = _clone_name(url, out)
    return {"ok": True, "dir": name, "path": str(root / name)}


async def pull() -> dict:
    root = _root()
    async with _lock:
        await _require_repo(root)
        code, ref, _ = await _git(root, "rev-parse", "--abbrev-ref", "HEAD", timeout=FAST)
        if code == 0 and ref.strip() == "HEAD":
            raise GitError("The repository is in a detached HEAD state; switch to a branch before pulling.")
        credentials = get_stored_credentials()
        code, out, err = await _git_auth(root, "pull", credentials)
    if code != 0:
        detail = err or out
        if _is_auth_failure(detail):
            _auth_error(detail, had_credentials=bool(credentials))
        raise _pull_error(detail)
    return {"ok": True, "message": "Pull completed."}


async def push(credentials: dict | None = None) -> dict:
    """`credentials` is an optional one-shot pair from the auth dialog (never
    persisted); otherwise the stored credentials are used."""
    root = _root()
    async with _lock:
        await _require_repo(root)
        code, out, err = await _git_auth(root, "push", credentials)
    if code != 0:
        detail = err or out
        if _is_auth_failure(detail):
            _auth_error(detail, had_credentials=bool(credentials))
        raise _push_error(detail)
    return {"ok": True, "message": "Push completed."}


async def publish_branch(name: str, credentials: dict | None = None) -> dict:
    """`credentials` is an optional one-shot pair from the auth dialog (never
    persisted); otherwise the stored credentials are used."""
    name = name.strip()
    root = _root()
    async with _lock:
        await _require_repo(root)
        if not name:
            raise GitError("Enter a branch name.")
        code, out, err = await _git(root, "check-ref-format", "--branch", name, timeout=FAST)
        if code != 0:
            raise GitError(f"Invalid branch name {name!r}. Use letters, numbers, '-' and '/' (e.g. feature/my-new-feature).")
        code, out, _ = await _git(root, "show-ref", "--verify", "--quiet", f"refs/heads/{name}", timeout=FAST)
        if code == 0:
            raise GitConflictError(f"Branch '{name}' already exists locally. Switch to it with: git switch {name}")
        code, out, _ = await _git(root, "remote", timeout=FAST)
        remotes = [x.strip() for x in out.splitlines() if x.strip()]
        if not remotes:
            raise GitError("No Git remote is configured; add one before publishing (git remote add origin <url>).")
        remote = "origin" if "origin" in remotes else remotes[0]
        code, _, _ = await _git(root, "ls-remote", "--exit-code", "--heads", remote, name, timeout=60)
        if code == 0:
            raise GitConflictError(f"Branch '{name}' already exists on remote '{remote}' and will not be overwritten.")
        code, out, err = await _git(root, "checkout", "-b", name, timeout=FAST)
        if code != 0:
            raise GitError("Failed to create branch.\n" + _short(err or out))
        code, out, err = await _git_auth(root, "push", "-u", remote, name, credentials)
        if code != 0:
            detail = err or out
            if _is_auth_failure(detail):
                _auth_error(detail, had_credentials=bool(credentials))
            raise _push_error(detail)
    return {"ok": True, "branch": name, "remote": remote, "message": f"Branch '{name}' published to {remote}."}
