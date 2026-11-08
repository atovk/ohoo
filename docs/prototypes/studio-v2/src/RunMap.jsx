import React, { useMemo } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Circle,
  GitBranch,
  LockKeyhole,
  MessageSquare,
  Play,
  Terminal,
  UserRound,
  Workflow,
} from "lucide-react";
import { Badge, Button, useStudio } from "./studio";

const ports = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
};

function RoleCard({ data }) {
  const { role, current, visited, mine, open } = data;
  const Icon = role.kind === "human" ? UserRound : Terminal;
  return (
    <div className="run-map-node-wrap">
      {Object.entries(ports).map(([name, pos]) => (
        <React.Fragment key={name}>
          <Handle
            id={"from-" + name}
            type="source"
            position={pos}
            isConnectable={false}
          />
          <Handle
            id={"to-" + name}
            type="target"
            position={pos}
            isConnectable={false}
          />
        </React.Fragment>
      ))}
      <button
        type="button"
        className={
          "run-map-node " +
          (current ? "is-current" : visited ? "is-visited" : "")
        }
        aria-label={"打开" + role.name + "角色会话"}
        onClick={() => open(role.id)}
      >
        <span className="run-map-node-head">
          <span>
            <Icon size={13} />
            {role.kind === "human" ? "真人" : "Agent"}
          </span>
          {current ? (
            <span className="run-map-current">
              <Play size={9} fill="currentColor" />
              当前
            </span>
          ) : visited ? (
            <Check size={13} />
          ) : (
            <Circle size={7} />
          )}
        </span>
        <strong>{role.name}</strong>
        <small>
          {!mine && <LockKeyhole size={11} />} {role.owner || "待分配"}{" "}
          <ArrowUpRight size={12} />
        </small>
      </button>
    </div>
  );
}
const nodeTypes = { role: RoleCard };

function choosePorts(source, target, isReturn) {
  const dx = target.x - source.x,
    dy = target.y - source.y;
  if (isReturn && Math.abs(dx) > Math.abs(dy)) return ["bottom", "bottom"];
  if (isReturn && Math.abs(dy) >= Math.abs(dx)) return ["right", "right"];
  if (Math.abs(dx) >= Math.abs(dy))
    return dx >= 0 ? ["right", "left"] : ["left", "right"];
  return dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
}

export function RunMap({ r, t }) {
  const { user, nav } = useStudio();
  const current = r.nodes.find((n) => n.id === r.current);
  const seen = new Set(r.history.map((event) => event.nodeId));
  const openRole = (id) =>
    nav("session", {
      teamId: t.id,
      runId: r.id,
      nodeId: id,
      tab: "from-run-map",
    });
  const active = (id) => r.status !== "已完成" && r.current === id;
  const nodes = r.nodes.map((n, i) => ({
    id: n.id,
    type: "role",
    position: { x: n.x ?? (i % 3) * 260, y: n.y ?? Math.floor(i / 3) * 165 },
    data: {
      role: n,
      current: active(n.id),
      visited: seen.has(n.id),
      mine: n.owner === user,
      open: openRole,
    },
  }));
  const edges = useMemo(() => {
    const locations = new Map(r.nodes.map((n) => [n.id, n]));
    return r.edges.flatMap((edge) => {
      const source = locations.get(edge.from),
        target = locations.get(edge.to);
      if (!source || !target) return [];
      const reverse = r.edges.some(
        (other) => other.from === edge.to && other.to === edge.from,
      );
      const isReturn =
        reverse &&
        (/退回|返工|失败|修改|回滚/.test(edge.label) ||
          (!r.edges.some(
            (e) =>
              e.from === target.id &&
              e.to === source.id &&
              /退回|返工|失败|修改|回滚/.test(e.label),
          ) &&
            source.id.localeCompare(target.id) > 0));
      const [outPort, inPort] = choosePorts(source, target, isReturn);
      return [
        {
          id: edge.id,
          source: edge.from,
          target: edge.to,
          sourceHandle: "from-" + outPort,
          targetHandle: "to-" + inPort,
          type: "smoothstep",
          label: edge.label,
          labelShowBg: true,
          labelBgPadding: [5, 3],
          labelBgBorderRadius: 3,
          labelStyle: { fill: "#46544a", fontSize: 10, fontWeight: 600 },
          labelBgStyle: { fill: "#f4f5ec" },
          style: {
            stroke: edge.mode === "manual" ? "#5b6cb0" : "#899586",
            strokeWidth: 1.3,
            strokeDasharray: edge.mode === "manual" ? "4 3" : undefined,
          },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: edge.mode === "manual" ? "#5b6cb0" : "#899586",
            width: 14,
            height: 14,
          },
        },
      ];
    });
  }, [r.nodes, r.edges]);
  return (
    <section className="run-map-card" aria-label="本次运行的流程图">
      <header className="run-map-head">
        <div className="run-hgroup">
          <Workflow size={18} />
          <h2>运行画布</h2>
        </div>
        <span className="run-map-version">
          <GitBranch size={13} />
          已发布 v{r.version} · {r.nodes.length} 个角色
        </span>
      </header>
      <div className="run-map-desktop">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.15, maxZoom: 1.2 }}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          minZoom={0.25}
          maxZoom={1.8}
          zoomOnScroll={false}
          panOnScroll={false}
          preventScrolling={false}
        >
          <Background gap={16} size={1} color="#cbd3bf" />
          <Controls showInteractive={false} position="bottom-right" />
        </ReactFlow>
      </div>
      <ol className="run-map-mobile" aria-label="运行角色列表">
        {r.nodes.map((n) => {
          const outgoing = r.edges.filter((e) => e.from === n.id);
          return (
            <li key={n.id}>
              <button
                type="button"
                onClick={() => openRole(n.id)}
                aria-label={"打开" + n.name + "角色会话"}
              >
                <span
                  className={
                    "run-map-role-icon " + (active(n.id) ? "is-current" : "")
                  }
                >
                  {n.kind === "human" ? (
                    <UserRound size={16} />
                  ) : (
                    <Terminal size={16} />
                  )}
                </span>
                <span className="run-map-list-caption">
                  <strong>{n.name}</strong>
                  <small>
                    {n.owner || "待分配"} ·{" "}
                    {n.kind === "human" ? "真人" : "Agent"}
                  </small>
                </span>
                {active(n.id) && <Badge tone="blue">当前</Badge>}
                <ArrowUpRight size={14} />
              </button>
              {outgoing.map((e) => (
                <p key={e.id}>
                  <ArrowRight size={11} />
                  {e.label} · {r.nodes.find((n) => n.id === e.to)?.name}
                </p>
              ))}
            </li>
          );
        })}
      </ol>
      {current && (
        <footer className="run-map-foot">
          <div>
            <span>{r.status === "已完成" ? "结束角色" : "当前角色"}</span>
            <strong>{current.name}</strong>
            <small>{current.owner}</small>
          </div>
          <Button variant="primary" onClick={() => openRole(current.id)}>
            <MessageSquare size={15} />
            进入角色会话
            <ArrowUpRight size={13} />
          </Button>
        </footer>
      )}
    </section>
  );
}
