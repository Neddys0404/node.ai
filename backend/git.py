"""Git operations for the active project workspace.

Commands run the git CLI via asyncio subprocesses, serialized by a
module-level lock so two operations never touch the same work tree at the
same time. Only safe, non-destructive operations are exposed: clone, pull,
push, and create-and-publish a new branch. Nothing here force-pushes, resets,
cleans, deletes, or discards uncommitted changes.
"""
import asyncio
import re

import backend.workspace as ws

TIMEOUT = 180  # seconds for network-bound commands
FAST = 15      # seconds for local-only commands


class GitError(Exception):
    """User-presentable Git failure."""


class GitConflictError(GitError):
    """Operation refused because it would overwrite or duplicate existing state."""


_lock = asyncio.Lock()


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
    return {"is_repo": True, "branch": branch, "remotes": remotes}


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
        code, out, err = await _git(root, "pull")
    if code != 0:
        raise _pull_error(err or out)
    return {"ok": True, "output": _short(out or err, 300)}


async def push() -> dict:
    root = _root()
    async with _lock:
        await _require_repo(root)
        code, out, err = await _git(root, "push")
    if code != 0:
        raise _push_error(err or out)
    return {"ok": True, "output": _short(out or err, 300)}


async def publish_branch(name: str) -> dict:
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
        code, out, err = await _git(root, "push", "-u", remote, name)
        if code != 0:
            raise _push_error(err or out)
    return {"ok": True, "branch": name, "remote": remote}
