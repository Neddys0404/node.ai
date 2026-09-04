import json
import sqlite3
from datetime import datetime, timezone
from backend.config import settings
from backend.models import WorkflowCreate


def connection():
    conn = sqlite3.connect(settings.database_url)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with connection() as db:
        db.execute("""CREATE TABLE IF NOT EXISTS workflows (
          id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
          graph TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)""")


def list_workflows():
    with connection() as db:
        return [dict(row) | {"graph": json.loads(row["graph"])} for row in db.execute("SELECT * FROM workflows ORDER BY updated_at DESC")]


def get_workflow(workflow_id: int):
    with connection() as db:
        row = db.execute("SELECT * FROM workflows WHERE id=?", (workflow_id,)).fetchone()
        return dict(row) | {"graph": json.loads(row["graph"])} if row else None


def save_workflow(payload: WorkflowCreate, workflow_id: int | None = None):
    now = datetime.now(timezone.utc).isoformat()
    values = (payload.name, payload.description, payload.graph.model_dump_json(), now)
    with connection() as db:
        if workflow_id:
            db.execute("UPDATE workflows SET name=?,description=?,graph=?,updated_at=? WHERE id=?", values + (workflow_id,))
        else:
            cursor = db.execute("INSERT INTO workflows(name,description,graph,created_at,updated_at) VALUES(?,?,?,?,?)", values + (now,))
            workflow_id = cursor.lastrowid
    return get_workflow(workflow_id)


def delete_workflow(workflow_id: int):
    with connection() as db:
        return db.execute("DELETE FROM workflows WHERE id=?", (workflow_id,)).rowcount > 0
