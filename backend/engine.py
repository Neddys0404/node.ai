import re
from collections import defaultdict, deque
from typing import Any
from backend.models import WorkflowGraph
from backend.llm import chat


class WorkflowError(Exception): pass


def validate_and_order(graph: WorkflowGraph) -> list[str]:
    ids = {node.id for node in graph.nodes}
    if len(ids) != len(graph.nodes): raise WorkflowError("Workflow contains duplicate node IDs.")
    for edge in graph.edges:
        if edge.source not in ids or edge.target not in ids: raise WorkflowError("Workflow has an edge pointing to a missing node.")
    indegree = {node_id: 0 for node_id in ids}
    children = defaultdict(list)
    for edge in graph.edges:
        children[edge.source].append(edge.target); indegree[edge.target] += 1
    queue = deque(node_id for node_id, value in indegree.items() if value == 0); order = []
    while queue:
        current = queue.popleft(); order.append(current)
        for child in children[current]:
            indegree[child] -= 1
            if indegree[child] == 0: queue.append(child)
    if len(order) != len(ids): raise WorkflowError("Workflow contains a cycle. Remove a connection that loops back upstream.")
    return order


def transform(text: str, config: dict) -> str:
    operation = config.get("operation", "trim")
    if operation == "trim": return text.strip()
    if operation == "prepend": return config.get("value", "") + text
    if operation == "append": return text + config.get("value", "")
    if operation == "replace": return text.replace(config.get("find", ""), config.get("replace", ""))
    if operation == "regex_replace": return re.sub(config.get("find", ""), config.get("replace", ""), text)
    if operation == "strip_fences": return re.sub(r"^```[\w-]*\s*|\s*```$", "", text.strip())
    if operation == "first_code_block":
        match = re.search(r"```(?:[\w-]+)?\s*\n?(.*?)```", text, re.S); return match.group(1).strip() if match else text
    if operation == "extract_json":
        match = re.search(r"(\{.*\}|\[.*\])", text, re.S); return match.group(1) if match else text
    raise WorkflowError(f"Unknown transform operation '{operation}'.")


def input_values(node_id: str, edges, outputs: dict[str, Any]) -> dict[str, Any]:
    values = {}
    for edge in edges:
        if edge.target == node_id and edge.source in outputs:
            value = outputs[edge.source]
            if isinstance(value, dict):
                value = value.get(edge.sourceHandle or "text")
            if value is not None:
                values[edge.targetHandle or "text"] = value
    return values


async def execute(graph: WorkflowGraph):
    order = validate_and_order(graph); nodes = {node.id: node for node in graph.nodes}; outputs = {}; states = {}
    for node_id in order:
        node = nodes[node_id]; states[node_id] = {"status": "running"}; inputs = input_values(node_id, graph.edges, outputs)
        try:
            if node.type == "textInput": result = node.data.get("text", "")
            elif node.type == "template":
                template = node.data.get("template", "")
                result = re.sub(r"{{\s*([^}]+)\s*}}", lambda m: str(inputs.get(m.group(1).strip(), "")), template)
            elif node.type == "transform": result = transform(str(inputs.get("text", "")), node.data)
            elif node.type == "append": result = node.data.get("prefix", "") + str(inputs.get("text", "")) + node.data.get("suffix", "")
            elif node.type == "condition":
                text, needle, kind = str(inputs.get("text", "")), node.data.get("value", ""), node.data.get("condition", "contains")
                matched = {"contains": needle in text, "equals": text == needle, "starts_with": text.startswith(needle), "ends_with": text.endswith(needle), "regex": bool(re.search(needle, text))}.get(kind, False)
                branch = "true" if matched else "false"
                outputs[node_id] = {branch: text}; states[node_id] = {"status":"success", "branch": branch}; continue
            elif node.type == "llm":
                prompt = inputs.get("prompt") or inputs.get("text")
                if not prompt: raise WorkflowError("LLM Task requires input 'prompt'.")
                config = node.data; result = await chat({"model": config.get("model", ""), "messages": [{"role":"system","content":config.get("systemPrompt", "")}, {"role":"user","content":str(prompt)}], **{key: config[key] for key in ("temperature","top_p","top_k","min_p","repetition_penalty","presence_penalty","max_tokens") if key in config}})
            elif node.type == "output": result = str(inputs.get("text", ""))
            else: raise WorkflowError(f"Unknown node type '{node.type}'.")
            outputs[node_id] = result; states[node_id] = {"status": "success", "preview": str(result)[:180]}
        except Exception as error:
            states[node_id] = {"status": "error", "error": str(error)}; raise WorkflowError(f"{node_id}: {error}") from error
    return states, outputs
