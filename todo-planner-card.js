/*
 * Todo Planner Card: a Lovelace card for Home Assistant to-do lists with start date,
 * deadline and priority. Data lives in a native todo.* entity (for example Local To-do):
 * the deadline is the item's due date; start date and priority are kept in the first
 * line of the description ("Start: 2026-11-02 · Priority: high"), so the list stays
 * readable in the standard to-do panel and in the companion app.
 * MIT License, dllfpp.
 */
const VERSION = "1.0.3";

const I18N = {
  en: {
    add: "Add", cancel: "Cancel", save: "Save", task: "Task", start: "Start", deadline: "Deadline",
    priority: "Priority", high: "High", medium: "Medium", low: "Low", today: "today",
    startHint: "Empty = today", from: "from", due: "due", overdue: "overdue",
    empty: "Nothing to do", done: "done", showDone: "Show done", hideDone: "Hide done",
    remove: "Remove", complete: "Mark as done", reopen: "Mark as not done", noEntity: "Entity not found",
    newTask: "New task", taskPh: "What needs doing?", drag: "Drag to reorder",
    groupHigh: "High priority", groupMedium: "Medium priority", groupLow: "Low priority",
  },
  it: {
    add: "Aggiungi", cancel: "Annulla", save: "Salva", task: "Attività", start: "Inizio", deadline: "Scadenza",
    priority: "Priorità", high: "Alta", medium: "Media", low: "Bassa", today: "oggi",
    startHint: "Vuoto = oggi", from: "dal", due: "entro", overdue: "scaduta",
    empty: "Niente da fare", done: "fatte", showDone: "Mostra fatte", hideDone: "Nascondi fatte",
    remove: "Elimina", complete: "Segna come fatta", reopen: "Segna come da fare", noEntity: "Entità non trovata",
    newTask: "Nuova attività", taskPh: "Cosa c'è da fare?", drag: "Trascina per riordinare",
    groupHigh: "Priorità alta", groupMedium: "Priorità media", groupLow: "Priorità bassa",
  },
};
// Priority words accepted when reading descriptions (any supported language).
const PRIO_WORDS = { high: ["high", "alta"], medium: ["medium", "media"], low: ["low", "bassa"] };
const PRIO_RANK = { high: 0, medium: 1, low: 2 };
const META_RE = /^(?:start|inizio):\s*(\d{4}-\d{2}-\d{2})\s*·\s*(?:priority|priorità):\s*(\w+)\s*$/i;

function parseMeta(description) {
  const [first, ...rest] = (description || "").split("\n");
  const m = META_RE.exec(first.trim());
  if (!m) return { start: null, priority: "medium", notes: description || "" };
  const word = m[2].toLowerCase();
  const priority = Object.keys(PRIO_WORDS).find((p) => PRIO_WORDS[p].includes(word)) || "medium";
  return { start: m[1], priority, notes: rest.join("\n").trim() };
}

function buildDescription(t, start, priority, notes) {
  const line = `${t.start}: ${start} · ${t.priority}: ${t[priority].toLowerCase()}`;
  return notes ? `${line}\n${notes}` : line;
}

function isoToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function daysUntil(iso) {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const target = new Date(y, m - 1, d);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / 86400000);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

class TodoPlannerCard extends HTMLElement {
  // Visual editor: Home Assistant builds it from this schema.
  static getConfigForm() {
    return {
      schema: [
        { name: "entity", required: true, selector: { entity: { domain: "todo" } } },
        { name: "title", selector: { text: {} } },
        {
          type: "grid",
          name: "",
          schema: [
            { name: "group_by_priority", selector: { boolean: {} } },
            { name: "allow_reorder", selector: { boolean: {} } },
            { name: "show_completed", selector: { boolean: {} } },
          ],
        },
      ],
      computeLabel: (s) =>
        ({
          entity: "To-do list",
          title: "Title",
          group_by_priority: "Group by priority",
          allow_reorder: "Drag & drop reordering (admins only)",
          show_completed: "Show completed by default",
        })[s.name],
      computeHelper: (s) =>
        s.name === "allow_reorder" ? "Manual order replaces the automatic priority/deadline sort." : undefined,
    };
  }

  static getStubConfig(hass) {
    const entity = Object.keys(hass?.states || {}).find((e) => e.startsWith("todo.")) || "todo.example";
    return { entity };
  }

  setConfig(config) {
    if (!config.entity || !config.entity.startsWith("todo.")) throw new Error("Set 'entity' to a todo.* entity");
    this._config = { show_completed: false, group_by_priority: false, allow_reorder: false, ...config };
    this._showDone = !!this._config.show_completed;
    this._formOpen = false;
    this._setLanguage();
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    this._setLanguage();
    if (first || !this._unsub) this._subscribe();
  }

  // Texts are needed by every render, which can happen before or after hass arrives.
  _setLanguage() {
    const lang = (this._config?.language || this._hass?.locale?.language || this._hass?.language || "en").slice(0, 2);
    this._t = I18N[lang] || I18N.en;
    this._locale = this._hass?.locale?.language || lang;
  }

  connectedCallback() {
    if (this._hass && !this._unsub) this._subscribe();
  }

  disconnectedCallback() {
    if (this._unsub) {
      this._unsub.then((u) => u && u()).catch(() => {});
      this._unsub = null;
    }
  }

  getCardSize() {
    return 5;
  }

  getGridOptions() {
    return { columns: 6, rows: 5, min_rows: 3 };
  }

  _subscribe() {
    if (!this._hass || !this._config || !this.isConnected) return;
    this._unsub = this._hass.connection
      .subscribeMessage(
        (msg) => {
          this._items = msg.items || [];
          this._render();
        },
        { type: "todo/item/subscribe", entity_id: this._config.entity },
      )
      .catch((err) => {
        this._error = err.message || String(err);
        this._unsub = null;
        this._render();
      });
  }

  _call(service, data) {
    return this._hass.callService("todo", service, data, { entity_id: this._config.entity });
  }

  _sorted() {
    const items = (this._items || []).map((it) => ({ ...it, meta: parseMeta(it.description) }));
    const manual = this._config.allow_reorder;
    const open = items
      .filter((it) => it.status !== "completed")
      .sort((a, b) => {
        if (manual) return 0; // keep the list's own (manually arranged) order
        const p = PRIO_RANK[a.meta.priority] - PRIO_RANK[b.meta.priority];
        if (p) return p;
        if (a.due && b.due) return a.due.localeCompare(b.due);
        return a.due ? -1 : b.due ? 1 : 0;
      });
    const done = items.filter((it) => it.status === "completed");
    return { open, done };
  }

  // Drag handles appear only when enabled in the card config and for HA administrators.
  _canReorder() {
    return !!(this._config.allow_reorder && this._hass?.user?.is_admin);
  }

  _fmt(iso) {
    const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(this._locale, { day: "2-digit", month: "short" });
  }

  _row(it) {
    const t = this._t;
    const done = it.status === "completed";
    const chips = [];
    chips.push(`<span class="chip prio-${it.meta.priority}">${esc(t[it.meta.priority])}</span>`);
    if (it.meta.start && daysUntil(it.meta.start) > 0) chips.push(`<span class="chip">${t.from} ${esc(this._fmt(it.meta.start))}</span>`);
    if (it.due) {
      const left = daysUntil(it.due);
      const cls = done ? "" : left < 0 ? "late" : left <= 2 ? "soon" : "";
      const label = !done && left < 0 ? `${t.overdue} ${esc(this._fmt(it.due))}` : `${t.due} ${esc(this._fmt(it.due))}`;
      chips.push(`<span class="chip ${cls}">${label}</span>`);
    }
    return `
      <li class="row ${done ? "done" : ""} bar-${it.meta.priority}" data-uid="${esc(it.uid)}" data-prio="${it.meta.priority}">
        ${!done && this._canReorder() ? `<span class="handle" data-drag aria-label="${t.drag}" title="${t.drag}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h2v2H9zm4 0h2v2h-2zM9 7h2v2H9zm4 0h2v2h-2zm-4 4h2v2H9zm4 0h2v2h-2zm-4 4h2v2H9zm4 0h2v2h-2zm-4 4h2v2H9zm4 0h2v2h-2z"/></svg></span>` : ""}
        <button class="check" data-act="toggle" data-uid="${esc(it.uid)}" aria-label="${done ? t.reopen : t.complete}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="${done ? "M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" : ""}"/></svg>
        </button>
        <div class="body">
          <div class="summary">${esc(it.summary)}</div>
          <div class="chips">${chips.join("")}</div>
        </div>
        <button class="icon" data-act="remove" data-uid="${esc(it.uid)}" aria-label="${t.remove}" title="${t.remove}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      </li>`;
  }

  _openList(open) {
    const t = this._t;
    if (!open.length) return `<ul class="list"><li class="empty">${t.empty}</li></ul>`;
    if (!this._config.group_by_priority) return `<ul class="list" data-group="">${open.map((it) => this._row(it)).join("")}</ul>`;
    const names = { high: t.groupHigh, medium: t.groupMedium, low: t.groupLow };
    return ["high", "medium", "low"]
      .map((p) => {
        const rows = open.filter((it) => it.meta.priority === p);
        if (!rows.length && !this._canReorder()) return "";
        return `<h3 class="group prio-${p}">${names[p]} <span>${rows.length}</span></h3>
          <ul class="list" data-group="${p}">${rows.map((it) => this._row(it)).join("")}</ul>`;
      })
      .join("");
  }

  _form() {
    const t = this._t;
    const prio = this._draftPrio || "medium";
    return `
      <form class="form" novalidate>
        <label class="field wide"><span>${t.task}</span>
          <input name="summary" required autocomplete="off" placeholder="${t.taskPh}" />
        </label>
        <label class="field"><span>${t.start}</span>
          <input name="start" type="date" aria-describedby="start-hint" />
          <small id="start-hint">${t.startHint}</small>
        </label>
        <label class="field"><span>${t.deadline}</span>
          <input name="due" type="date" />
        </label>
        <fieldset class="field wide prio">
          <legend>${t.priority}</legend>
          ${["high", "medium", "low"]
            .map((p) => `<button type="button" class="seg prio-${p} ${p === prio ? "on" : ""}" data-act="prio" data-prio="${p}" aria-pressed="${p === prio}">${t[p]}</button>`)
            .join("")}
        </fieldset>
        <p class="error" role="alert"></p>
        <div class="actions wide">
          <button type="button" class="btn ghost" data-act="cancel">${t.cancel}</button>
          <button type="submit" class="btn primary">${t.save}</button>
        </div>
      </form>`;
  }

  _render() {
    if (!this.shadowRoot || !this._config) return;
    const t = this._t || I18N.en;
    const title = this._config.title ?? this._hass?.states[this._config.entity]?.attributes.friendly_name ?? "";
    let content;
    if (this._error) content = `<p class="empty">${esc(this._error)}</p>`;
    else if (this._hass && !this._hass.states[this._config.entity]) content = `<p class="empty">${t.noEntity}: ${esc(this._config.entity)}</p>`;
    else {
      const { open, done } = this._sorted();
      content = `
        ${this._openList(open)}
        ${done.length ? `<button class="link" data-act="done">${this._showDone ? t.hideDone : t.showDone} (${done.length})</button>` : ""}
        ${this._showDone && done.length ? `<ul class="list">${done.map((it) => this._row(it)).join("")}</ul>` : ""}`;
    }
    // ha-card is created once and kept: styles injected into it by other tools (card-mod, UIX) survive updates.
    if (!this._card) {
      this.shadowRoot.innerHTML = `<style>${STYLE}</style><ha-card></ha-card>`;
      this._card = this.shadowRoot.querySelector("ha-card");
    }
    this._card.innerHTML = `
        <div class="head">
          <h2>${esc(title)}</h2>
          ${this._formOpen ? "" : `<button class="btn primary add" data-act="open" aria-label="${t.newTask}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z"/></svg><span>${t.add}</span></button>`}
        </div>
        ${this._formOpen ? this._form() : ""}
        <div class="scroll">${content}</div>`;
    this.shadowRoot.querySelectorAll("[data-act]").forEach((el) => el.addEventListener("click", (e) => this._onAct(e, el)));
    this.shadowRoot.querySelectorAll("[data-drag]").forEach((h) => h.addEventListener("pointerdown", (e) => this._dragStart(e, h)));
    const form = this.shadowRoot.querySelector("form");
    if (form) {
      form.addEventListener("submit", (e) => this._onSubmit(e, form));
      if (this._focusForm) {
        form.elements.namedItem("summary").focus();
        this._focusForm = false;
      }
    }
  }

  _onAct(e, el) {
    e.preventDefault();
    const act = el.dataset.act;
    const item = (this._items || []).find((it) => it.uid === el.dataset.uid);
    if (act === "open") {
      this._formOpen = true;
      this._draftPrio = "medium";
      this._focusForm = true;
      this._render();
    } else if (act === "cancel") {
      this._formOpen = false;
      this._render();
    } else if (act === "prio") {
      this._draftPrio = el.dataset.prio;
      this.shadowRoot.querySelectorAll(".seg").forEach((b) => {
        const on = b.dataset.prio === this._draftPrio;
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", String(on));
      });
    } else if (act === "done") {
      this._showDone = !this._showDone;
      this._render();
    } else if (act === "toggle" && item) {
      this._call("update_item", { item: item.uid, status: item.status === "completed" ? "needs_action" : "completed" });
    } else if (act === "remove" && item) {
      this._call("remove_item", { item: item.uid });
    }
  }

  _dragStart(e, handle) {
    e.preventDefault();
    const row = handle.closest(".row");
    const root = this.shadowRoot;
    row.classList.add("dragging");
    handle.setPointerCapture(e.pointerId);
    let target = null; // { list, before: row|null }
    const move = (ev) => {
      root.querySelectorAll(".drop-before, .drop-end").forEach((x) => x.classList.remove("drop-before", "drop-end"));
      const el = root.elementFromPoint(ev.clientX, ev.clientY);
      const list = el?.closest("ul.list[data-group]");
      if (!list) return (target = null);
      const over = el.closest(".row:not(.dragging)");
      let before = over;
      if (over && ev.clientY > over.getBoundingClientRect().top + over.offsetHeight / 2) before = over.nextElementSibling;
      while (before && !before.classList.contains("row")) before = before.nextElementSibling;
      target = { list, before };
      before ? before.classList.add("drop-before") : list.classList.add("drop-end");
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      row.classList.remove("dragging");
      root.querySelectorAll(".drop-before, .drop-end").forEach((x) => x.classList.remove("drop-before", "drop-end"));
      if (target && target.before !== row) this._drop(row.dataset.uid, target);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  }

  async _drop(uid, { list, before }) {
    const all = this._items || [];
    const item = all.find((it) => it.uid === uid);
    if (!item) return;
    // previous_uid = item that will precede the moved one in the full list.
    let previous;
    if (before) {
      const idx = all.findIndex((it) => it.uid === before.dataset.uid);
      previous = all.slice(0, idx).filter((it) => it.uid !== uid).pop();
    } else {
      const rows = [...list.querySelectorAll(".row")].filter((r) => r.dataset.uid !== uid);
      previous = rows.length ? all.find((it) => it.uid === rows[rows.length - 1].dataset.uid) : null;
      if (!previous && before === null && list.dataset.group) {
        // empty group: place after the last item of the groups above
        const order = ["high", "medium", "low"];
        const above = all.filter((it) => it.uid !== uid && order.indexOf(parseMeta(it.description).priority) < order.indexOf(list.dataset.group));
        previous = above.pop() || null;
      }
    }
    try {
      const msg = { type: "todo/item/move", entity_id: this._config.entity, uid };
      if (previous) msg.previous_uid = previous.uid;
      await this._hass.callWS(msg);
      const group = list.dataset.group;
      const meta = parseMeta(item.description);
      if (group && group !== meta.priority) {
        await this._call("update_item", {
          item: uid,
          description: buildDescription(this._t, meta.start || isoToday(), group, meta.notes),
        });
      }
    } catch (err) {
      this._error = err.message || String(err);
      this._render();
      this._error = null;
    }
  }

  async _onSubmit(e, form) {
    e.preventDefault();
    const t = this._t;
    const summary = form.elements.namedItem("summary").value.trim();
    const error = form.querySelector(".error");
    if (!summary) {
      error.textContent = `${t.task}?`;
      form.elements.namedItem("summary").focus();
      return;
    }
    const start = form.elements.namedItem("start").value || isoToday();
    const data = { item: summary, description: buildDescription(t, start, this._draftPrio || "medium", "") };
    if (form.elements.namedItem("due").value) data.due_date = form.elements.namedItem("due").value;
    try {
      await this._call("add_item", data);
      this._formOpen = false;
      this._render();
    } catch (err) {
      error.textContent = err.message || String(err);
    }
  }
}

const STYLE = `
  :host { display: block; height: 100%; }
  ha-card { height: 100%; min-width: 0; display: flex; flex-direction: column; box-sizing: border-box; padding: 12px 12px 8px; overflow: hidden; }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 44px; }
  h2 { margin: 0; font-size: 18px; font-weight: 600; color: var(--primary-text-color); }
  .scroll { flex: 1 1 auto; overflow-y: auto; min-height: 0; margin-top: 6px; }
  .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .row { display: flex; align-items: center; gap: 8px; padding: 4px 4px 4px 8px; border-radius: 14px;
         background: rgba(255,255,255,0.06); border-left: 4px solid transparent; }
  .bar-high { border-left-color: var(--error-color, #db4437); }
  .bar-medium { border-left-color: var(--warning-color, #ffa600); }
  .bar-low { border-left-color: var(--success-color, #43a047); }
  .row.done { opacity: 0.55; }
  .row.dragging { opacity: 0.4; }
  .row.drop-before { box-shadow: 0 -3px 0 var(--primary-color); }
  .list.drop-end { box-shadow: 0 3px 0 var(--primary-color); min-height: 12px; }
  .handle { flex: 0 0 32px; height: 44px; display: grid; place-items: center; cursor: grab; touch-action: none; color: var(--secondary-text-color); }
  .handle svg { width: 20px; height: 20px; fill: currentColor; }
  .group { display: flex; align-items: center; gap: 6px; margin: 10px 2px 4px; font-size: 13px; font-weight: 600; }
  .group span { font-weight: 400; color: var(--secondary-text-color); }
  .group.prio-high { color: var(--error-color, #db4437); }
  .group.prio-medium { color: var(--warning-color, #ffa600); }
  .group.prio-low { color: var(--success-color, #43a047); }
  .list[data-group] { min-height: 4px; }
  .row.done .summary { text-decoration: line-through; }
  .body { flex: 1 1 auto; min-width: 0; padding: 4px 0; }
  .summary { font-size: 15px; line-height: 1.3; color: var(--primary-text-color); overflow-wrap: anywhere; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
  .chip { font-size: 12px; line-height: 18px; padding: 0 8px; border-radius: 9px; white-space: nowrap;
          background: rgba(255,255,255,0.08); color: var(--secondary-text-color); }
  .chip.prio-high { color: var(--error-color, #db4437); }
  .chip.prio-medium { color: var(--warning-color, #ffa600); }
  .chip.prio-low { color: var(--success-color, #43a047); }
  .chip.soon { color: var(--warning-color, #ffa600); }
  .chip.late { color: #fff; background: var(--error-color, #db4437); }
  button { font: inherit; cursor: pointer; }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
  .check, .icon { flex: 0 0 44px; width: 44px; height: 44px; border: 0; background: none; padding: 0;
                  display: grid; place-items: center; color: var(--secondary-text-color); border-radius: 50%; }
  .check svg { width: 22px; height: 22px; fill: var(--primary-color); border: 2px solid var(--secondary-text-color); border-radius: 7px; box-sizing: border-box; }
  .row.done .check svg { background: var(--primary-color); border-color: var(--primary-color); fill: var(--text-primary-color, #fff); }
  .icon svg { width: 20px; height: 20px; fill: currentColor; }
  .icon:hover { color: var(--error-color, #db4437); }
  .btn { min-height: 44px; padding: 0 16px; border-radius: 22px; border: 0; display: inline-flex; align-items: center; gap: 6px; font-weight: 600; }
  .btn svg { width: 20px; height: 20px; fill: currentColor; }
  .primary { background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .ghost { background: rgba(255,255,255,0.08); color: var(--primary-text-color); }
  .link { border: 0; background: none; color: var(--primary-color); min-height: 44px; padding: 0 4px; }
  .empty { color: var(--secondary-text-color); padding: 12px 4px; }
  .form { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 10px; margin-top: 6px; padding: 10px; border-radius: 16px; background: rgba(255,255,255,0.06); }
  .wide { grid-column: 1 / -1; }
  .field { display: flex; flex-direction: column; gap: 4px; min-width: 0; border: 0; margin: 0; padding: 0; }
  .field > span, legend { font-size: 13px; color: var(--secondary-text-color); padding: 0; }
  .field small { font-size: 12px; color: var(--secondary-text-color); }
  input { min-height: 44px; box-sizing: border-box; width: 100%; padding: 0 12px; border-radius: 12px; font: inherit; font-size: 16px;
          border: 1px solid var(--divider-color, rgba(255,255,255,0.2)); background: var(--card-background-color, transparent);
          color: var(--primary-text-color); color-scheme: dark light; }
  .prio { flex-direction: row; flex-wrap: wrap; gap: 6px; }
  .prio legend { width: 100%; margin-bottom: 4px; }
  .seg { flex: 1 1 0; min-height: 44px; border-radius: 12px; border: 1px solid var(--divider-color, rgba(255,255,255,0.2));
         background: none; color: var(--primary-text-color); }
  .seg.on.prio-high { background: var(--error-color, #db4437); border-color: transparent; color: #fff; }
  .seg.on.prio-medium { background: var(--warning-color, #ffa600); border-color: transparent; color: #000; }
  .seg.on.prio-low { background: var(--success-color, #43a047); border-color: transparent; color: #fff; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; }
  .error { grid-column: 1 / -1; margin: 0; min-height: 0; color: var(--error-color, #db4437); font-size: 13px; }
  .error:empty { display: none; }
  @media (prefers-reduced-motion: no-preference) { .row, .btn, .seg { transition: background-color 150ms ease, opacity 150ms ease; } }
`;

customElements.define("todo-planner-card", TodoPlannerCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "todo-planner-card",
  name: "Todo Planner Card",
  description: "To-do list with start date, deadline and priority",
  documentationURL: "https://github.com/dllfpp/todo-planner-card",
});
console.info(`%c TODO-PLANNER-CARD %c ${VERSION} `, "background:#03a9f4;color:#fff", "");
