# Community Custom Fields

A Discourse plugin that turns topics into support tickets: it adds ticketing
**custom fields** and a **status workflow**, and records every status change to
an **audit table** so you can report on ticket flow and time-in-status.

> Backend-only today — `assets/javascripts` and `test/javascripts` are
> placeholders, and almost all logic lives in `plugin.rb`.

## What it does

- Adds a set of **custom fields** to every topic (assignee, priority, account,
  status, timestamps, …).
- Maintains a **ticket status state machine** (`new → open → snoozed / closed`
  and back) automatically as posts are created.
- Records every status transition to a **history table** with who/what
  triggered it and how long the previous status lasted.
- Exposes an **admin API endpoint** for setting custom fields on a topic.

## Custom fields

`CommunityCustomFields::CUSTOM_FIELDS` in `plugin.rb` is the single source of
truth — add a field there and it's automatically registered on `Topic`,
preloaded on `TopicList`, exposed on the `topic_view` serializer, and made
settable through the controller.

| Field | Type | Purpose |
|---|---|---|
| `status` | string | Ticket status — one of `new` / `open` / `snoozed` / `closed` |
| `assignee_id` | integer | Current assignee |
| `first_assigned_to_id` / `first_assigned_at` | integer / datetime | First assignment |
| `last_assigned_to_id` / `last_assigned_at` | integer / datetime | Most recent assignment |
| `waiting_id` / `waiting_since` | integer / datetime | Customer awaiting a reply, and since when |
| `priority` | string | Ticket priority |
| `product_area` | string | Product area |
| `account_name` | string | Account name |
| `is_committed` / `is_agency` | boolean | Account flags |
| `outcome` | string | Resolution outcome |
| `closed_at` | datetime | When the ticket was closed |
| `snoozed_until` | datetime | Snooze expiry |

## Status lifecycle

`topic_created` seeds `status = "new"`. From there, `post_created` maintains
state based on who posts and how:

- **Customer reply** (non-admin) — marks the customer as waiting (`waiting_*`);
  reopens a `snoozed` topic to `open`. Reopening a `closed` topic goes to
  `open` and reassigns to the last assignee, **unless** it was closed over a
  month ago or was never assigned, in which case it reopens as `new`.
- **Admin reply** (regular) — clears `waiting_*`; leaves the status unchanged.
- **Admin whisper** (staff-only note) — reopens a `snoozed` / `closed` topic
  (same closed → `open`/`new` logic, without the one-month rule) and does *not*
  clear `waiting_*`.
- System users (`id <= 0`) and non-`regular` archetypes (PMs, etc.) are skipped.

Valid statuses are `CommunityCustomFields::STATUSES` (`new`, `open`, `snoozed`,
`closed`); the admin endpoint rejects anything else with `422`.

## Status-change history

Every real transition is written to `community_custom_fields_topic_status_changes`
(model `CommunityCustomFields::TopicStatusChange`). `TopicStatusChange.record`
is the single writer and no-ops when the status doesn't actually change. Each
row captures:

| Column | Meaning |
|---|---|
| `from_status` / `to_status` | The transition (`from_status` is null when the topic had no prior status) |
| `source` | `"api_update"` (admin endpoint) or `"post_creation"` (a post) |
| `user_id` | The admin who made an `api_update` change |
| `post_id` | The post that triggered a `post_creation` change |
| `assignee_id` | The assignee *before* the change |
| `duration` | Seconds spent in the status being left |

`topic_created` is intentionally not recorded, so a ticket's history begins at
its first real transition. The table isn't exposed over the API — query it with
[Data Explorer](https://github.com/discourse/discourse-data-explorer) or SQL.

## Admin API

```
PUT /admin/plugins/community-custom-fields/:topic_id.json
```

Admin-only. Sets any custom fields on a topic:

```json
{ "custom_field": { "status": "closed", "assignee_id": 42 } }
```

Uses `Topic.unscoped` so it works on topics that normal scopes hide (deleted,
closed). An out-of-range `status` returns `422`; a `status` change is recorded
as an `api_update` history row.

## Installation

Standard [Discourse plugin install](https://meta.discourse.org/t/install-plugins-in-discourse/19157) —
add it to your `app.yml` and rebuild:

```yaml
hooks:
  after_code:
    - exec:
        cd: $home/plugins
        cmd:
          - git clone https://github.com/tryretool/community-custom-fields.git
```

Then enable it under **Admin → Plugins** (the `community_custom_fields_enabled`
site setting).

## Development

Tests are Discourse specs and run from a Discourse host app with this plugin
symlinked into `plugins/`:

```bash
LOAD_PLUGINS=1 bin/rspec plugins/community-custom-fields/spec
```

Linting uses Discourse's shared configs:

```bash
bundle exec rubocop
bundle exec stree check Gemfile $(git ls-files '*.rb')
pnpm eslint . && pnpm prettier --check .
```

`test/staging/` contains a standalone Node script for smoke-testing the feature
against a live instance over the API — see `test/staging/README.md`.
