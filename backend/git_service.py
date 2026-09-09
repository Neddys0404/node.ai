"""Git operations for the active project workspace.

Raises GitError(kind, message, detail); backend/main.py maps kinds to HTTP codes:
    bad_request -> 409, invalid_branch -> 422, command_not_found -> 503.
`message` is user-facing; `detail` carries raw git output for troubleshooting.
"""
import asyncio
import re
import subprocess
from pathlib import Path

VALID_BRANCH_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]*$")


class GitError(Exception):
    def __init__(self, kind: str, message: str, detail: str = ""):
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.detail = detail


def _text(res: subprocess.CompletedProcess) -> str:
    return (res.stderr or "").strip() + ("\n" + res.stdout.strip() if res.stdout and res.stdout.strip() else "")


_FIRED = [
    (re.compile(r"not a git repository|not inside a git", re.I),
     "bad_request", "Current project directory is not a Git repository."),
    (re.compile(r"origin does not appear to be a git repository|no remote named origin", re.I),
     "bad_request", "No remote configured. Add one first, e.g. `git remote add origin <url>`, then push with upstream: `git push -u origin <branch>`."),
    (re.compile(r"no tracking information|fatal: no unique tracking", re.I),
     "bad_request", "The current branch has no upstream configured. Push once with `git push -u origin <branch>`, then plain `git pull` will work."),
    (re.compile(r"(Authentication failed|Invalid username or password|could not read Username|terminal prompts disabled)", re.I),
     "bad_request", "Git authentication failed. Check your credentials/token for this remote, then retry from a terminal if the app cannot prompt: git pull"),
    (re.compile(r"rejected|non-fast-forward|fetch first", re.I),
     "bad_request", "The remote branch contains changes that are not present locally and the push was rejected. Run `git pull` (or `git pull --rebase`) in this directory to synchronize, then push again. Node.AI never force-pushes."),
    (re.compile(r"merge conflict|conflicting modifications", re.I),
     "bad_request", "Pull stopped because of a merge conflict. Resolve the conflicting files, commit the resolution, then retry Pull."),
    (re.compile(r"pathspec .* did not match", re.I),
     "bad_request", "The local and remote branch history for this name diverge, so it cannot be published without a force push. Node.AI refuses to force; choose another branch name or reconcile manually."),
    (re.compile(r"curl (\d+)|RPC failed|timed? ?out", re.I),
     "bad_request", "Network failure while talking to the remote. Check connectivity/proxy, then retry."),
    (re.compile(r"already exists and is not an empty directory", re.I),
     "bad_request", "A folder with that name already exists in the project directory, so Git refused to clone into it. Remove/rename it or choose a different repository."),
    (re.compile(r"invalid url|could not resolve hostname|repository not found", re.I),
     "bad_request", "The repository URL does not look reachable/valid. Check the spelling and that you have access."),
]


def _friendly(res: subprocess.CompletedProcess, fallback_kind: str = "bad_request") -> GitError:
    text = _text(res)
    for rx, kind, msg in _FIRED:  # (renamed from fired; matches first hit)
        if rx.search(text):
            return GitError(kind, msg, detail=text)
    return GitError(fallback_kind, "Git command failed.", detail=text)


def call(args: list[str], cwd: Path | str | None = None) -> subprocess.CompletedProcess:
    """Run one git command synchronously; raise GitError on any failure."""
    try:
        res = subprocess.run(
            ["git"] + args,
            cwd=str(cwd) if cwd is not None else None,
            capture_output=True, text=True, timeout=1800,
        )
    except FileNotFoundError:
        raise GitError("command_not_found", "Git is not installed or not on PATH. Install Git (git-scm.com) and restart Node.AI.")
    except subprocess.TimeoutExpired:
        raise GitError("bad_request", "Git command timed out after 30 minutes.")
    if res.returncode != 0:
        raise _friendly(res)
    return res


async def is_git_repo(path: Path) -> bool:
    async def probe() -> bool:
        try:
            r = subprocess.run(["git", "rev-parse", "--is-inside-work-tree"], cwd=str(path), capture_output=True, text=True, timeout=30)
            return r.returncode == 0 and r.stdout.strip() == "true"
        except (OSError, subprocess.TimeoutExpired, FileNotFoundError):
            return False
    return await asyncio.to_thread(probe)


async def status(path: Path) -> dict:
    if not path.is_dir():
        return {"is_repo": False}

    async def probe() -> dict:
        try:
            inside = subprocess.run(["git", "rev-parse", "--is-inside-work-tree"], cwd=str(path), capture_output=True, text=True, timeout=30)
            if inside.returncode != 0 or inside.stdout.strip() != "true":
                return {"is_repo": False}
        except (OSError, subprocess.TimeoutExpired, FileNotFoundError):
            return {"is_repo": False}
        branch = ""
        try:
            b = subprocess.run(["git", "branch", "--show-current"], cwd=str(path), capture_output=True, text=True, timeout=30)
            branch = b.stdout.strip()
        except (OSError, subprocess.TimeoutExpired):
            pass
        uncommitted = False
        try:
            s = subprocess.run(["git", "status", "--porcelain"], cwd=str(path), capture_output=True, text=True, timeout=30)
            uncommitted = bool(s.stdout.strip())
        except (OSError, subprocess.TimeoutExpired):
            pass
        return {"is_repo": True, "branch": branch, "uncommitted": uncommitted}

    return await asyncio.to_thread(probe)


async def clone(url: str, parent: Path) -> dict:
    url = url.strip()
    if not url:
        raise GitError("bad_request", "Repository URL is empty.")
    if not parent.is_dir():
        raise GitError("bad_request", f"The active project directory does not exist on the server: {parent}")

    def work() -> dict:
        try:
            res = subprocess.run(["git", "clone", url], cwd=str(parent), capture_output=True, text=True, timeout=1800)
        except FileNotFoundError:
            raise GitError("command_not_found", "Git is not installed or not on PATH. Install Git (git-scm.com) and restart Node.AI.")
        except subprocess.TimeoutExpired:
            raise GitError("bad_request", "Clone timed out after 30 minutes.")
        if res.returncode != 0:
            raise _friendly(res)
        last = (res.stdout or "").strip().splitlines()[-1] if (res.stdout or "").strip() else ""
        return {"message": f"Cloned successfully." + (f" {last}" if last.startswith("Cloning") else ""), "detail": res.stdout.strip()}

    return await asyncio.to_thread(work)


async def pull(path: Path) -> dict:
    if not path.is_dir():
        raise GitError("bad_request", f"The active project directory does not exist on the server: {path}")

    def work() -> dict:
        try:
            res = subprocess.run(["git", "pull"], cwd=str(path), capture_output=True, text=True, timeout=1800)
        except FileNotFoundError:
            raise GitError("command_not_found", "Git is not installed or not on PATH.")
        if res.returncode != 0:
            raise _friendly(res)
        return {"message": "Pull completed.", "detail": (res.stdout or "").strip()}

    return await asyncio.to_thread(work)


async def push(path: Path) -> dict:
    if not path.is_dir():
        raise GitError("bad_request", f"The active project directory does not exist on the server: {path}")

    def work() -> dict:
        try:
            res = subprocess.run(["git", "push"], cwd=str(path), capture_output=True, text=True, timeout=1800)
        except FileNotFoundError:
            raise GitError("command_not_found", "Git is not installed or not on PATH.")
        if res.returncode != 0:
            raise _friendly(res)
        return {"message": "Push completed.", "detail": (res.stdout or "").strip()}

    return await asyncio.to_thread(work)


async def publish_branch(path: Path, name: str) -> dict:
    """Create a local branch from the current HEAD and publish it with upstream.
    Refuses to touch work: requires a clean tree, validates the name, and refuses
    if the branch already exists locally or exists remotely with divergent history.
    """
    name = (name or "").strip()
    if not name:
        raise GitError("invalid_branch", "Branch name is empty.")
    if len(name) > 100:
        raise GitError("invalid_branch", "Branch name is too long.")
    if not VALID_BRANCH_RE.match(name) or ".." in name or name.startswith("/") or name.endswith(".lock"):
        raise GitError("invalid_branch", "Invalid branch name. Use letters, digits, '.', '_', '/' (starting with a letter or digit); no spaces, '..', or trailing '.lock'.")
    if not path.is_dir():
        raise GitError("bad_request", f"The active project directory does not exist on the server: {path}")

    def work() -> dict:
        inside = subprocess.run(["git", "rev-parse", "--is-inside-work-tree"], cwd=str(path), capture_output=True, text=True, timeout=30)
        if inside.returncode != 0 or inside.stdout.strip() != "true":
            raise GitError("bad_request", "Current project directory is not a Git repository.")

        st = subprocess.run(["git", "status", "--porcelain"], cwd=str(path), capture_output=True, text=True, timeout=30)
        dirty = bool(st.stdout.strip())

        local = subprocess.run(["git", "branch", "--list", f"refs/heads/{name}"], cwd=str(path), capture_output=True, text=True, timeout=30)
        if (local.stdout or "").strip():
            raise GitError("bad_request", f"Branch '{name}' already exists locally. Choose a different name — Node.AI will not overwrite it.")

        remotes = subprocess.run(["git", "remote"], cwd=str(path), capture_output=True, text=True, timeout=30)
        if "origin" not in (remotes.stdout or "").split():
            raise GitError("bad_request", "No remote named 'origin' is configured. Add one first: git remote add origin <url>")

        def sha_of(ref: str) -> str:
            r = subprocess.run(["git", "rev-parse", "--verify", "--quiet", ref], cwd=str(path), capture_output=True, text=True, timeout=30)
            return r.stdout.strip() if r.returncode == 0 else ""

        # If the branch already exists on the remote and its tip is neither our HEAD
        # nor an ancestor of our HEAD, publishing would require a force push — refuse.
        remote_sha = sha_of(f"refs/remotes/origin/{name}")
        if remote_sha:
            head = sha_of("HEAD")
            mb_res = subprocess.run(["git", "merge-base", f"origin/{name}", "HEAD"], cwd=str(path), capture_output=True, text=True, timeout=30)
            merged_base = mb_res.stdout.strip() if mb_res.returncode == 0 else ""
            if remote_sha != head and not (merged_base == remote_sha):
                raise GitError("bad_request", f"Branch '{name}' already exists on the remote with different history. Node.AI will not force-push over it; pick another name or reconcile manually.")

        switch = subprocess.run(["git", "switch", "-c", name], cwd=str(path), capture_output=True, text=True, timeout=60)
        if switch.returncode != 0:
            raise _friendly(switch, fallback_kind="bad_request")

        push_res = subprocess.run(["git", "push", "-u", "origin", name], cwd=str(path), capture_output=True, text=True, timeout=1800)
        if push_res.returncode != 0:
            # branch exists locally now — surface honestly; do not auto-delete
            err = _friendly(push_res)
            err.message = f"Branch '{name}' was created locally, but publishing failed. {err.message}"
            raise err

        current = subprocess.run(["git", "branch", "--show-current"], cwd=str(path), capture_output=True, text=True, timeout=30).stdout.strip()
        return {"message": f"Published branch '{name}' to origin with upstream tracking.", "detail": push_res.stdout.strip(), "branch": current or name, "uncommitted": dirty}

    return await asyncio.to_thread(work)