# Todo Planner Card

A Lovelace card for Home Assistant to-do lists with **start date**, **deadline** and **priority**,
and an inline form to add tasks straight from the dashboard.

- Works on top of any native `todo.*` entity that supports due dates and descriptions
  (for example the built-in **Local To-do** integration). No extra backend: your tasks stay in
  Home Assistant and remain visible in the standard To-do panel, the companion app and Assist.
- Add a task with title, start date (leave it empty to use today), deadline and priority.
- Open tasks are sorted by priority, then by deadline. Deadlines within two days are highlighted,
  overdue ones are marked.
- Optional grouping by priority.
- Optional drag & drop reordering, shown **only to Home Assistant administrators**. Dropping a task
  into another priority group changes its priority. Works with touch screens.
- Visual editor, English and Italian (follows your Home Assistant language).

## How the data is stored

| Field      | Where                                                                   |
|------------|-------------------------------------------------------------------------|
| Title      | item summary                                                            |
| Deadline   | item due date                                                           |
| Start date | first line of the description, e.g. `Start: 2026-11-02 · Priority: high` |
| Priority   | same line (`high`, `medium`, `low`)                                     |

Anything after the first line of the description is kept as notes.

## Installation

### HACS (custom repository)

1. HACS → three dots → **Custom repositories**.
2. Add `https://github.com/dllfpp/todo-planner-card`, type **Dashboard**.
3. Download **Todo Planner Card** and reload the browser.

### Manual

Copy `todo-planner-card.js` to `/config/www/` and add it as a dashboard resource
(`/local/todo-planner-card.js`, type JavaScript module).

## Configuration

Create a to-do list first (Settings → Devices & services → Add integration → **Local To-do**),
then add the card from the dashboard editor or in YAML:

```yaml
type: custom:todo-planner-card
entity: todo.tasks
title: To-do
group_by_priority: true
allow_reorder: true
show_completed: false
```

| Option              | Default         | Description                                                                 |
|---------------------|-----------------|-----------------------------------------------------------------------------|
| `entity`            | required        | The `todo.*` entity.                                                        |
| `title`             | entity name     | Card title.                                                                 |
| `group_by_priority` | `false`         | Show open tasks in High / Medium / Low groups.                              |
| `allow_reorder`     | `false`         | Manual order with drag & drop, for administrators only. Replaces the automatic priority/deadline sort. Needs a list that supports moving items (Local To-do does). |
| `show_completed`    | `false`         | Show completed tasks by default (they can always be toggled).               |
| `language`          | HA language     | `en` or `it`.                                                               |

## License

MIT © dllfpp
