import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, GitPullRequest, Plus, Ticket as TicketIcon, Trash2, X } from "lucide-react";
import { uid, useNamespaced, useStore, useToast } from "../store";
import { Field, Modal, ModalActions, PageHead, PrimaryButton, initials, usd, useErrors } from "../components/ui";
import "../styles/pages.css";
import type { Task, TaskStatus } from "../types";
import { kindDef } from "./Integrations";

const COLUMNS: { id: TaskStatus; label: string; dot: string }[] = [
  { id: "queued", label: "Queued", dot: "var(--text-3)" },
  { id: "running", label: "Running", dot: "var(--accent-hi)" },
  { id: "review", label: "In review", dot: "var(--warn)" },
  { id: "done", label: "Done", dot: "var(--ok)" },
  { id: "failed", label: "Failed", dot: "var(--err)" },
];

export function Tracker() {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const { tasks, agents } = useNamespaced();
  const [agentFilter, setAgentFilter] = useState("all");
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<TaskStatus | null>(null);
  const [creating, setCreating] = useState(state.compose);
  const [importing, setImporting] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const opened = state.tasks.find((t) => t.id === openId);
  const ticketSources = useNamespaced().integrations.filter((i) => i.ticketing);

  const visible = tasks.filter((t) => agentFilter === "all" || t.agentId === agentFilter);
  const agentName = (id: string) => state.agents.find((a) => a.id === id)?.name ?? id;
  const count = (s: TaskStatus) => tasks.filter((t) => t.status === s).length;

  const drop = (status: TaskStatus) => {
    if (dragging) {
      const t = tasks.find((x) => x.id === dragging);
      if (t && t.status !== status) {
        dispatch({ type: "moveTask", id: dragging, status });
        const label = COLUMNS.find((c) => c.id === status)!.label;
        const it = t.ticket && state.integrations.find((i) => i.id === t.ticket!.integrationId);
        // Linked tickets follow the board when two-way sync is on.
        if (t.ticket && it?.ticketing?.twoWay) toast(`${t.ticket.key} moved to ${label} in ${kindDef(it.kind).label}`, "info");
        else toast(`Moved to ${label.toLowerCase()}`, "info");
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
        {ticketSources.length > 0 && <button className="btn" onClick={() => setImporting(true)}><Download size={14} /> Import tickets</button>}
        <PrimaryButton onClick={() => setCreating(true)} icon={<Plus size={14} />}>New task</PrimaryButton>
      </PageHead>

      <div className="stats">
        <div className="stat"><div className="stat-label">Running</div><div className="stat-value">{count("running")}</div><div className="stat-sub">{count("queued")} queued</div></div>
        <div className="stat"><div className="stat-label">Waiting for review</div><div className="stat-value">{count("review")}</div><div className="stat-sub">needs a human</div></div>
        <div className="stat"><div className="stat-label">Done today</div><div className="stat-value">{count("done")}</div><div className="stat-sub">{count("failed")} failed</div></div>
        <div className="stat"><div className="stat-label">Cost today</div><div className="stat-value">{usd(tasks.reduce((s, t) => s + t.cost, 0))}</div><div className="stat-sub">{tasks.reduce((s, t) => s + t.minutes, 0)} agent minutes</div></div>
      </div>

      <div className={`board ${dragging ? "is-dragging" : ""}`}>
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
                <span className="dot" style={{ background: c.dot }} />
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
                  onDelete={() => { dispatch({ type: "removeTask", id: t.id }); if (openId === t.id) setOpenId(null); }}
                  onOpen={() => setOpenId(t.id)}
                  selected={openId === t.id}
                />
              ))}
              {items.length === 0 && <div className="column-empty">Nothing here</div>}
            </div>
          );
        })}
      </div>

      {creating && <NewTask onClose={() => setCreating(false)} />}
      {opened && <TaskPanel key={opened.id} task={opened} onClose={() => setOpenId(null)} />}
      {importing && <ImportTickets onClose={() => setImporting(false)} />}
    </>
  );
}

function TaskCard({ task: t, agent, dragging, selected, onDragStart, onDragEnd, onDelete, onOpen }: {
  task: Task; agent: string; dragging: boolean; selected: boolean; onDragStart: () => void; onDragEnd: () => void; onDelete: () => void; onOpen: () => void;
}) {
  return (
    <div
      className={`task ${dragging ? "dragging" : ""} ${selected ? "selected" : ""}`}
      aria-pressed={selected}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && onOpen()}
      tabIndex={0}
      role="button"
      aria-label={`Open ${t.title}`}
    >
      <div className="row" style={{ alignItems: "flex-start" }}>
        <span className="task-title">{t.title}</span>
        <span className="spacer" />
        <button className="btn ghost sm icon" title="Delete task" onClick={(e) => { e.stopPropagation(); onDelete(); }}><Trash2 size={12} /></button>
      </div>
      {t.description && <p className="task-desc">{t.description}</p>}
      {t.status === "running" && <div className="bar"><span style={{ width: `${t.progress * 100}%` }} /></div>}
      <div className="row small">
        <span className="avatar" style={{ width: 20, height: 20, fontSize: 9 }}>{initials(agent)}</span>
        <span className="dim">{agent}</span>
        <span className="spacer" />
        {t.ticket && <span className="badge mono" title={t.ticket.url}>{t.ticket.key}</span>}
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
  const [description, setDescription] = useState("");
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [priority, setPriority] = useState<Task["priority"]>("normal");
  const { errors, check, clear } = useErrors();

  const create = () => {
    const ok = check({
      title: title.trim() ? undefined : "Give the task a title.",
      description: description.length > MAX_DESCRIPTION ? `Keep the description under ${MAX_DESCRIPTION} characters.` : undefined,
      agent: agentId ? undefined : agents.length ? "Pick an agent." : "Create an agent first.",
    });
    if (!ok) return;
    dispatch({
      type: "addTask",
      task: {
        id: uid("t"), ns: state.ns, title: title.trim(), description: description.trim() || undefined, agentId, status: "queued", priority,
        progress: 0, startedAt: "", minutes: 0, cost: 0, pr: null,
      },
    });
    toast("Task queued");
    onClose();
  };

  return (
    <Modal title="New task" subtitle="The agent picks it up when it is free." onClose={onClose}>
      <Field label="Title" error={errors.title}>
        <input className="input" autoFocus value={title} onChange={(e) => { setTitle(e.target.value); clear("title"); }} placeholder="Add pagination to the audit log API" />
      </Field>
      <Field label="Description" error={errors.description} hint="Optional. The agent works from this: what done looks like, links, constraints.">
        <textarea
          className="textarea"
          rows={5}
          value={description}
          onChange={(e) => { setDescription(e.target.value); clear("description"); }}
          placeholder="Cursor-based, 50 per page by default. Keep the old response shape behind ?legacy=1."
        />
      </Field>
      <div className="field-row">
        <Field label="Agent" error={errors.agent}>
          <select className="select" value={agentId} onChange={(e) => { setAgentId(e.target.value); clear("agent"); }}>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
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

const MAX_DESCRIPTION = 4000;

/** One task in a panel on the right. Changes save as you type; the board stays usable beside it. */
function TaskPanel({ task, onClose }: { task: Task; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const { agents } = useNamespaced();
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const column = COLUMNS.find((c) => c.id === task.status);
  const ticketSource = task.ticket && state.integrations.find((i) => i.id === task.ticket?.integrationId);
  const update = (patch: Partial<Pick<Task, "title" | "description" | "agentId" | "priority">>) => dispatch({ type: "updateTask", id: task.id, patch });

  // The panel lives inside the main area, beside the content, which narrows to make room.
  const anchor = useRef<HTMLSpanElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const main = anchor.current?.closest<HTMLElement>(".main") ?? null;
    main?.classList.add("with-panel");
    setHost(main);
    return () => main?.classList.remove("with-panel");
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const tooLong = description.length > MAX_DESCRIPTION;

  return (
    <>
      <span ref={anchor} hidden />
      {host && createPortal(
        <aside className="side-panel" aria-label="Task details">
          <div className="side-panel-head">
            <span className="dot" style={{ background: column?.dot }} />
            <select className="side-panel-status" value={task.status} onChange={(e) => dispatch({ type: "moveTask", id: task.id, status: e.target.value as TaskStatus })} aria-label="Status">
              {COLUMNS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
            <span className="spacer" />
            <span className="faint small mono">{task.id}</span>
            <button className="btn ghost icon" onClick={onClose} aria-label="Close" title="Close (Esc)"><X size={16} /></button>
          </div>

          <div className="side-panel-body">
            <textarea
              className="side-panel-title"
              rows={1}
              value={title}
              aria-label="Title"
              onChange={(e) => {
                const v = e.target.value.replace(/\n/g, " ");
                setTitle(v);
                if (v.trim()) update({ title: v.trim() });
              }}
              onBlur={() => !title.trim() && setTitle(task.title)}
              ref={autosize}
            />
            {task.status === "running" && <div className="bar"><span style={{ width: `${task.progress * 100}%` }} /></div>}

            <div>
              <textarea
                className="side-panel-desc"
                value={description}
                aria-label="Description"
                placeholder="Add a description: what done looks like, links, constraints."
                onChange={(e) => {
                  setDescription(e.target.value);
                  if (e.target.value.length <= MAX_DESCRIPTION) update({ description: e.target.value.trim() || undefined });
                }}
                ref={autosize}
              />
              {tooLong && <span className="field-error" role="alert">Keep the description under {MAX_DESCRIPTION} characters; changes past that aren't saved.</span>}
            </div>

            <dl className="props">
              <dt>Agent</dt>
              <dd>
                <select className="select" value={task.agentId} onChange={(e) => update({ agentId: e.target.value })}>
                  {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </dd>
              <dt>Priority</dt>
              <dd>
                <select className="select" value={task.priority} onChange={(e) => update({ priority: e.target.value as Task["priority"] })}>
                  <option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option>
                </select>
              </dd>
              <dt>Started</dt>
              <dd className="dim">{task.startedAt || "Not yet"}</dd>
              <dt>Time and cost</dt>
              <dd className="dim">{task.minutes} min, {usd(task.cost)}</dd>
              {task.ticket && (
                <>
                  <dt>Ticket</dt>
                  <dd>
                    <a href={task.ticket.url} target="_blank" rel="noreferrer" className="row" style={{ gap: 6 }}>
                      <TicketIcon size={13} /> {task.ticket.key}{ticketSource ? <span className="faint">in {ticketSource.name}</span> : null}
                    </a>
                  </dd>
                </>
              )}
              {task.pr && (
                <>
                  <dt>Pull request</dt>
                  <dd className="row" style={{ gap: 6 }}><GitPullRequest size={13} /> {task.pr}</dd>
                </>
              )}
            </dl>
          </div>

          <div className="side-panel-foot">
            <span className="faint small">Changes save automatically</span>
            <span className="spacer" />
            <button className="btn ghost sm danger" onClick={() => { dispatch({ type: "removeTask", id: task.id }); onClose(); }}>
              <Trash2 size={12} /> Delete
            </button>
          </div>
        </aside>,
        host,
      )}
    </>
  );
}

/** Grow a textarea to fit its text. */
function autosize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  const fit = () => { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; };
  fit();
  el.oninput = fit;
}

function ImportTickets({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const { agents, integrations, tasks } = useNamespaced();
  const sources = integrations.filter((i) => i.ticketing);
  const linked = new Set(tasks.map((t) => t.ticket?.key).filter(Boolean));
  const available = state.tickets.filter((t) => sources.some((s) => s.id === t.integrationId) && !linked.has(t.key));
  const [picked, setPicked] = useState<string[]>([]);
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const { errors, check, clear } = useErrors();
  const toggle = (key: string) => { setPicked(picked.includes(key) ? picked.filter((k) => k !== key) : [...picked, key]); clear("tickets"); };

  const importNow = () => {
    const ok = check({
      tickets: picked.length ? undefined : available.length ? "Pick at least one ticket." : "There is nothing left to import.",
      agent: agentId ? undefined : "Create an agent to assign these to.",
    });
    if (!ok) return;
    for (const t of available.filter((x) => picked.includes(x.key))) {
      dispatch({
        type: "addTask",
        task: {
          id: uid("t"), ns: state.ns, title: t.title, description: t.description, agentId, status: "queued", priority: t.priority, progress: 0, startedAt: "", minutes: 0, cost: 0, pr: null,
          ticket: { integrationId: t.integrationId, key: t.key, url: t.url },
        },
      });
    }
    toast(`Queued ${picked.length} ticket${picked.length === 1 ? "" : "s"} for ${agents.find((a) => a.id === agentId)?.name}`);
    onClose();
  };

  return (
    <Modal title="Import tickets" subtitle={`Open tickets matching ${sources.map((s) => s.name).join(", ")}. Each becomes a queued task.`} onClose={onClose}>
      {available.length === 0 ? (
        <div className="faint">Every matching ticket is already on the board.</div>
      ) : (
        <div style={{ maxHeight: 280, overflow: "auto", margin: "0 -4px" }}>
          {available.map((t) => (
            <label key={t.key} className="list-row" style={{ cursor: "pointer", padding: "8px 4px" }}>
              <input type="checkbox" checked={picked.includes(t.key)} onChange={() => toggle(t.key)} style={{ accentColor: "var(--accent)" }} />
              <TicketIcon size={13} className="faint" />
              <span className="mono small faint" style={{ width: 64, flex: "none" }}>{t.key}</span>
              <span className="clip" style={{ flex: 1 }}>{t.title}</span>
              {t.priority === "high" && <span className="badge accent">High</span>}
              <span className="faint small">{t.status}</span>
            </label>
          ))}
        </div>
      )}
      {errors.tickets && <span className="field-error" role="alert">{errors.tickets}</span>}
      <Field label="Assign to" error={errors.agent}>
        <select className="select" value={agentId} onChange={(e) => { setAgentId(e.target.value); clear("agent"); }}>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </Field>
      <ModalActions onCancel={onClose} onConfirm={importNow} confirm={picked.length ? `Import ${picked.length}` : "Import"} />
    </Modal>
  );
}
