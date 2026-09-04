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
    version: int = 1
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


class RunResult(BaseModel):
    states: dict[str, dict[str, Any]]
    outputs: dict[str, Any]
