import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Download, GitPullRequest, Plus, RotateCcw, Ticket as TicketIcon, Trash2, X } from "lucide-react";
import { uid, useNamespaced, useStore, useToast, useCompose } from "../store";
import { Field, Modal, ModalActions, PageHead, PrimaryButton, initials, usd, useErrors } from "../components/ui";
import { Markdown } from "../components/Conversation";
import { api, errorMessage, isLive, onTaskChanged } from "../backend";
import type { Task as TaskRecord } from "../bindings/Task";
import "../styles/pages.css";
import type { Task, TaskStatus, TicketRef } from "../types";
import { kindDef } from "./Integrations";

const COLUMNS: { id: TaskStatus; label: string; dot: string }[] = [
  { id: "queued", label: "Queued", dot: "var(--text-3)" },
  { id: "running", label: "Running", dot: "var(--accent-hi)" },
  { id: "review", label: "In review", dot: "var(--warn)" },
  { id: "done", label: "Done", dot: "var(--ok)" },
  { id: "failed", label: "Failed", dot: "var(--err)" },
];

type TaskEdit = Partial<Pick<Task, "title" | "description" | "agentId" | "priority">>;
interface NewTaskInput { title: string; description?: string; agentId: string; priority: Task["priority"]; ticket?: TicketRef }

/** UTC "YYYY-MM-DD HH:MM:SS" from the core, as a local "HH:MM". */
const hhmm = (ts: string | null) => (ts ? new Date(`${ts.replace(" ", "T")}Z`).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");

const fromRecord = (r: TaskRecord): Task => ({
  id: r.id, ns: r.ns, title: r.title, description: r.description || undefined, agentId: r.agent_id,
  status: r.status as TaskStatus, priority: r.priority as Task["priority"], progress: 0,
  startedAt: hhmm(r.started_at), minutes: Math.round(r.seconds / 60), cost: r.cost_usd, pr: null,
  note: r.status_note, result: r.result, reviewNote: r.review_note, attempts: r.attempts,
});

/**
 * The board's tasks and what you can do with them. In the desktop app they live in the core,
 * which hands queued tasks to agents and moves them along (src-tauri/src/task.rs); in a plain
 * browser they are sample data in the store.
 */
function useBoard() {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const live = isLive();
  const ns = state.ns;
  const sample = useNamespaced().tasks;
  const [records, setRecords] = useState<Task[] | null>(null);

  const load = useCallback(() => {
    api.taskList(ns).then((rs) => setRecords(rs.map(fromRecord))).catch((e) => { setRecords([]); toast(errorMessage(e), "err"); });
  }, [ns]);

  useEffect(() => {
    if (!live) return;
    setRecords(null);
    load();
    const off = onTaskChanged((changed) => changed === ns && load());
    // Time and cost of running tasks grow while they run.
    const tick = window.setInterval(load, 20_000);
    return () => { off.then((f) => f()); window.clearInterval(tick); };
  }, [ns]);

  /** Run a core call; on failure say why. Resolves to whether it worked. */
  const call = async (p: Promise<unknown>) => {
    try { await p; load(); return true; } catch (e) { toast(errorMessage(e), "err"); return false; }
  };

  // Edits from the panel save as you type; in the desktop app they go out after a short pause.
  const pending = useRef(new Map<string, { patch: TaskEdit; timer: number }>());
  const update = (id: string, patch: TaskEdit) => {
    if (!live) return dispatch({ type: "updateTask", id, patch });
    setRecords((rs) => rs?.map((t) => (t.id === id ? { ...t, ...patch } : t)) ?? rs);
    const p = pending.current.get(id);
    if (p) window.clearTimeout(p.timer);
    const merged = { ...p?.patch, ...patch };
    const timer = window.setTimeout(() => {
      pending.current.delete(id);
      call(api.taskUpdate(ns, id, { title: merged.title, description: merged.description ?? (("description" in merged) ? "" : undefined), agent_id: merged.agentId, priority: merged.priority }));
    }, 500);
    pending.current.set(id, { patch: merged, timer });
  };

  return {
    live,
    loading: live && records === null,
    tasks: live ? records ?? [] : sample,
    create: async (t: NewTaskInput) => {
      if (live) return call(api.taskCreate(ns, { agent_id: t.agentId, title: t.title, description: t.description, priority: t.priority }));
      dispatch({ type: "addTask", task: { id: uid("t"), ns, title: t.title, description: t.description, agentId: t.agentId, status: "queued", priority: t.priority, progress: 0, startedAt: "", minutes: 0, cost: 0, pr: null, ticket: t.ticket } });
      return true;
    },
    update,
    move: async (id: string, status: TaskStatus) => {
      if (live) return call(api.taskMove(ns, id, status));
      dispatch({ type: "moveTask", id, status });
      return true;
    },
    remove: async (id: string) => {
      if (live) return call(api.taskDelete(ns, id));
      dispatch({ type: "removeTask", id });
      return true;
    },
    review: (id: string, approve: boolean, note: string) => call(api.taskReview(ns, id, approve, note)),
  };
}

type Board = ReturnType<typeof useBoard>;

export function Tracker() {
  const { state } = useStore();
  const toast = useToast();
  const board = useBoard();
  const { tasks } = board;
  const agents = useNamespaced().agents.filter((a) => !a.master);
  const [agentFilter, setAgentFilter] = useState("all");
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<TaskStatus | null>(null);
  const [creating, setCreating] = useState(false);
  useCompose(() => setCreating(true));
  const [importing, setImporting] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const opened = tasks.find((t) => t.id === openId);
  const ticketSources = useNamespaced().integrations.filter((i) => i.ticketing);

  const visible = tasks.filter((t) => agentFilter === "all" || t.agentId === agentFilter);
  const agentName = (id: string) => state.agents.find((a) => a.id === id)?.name ?? id;
  const count = (s: TaskStatus) => tasks.filter((t) => t.status === s).length;

  const drop = async (status: TaskStatus) => {
    const id = dragging;
    setDragging(null);
    setOver(null);
    if (id) {
      const t = tasks.find((x) => x.id === id);
      if (t && t.status !== status) {
        if (board.live && status === "running") {
          toast("Tasks start when their agent picks them up. Move it to Queued instead.", "info");
          return;
        }
        if (!(await board.move(id, status))) return;
        const label = COLUMNS.find((c) => c.id === status)!.label;
        const it = t.ticket && state.integrations.find((i) => i.id === t.ticket!.integrationId);
        // Linked tickets follow the board when two-way sync is on.
        if (t.ticket && it?.ticketing?.twoWay) toast(`${t.ticket.key} moved to ${label} in ${kindDef(it.kind).label}`, "info");
        else toast(`Moved to ${label.toLowerCase()}`, "info");
      }
    }
  };

  return (
    <>
      <PageHead title="Board" subtitle={board.live ? "Work for your agents. Queue a task and its agent picks it up, then it waits here for your review." : "What each agent is working on. Drag a task to change its status."}>
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
        <div className="stat"><div className="stat-label">{board.live ? "Done" : "Done today"}</div><div className="stat-value">{count("done")}</div><div className="stat-sub">{count("failed")} failed</div></div>
        <div className="stat"><div className="stat-label">{board.live ? "Cost" : "Cost today"}</div><div className="stat-value">{usd(tasks.reduce((s, t) => s + t.cost, 0))}</div><div className="stat-sub">{tasks.reduce((s, t) => s + t.minutes, 0)} agent minutes</div></div>
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
                  live={board.live}
                  onDelete={() => { board.remove(t.id); if (openId === t.id) setOpenId(null); }}
                  onOpen={() => setOpenId(t.id)}
                  selected={openId === t.id}
                />
              ))}
              {items.length === 0 && <div className="column-empty">{board.loading ? "Loading…" : "Nothing here"}</div>}
            </div>
          );
        })}
      </div>

      {creating && <NewTask board={board} onClose={() => setCreating(false)} />}
      {opened && <TaskPanel key={opened.id} board={board} task={opened} onClose={() => setOpenId(null)} />}
      {importing && <ImportTickets board={board} onClose={() => setImporting(false)} />}
    </>
  );
}

function TaskCard({ task: t, agent, live, dragging, selected, onDragStart, onDragEnd, onDelete, onOpen }: {
  task: Task; agent: string; live: boolean; dragging: boolean; selected: boolean; onDragStart: () => void; onDragEnd: () => void; onDelete: () => void; onOpen: () => void;
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
      {t.status === "running" && !live && <div className="bar"><span style={{ width: `${t.progress * 100}%` }} /></div>}
      {t.status === "failed" && t.note && <p className="task-desc" style={{ color: "var(--err)" }}>{t.note}</p>}
      {t.status === "queued" && t.reviewNote && <p className="task-desc faint">Changes requested</p>}
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

function NewTask({ board, onClose }: { board: Board; onClose: () => void }) {
  const toast = useToast();
  const agents = useNamespaced().agents.filter((a) => !a.master);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [priority, setPriority] = useState<Task["priority"]>("normal");
  const { errors, check, clear } = useErrors();

  const create = async () => {
    const ok = check({
      title: title.trim() ? undefined : "Give the task a title.",
      description: description.length > MAX_DESCRIPTION ? `Keep the description under ${MAX_DESCRIPTION} characters.` : undefined,
      agent: agentId ? undefined : agents.length ? "Pick an agent." : "Create an agent first.",
    });
    if (!ok) return;
    if (!(await board.create({ title: title.trim(), description: description.trim() || undefined, agentId, priority }))) return;
    toast("Task queued");
    onClose();
  };

  return (
    <Modal title="New task" subtitle={board.live ? "The agent picks it up when it is free, starting it if it is stopped." : "The agent picks it up when it is free."} onClose={onClose}>
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
function TaskPanel({ board, task, onClose }: { board: Board; task: Task; onClose: () => void }) {
  const { state } = useStore();
  const agents = useNamespaced().agents.filter((a) => !a.master);
  const [changes, setChanges] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const column = COLUMNS.find((c) => c.id === task.status);
  const ticketSource = task.ticket && state.integrations.find((i) => i.id === task.ticket?.integrationId);
  const update = (patch: TaskEdit) => board.update(task.id, patch);
  const decide = async (approve: boolean) => {
    setReviewing(true);
    const ok = await board.review(task.id, approve, changes);
    setReviewing(false);
    if (ok) setChanges("");
  };

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
            <select className="side-panel-status" value={task.status} onChange={(e) => board.move(task.id, e.target.value as TaskStatus)} aria-label="Status">
              {COLUMNS.map((c) => <option key={c.id} value={c.id} disabled={board.live && c.id === "running" && task.status !== "running"}>{c.label}</option>)}
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
            {task.status === "running" && !board.live && <div className="bar"><span style={{ width: `${task.progress * 100}%` }} /></div>}
            {board.live && task.status === "running" && <p className="dim small">{agents.find((a) => a.id === task.agentId)?.name ?? "The agent"} is working on it. It moves to In review when the agent answers.</p>}
            {board.live && task.status === "failed" && task.note && <p className="small" style={{ color: "var(--err)" }}>{task.note}</p>}

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

            {board.live && task.result && (task.status === "review" || task.status === "done" || task.status === "failed") && (
              <section>
                <div className="faint small" style={{ marginBottom: 6 }}>What {agents.find((a) => a.id === task.agentId)?.name ?? "the agent"} said{task.note && task.status !== "failed" ? <> · {task.note}</> : null}</div>
                <div className="task-result"><Markdown text={task.result} /></div>
              </section>
            )}

            {board.live && task.status === "review" && (
              <section>
                <textarea
                  className="textarea"
                  rows={3}
                  value={changes}
                  onChange={(e) => setChanges(e.target.value)}
                  placeholder="What should change? Needed only to send it back."
                  aria-label="Changes to ask for"
                />
                <div className="row" style={{ marginTop: 8, gap: 8 }}>
                  <span className="spacer" />
                  <button className="btn" disabled={reviewing || !changes.trim()} onClick={() => decide(false)}><RotateCcw size={13} /> Request changes</button>
                  <button className="btn primary" disabled={reviewing} onClick={() => decide(true)}><Check size={13} /> Approve</button>
                </div>
              </section>
            )}
            {board.live && task.status === "queued" && task.reviewNote && (
              <p className="dim small">Sent back with: “{task.reviewNote}”. The agent gets these notes when it picks the task up again.</p>
            )}

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
              <dd className="dim">{task.minutes} min, {usd(task.cost)}{task.attempts && task.attempts > 1 ? `, over ${task.attempts} attempts` : ""}</dd>
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
            <button className="btn ghost sm danger" onClick={() => { board.remove(task.id); onClose(); }}>
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

function ImportTickets({ board, onClose }: { board: Board; onClose: () => void }) {
  const { state } = useStore();
  const toast = useToast();
  const { integrations } = useNamespaced();
  const agents = useNamespaced().agents.filter((a) => !a.master);
  const tasks = board.tasks;
  const sources = integrations.filter((i) => i.ticketing);
  const linked = new Set(tasks.map((t) => t.ticket?.key).filter(Boolean));
  const available = state.tickets.filter((t) => sources.some((s) => s.id === t.integrationId) && !linked.has(t.key));
  const [picked, setPicked] = useState<string[]>([]);
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const { errors, check, clear } = useErrors();
  const toggle = (key: string) => { setPicked(picked.includes(key) ? picked.filter((k) => k !== key) : [...picked, key]); clear("tickets"); };

  const importNow = async () => {
    const ok = check({
      tickets: picked.length ? undefined : available.length ? "Pick at least one ticket." : "There is nothing left to import.",
      agent: agentId ? undefined : "Create an agent to assign these to.",
    });
    if (!ok) return;
    for (const t of available.filter((x) => picked.includes(x.key))) {
      await board.create({ title: t.title, description: t.description, agentId, priority: t.priority, ticket: { integrationId: t.integrationId, key: t.key, url: t.url } });
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
