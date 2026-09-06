import json
import sqlite3
from datetime import datetime, timezone
from backend.config import settings
from backend.models import WorkflowCreate, ProviderProfile


def connection():
    conn = sqlite3.connect(settings.database_url)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with connection() as db:
        db.execute("""CREATE TABLE IF NOT EXISTS workflows (
          id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
          graph TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)""")
        db.execute("""CREATE TABLE IF NOT EXISTS providers (
          id INTEGER PRIMARY KEY, alias TEXT NOT NULL UNIQUE, endpoint TEXT NOT NULL,
          model_id TEXT NOT NULL, api_type TEXT NOT NULL, api_key TEXT NOT NULL DEFAULT '',
          timeout_seconds INTEGER NOT NULL DEFAULT 120, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)""")
        db.execute("""CREATE TABLE IF NOT EXISTS execution_history (
          id INTEGER PRIMARY KEY, workflow_name TEXT NOT NULL, status TEXT NOT NULL,
          started_at TEXT NOT NULL, completed_at TEXT NOT NULL, duration_ms INTEGER NOT NULL,
          details TEXT NOT NULL)""")


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


def _provider_public(row):
    item = dict(row); item["has_api_key"] = bool(item.pop("api_key", "")); return item


def list_providers():
    with connection() as db:
        return [_provider_public(row) for row in db.execute("SELECT * FROM providers ORDER BY alias COLLATE NOCASE")]


def get_provider(alias: str, include_key: bool = True):
    with connection() as db:
        row = db.execute("SELECT * FROM providers WHERE alias=?", (alias,)).fetchone()
        if not row: return None
        return dict(row) if include_key else _provider_public(row)


def save_provider(payload: ProviderProfile, provider_id: int | None = None):
    now = datetime.now(timezone.utc).isoformat()
    values = (payload.alias, payload.endpoint.rstrip("/"), payload.model_id, payload.api_type, payload.api_key, payload.timeout_seconds, now)
    with connection() as db:
        try:
            if provider_id:
                old = db.execute("SELECT api_key FROM providers WHERE id=?", (provider_id,)).fetchone()
                if not old: return None
                key = payload.api_key or old["api_key"]
                db.execute("UPDATE providers SET alias=?,endpoint=?,model_id=?,api_type=?,api_key=?,timeout_seconds=?,updated_at=? WHERE id=?", values[:4] + (key,) + values[5:] + (provider_id,))
            else:
                cursor = db.execute("INSERT INTO providers(alias,endpoint,model_id,api_type,api_key,timeout_seconds,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)", values + (now,)); provider_id = cursor.lastrowid
        except sqlite3.IntegrityError as error:
            raise ValueError("A provider with that alias already exists.") from error
        row = db.execute("SELECT * FROM providers WHERE id=?", (provider_id,)).fetchone()
        return _provider_public(row)


def delete_provider(provider_id: int):
    with connection() as db: return db.execute("DELETE FROM providers WHERE id=?", (provider_id,)).rowcount > 0


def record_execution(workflow_name: str, status: str, started_at: str, completed_at: str, duration_ms: int, details: dict):
    with connection() as db:
        db.execute("INSERT INTO execution_history(workflow_name,status,started_at,completed_at,duration_ms,details) VALUES(?,?,?,?,?,?)", (workflow_name, status, started_at, completed_at, duration_ms, json.dumps(details)))
        db.execute("DELETE FROM execution_history WHERE id NOT IN (SELECT id FROM execution_history ORDER BY id DESC LIMIT 100)")


def list_history():
    with connection() as db:
        return [dict(row) | {"details": json.loads(row["details"])} for row in db.execute("SELECT * FROM execution_history ORDER BY id DESC LIMIT 100")]
