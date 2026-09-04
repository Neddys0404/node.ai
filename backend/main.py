import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pathlib import Path
from backend.config import settings
from backend import db
from backend.engine import execute, WorkflowError
from backend.models import WorkflowCreate, RunRequest

logging.basicConfig(level=logging.DEBUG if settings.debug else logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

@asynccontextmanager
async def lifespan(app):
    Path(settings.database_url).parent.mkdir(parents=True, exist_ok=True); db.init_db(); yield

app = FastAPI(title="Node AI", lifespan=lifespan)

@app.get("/api/health")
def health(): return {"ok": True, "llm_api_base_url": settings.llm_api_base_url}
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
    try:
        states, outputs = await execute(request.graph); return {"states": states, "outputs": outputs}
    except WorkflowError as error: raise HTTPException(422, str(error))

web = Path("frontend/dist")
if web.exists():
    app.mount("/assets", StaticFiles(directory=web / "assets"), name="assets")
    @app.get("/{path:path}")
    def frontend(path: str): return FileResponse(web / "index.html")
