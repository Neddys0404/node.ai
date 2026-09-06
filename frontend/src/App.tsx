import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useUpdateNodeInternals,
  type Connection,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import nodeAiMark from "./node-ai-mark.svg";

// ─── Types ────────────────────────────────────────────────────────────────────

type Provider = {
  id: number;
  alias: string;
  endpoint: string;
  model_id: string;
  has_api_key: boolean;
};
type D = Record<string, any> & {
  onChange?: (id: string, p: any) => void;
  onDelete?: (id: string) => void;
  onInput?: (id: string) => void;
  onOutput?: (id: string) => void;
  providers?: Provider[];
};
type W = Node<D>;

// ─── Constants ────────────────────────────────────────────────────────────────

const HANDLE_STYLE = {
  width: 10,
  height: 10,
  background: "#69d2a5",
  border: "2px solid #10141b",
  borderRadius: "50%",
};

const NODE_TYPES_LIST = [
  "textInput",
  "fileInput",
  "llm",
  "template",
  "append",
  "transform",
  "condition",
  "resultOutput",
] as const;

type NodeTypeName = (typeof NODE_TYPES_LIST)[number];

const NODE_LABELS: Record<NodeTypeName, string> = {
  textInput: "Text Input",
  fileInput: "File Input",
  llm: "LLM Task",
  template: "Template",
  append: "Append",
  transform: "Transform",
  condition: "Condition",
  resultOutput: "Output",
};

// SVG icons for node types — 16×16 viewBox, currentColor
const NODE_SVG_ICONS: Record<NodeTypeName, React.ReactNode> = {
  textInput: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12.5h10M3 3.5h4M5 3.5v9M10 6l3 3-3 3M13 9H8"/>
    </svg>
  ),
  fileInput: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 2H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6L9 2z"/>
      <path d="M9 2v4h4M5 9h6M5 11.5h4"/>
    </svg>
  ),
  llm: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="12" height="8" rx="1.5"/>
      <path d="M5 8h.01M8 8h.01M11 8h.01M5 2v2M8 2v2M11 2v2M5 12v2M8 12v2M11 12v2"/>
    </svg>
  ),
  template: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="12" height="12" rx="1.5"/>
      <path d="M2 6h12M6 6v8"/>
    </svg>
  ),
  append: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6"/>
      <path d="M8 5v6M5 8h6"/>
    </svg>
  ),
  transform: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="2.5"/>
      <path d="M8 2v1.5M8 12.5V14M2 8h1.5M12.5 8H14M3.93 3.93l1.06 1.06M11.01 11.01l1.06 1.06M3.93 12.07l1.06-1.06M11.01 4.99l1.06-1.06"/>
    </svg>
  ),
  condition: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 8h4l2-4 2 4 2-4 2 4"/>
      <circle cx="14" cy="8" r="1"/>
    </svg>
  ),
  resultOutput: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="12" height="10" rx="1.5"/>
      <path d="M5 7.5h6M5 10h4"/>
      <path d="M10 5.5l2 2-2 2" strokeWidth="1.2"/>
    </svg>
  ),
};

const preview = (s: string, n = 28) => {
  const words = s.trim().split(/\s+/);
  return words.length > n ? words.slice(0, n).join(" ") + " …" : s;
};

const BASE_NODES: any[] = [
  {
    id: "input",
    type: "textInput",
    position: { x: 60, y: 200 },
    data: { label: "TEXT INPUT", text: "Review this code for problems." },
  },
  {
    id: "llm",
    type: "llm",
    position: { x: 370, y: 140 },
    data: {
      label: "LLM TASK",
      model: "gemma-4-12b",
      systemPrompt: "You are a careful software reviewer.",
    },
  },
  {
    id: "out",
    type: "resultOutput",
    position: { x: 700, y: 200 },
    data: { label: "OUTPUT" },
  },
];

const BASE_EDGES: any[] = [
  { id: "e1", source: "input", target: "llm", targetHandle: "prompt" },
  { id: "e2", source: "llm", target: "out" },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

const safeJson = async (r: Response) => {
  const text = await r.text();
  return text ? JSON.parse(text) : {};
};

function createInputId() {
  return `input_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

// VSCode-style file type icons
function FileIcon({ name }: { name: string }) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const base: React.CSSProperties = { width: 14, height: 14, flexShrink: 0 };

  if (ext === "tsx" || ext === "jsx")
    return <svg style={base} viewBox="0 0 14 14"><rect width="14" height="14" rx="2" fill="#1d9fd8"/><text x="7" y="10.5" textAnchor="middle" fontSize="7" fontWeight="700" fill="white" fontFamily="monospace">TS</text></svg>;
  if (ext === "ts")
    return <svg style={base} viewBox="0 0 14 14"><rect width="14" height="14" rx="2" fill="#3178c6"/><text x="7" y="10.5" textAnchor="middle" fontSize="7" fontWeight="700" fill="white" fontFamily="monospace">TS</text></svg>;
  if (ext === "js" || ext === "mjs")
    return <svg style={base} viewBox="0 0 14 14"><rect width="14" height="14" rx="2" fill="#f0d040"/><text x="7" y="10.5" textAnchor="middle" fontSize="7" fontWeight="700" fill="#1a1a1a" fontFamily="monospace">JS</text></svg>;
  if (ext === "css" || ext === "scss")
    return <svg style={base} viewBox="0 0 14 14"><rect width="14" height="14" rx="2" fill="#6a4fc8"/><text x="7" y="10.5" textAnchor="middle" fontSize="7" fontWeight="700" fill="white" fontFamily="monospace">CSS</text></svg>;
  if (ext === "json")
    return <svg style={base} viewBox="0 0 14 14" fill="none" stroke="#e5c07b" strokeWidth="1.4" strokeLinecap="round"><path d="M4 5c-1 0-1.5.5-1.5 1.5v1c0 .6-.4 1-1 1 .6 0 1 .4 1 1v1c0 1 .5 1.5 1.5 1.5M10 5c1 0 1.5.5 1.5 1.5v1c0 .6.4 1 1 1-.6 0-1 .4-1 1v1c0 1-.5 1.5-1.5 1.5"/></svg>;
  if (ext === "md")
    return <svg style={base} viewBox="0 0 14 14" fill="none" stroke="#78c5e0" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="2" width="12" height="10" rx="1.5"/><path d="M3.5 9.5V4.5l2.5 3 2.5-3v5M10.5 7H9"/></svg>;
  if (ext === "html")
    return <svg style={base} viewBox="0 0 14 14" fill="none" stroke="#e06c75" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M2 2l1.5 10L7 13.5 10.5 12 12 2H2zM4.5 5h5l-.4 3.5L7 9.5l-2.1-.8-.15-1.7H6l.1.8.9.35.9-.35.15-1.3H4.5z"/></svg>;
  if (ext === "py")
    return <svg style={base} viewBox="0 0 14 14" fill="none" stroke="#4b8bbe" strokeWidth="1.3" strokeLinecap="round"><path d="M7 1.5C4.5 1.5 4 2.5 4 4v1.5h3v.5H2.5C1.5 6 1 6.8 1 8.5s.6 2.5 1.5 2.5H4V9.5c0-1.1.8-2 2-2h4c1 0 1.5-.7 1.5-1.5v-2C11.5 2.5 11 1.5 7 1.5z"/><path d="M7 12.5c2.5 0 3-1 3-2.5V8.5H7V8H11.5c1 0 1.5-.8 1.5-2.5s-.6-2.5-1.5-2.5H10V4.5c0 1.1-.8 2-2 2H4c-1 0-1.5.7-1.5 1.5v2c0 1.5.5 2.5 4.5 2.5z" stroke="#ffe873"/></svg>;
  if (ext === "yaml" || ext === "yml")
    return <svg style={base} viewBox="0 0 14 14" fill="none" stroke="#a070c0" strokeWidth="1.4" strokeLinecap="round"><path d="M7 2v5M4 2l3 5 3-5M4 10h6M7 10v2"/></svg>;
  if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "gif" || ext === "svg" || ext === "webp")
    return <svg style={base} viewBox="0 0 14 14" fill="none" stroke="#98c379" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="2" width="12" height="10" rx="1.5"/><circle cx="4.5" cy="5" r="1"/><path d="M1 9l3.5-3 3 3 2-2 3.5 3.5"/></svg>;

  // generic file
  return <svg style={base} viewBox="0 0 14 14" fill="none" stroke="#7a9cb0" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M8 1.5H3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5L8 1.5z"/><path d="M8 1.5V5.5h3"/></svg>;
}

function FolderIcon({ open }: { open: boolean }) {
  return open
    ? <svg style={{ width: 14, height: 14, flexShrink: 0 }} viewBox="0 0 14 14" fill="#e8b84b" stroke="none"><path d="M1 4a1 1 0 0 1 1-1h3l1.5 1.5H12a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4z"/></svg>
    : <svg style={{ width: 14, height: 14, flexShrink: 0 }} viewBox="0 0 14 14" fill="none" stroke="#c09040" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M1 4a1 1 0 0 1 1-1h3l1.5 1.5H12a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4z"/></svg>;
}

const isTyping = () =>
  ["INPUT", "TEXTAREA", "SELECT"].includes(
    (document.activeElement as HTMLElement)?.tagName || ""
  );

const statusColor = (state: string) => {
  if (state === "success") return "#69d2a5";
  if (state === "error") return "#ef6969";
  if (state === "running" || state === "waiting") return "#f0c36d";
  if (state === "cancelled") return "#8290a2";
  return "#4a5568";
};

// ─── Node Card ────────────────────────────────────────────────────────────────

function NodeCard({ id, data, type, selected }: NodeProps<W> & { type: string }) {
  const { setEdges } = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();

  const [sysOpen, setSysOpen] = useState(false);
  const set = (p: any) => data.onChange?.(id, p);
  const state = data.state || "idle";
  const collapsed = data.collapsed;
  const isOutput = type === "resultOutput";

  const dotColor = statusColor(state);

  return (
    <div
      style={{
        width: isOutput ? 280 : 252,
        background: "#1a2233",
        border: `1px solid ${selected ? "#69d2a5" : "#2d3d54"}`,
        borderRadius: 10,
        boxShadow: selected
          ? "0 0 0 2px #69d2a540, 0 8px 32px #0006"
          : "0 4px 20px #0004",
        color: "#d8e4f0",
        overflow: "visible",
        fontFamily: "Inter, ui-sans-serif, sans-serif",
      }}
    >
      {/* Node Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "8px 10px",
          borderRadius: "10px 10px 0px 0px",
          background: "#151e2e",
          borderBottom: collapsed ? "none" : "1px solid #243047",
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: dotColor,
            flexShrink: 0,
            transition: "background 0.2s",
            ...(state === "running" || state === "waiting"
              ? { animation: "pulse 1s infinite" }
              : {}),
          }}
        />
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.6px",
            textTransform: "uppercase",
            flex: 1,
            color: "#a8bcce",
          }}
        >
          {data.label || NODE_LABELS[type as NodeTypeName] || type}
        </span>
        <button
          className="nodrag"
          onClick={() => set({ collapsed: !collapsed })}
          style={{
            background: "none",
            border: "none",
            color: "#5a7a96",
            cursor: "pointer",
            padding: "0 3px",
            fontSize: 13,
            lineHeight: 1,
          }}
        >
          {collapsed ? "+" : "−"}
        </button>
        <button
          className="nodrag"
          onClick={() => data.onDelete?.(id)}
          style={{
            background: "none",
            border: "none",
            color: "#774444",
            cursor: "pointer",
            padding: "0 2px",
            fontSize: 14,
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </div>

      {/* Collapsed State */}
      {collapsed ? (
        <div style={{ padding: "7px 10px", fontSize: 11, color: "#7a8fa3" }}>
          {isOutput && data.result
            ? String(data.result).length.toLocaleString() + " chars"
            : state}
        </div>
      ) : (
        <div style={{ padding: "10px 10px 8px" }}>
          {/* TEXT INPUT */}
          {type === "textInput" && (
            <>
              <div
                style={{
                  whiteSpace: "pre-wrap",
                  fontSize: 11,
                  lineHeight: 1.5,
                  color: "#9ab5c8",
                  minHeight: 44,
                  marginBottom: 8,
                  padding: "6px 8px",
                  background: "#111827",
                  borderRadius: 6,
                  border: "1px solid #243047",
                }}
              >
                {preview(data.text || "")}
              </div>
              <NodeBtn onClick={() => data.onInput?.(id)}>
                Open Editor
              </NodeBtn>
            </>
          )}

          {/* FILE INPUT */}
          {type === "fileInput" && (
            <>
              <NodeInput
                value={data.path || ""}
                onChange={(v) => set({ path: v })}
                placeholder="prompts/research.md"
              />
              <small style={{ color: "#66788a", fontSize: 10 }}>
                Read from project at runtime
              </small>
            </>
          )}

          {/* TEMPLATE */}
          {type === "template" && (
            <>
              <NodeTextarea
                value={data.template || ""}
                onChange={(v) => set({ template: v })}
                placeholder="Use {{variable}}"
              />

              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                  marginTop: 8,
                }}
              >
                {/* Input header */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 2,
                  }}
                >
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      color: "#8fa6ba",
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                    }}
                  >
                    Inputs
                  </span>

                  <Btn
                    className="nodrag"
                    onClick={(e) => {
                      e.stopPropagation();

                      const currentInputs = Array.isArray(data.inputs)
                        ? data.inputs
                        : [];

                      let index = 1;
                      let newName = `input_${index}`;

                      while (
                        currentInputs.some(
                          (input: { name: string }) => input.name === newName
                        )
                      ) {
                        index++;
                        newName = `input_${index}`;
                      }

                      set({
                        inputs: [
                          ...currentInputs,
                          {
                            id: createInputId(),
                            name: newName,
                          },
                        ],
                      });

                      requestAnimationFrame(() => {
                        updateNodeInternals(id);
                      });
                    }}
                    style={{
                      padding: "2px 6px",
                      fontSize: 10,
                    }}
                  >
                    + Add Input
                  </Btn>
                </div>

                {/* Dynamic inputs */}
                {(Array.isArray(data.inputs) ? data.inputs : []).map(
                  (input: { id: string; name: string }, idx: number) => (
                    <div
                      key={input.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        minHeight: 24,
                        position: "relative",
                      }}
                    >
                      <Handle
                        type="target"
                        position={Position.Left}
                        id={input.name}
                        style={{
                          ...HANDLE_STYLE,

                          // Push the handle from the input row
                          // all the way to the node's left edge.
                          left: -15,

                          // Keep it vertically centered with this input row.
                          top: "50%",
                          transform: "translateY(-50%)",

                          // Make sure the handle is rendered above
                          // the node border/background.
                          zIndex: 10,
                        }}
                      />

                      <input
                        className="nodrag"
                        value={input.name}
                        onChange={(e) => {
                          const newName = e.target.value;
                          const oldName = input.name;

                          const newInputs = data.inputs.map(
                            (item: { id: string; name: string }) =>
                              item.id === input.id
                                ? { ...item, name: newName }
                                : item
                          );

                          set({ inputs: newInputs });

                          if (
                            oldName !== newName &&
                            newName &&
                            /^[A-Za-z_][A-Za-z0-9_-]*$/.test(newName)
                          ) {
                            setEdges((edges) =>
                              edges.map((edge) =>
                                edge.target === id &&
                                edge.targetHandle === oldName
                                  ? {
                                      ...edge,
                                      targetHandle: newName,
                                    }
                                  : edge
                              )
                            );

                            requestAnimationFrame(() => {
                              updateNodeInternals(id);
                            });
                          }
                        }}
                        style={{
                          flex: 1,
                          minWidth: 0,
                        }}
                      />

                      <button
                        className="nodrag"
                        onClick={(e) => {
                          e.stopPropagation();

                          const inputName = input.name;

                          set({
                            inputs: data.inputs.filter(
                              (item: { id: string }) => item.id !== input.id
                            ),
                          });

                          setEdges((edges) =>
                            edges.filter(
                              (edge) =>
                                !(
                                  edge.target === id &&
                                  edge.targetHandle === inputName
                                )
                            )
                          );

                          requestAnimationFrame(() => {
                            updateNodeInternals(id);
                          });
                        }}
                      >
                        ×
                      </button>
                    </div>
                  )
                )}
              </div>
            </>
          )}
          {/* APPEND */}

          {/* APPEND */}
          {type === "append" && (
            <>
              <NodeInput
                value={data.prefix || ""}
                onChange={(v) => set({ prefix: v })}
                placeholder="Prefix"
              />
              <NodeInput
                value={data.suffix || ""}
                onChange={(v) => set({ suffix: v })}
                placeholder="Suffix"
              />
            </>
          )}

          {/* TRANSFORM */}
          {type === "transform" && (
            <>
              <NodeSelect
                value={data.operation || "trim"}
                onChange={(v) => set({ operation: v })}
                options={[
                  "trim",
                  "prepend",
                  "append",
                  "replace",
                  "regex_replace",
                  "strip_fences",
                  "first_code_block",
                  "extract_json",
                ]}
              />
              <NodeInput
                value={data.value || data.find || ""}
                onChange={(v) =>
                  set(
                    data.operation?.includes("replace")
                      ? { find: v }
                      : { value: v }
                  )
                }
                placeholder="Value"
              />
            </>
          )}

          {/* CONDITION */}
          {type === "condition" && (
            <>
              <NodeSelect
                value={data.condition || "contains"}
                onChange={(v) => set({ condition: v })}
                options={[
                  "contains",
                  "equals",
                  "starts_with",
                  "ends_with",
                  "regex",
                ]}
              />
              <NodeInput
                value={data.value || ""}
                onChange={(v) => set({ value: v })}
                placeholder="Match value"
              />
            </>
          )}

          {/* LLM */}
          {type === "llm" && (
            <>
              <NodeSelect
                value={data.provider || ""}
                onChange={(v) => set({ provider: v })}
                options={["", ...(data.providers || []).map((p: Provider) => p.alias)]}
                labels={[
                  "Default endpoint",
                  ...(data.providers || []).map(
                    (p: Provider) => `${p.alias} · ${p.model_id}`
                  ),
                ]}
              />
              {!data.provider && (
                <NodeInput
                  value={data.model || ""}
                  onChange={(v) => set({ model: v })}
                  placeholder="Model ID"
                />
              )}
              <NodeBtn onClick={() => setSysOpen(!sysOpen)}>
                System prompt {sysOpen ? "▲" : "▼"}
              </NodeBtn>
              {sysOpen && (
                <NodeTextarea
                  value={data.systemPrompt || ""}
                  onChange={(v) => set({ systemPrompt: v })}
                  placeholder="System instructions…"
                />
              )}
              <details style={{ marginTop: 4 }}>
                <summary
                  style={{ fontSize: 10, color: "#66788a", cursor: "pointer" }}
                >
                  Sampling parameters
                </summary>
                <div style={{ marginTop: 6 }}>
                  {(
                    [
                      ["temperature", 0.7],
                      ["top_p", 0.95],
                      ["max_tokens", 4096],
                    ] as [string, number][]
                  ).map(([k, v]) => (
                    <label
                      key={k}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        fontSize: 10,
                        color: "#8099af",
                        marginBottom: 4,
                      }}
                    >
                      {k}
                      <input
                        type="number"
                        value={data[k] ?? v}
                        onChange={(e) => set({ [k]: Number(e.target.value) })}
                        className="nodrag"
                        style={{
                          width: 68,
                          background: "#111827",
                          border: "1px solid #243047",
                          color: "#c8dce8",
                          borderRadius: 4,
                          padding: "3px 6px",
                          fontSize: 11,
                          fontFamily: "inherit",
                        }}
                      />
                    </label>
                  ))}
                </div>
              </details>
            </>
          )}

          {/* OUTPUT */}
          {isOutput && (
            <>
              {["running", "waiting"].includes(state) ? (
                <div
                  style={{
                    textAlign: "center",
                    color: "#f0c36d",
                    padding: "16px 8px",
                    fontSize: 12,
                  }}
                >
                  ◌ Running…
                </div>
              ) : (
                <div
                  style={{
                    fontSize: 11,
                    lineHeight: 1.5,
                    maxHeight: 140,
                    overflowY: "auto",
                    whiteSpace: "pre-wrap",
                    color: data.result ? "#b0ccdd" : "#55738a",
                    padding: "8px",
                    background: "#111827",
                    borderRadius: 6,
                    border: "1px solid #243047",
                    marginBottom: 8,
                    minHeight: 52,
                  }}
                >
                  {data.result
                    ? preview(String(data.result), 70)
                    : "Final response appears here."}
                </div>
              )}
              <NodeBtn onClick={() => data.onOutput?.(id)}>
                Open Viewer / Export
              </NodeBtn>
            </>
          )}

          {/* Error */}
          {data.error && (
            <details style={{ marginTop: 6 }}>
              <summary
                style={{ fontSize: 10, color: "#ef9090", cursor: "pointer" }}
              >
                {data.error.slice(0, 60)}
              </summary>
              <pre
                style={{
                  fontSize: 10,
                  color: "#ef9090",
                  whiteSpace: "pre-wrap",
                  marginTop: 4,
                }}
              >
                {data.error}
              </pre>
            </details>
          )}
        </div>
      )}

      {/* Handles */}
      {!["textInput", "fileInput", "template"].includes(type) && (
        <Handle
          type="target"
          position={Position.Left}
          id={type === "llm" ? "prompt" : "text"}
          style={HANDLE_STYLE}
        />
      )}
      {type === "condition" ? (
        <>
          <Handle
            type="source"
            position={Position.Right}
            id="true"
            style={{ ...HANDLE_STYLE, top: "40%" }}
          />
          <Handle
            type="source"
            position={Position.Right}
            id="false"
            style={{ ...HANDLE_STYLE, top: "68%" }}
          />
        </>
      ) : (
        <Handle
          type="source"
          position={Position.Right}
          id="text"
          style={HANDLE_STYLE}
        />
      )}
    </div>
  );
}

// ─── Small node form components ───────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "#111827",
  border: "1px solid #243047",
  color: "#c8dce8",
  borderRadius: 5,
  padding: "6px 8px",
  fontSize: 11,
  fontFamily: "inherit",
  marginBottom: 6,
  outline: "none",
};

function NodeInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      className="nodrag"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={inputStyle}
    />
  );
}

function NodeTextarea({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <textarea
      className="nodrag"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{ ...inputStyle, resize: "vertical", minHeight: 60, marginBottom: 6 }}
    />
  );
}

function NodeSelect({
  value,
  onChange,
  options,
  labels,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  labels?: string[];
}) {
  return (
    <select
      className="nodrag"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={inputStyle}
    >
      {options.map((o, i) => (
        <option key={o} value={o}>
          {labels?.[i] ?? o}
        </option>
      ))}
    </select>
  );
}

function NodeBtn({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className="nodrag"
      onClick={onClick}
      style={{
        width: "100%",
        textAlign: "left",
        background: "#192335",
        border: "1px solid #2a3c52",
        color: "#8fb4cc",
        borderRadius: 5,
        padding: "6px 9px",
        fontSize: 11,
        cursor: "pointer",
        marginBottom: 5,
        fontFamily: "inherit",
      }}
    >
      {children}
    </button>
  );
}

// ─── nodeTypes map ─────────────────────────────────────────────────────────────

const nodeTypes = Object.fromEntries(
  NODE_TYPES_LIST.map((type) => [
    type,
    (p: NodeProps<W>) => <NodeCard {...p} type={type} />,
  ])
) as any;

// ─── Markdown renderer ────────────────────────────────────────────────────────

function Markdown({ text }: { text: string }) {
  return (
    <article style={{ fontSize: 13, lineHeight: 1.6, color: "#c0d5e5" }}>
      {text.split("\n").map((x, i) =>
        x.startsWith("### ") ? (
          <h3 key={i} style={{ margin: "10px 0 4px", color: "#e2edf6" }}>
            {x.slice(4)}
          </h3>
        ) : x.startsWith("## ") ? (
          <h2 key={i} style={{ margin: "12px 0 4px", color: "#e2edf6" }}>
            {x.slice(3)}
          </h2>
        ) : x.startsWith("# ") ? (
          <h1 key={i} style={{ margin: "14px 0 4px", color: "#e2edf6" }}>
            {x.slice(2)}
          </h1>
        ) : x.startsWith("> ") ? (
          <blockquote
            key={i}
            style={{
              borderLeft: "3px solid #69d2a5",
              paddingLeft: 10,
              margin: "4px 0",
              color: "#8cafc4",
            }}
          >
            {x.slice(2)}
          </blockquote>
        ) : x.startsWith("- ") ? (
          <li key={i} style={{ marginLeft: 16, marginBottom: 2 }}>
            {x.slice(2)}
          </li>
        ) : (
          <p key={i} style={{ margin: "3px 0" }}>
            {x || " "}
          </p>
        )
      )}
    </article>
  );
}

// ─── Modal ────────────────────────────────────────────────────────────────────

function Modal({
  title,
  close,
  children,
  wide,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 40,
        background: "#00000088",
        display: "grid",
        placeItems: "center",
        backdropFilter: "blur(2px)",
      }}
      onClick={(e) => e.target === e.currentTarget && close()}
    >
      <div
        style={{
          width: wide ? "min(860px, 92vw)" : "min(640px, 92vw)",
          maxHeight: "88vh",
          overflowY: "auto",
          background: "#15202e",
          border: "1px solid #2d4060",
          borderRadius: 12,
          boxShadow: "0 24px 64px #0009",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            padding: "14px 18px",
            borderBottom: "1px solid #243047",
            flexShrink: 0,
          }}
        >
          <span style={{ fontWeight: 700, fontSize: 14, color: "#dceaf6" }}>
            {title}
          </span>
          <button
            onClick={close}
            style={{
              marginLeft: "auto",
              background: "none",
              border: "none",
              color: "#55738a",
              fontSize: 18,
              cursor: "pointer",
              lineHeight: 1,
              padding: "0 2px",
            }}
          >
            ×
          </button>
        </div>
        <div style={{ padding: "18px", overflowY: "auto" }}>{children}</div>
      </div>
    </div>
  );
}

// ─── Common button ────────────────────────────────────────────────────────────

function Btn({
  onClick,
  children,
  variant = "default",
  small,
  title,
  disabled,
}: {
  onClick?: () => void;
  children: React.ReactNode;
  variant?: "default" | "primary" | "danger" | "ghost";
  small?: boolean;
  title?: string;
  disabled?: boolean;
}) {
  const styles: Record<string, React.CSSProperties> = {
    default: {
      background: "#1e2d3f",
      border: "1px solid #2d4060",
      color: "#a8bfd6",
    },
    primary: {
      background: "#1e6b50",
      border: "1px solid #2ea87c",
      color: "#b6f0d8",
    },
    danger: {
      background: "#2c1f1f",
      border: "1px solid #6b3030",
      color: "#f4a0a0",
    },
    ghost: { background: "transparent", border: "1px solid transparent", color: "#6a8fa8" },
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        ...styles[variant],
        padding: small ? "4px 9px" : "6px 12px",
        borderRadius: 6,
        fontSize: small ? 11 : 12,
        cursor: disabled ? "not-allowed" : "pointer",
        fontFamily: "inherit",
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        opacity: disabled ? 0.45 : 1,
        transition: "opacity 0.15s, border-color 0.15s",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

// ─── Workspace (project explorer) ────────────────────────────────────────────

function Tree({
  item,
  open,
  remove,
  depth = 0,
}: {
  item: any;
  open: (p: string) => void;
  remove: (p: string) => void;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState(true);
  const indent = depth * 12;

  const rowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    paddingLeft: indent + 2,
    paddingRight: 4,
    height: 24,
    borderRadius: 4,
    cursor: "pointer",
    position: "relative",
    userSelect: "none",
  };

  const chevron = (
    <svg
      viewBox="0 0 10 10"
      style={{
        width: 10,
        height: 10,
        flexShrink: 0,
        marginRight: 2,
        transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 0.12s ease",
        color: "#5a7a90",
      }}
      fill="currentColor"
    >
      <path d="M3 2l4 3-4 3V2z"/>
    </svg>
  );

  const btnStyle: React.CSSProperties = {
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: 0,
    fontFamily: "inherit",
    textAlign: "left",
  };

  if (item.directory) {
    return (
      <div>
        <div
          style={rowStyle}
          onClick={() => setExpanded((v) => !v)}
          onMouseEnter={(e) => (e.currentTarget.style.background = "#1a2d40")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          {chevron}
          <FolderIcon open={expanded} />
          <span style={{ marginLeft: 5, fontSize: 12, color: "#c8dce8", flex: 1 }}>
            {item.name}
          </span>
          <button
            onClick={(e) => { e.stopPropagation(); remove(item.path); }}
            style={{ ...btnStyle, color: "#6b3030", fontSize: 13, padding: "0 2px", opacity: 0.7 }}
            title="Delete"
          >
            ×
          </button>
        </div>
        {expanded && (
          <div style={{ position: "relative" }}>
            {/* Indent guide line */}
            <div style={{
              position: "absolute",
              left: indent + 9,
              top: 0,
              bottom: 0,
              width: 1,
              background: "#243047",
              pointerEvents: "none",
            }} />
            {item.children.map((x: any) => (
              <Tree key={x.path} item={x} open={open} remove={remove} depth={depth + 1} />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      style={rowStyle}
      onClick={() => open(item.path)}
      onMouseEnter={(e) => (e.currentTarget.style.background = "#1a2d40")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      {/* spacer matching chevron width */}
      <span style={{ width: 12, flexShrink: 0 }} />
      <FileIcon name={item.name} />
      <span style={{ marginLeft: 5, fontSize: 12, color: "#a8c4d8", flex: 1 }}>
        {item.name}
      </span>
      <button
        onClick={(e) => { e.stopPropagation(); remove(item.path); }}
        style={{ ...btnStyle, color: "#6b3030", fontSize: 13, padding: "0 2px", opacity: 0 }}
        className="tree-del"
        title="Delete"
      >
        ×
      </button>
    </div>
  );
}

function Highlight({ text, path }: { text: string; path: string }) {
  const ext = path.split(".").pop() || "";
  const tokens = text.split(
    /(\/\/.*|#.*|\b(?:def|class|function|return|const|let|var|if|else|for|while|import|from|async|await|true|false|null|None)\b|"[^"]*"|'[^']*'|\b\d+(?:\.\d+)?\b)/g
  );
  return (
    <pre
      style={{
        margin: 0,
        background: "#0d1520",
        borderRadius: 6,
        padding: 10,
        overflowX: "auto",
        fontFamily: "ui-monospace, monospace",
        fontSize: 11,
        lineHeight: 1.5,
        color: "#c5d8e8",
        height: "100%",
      }}
      data-language={ext}
    >
      {tokens.map((x, i) => (
        <span
          key={i}
          style={{
            color:
              x.startsWith("//") || x.startsWith("#")
                ? "#55728a"
                : /^['"]/.test(x)
                  ? "#d9aa73"
                  : /^\d/.test(x)
                    ? "#91c8e8"
                    : /^(def|class|function|return|const|let|var|if|else|for|while|import|from|async|await|true|false|null|None)$/.test(x)
                      ? "#b58bea"
                      : "inherit",
          }}
        >
          {x}
        </span>
      ))}
    </pre>
  );
}

function Workspace({
  tree,
  refresh,
  file,
  setFile,
  notify,
  onClose,
}: {
  tree: any[];
  refresh: () => void;
  file: any;
  setFile: (x: any) => void;
  notify: (s: string) => void;
  onClose: () => void;
}) {
  const [treeWidth, setTreeWidth] = useState(210);
  const [workspaceWidth, setWorkspaceWidth] = useState(760);
  const [savedIndicator, setSavedIndicator] = useState(false);
  const dragRef = useRef<{ x: number; w: number } | null>(null);
  const workspaceDragRef = useRef<{ x: number; w: number } | null>(null);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { x: e.clientX, w: treeWidth };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const next = Math.max(140, Math.min(480, dragRef.current.w + ev.clientX - dragRef.current.x));
      setTreeWidth(next);
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const startWorkspaceResize = (e: React.MouseEvent) => {
    e.preventDefault();
    workspaceDragRef.current = { x: e.clientX, w: workspaceWidth };
    const onMove = (ev: MouseEvent) => {
      if (!workspaceDragRef.current) return;
      // The panel is anchored on the right, so dragging left makes it wider.
      const next = workspaceDragRef.current.w + workspaceDragRef.current.x - ev.clientX;
      setWorkspaceWidth(Math.max(480, Math.min(window.innerWidth * 0.92, next)));
    };
    const onUp = () => {
      workspaceDragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const openFile = (path: string) =>
    fetch("/api/project/file?path=" + encodeURIComponent(path))
      .then((r) => r.json())
      .then(setFile);
  const removeFile = async (path: string) => {
    if (!confirm("Delete " + path + "?")) return;
    const r = await fetch(
      "/api/project/file?path=" + encodeURIComponent(path),
      { method: "DELETE" }
    );
    const b = await r.json();
    if (!r.ok) return alert(b.detail);
    if (file?.path === path) setFile(null);
    notify("✓ File deleted");
    refresh();
  };
  const createFile = () => {
    const p = prompt("Project relative path");
    if (p)
      fetch("/api/project/file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: p, content: "" }),
      }).then(() => {
        notify("✓ File created");
        refresh();
      });
  };
  const openFolder = async () => {
    let r = await fetch("/api/project/pick-folder", { method: "POST" });
    let b = await safeJson(r);
    if (r.ok && !b.cancelled) {
      setFile(null);
      return refresh();
    }
    const path = prompt(
      "Enter a folder path on the Node.AI server/device"
    );
    if (!path) return;
    r = await fetch("/api/project/open-folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    b = await safeJson(r);
    if (!r.ok) return alert(b.detail);
    setFile(null);
    refresh();
  };

  return (
    <div
      style={{
        position: "absolute",
        zIndex: 10,
        right: 0,
        top: 0,
        bottom: 0,
        width: workspaceWidth,
        maxWidth: "92vw",
        display: "flex",
        flexDirection: "column",
        background: "#12192a",
        borderLeft: "1px solid #273447",
        boxShadow: "-12px 0 36px #0008",
      }}
    >
      {/* Resize the entire project panel from its left edge. */}
      <div
        onMouseDown={startWorkspaceResize}
        title="Drag to resize Project Explorer"
        style={{
          position: "absolute",
          left: -5,
          top: 0,
          bottom: 0,
          width: 10,
          cursor: "col-resize",
          zIndex: 20,
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "#2d6d9f")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      />
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "12px 16px",
          borderBottom: "1px solid #273447",
          gap: 8,
          flexShrink: 0,
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 13, color: "#c0d8e8", flex: 1 }}>
          Project Explorer
        </span>
        <Btn small onClick={openFolder} title="Open a folder">
          Open Folder
        </Btn>
        <Btn small onClick={createFile} title="Create a new file">
          + File
        </Btn>
        <Btn small onClick={refresh} title="Refresh file tree">
          ↻
        </Btn>
        <Btn small variant="ghost" onClick={onClose}>
          ✕
        </Btn>
      </div>

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* Tree */}
        <div
          style={{
            width: treeWidth,
            flexShrink: 0,
            overflowY: "auto",
            padding: "8px 6px",
            borderRight: "1px solid #1f2f40",
            position: "relative",
          }}
        >
          {tree.map((x) => (
            <Tree
              key={x.path}
              item={x}
              open={openFile}
              remove={removeFile}
            />
          ))}
          {!tree.length && (
            <p
              style={{ fontSize: 11, color: "#4a6070", padding: "4px 6px" }}
            >
              No files yet. Open a folder to begin.
            </p>
          )}
        </div>

        {/* Drag resize handle */}
        <div
          onMouseDown={startResize}
          style={{
            width: 5,
            flexShrink: 0,
            cursor: "col-resize",
            background: "transparent",
            position: "relative",
            zIndex: 2,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "#2d4a66")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        />

        {/* Editor */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
            padding: "12px 14px",
            overflowY: "auto",
          }}
        >
          {file ? (
            <>
              <div
                style={{
                  fontSize: 11,
                  color: "#7a9cb0",
                  marginBottom: 10,
                  fontFamily: "ui-monospace, monospace",
                }}
              >
                {file.path}
              </div>
              {file.path.endsWith(".md") ? (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 10,
                    flex: 1,
                    minHeight: 0,
                  }}
                >
                  <textarea
                    value={file.content}
                    onChange={(e) =>
                      setFile({ ...file, content: e.target.value })
                    }
                    style={{
                      ...inputStyle,
                      fontFamily: "ui-monospace, monospace",
                      resize: "none",
                      height: "100%",
                      marginBottom: 0,
                    }}
                  />
                  <Markdown text={file.content} />
                </div>
              ) : (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 10,
                    flex: 1,
                    minHeight: 0,
                  }}
                >
                  <textarea
                    value={file.content}
                    onChange={(e) =>
                      setFile({ ...file, content: e.target.value })
                    }
                    style={{
                      ...inputStyle,
                      fontFamily: "ui-monospace, monospace",
                      resize: "none",
                      height: "100%",
                      marginBottom: 0,
                    }}
                  />
                  <Highlight text={file.content} path={file.path} />
                </div>
              )}
              <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10 }}>
                <Btn
                  onClick={() =>
                    fetch("/api/project/file", {
                      method: "PUT",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify(file),
                    }).then(() => {
                      notify("✓ File saved");
                      setSavedIndicator(true);
                      setTimeout(() => setSavedIndicator(false), 2500);
                    })
                  }
                >
                  Save File
                </Btn>
                {savedIndicator && (
                  <span style={{ fontSize: 11, color: "#69d2a5", display: "flex", alignItems: "center", gap: 4 }}>
                    <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="#69d2a5" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M2 6l3 3 5-5"/>
                    </svg>
                    Saved
                  </span>
                )}
              </div>
            </>
          ) : (
            <p style={{ fontSize: 12, color: "#4a6070" }}>
              Select a file from the explorer to edit it. Markdown files show
              a live preview.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Workflow Picker ──────────────────────────────────────────────────────────

function WorkflowPicker({
  open,
  close,
}: {
  open: (item: any) => void;
  close: () => void;
}) {
  const [items, setItems] = useState<any[]>([]);
  const reload = () =>
    fetch("/api/workflows")
      .then((r) => r.json())
      .then(setItems);
  const remove = async (id: number) => {
    if (!confirm("Delete this saved workflow?")) return;
    await fetch("/api/workflows/" + id, { method: "DELETE" });
    reload();
  };
  useEffect(() => {
    reload();
  }, []);

  return (
    <Modal title="Open Workflow" close={close}>
      {items.length ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {items.map((item) => (
            <div
              key={item.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "10px 12px",
                background: "#111e2d",
                border: "1px solid #243047",
                borderRadius: 7,
              }}
            >
              <div style={{ flex: 1 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: "#c8dce8",
                    marginBottom: 2,
                  }}
                >
                  {item.name}
                </div>
                <div style={{ fontSize: 10, color: "#55738a" }}>
                  Updated {new Date(item.updated_at).toLocaleString()}
                </div>
              </div>
              <Btn small onClick={() => open(item)}>
                Open
              </Btn>
              <Btn small variant="danger" onClick={() => remove(item.id)}>
                Delete
              </Btn>
            </div>
          ))}
        </div>
      ) : (
        <p style={{ fontSize: 12, color: "#55738a" }}>
          No saved workflows yet. Use Save to persist your current workflow.
        </p>
      )}
    </Modal>
  );
}

// ─── Providers ────────────────────────────────────────────────────────────────

function Providers({
  providers,
  refresh,
  close,
}: {
  providers: Provider[];
  refresh: () => void;
  close: () => void;
}) {
  const [form, setForm] = useState<any>({
    alias: "",
    endpoint: "http://localhost:8000/v1",
    model_id: "",
    api_type: "openai",
    api_key: "",
    timeout_seconds: 120,
  });
  const submit = async () => {
    const r = await fetch("/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    if (!r.ok) return alert((await safeJson(r)).detail);
    setForm({ ...form, alias: "", model_id: "", api_key: "" });
    refresh();
  };

  return (
    <Modal title="Models & Providers" close={close} wide>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 10,
          marginBottom: 16,
        }}
      >
        {(
          [
            ["alias", "Name / Alias", "text"],
            ["endpoint", "Endpoint URL", "text"],
            ["model_id", "Model ID", "text"],
            ["api_key", "API Key", "password"],
          ] as [string, string, string][]
        ).map(([k, label, t]) => (
          <label
            key={k}
            style={{ display: "flex", flexDirection: "column", gap: 4 }}
          >
            <span style={{ fontSize: 11, color: "#7a9cb0" }}>{label}</span>
            <input
              type={t}
              value={form[k]}
              onChange={(e) => setForm({ ...form, [k]: e.target.value })}
              style={{ ...inputStyle, marginBottom: 0 }}
            />
          </label>
        ))}
      </div>
      <Btn variant="primary" onClick={submit}>
        Add Provider
      </Btn>

      {providers.length > 0 && (
        <>
          <div
            style={{
              borderTop: "1px solid #243047",
              margin: "16px 0 12px",
            }}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {providers.map((p) => (
              <div
                key={p.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "10px 12px",
                  background: "#111e2d",
                  border: "1px solid #243047",
                  borderRadius: 7,
                }}
              >
                <div style={{ flex: 1 }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: "#c8dce8",
                      marginBottom: 2,
                    }}
                  >
                    {p.alias}
                  </div>
                  <div style={{ fontSize: 10, color: "#55738a" }}>
                    {p.model_id} · {p.endpoint}
                  </div>
                </div>
                <Btn
                  small
                  onClick={() =>
                    fetch("/api/providers/" + p.id + "/test", {
                      method: "POST",
                    })
                      .then((r) => r.json())
                      .then((x) => alert(x.message || x.detail))
                  }
                >
                  Test
                </Btn>
                <Btn
                  small
                  variant="danger"
                  onClick={() =>
                    fetch("/api/providers/" + p.id, { method: "DELETE" }).then(
                      refresh
                    )
                  }
                >
                  Delete
                </Btn>
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}

// ─── Command Palette ──────────────────────────────────────────────────────────

function Palette({
  close,
  commands,
}: {
  close: () => void;
  commands: [string, () => void][];
}) {
  const [q, setQ] = useState("");
  const filtered = commands.filter(([n]) =>
    n.toLowerCase().includes(q.toLowerCase())
  );
  return (
    <Modal title="Command Palette" close={close}>
      <input
        autoFocus
        placeholder="Type a command…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        style={{ ...inputStyle, fontSize: 13, marginBottom: 10 }}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {filtered.map(([name, fn]) => (
          <button
            key={name}
            onClick={() => {
              fn();
              close();
            }}
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              background: "#111e2d",
              border: "1px solid #1e3048",
              color: "#a8c8e0",
              borderRadius: 6,
              padding: "9px 12px",
              fontSize: 13,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            {name}
          </button>
        ))}
      </div>
    </Modal>
  );
}

// ─── Sidebar panel ────────────────────────────────────────────────────────────

function Sidebar({
  onAdd,
  history,
  expanded,
  onToggle,
}: {
  onAdd: (type: string) => void;
  history: any[];
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <aside
      style={{
        width: expanded ? 192 : 48,
        transition: "width 0.18s ease",
        background: "#0f1825",
        borderRight: "1px solid #1e2d3f",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        flexShrink: 0,
      }}
    >
      {/* Toggle */}
      <button
        onClick={onToggle}
        title={expanded ? "Collapse sidebar" : "Expand sidebar"}
        style={{
          background: "none",
          border: "none",
          borderBottom: "1px solid #1e2d3f",
          color: "#4a6880",
          cursor: "pointer",
          padding: "13px",
          fontSize: 14,
          textAlign: "right",
          flexShrink: 0,
        }}
      >
        {expanded ? "◀" : "▶"}
      </button>

      <div style={{ overflowY: "auto", flex: 1, padding: expanded ? "12px 10px" : "10px 6px" }}>
        {/* Add Nodes */}
        <div
          style={{
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: "1px",
            color: "#3d5a70",
            marginBottom: 8,
            textTransform: "uppercase",
            whiteSpace: "nowrap",
            overflow: "hidden",
          }}
        >
          {expanded ? "Add Nodes" : ""}
        </div>
        {NODE_TYPES_LIST.map((type) => (
          <button
            key={type}
            onClick={() => onAdd(type)}
            title={NODE_LABELS[type]}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              width: "100%",
              background: "none",
              border: "1px solid transparent",
              borderRadius: 6,
              color: "#7baabb",
              cursor: "pointer",
              padding: expanded ? "6px 8px" : "7px",
              fontSize: 11,
              marginBottom: 2,
              textAlign: "left",
              whiteSpace: "nowrap",
              overflow: "hidden",
              fontFamily: "inherit",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background =
                "#192535";
              (e.currentTarget as HTMLButtonElement).style.borderColor =
                "#2d4060";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "none";
              (e.currentTarget as HTMLButtonElement).style.borderColor =
                "transparent";
            }}
          >
            <span style={{ flexShrink: 0, width: 15, height: 15, display: "flex", alignItems: "center", justifyContent: "center" }}>
              {NODE_SVG_ICONS[type]}
            </span>
            {expanded && NODE_LABELS[type]}
          </button>
        ))}

        {/* History */}
        {history.length > 0 && (
          <>
            <div
              style={{
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: "1px",
                color: "#3d5a70",
                margin: "18px 0 8px",
                textTransform: "uppercase",
                whiteSpace: "nowrap",
              }}
            >
              {expanded ? "Recent Runs" : ""}
            </div>
            {history.slice(0, 5).map((h) => (
              <div
                key={h.id}
                title={`${h.status} · ${Math.round(h.duration_ms / 1000)}s`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "5px 6px",
                  marginBottom: 3,
                  borderRadius: 5,
                  fontSize: 10,
                  color: h.status === "success" ? "#5cb890" : "#c07070",
                  overflow: "hidden",
                  whiteSpace: "nowrap",
                }}
              >
                <span style={{ flexShrink: 0 }}>
                  {h.status === "success" ? "✓" : "⚠"}
                </span>
                {expanded && (
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {h.status} · {Math.round(h.duration_ms / 1000)}s
                  </span>
                )}
              </div>
            ))}
          </>
        )}

        {/* Shortcuts */}
        {expanded && (
          <div
            style={{
              marginTop: 20,
              fontSize: 10,
              color: "#3d5570",
              lineHeight: 1.7,
            }}
          >
            <div>Ctrl+P · Palette</div>
            <div>Ctrl+Enter · Run</div>
            <div>Ctrl+D · Duplicate</div>
            <div>Ctrl+Z · Undo</div>
          </div>
        )}
      </div>
    </aside>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState(BASE_NODES);
  const [edges, setEdges, onEdgesChange] = useEdgesState(BASE_EDGES);
  const [name, setName] = useState("Untitled workflow");
  const [notice, setNotice] = useState<{ msg: string; ok?: boolean }>({
    msg: "Ready",
  });
  const [saved, setSaved] = useState<number | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [inputId, setInputId] = useState<string | null>(null);
  const [outId, setOutId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [showWorkspace, setShowWorkspace] = useState(false);
  const [showWorkflowPicker, setShowWorkflowPicker] = useState(false);
  const [sidebarExpanded, setSidebarExpanded] = useState(true);
  const [tree, setTree] = useState<any[]>([]);
  const [file, setFile] = useState<any>(null);
  const [history, setHistory] = useState<any[]>([]);

  const snapshots = useRef<string[]>([]);
  const cursor = useRef(-1);
  const copied = useRef<W[]>([]);
  const abort = useRef<AbortController | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const notify = (msg: string, ok?: boolean) => setNotice({ msg, ok });

  const graph = useCallback(
    () => ({
      version: 2,
      nodes: nodes.map(({ id, type, position, data, width, height }) => ({
        id,
        type: type === "resultOutput" ? "output" : type,
        position,
        width,
        height,
        data: Object.fromEntries(
          Object.entries(data).filter(
            ([k]) =>
              ![
                "onChange",
                "onDelete",
                "onInput",
                "onOutput",
                "providers",
                "state",
                "error",
                "result",
              ].includes(k)
          )
        ),
      })),
      edges,
    }),
    [nodes, edges]
  );

  const refresh = () => {
    fetch("/api/providers")
      .then((r) => r.json())
      .then(setProviders);
    fetch("/api/project/tree")
      .then((r) => r.json())
      .then(setTree);
    fetch("/api/history")
      .then((r) => r.json())
      .then(setHistory);
  };
  useEffect(refresh, []);

  const remember = useCallback(() => {
    const s = JSON.stringify(graph());
    if (snapshots.current[cursor.current] !== s) {
      snapshots.current = snapshots.current
        .slice(0, cursor.current + 1)
        .concat(s)
        .slice(-40);
      cursor.current = snapshots.current.length - 1;
    }
  }, [graph]);

  useEffect(() => {
    const t = setTimeout(remember, 250);
    return () => clearTimeout(t);
  }, [remember]);

  const restore = (d: number) => {
    const p = cursor.current + d;
    if (p < 0 || p >= snapshots.current.length) return;
    cursor.current = p;
    const x = JSON.parse(snapshots.current[p]);
    setNodes(x.nodes);
    setEdges(x.edges);
  };

  const update = useCallback(
    (id: string, p: any) =>
      setNodes((ns) =>
        ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...p } } : n))
      ),
    []
  );
  const remove = (id: string) => {
    setNodes((ns) => ns.filter((n) => n.id !== id));
    setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
  };

  const decorated = useMemo(
    () =>
      nodes.map((n) => ({
        ...n,
        data: {
          ...(n.type === "llm"
            ? { temperature: "", top_p: "", max_tokens: "" }
            : {}),
          ...n.data,
          onChange: update,
          onDelete: remove,
          onInput: setInputId,
          onOutput: setOutId,
          providers,
        },
      })),
    [nodes, providers, update]
  );

  const add = (type: string) =>
    setNodes((ns) => [
      ...ns,
      {
        id: type + "-" + Date.now(),
        type,
        position: { x: 160 + Math.random() * 420, y: 100 + Math.random() * 340 },
        data: { label: NODE_LABELS[type as NodeTypeName] || type },
      },
    ]);

  const run = async () => {
    abort.current = new AbortController();
    notify("Running workflow…");
    setNodes((ns) =>
      ns.map((n) => ({
        ...n,
        data: {
          ...n.data,
          state: "running",
          error: "",
          result: n.type === "resultOutput" ? "" : n.data.result,
        },
      }))
    );
    try {
      const r = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ graph: graph() }),
        signal: abort.current.signal,
      });
      const b = await r.json();
      if (!r.ok) throw Error(b.detail);
      setNodes((ns) =>
        ns.map((n) => ({
          ...n,
          data: {
            ...n.data,
            state: b.states[n.id]?.status || "idle",
            error: b.states[n.id]?.error,
            result:
              n.type === "resultOutput"
                ? b.outputs[n.id]
                : n.data.result,
          },
        }))
      );
      notify("Workflow completed", true);
      refresh();
    } catch (e: any) {
      const cancelled = e.name === "AbortError";
      notify(cancelled ? "Workflow cancelled" : e.message);
      setNodes((ns) =>
        ns.map((n) => ({
          ...n,
          data: {
            ...n.data,
            state: cancelled ? "cancelled" : "error",
            error: cancelled ? "" : e.message,
          },
        }))
      );
    } finally {
      abort.current = null;
    }
  };

  const save = async () => {
    const r = await fetch(
      saved ? "/api/workflows/" + saved : "/api/workflows",
      {
        method: saved ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description: "", graph: graph() }),
      }
    );
    const b = await safeJson(r);
    setSaved(b.id);
    notify("Workflow saved", true);
  };

  const fromGraph = (x: any) =>
    x.nodes.map((n: any) => ({
      ...n,
      type: n.type === "output" ? "resultOutput" : n.type,
    }));

  const exportJson = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(
      new Blob([JSON.stringify({ name, description: "", graph: graph() }, null, 2)], {
        type: "application/json",
      })
    );
    a.download = name + ".json";
    a.click();
  };

  const importJson = (f: File) => {
    const r = new FileReader();
    r.onload = () => {
      const x = JSON.parse(String(r.result));
      setName(x.name || "Imported workflow");
      setNodes(fromGraph(x.graph));
      setEdges(x.graph.edges);
      setSaved(null);
      notify("Workflow imported", true);
    };
    r.readAsText(f);
  };

  const openWorkflow = (item: any) => {
    setName(item.name);
    setNodes(fromGraph(item.graph));
    setEdges(item.graph.edges);
    setSaved(item.id);
    setShowWorkflowPicker(false);
    notify("Workflow opened", true);
  };

  const selected = () => nodes.filter((n) => n.selected);
  const dup = () => {
    const sel = selected();
    setNodes((ns) => [
      ...ns,
      ...sel.map((n) => ({
        ...n,
        id: n.type + "-" + Date.now() + "-" + Math.random(),
        position: { x: n.position.x + 35, y: n.position.y + 35 },
        selected: false,
        data: { ...n.data },
      })),
    ]);
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (isTyping() && e.key !== "Escape") return;
      if (e.ctrlKey && e.key === "s") {
        e.preventDefault();
        save();
      } else if (e.ctrlKey && e.key === "z") {
        e.preventDefault();
        restore(e.shiftKey ? 1 : -1);
      } else if (e.ctrlKey && e.key === "d") {
        e.preventDefault();
        dup();
      } else if (e.ctrlKey && e.key === "c") {
        copied.current = selected();
      } else if (e.ctrlKey && e.key === "v" && copied.current.length) {
        setNodes((ns) => [
          ...ns,
          ...copied.current.map((n) => ({
            ...n,
            id: n.type + "-" + Date.now() + "-" + Math.random(),
            position: { x: n.position.x + 45, y: n.position.y + 45 },
            selected: false,
            data: { ...n.data },
          })),
        ]);
      } else if (["Delete", "Backspace"].includes(e.key)) {
        selected().forEach((n) => remove(n.id));
      } else if (e.ctrlKey && e.key === "p") {
        e.preventDefault();
        setShowPalette(true);
      } else if (e.ctrlKey && e.key === "Enter") {
        run();
      } else if (e.key === "Escape") {
        setShowPalette(false);
        setInputId(null);
        setOutId(null);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [nodes, graph]);

  const inputNode = nodes.find((n) => n.id === inputId);
  const outputNode = nodes.find((n) => n.id === outId);

  const exportMd = () => {
    if (!outputNode) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(
      new Blob([String(outputNode.data.result || "")], {
        type: "text/markdown",
      })
    );
    a.download =
      "output-" + new Date().toISOString().replace(/[:.]/g, "-") + ".md";
    a.click();
  };

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "#0d1520",
        fontFamily: "Inter, ui-sans-serif, sans-serif",
        color: "#c8dce8",
        overflow: "hidden",
      }}
    >
      {/* ── Top Nav ─────────────────────────────────────────────────────── */}
      <header
        style={{
          height: 52,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          padding: "0 16px",
          gap: 10,
          background: "#0f1a2a",
          borderBottom: "1px solid #1e2d3f",
          zIndex: 20,
        }}
      >
        {/* Brand */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            fontWeight: 800,
            fontSize: 15,
            letterSpacing: "1.5px",
            color: "#e0f0ff",
            marginRight: 4,
          }}
        >
          <img
            src={nodeAiMark}
            width={27}
            height={27}
            alt="Node.AI"
            style={{ display: "block" }}
          />
          <span>NODE<span style={{ color: "#69d2a5" }}>.AI</span></span>
        </div>

        {/* Divider */}
        <div
          style={{
            width: 1,
            height: 22,
            background: "#243047",
            flexShrink: 0,
          }}
        />

        {/* Workflow name */}
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{
            background: "transparent",
            border: "1px solid #243047",
            borderRadius: 5,
            color: "#d8eaf8",
            fontSize: 13,
            fontWeight: 500,
            width: 200,
            padding: "3px 8px",
            outline: "none",
            fontFamily: "inherit",
            transition: "border-color 0.15s",
          }}
          title="Workflow name — click to rename"
          onFocus={(e) => (e.currentTarget.style.borderColor = "#4a80aa")}
          onBlur={(e) => (e.currentTarget.style.borderColor = "#243047")}
        />

        {/* Saved badge */}
        {saved && (
          <span
            style={{
              fontSize: 10,
              color: "#4a8c6a",
              background: "#0e2820",
              border: "1px solid #1e5440",
              borderRadius: 4,
              padding: "2px 7px",
            }}
          >
            Saved
          </span>
        )}

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* File actions group */}
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <Btn
            small
            onClick={() => {
              setNodes([]);
              setEdges([]);
              setSaved(null);
              setName("Untitled workflow");
            }}
            title="New blank workflow"
          >
            New
          </Btn>
          <Btn small onClick={() => setShowWorkflowPicker(true)} title="Open saved workflow">
            Open
          </Btn>
          <input
            ref={importRef}
            hidden
            type="file"
            accept="application/json"
            onChange={(e) => e.target.files?.[0] && importJson(e.target.files[0])}
          />
          <Btn small onClick={() => importRef.current?.click()} title="Import JSON">
            Import
          </Btn>
          <Btn small onClick={exportJson} title="Export JSON">
            Export
          </Btn>
          <Btn small onClick={save} title="Save workflow (Ctrl+S)">
            Save
          </Btn>
        </div>

        {/* Divider */}
        <div
          style={{
            width: 1,
            height: 22,
            background: "#243047",
            flexShrink: 0,
          }}
        />

        {/* Tools group */}
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <Btn
            small
            onClick={() => setShowWorkspace(!showWorkspace)}
            title="Toggle project explorer"
          >
            Project
          </Btn>
          <Btn small onClick={() => setShowSettings(true)} title="Manage LLM providers">
            Providers
          </Btn>
        </div>

        {/* Divider */}
        <div
          style={{
            width: 1,
            height: 22,
            background: "#243047",
            flexShrink: 0,
          }}
        />

        {/* Run/Stop */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Btn variant="primary" onClick={run} title="Run workflow (Ctrl+Enter)">
            ▶ Run
          </Btn>
          <Btn
            variant="danger"
            onClick={() => abort.current?.abort()}
            title="Stop running workflow"
            disabled={!abort.current}
          >
            ■ Stop
          </Btn>
        </div>
      </header>

      {/* ── Body ────────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* Sidebar */}
        <Sidebar
          onAdd={add}
          history={history}
          expanded={sidebarExpanded}
          onToggle={() => setSidebarExpanded((v) => !v)}
        />

        {/* Canvas */}
        <div style={{ flex: 1, position: "relative", minWidth: 0 }}>
          <ReactFlow
            nodes={decorated}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={(c: Connection) => setEdges((es) => addEdge(c, es))}
            fitView
            style={{ background: "#0d1520" }}
          >
            <Background gap={28} color="#1a2840" />
            <Controls
              style={{
                background: "#111e2e",
                border: "1px solid #243047",
                borderRadius: 8,
              }}
            />
            <MiniMap
              style={{
                background: "#0f1825",
                border: "1px solid #1e2d3f",
                borderRadius: 8,
              }}
              nodeColor="#1e3050"
              maskColor="#0d152099"
            />
          </ReactFlow>

          {/* Workspace overlay */}
          {showWorkspace && (
            <Workspace
              tree={tree}
              refresh={refresh}
              file={file}
              setFile={setFile}
              notify={(msg) => notify(msg, true)}
              onClose={() => setShowWorkspace(false)}
            />
          )}
        </div>
      </div>

      {/* ── Status Bar ──────────────────────────────────────────────────── */}
      <footer
        style={{
          height: 30,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          padding: "0 16px",
          gap: 12,
          background: "#0a1220",
          borderTop: "1px solid #1a2840",
          fontSize: 11,
          color: "#4a6880",
        }}
      >
        <span
          style={{
            color: notice.ok
              ? "#69d2a5"
              : notice.msg.toLowerCase().includes("error") ||
                notice.msg.toLowerCase().includes("cancel")
              ? "#ef9090"
              : "#7a9cb0",
          }}
        >
          {notice.msg}
        </span>
        <div style={{ flex: 1 }} />
        <span>{providers.length} provider{providers.length !== 1 ? "s" : ""}</span>
        <span>·</span>
        <span>workflow v2</span>
        <span>·</span>
        <button
          onClick={() => setShowPalette(true)}
          style={{
            background: "none",
            border: "none",
            color: "#3d5570",
            cursor: "pointer",
            fontSize: 11,
            fontFamily: "inherit",
            padding: 0,
          }}
        >
          Ctrl+P for commands
        </button>
      </footer>

      {/* ── Modals ──────────────────────────────────────────────────────── */}

      {/* Input editor */}
      {inputNode && (
        <Modal title="Input Editor" close={() => setInputId(null)}>
          <textarea
            autoFocus
            value={inputNode.data.text || ""}
            onChange={(e) => update(inputNode.id, { text: e.target.value })}
            style={{
              ...inputStyle,
              minHeight: "50vh",
              fontSize: 13,
              lineHeight: 1.55,
              resize: "vertical",
              marginBottom: 10,
            }}
          />
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              fontSize: 11,
              color: "#55738a",
              marginBottom: 12,
            }}
          >
            <span>
              {(inputNode.data.text || "").length.toLocaleString()} chars ·{" "}
              {(inputNode.data.text || "")
                .trim()
                .split(/\s+/)
                .filter(Boolean).length.toLocaleString()}{" "}
              words
            </span>
          </div>
          <Btn onClick={() => setInputId(null)}>Apply</Btn>
        </Modal>
      )}

      {/* Output viewer */}
      {outputNode && (
        <Modal title="Output Viewer" close={() => setOutId(null)} wide>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 14,
            }}
          >
            <span style={{ fontSize: 11, color: "#55738a" }}>
              {String(outputNode.data.result || "").length.toLocaleString()}{" "}
              characters
            </span>
            <Btn small onClick={exportMd}>
              Export Markdown
            </Btn>
          </div>
          <div
            style={{
              maxHeight: "56vh",
              overflowY: "auto",
              borderRadius: 8,
              border: "1px solid #1e3048",
              padding: "14px 16px",
              background: "#0d1720",
            }}
          >
            <Markdown text={String(outputNode.data.result || "")} />
          </div>
          <details style={{ marginTop: 12 }}>
            <summary
              style={{ fontSize: 11, color: "#4a6880", cursor: "pointer" }}
            >
              Raw text
            </summary>
            <pre
              style={{
                whiteSpace: "pre-wrap",
                fontSize: 11,
                color: "#8aacbe",
                maxHeight: 240,
                overflowY: "auto",
                marginTop: 8,
                background: "#0a1520",
                borderRadius: 6,
                padding: 10,
              }}
            >
              {String(outputNode.data.result || "")}
            </pre>
          </details>
        </Modal>
      )}

      {showWorkflowPicker && (
        <WorkflowPicker open={openWorkflow} close={() => setShowWorkflowPicker(false)} />
      )}
      {showSettings && (
        <Providers
          providers={providers}
          refresh={refresh}
          close={() => setShowSettings(false)}
        />
      )}
      {showPalette && (
        <Palette
          close={() => setShowPalette(false)}
          commands={[
            ["Run workflow", run],
            ["Stop workflow", () => abort.current?.abort()],
            ["Save workflow", save],
            ["Open workflow", () => setShowWorkflowPicker(true)],
            ["New workflow", () => { setNodes([]); setEdges([]); setSaved(null); setName("Untitled workflow"); }],
            ["Add Text Input", () => add("textInput")],
            ["Add LLM node", () => add("llm")],
            ["Add Output node", () => add("resultOutput")],
            ["Open providers", () => setShowSettings(true)],
            ["Toggle project explorer", () => setShowWorkspace((v) => !v)],
            ["Toggle sidebar", () => setSidebarExpanded((v) => !v)],
          ]}
        />
      )}
    </div>
  );
}
