# Node.AI

A lightweight, self-hosted visual workflow editor for OpenAI-compatible LLM APIs. It does not host or manage models: the browser talks only to Node.AI, and Node.AI calls the configured LLM service server-side.

## Workspace and provider profiles

The **Providers** dialog stores named endpoint/model profiles in SQLite. Select a
profile in an LLM Task instead of embedding credentials in a workflow. API keys
are never returned by the API or included in exported workflow JSON.

The **Project** panel is a constrained workspace rooted at `data/project`
(`workflows`, `prompts`, `scripts`, `configs`, `outputs`, and `docs`). It offers
basic project-file editing and Markdown source/preview. File Input nodes retain a
project-relative path and resolve it only at execution time. The Docker data
volume already persists this directory along with SQLite.

## Run with Docker

```bash
cp .env.example .env
# edit .env and set LLM_API_BASE_URL
docker compose up -d --build
```

Open `http://SERVER_IP:8080`. To stop it, run `docker compose down`. Workflow data remains in the named Docker volume.

## Configure the LLM service

Set `LLM_API_BASE_URL` to the full `/v1` prefix. Examples:

- LAN or remote machine: `http://192.168.1.100:8000/v1`
- Another Compose service named `llm`: `http://llm:8000/v1`
- LLM running on the Docker host: `http://host.docker.internal:8000/v1` (supported by Docker Desktop; on Linux, configure the host gateway or use the host LAN address)

Set `LLM_API_KEY` only when the external service requires it. It stays in the container environment and is never returned to the browser. The service calls `POST {LLM_API_BASE_URL}/chat/completions` with a standard OpenAI-compatible request.

## Using the editor

Use the left panel to add nodes, then drag between their handles to connect data flow. An LLM Task accepts a model ID, a collapsible system prompt, and sampling parameters. Template variables such as `{{code}}` read from incoming connections whose target handle is named `code` (React Flow lets you edit a target handle in the exported JSON; the built-in `text` connection works by default). Press **Run** for sequential dependency-order execution. Each card reports success or failure, and Output cards render final text.

**Save** persists the graph in SQLite. **Export** downloads a portable JSON document; **Import** loads one. `examples/code-review-pipeline.json` is ready to import.

## Local development and tests

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
pip install pytest-asyncio
pytest

cd frontend
npm install
npm run build
cd ..
uvicorn backend.main:app --reload --port 8080
```

The production container builds the React app and serves it from FastAPI. For frontend hot reload, run `npm run dev` inside `frontend`; use port 8080 for API requests in a production-style test.
