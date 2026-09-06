import logging, time, asyncio
from datetime import datetime, timezone
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pathlib import Path
from backend.config import settings
from backend import db
from backend.engine import execute, WorkflowError
from backend.models import WorkflowCreate, RunRequest, ProviderProfile
from backend.llm import chat
from backend.workspace import init_project, tree, read_project_file, write_project_file, delete_project_file, move_project_file, set_root

logging.basicConfig(level=logging.DEBUG if settings.debug else logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

@asynccontextmanager
async def lifespan(app):
    Path(settings.database_url).parent.mkdir(parents=True, exist_ok=True); db.init_db(); init_project(); yield

app = FastAPI(title="Node AI", lifespan=lifespan)

@app.get("/api/health")
def health(): return {"ok": True}
@app.get("/api/settings")
def api_settings(): return {"llm_api_base_url": settings.llm_api_base_url, "has_api_key": bool(settings.llm_api_key)}
@app.get("/api/workflows")
def list_workflows(): return db.list_workflows()
@app.post("/api/workflows")
def create_workflow(item: WorkflowCreate): return db.save_workflow(item)
@app.get("/api/workflows/{workflow_id}")
def get_workflow(workflow_id: int):
    item = db.get_workflow(workflow_id)
    if not item: raise HTTPException(404, "Workflow not found")
    return item
@app.put("/api/workflows/{workflow_id}")
def update_workflow(workflow_id: int, item: WorkflowCreate):
    if not db.get_workflow(workflow_id): raise HTTPException(404, "Workflow not found")
    return db.save_workflow(item, workflow_id)
@app.delete("/api/workflows/{workflow_id}")
def remove_workflow(workflow_id: int):
    if not db.delete_workflow(workflow_id): raise HTTPException(404, "Workflow not found")
    return {"ok": True}
@app.post("/api/run")
async def run(request: RunRequest):
    started = datetime.now(timezone.utc); clock = time.perf_counter()
    try:
        states, outputs = await execute(request.graph)
        db.record_execution("Unsaved workflow", "success", started.isoformat(), datetime.now(timezone.utc).isoformat(), int((time.perf_counter()-clock)*1000), {"states":states, "outputs":outputs})
        return {"states": states, "outputs": outputs}
    except WorkflowError as error:
        db.record_execution("Unsaved workflow", "error", started.isoformat(), datetime.now(timezone.utc).isoformat(), int((time.perf_counter()-clock)*1000), {"error":str(error)})
        raise HTTPException(422, str(error))

@app.get("/api/providers")
def providers(): return db.list_providers()
@app.post("/api/providers")
def create_provider(item: ProviderProfile):
    try: return db.save_provider(item)
    except ValueError as error: raise HTTPException(409, str(error))
@app.put("/api/providers/{provider_id}")
def update_provider(provider_id: int, item: ProviderProfile):
    try:
        saved = db.save_provider(item, provider_id)
        if not saved: raise HTTPException(404, "Provider not found")
        return saved
    except ValueError as error: raise HTTPException(409, str(error))
@app.delete("/api/providers/{provider_id}")
def remove_provider(provider_id: int):
    if not db.delete_provider(provider_id): raise HTTPException(404, "Provider not found")
    return {"ok":True}
@app.post("/api/providers/{provider_id}/test")
async def test_provider(provider_id: int):
    provider = next((x for x in db.list_providers() if x["id"] == provider_id), None)
    if not provider: raise HTTPException(404, "Provider not found")
    raw = db.get_provider(provider["alias"])
    try:
        text, _ = await chat({"model":raw["model_id"], "messages":[{"role":"user","content":"Reply with OK."}], "max_tokens":8}, raw)
        return {"ok":True, "message":text[:120]}
    except Exception as error: raise HTTPException(502, f"Connection test failed: {error}")
@app.get("/api/history")
def history(): return db.list_history()

class FileWrite(BaseModel): path: str; content: str = ""
class FileMove(BaseModel): source: str; target: str
class FolderOpen(BaseModel): path: str
@app.get("/api/project/tree")
def project_tree(): return tree()
@app.post("/api/project/open-folder")
def open_project_folder(item: FolderOpen):
    try: return {"root": set_root(item.path), "tree": tree()}
    except ValueError as error: raise HTTPException(400, str(error))
@app.post("/api/project/pick-folder")
async def pick_project_folder():
    """Native chooser for local desktop deployments; unavailable in headless Docker."""
    def choose():
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk(); root.withdraw(); root.attributes("-topmost", True)
        try: return filedialog.askdirectory(title="Open Node.AI project folder")
        finally: root.destroy()
    try:
        path = await asyncio.to_thread(choose)
        if not path: return {"cancelled": True}
        return {"root": set_root(path), "tree": tree()}
    except Exception as error:
        raise HTTPException(501, "Native folder chooser is unavailable on this server; enter a server-accessible folder path instead.") from error
@app.get("/api/project/file")
def project_file(path: str):
    try: return {"path":path, "content":read_project_file(path)}
    except (OSError, ValueError) as error: raise HTTPException(404, str(error))
@app.put("/api/project/file")
def save_project_file(item: FileWrite):
    try: write_project_file(item.path, item.content); return {"ok":True}
    except (OSError, ValueError) as error: raise HTTPException(400, str(error))
@app.delete("/api/project/file")
def remove_project_file(path: str):
    try: delete_project_file(path); return {"ok":True}
    except (OSError, ValueError) as error: raise HTTPException(400, str(error))
@app.post("/api/project/move")
def move_project(item: FileMove):
    try: move_project_file(item.source, item.target); return {"ok":True}
    except (OSError, ValueError) as error: raise HTTPException(400, str(error))

web = Path("frontend/dist")
if web.exists():
    app.mount("/assets", StaticFiles(directory=web / "assets"), name="assets")
    @app.get("/{path:path}")
    def frontend(path: str): return FileResponse(web / "index.html")
