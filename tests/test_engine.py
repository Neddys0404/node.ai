import pytest
from backend.engine import validate_and_order, transform, execute, WorkflowError
from backend.models import WorkflowGraph

def graph(nodes, edges=[]): return WorkflowGraph(nodes=nodes, edges=edges)
def node(id, type, data={}): return {"id":id,"type":type,"data":data}
def edge(source,target,targetHandle="text"): return {"source":source,"target":target,"targetHandle":targetHandle}

def test_order_and_cycle_detection():
    assert validate_and_order(graph([node("a","textInput"),node("b","output")],[edge("a","b")])) == ["a","b"]
    with pytest.raises(WorkflowError): validate_and_order(graph([node("a","output"),node("b","output")],[edge("a","b"),edge("b","a")]))
def test_transforms():
    assert transform("  x  ", {"operation":"trim"}) == "x"
    assert transform("```py\nx=1\n```", {"operation":"first_code_block"}) == "x=1"
@pytest.mark.asyncio
async def test_template_propagates_text():
    states, result = await execute(graph([node("a","textInput",{"text":"world"}),node("b","template",{"template":"Hello {{name}}"})],[edge("a","b","name")]))
    assert result["b"] == "Hello world" and states["b"]["status"] == "success"
@pytest.mark.asyncio
async def test_condition_routes_only_matching_handle():
    states, result = await execute(graph([node("a","textInput",{"text":"CRITICAL issue"}),node("c","condition",{"condition":"contains","value":"CRITICAL"}),node("yes","output")],[edge("a","c"),{"source":"c","target":"yes","sourceHandle":"true","targetHandle":"text"}]))
    assert states["c"]["branch"] == "true" and result["yes"] == "CRITICAL issue"
