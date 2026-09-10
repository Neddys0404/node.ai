"""Constrained project-file operations for the lightweight workspace."""
from pathlib import Path
import shutil
from backend.config import settings

ROOT = Path(settings.project_root).resolve()

def _is_git_repo(directory: Path) -> bool:
    """True when the directory itself is (inside) a Git work tree."""
    import subprocess
    try:
        result = subprocess.run(
            ["git", "-C", str(directory), "rev-parse", "--is-inside-work-tree"],
            capture_output=True, text=True, timeout=5,
        )
        return result.returncode == 0 and result.stdout.strip() == "true"
    except (OSError, subprocess.SubprocessError):
        return False


def set_root(path: str):
    """Switch the active workspace to an existing directory on the server host."""
    global ROOT
    candidate = Path(path).expanduser().resolve()
    if not candidate.is_dir(): raise ValueError("Folder does not exist or is not accessible to Node.AI.")
    ROOT = candidate
    return str(ROOT)

def _path(relative: str) -> Path:
    target = (ROOT / relative).resolve()
    if target != ROOT and ROOT not in target.parents: raise ValueError("Invalid project path")
    return target

def init_project():
    # Never create Node.AI folders inside an existing Git repository — that
    # would pollute the user's work tree with untracked files.
    if _is_git_repo(ROOT):
        return
    for name in ("workflows", "prompts", "scripts", "configs", "outputs", "docs"): (ROOT / name).mkdir(parents=True, exist_ok=True)

def tree(directory: Path | None = None):
    directory = directory or ROOT
    return [{"name": p.name, "path": str(p.relative_to(ROOT)).replace("\\", "/"), "directory": p.is_dir(), "children": tree(p) if p.is_dir() else []} for p in sorted(directory.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))]

def read_project_file(path: str): return _path(path).read_text(encoding="utf-8")
def write_project_file(path: str, content: str):
    item = _path(path); item.parent.mkdir(parents=True, exist_ok=True); item.write_text(content, encoding="utf-8")
def delete_project_file(path: str):
    item = _path(path)
    if item == ROOT: raise ValueError("The active project root cannot be deleted.")
    if item.is_dir(): shutil.rmtree(item)
    else: item.unlink()
def move_project_file(source: str, target: str): _path(source).rename(_path(target))
