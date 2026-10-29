import { useState } from "react";
import { GitPullRequest, Plus, Trash2 } from "lucide-react";
import { uid, useNamespaced, useStore, useToast } from "../store";
import { Modal, ModalActions, PageHead, PrimaryButton, initials, usd } from "../components/ui";
import type { Task, TaskStatus } from "../types";

const COLUMNS: { id: TaskStatus; label: string }[] = [
  { id: "queued", label: "Queued" },
  { id: "running", label: "Running" },
  { id: "review", label: "In review" },
  { id: "done", label: "Done" },
  { id: "failed", label: "Failed" },
];

export function Tracker() {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const { tasks, agents } = useNamespaced();
  const [agentFilter, setAgentFilter] = useState("all");
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<TaskStatus | null>(null);
  const [creating, setCreating] = useState(false);

  const visible = tasks.filter((t) => agentFilter === "all" || t.agentId === agentFilter);
  const agentName = (id: string) => state.agents.find((a) => a.id === id)?.name ?? id;
  const count = (s: TaskStatus) => tasks.filter((t) => t.status === s).length;

  const drop = (status: TaskStatus) => {
    if (dragging) {
      const t = tasks.find((x) => x.id === dragging);
      if (t && t.status !== status) {
        dispatch({ type: "moveTask", id: dragging, status });
        toast(`Moved to ${COLUMNS.find((c) => c.id === status)!.label.toLowerCase()}`, "info");
      }
    }
    setDragging(null);
    setOver(null);
  };

  return (
    <>
      <PageHead title="Tracker" subtitle="What each agent is working on. Drag a task to change its status.">
        <select className="select" value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)}>
          <option value="all">All agents</option>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <PrimaryButton onClick={() => setCreating(true)} icon={<Plus size={14} />}>New task</PrimaryButton>
      </PageHead>

      <div className="stats">
        <div className="stat"><div className="stat-label">Running</div><div className="stat-value">{count("running")}</div><div className="stat-sub">{count("queued")} queued</div></div>
        <div className="stat"><div className="stat-label">Waiting for review</div><div className="stat-value">{count("review")}</div><div className="stat-sub">needs a human</div></div>
        <div className="stat"><div className="stat-label">Done today</div><div className="stat-value">{count("done")}</div><div className="stat-sub">{count("failed")} failed</div></div>
        <div className="stat"><div className="stat-label">Cost today</div><div className="stat-value">{usd(tasks.reduce((s, t) => s + t.cost, 0))}</div><div className="stat-sub">{tasks.reduce((s, t) => s + t.minutes, 0)} agent minutes</div></div>
      </div>

      <div className="board">
        {COLUMNS.map((c) => {
          const items = visible.filter((t) => t.status === c.id);
          return (
            <div
              key={c.id}
              className={`column ${over === c.id ? "drop" : ""}`}
              onDragOver={(e) => { e.preventDefault(); setOver(c.id); }}
              onDragLeave={() => setOver((o) => (o === c.id ? null : o))}
              onDrop={() => drop(c.id)}
            >
              <div className="column-head">
                {c.label}
                <span className="faint">{items.length}</span>
              </div>
              {items.map((t) => (
                <TaskCard
                  key={t.id}
                  task={t}
                  agent={agentName(t.agentId)}
                  dragging={dragging === t.id}
                  onDragStart={() => setDragging(t.id)}
                  onDragEnd={() => { setDragging(null); setOver(null); }}
                  onDelete={() => dispatch({ type: "removeTask", id: t.id })}
                />
              ))}
              {items.length === 0 && <div className="faint small" style={{ padding: "4px 4px 8px" }}>Nothing here.</div>}
            </div>
          );
        })}
      </div>

      {creating && <NewTask onClose={() => setCreating(false)} />}
    </>
  );
}

function TaskCard({ task: t, agent, dragging, onDragStart, onDragEnd, onDelete }: {
  task: Task; agent: string; dragging: boolean; onDragStart: () => void; onDragEnd: () => void; onDelete: () => void;
}) {
  return (
    <div className={`task ${dragging ? "dragging" : ""}`} draggable onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <span className="task-title">{t.title}</span>
        <span className="spacer" />
        <button className="btn ghost sm icon" title="Delete task" onClick={onDelete}><Trash2 size={12} /></button>
      </div>
      {t.status === "running" && <div className="bar"><span style={{ width: `${t.progress * 100}%` }} /></div>}
      <div className="row small">
        <span className="avatar" style={{ width: 20, height: 20, fontSize: 9 }}>{initials(agent)}</span>
        <span className="dim">{agent}</span>
        <span className="spacer" />
        {t.priority === "high" && <span className="badge accent">High</span>}
      </div>
      {(t.startedAt || t.pr) && (
        <div className="row faint small">
          {t.startedAt && <span>{t.minutes} min, {usd(t.cost)}</span>}
          <span className="spacer" />
          {t.pr && <span className="row" style={{ gap: 4 }}><GitPullRequest size={12} />{t.pr}</span>}
        </div>
      )}
    </div>
  );
}

function NewTask({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const { agents } = useNamespaced();
  const [title, setTitle] = useState("");
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [priority, setPriority] = useState<Task["priority"]>("normal");

  const create = () => {
    if (!title.trim() || !agentId) return;
    dispatch({
      type: "addTask",
      task: { id: uid("t"), ns: state.ns, title: title.trim(), agentId, status: "queued", priority, progress: 0, startedAt: "", minutes: 0, cost: 0, pr: null },
    });
    toast("Task queued");
    onClose();
  };

  return (
    <Modal title="New task" subtitle="The agent picks it up when it is free." onClose={onClose}>
      <label className="field">Task<input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add pagination to the audit log API" /></label>
      <div className="field-row">
        <label className="field">Agent
          <select className="select" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label className="field">Priority
          <select className="select" value={priority} onChange={(e) => setPriority(e.target.value as Task["priority"])}>
            <option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option>
          </select>
        </label>
      </div>
      <ModalActions onCancel={onClose} onConfirm={create} confirm="Queue task" />
    </Modal>
  );
}
