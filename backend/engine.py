import re
from collections import defaultdict, deque
from typing import Any
from backend.models import WorkflowGraph
from backend.llm import chat
from backend import db


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
        match = re.search(r"```(?:[\w-]+)?\s*?(.*?)```", text, re.S); return match.group(1).strip() if match else text
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
            elif node.type == "fileInput":
                from backend.workspace import read_project_file
                result = read_project_file(node.data.get("path", ""))
            elif node.type == "template":
                template = node.data.get("template", "")

                # Explicit inputs owned by the Template node.
                declared_inputs = {
                    str(item.get("name", "")).strip()
                    for item in node.data.get("inputs", [])
                    if isinstance(item, dict) and str(item.get("name", "")).strip()
                }

                # Find variables referenced by {{variable}} in the template.
                variables = {
                    match.group(1).strip()
                    for match in re.finditer(r"{{\s*([^}]+?)\s*}}", template)
                }

                # Template references an input that hasn't been declared.
                undefined_variables = variables - declared_inputs
                if undefined_variables:
                    raise WorkflowError(
                        "Template references undefined input(s): "
                        + ", ".join(sorted(undefined_variables))
                    )

                # Template references an input that has no incoming connection.
                missing_inputs = variables - set(inputs.keys())
                if missing_inputs:
                    raise WorkflowError(
                        "Template input(s) not connected: "
                        + ", ".join(sorted(missing_inputs))
                    )

                # Replace variables with their connected values.
                result = re.sub(
                    r"{{\s*([^}]+?)\s*}}",
                    lambda m: str(inputs[m.group(1).strip()]),
                    template,
                )
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
                config = node.data; profile = db.get_provider(config.get("provider", "")) if config.get("provider") else None
                if config.get("provider") and not profile: raise WorkflowError(f"Provider '{config['provider']}' no longer exists.")
                model = profile["model_id"] if profile else config.get("model", "")
                # Preserve every exposed sampling override. Standard OpenAI fields
                # are understood by normal /chat/completions servers; the remaining
                # fields are intentionally passed through for OpenAI-compatible
                # gateways such as the user's custom router.
                options = {}
                for key in ("temperature", "top_p", "top_k", "min_p", "repetition_penalty", "presence_penalty", "frequency_penalty"):
                    if config.get(key) not in (None, ""):
                        try:
                            options[key] = float(config[key])
                        except (TypeError, ValueError):
                            raise WorkflowError(f"{key} must be a number.")
                raw_max_tokens = config.get("max_tokens", config.get("maxTokens"))
                if raw_max_tokens not in (None, ""):
                    try:
                        max_tokens = int(raw_max_tokens)
                        if max_tokens <= 0: raise ValueError
                        options["max_tokens"] = max_tokens
                    except (TypeError, ValueError):
                        raise WorkflowError("Max tokens must be a positive whole number.")
                result, usage = await chat({"model": model, "messages": [{"role":"system","content":config.get("systemPrompt", "")}, {"role":"user","content":str(prompt)}], **options}, profile)
                states[node_id]["provider"] = profile["alias"] if profile else "Default"
                states[node_id]["model"] = model
                if usage: states[node_id]["usage"] = usage
            elif node.type == "output": result = str(inputs.get("text", ""))
            else: raise WorkflowError(f"Unknown node type '{node.type}'.")
            outputs[node_id] = result; states[node_id] = {"status": "success", "preview": str(result)[:180]}
        except Exception as error:
            states[node_id] = {"status": "error", "error": str(error)}; raise WorkflowError(f"{node_id}: {error}") from error
    return states, outputs
