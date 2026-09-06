from typing import Any
from pydantic import BaseModel, Field


class GraphNode(BaseModel):
    id: str
    type: str
    position: dict[str, float] = Field(default_factory=dict)
    data: dict[str, Any] = Field(default_factory=dict)


class GraphEdge(BaseModel):
    id: str = ""
    source: str
    target: str
    sourceHandle: str | None = None
    targetHandle: str | None = None


class WorkflowGraph(BaseModel):
    version: int = 2
    nodes: list[GraphNode]
    edges: list[GraphEdge] = Field(default_factory=list)


class WorkflowCreate(BaseModel):
    name: str
    description: str = ""
    graph: WorkflowGraph


class WorkflowRecord(WorkflowCreate):
    id: int
    created_at: str
    updated_at: str


class RunRequest(BaseModel):
    graph: WorkflowGraph


class ProviderProfile(BaseModel):
    alias: str = Field(min_length=1, max_length=80)
    endpoint: str = Field(min_length=1)
    model_id: str = Field(min_length=1)
    api_type: str = "openai"
    api_key: str = ""
    timeout_seconds: int = Field(default=120, ge=5, le=600)


class ProviderPublic(BaseModel):
    id: int
    alias: str
    endpoint: str
    model_id: str
    api_type: str
    has_api_key: bool
    timeout_seconds: int


class RunResult(BaseModel):
    states: dict[str, dict[str, Any]]
    outputs: dict[str, Any]
