# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Discourse plugin that adds custom fields to topics so Discourse can be used as a support/ticketing platform. It is currently **backend-only** — the `assets/javascripts` and `test/javascripts` directories are empty placeholders. Almost all logic lives in `plugin.rb`.

## Architecture

### `CUSTOM_FIELDS` registry (`plugin.rb`)
The `CommunityCustomFields::CUSTOM_FIELDS` hash (name → type) is the single source of truth. Adding a field there automatically: registers its type on `Topic`, preloads it on `TopicList`, exposes it via the `topic_view` serializer, and makes it permittable in the controller's strong params. Add a field in one place only.

### The support-ticket state machine (`plugin.rb` event handlers)
The non-obvious core is the `topic_created` and `post_created` handlers, which maintain ticket state on topic custom fields. Understand these before editing:

- **`status`** moves through `"new"` → `"open"` → `"snoozed"`/`"closed"` and back. `topic_created` seeds `status = "new"`. Valid values are the `CommunityCustomFields::STATUSES` list.
- **`waiting_since` / `waiting_id`** track the customer who is waiting on a reply. Set when a non-admin posts; cleared when an admin posts a regular reply.
- **`post_type`** drives branching: `1` = regular reply, `4` = whisper (staff-only note). Other post types are ignored. The first post (`post_number == 1`) is skipped because `topic_created` already handled it.
- **Admin regular reply** (type 1): clears `waiting_*`.
- **Admin whisper** (type 4): does *not* clear `waiting_*`, but can reopen a `snoozed`/`closed` topic.
- **Customer reply** (non-admin): sets `waiting_*`, reopens `snoozed`, and reopens `closed` — with a **1-month rule**: if the topic was closed more than a month ago (or had no `last_assigned_to_id`), it reopens as `"new"`; otherwise it reopens as `"open"` and is reassigned to the last assignee.
- `user.id <= 0` (system users) and non-`"regular"` archetypes (e.g. PMs) are skipped.

### Controller (`app/controllers/community_custom_fields/custom_fields_controller.rb`)
Admin-only `PUT` endpoint to set custom fields on a topic. Mounted at `/admin/plugins/community-custom-fields/:topic_id` (see `config/routes.rb`). Uses `Topic.unscoped.find` so it can update topics that are otherwise filtered out (e.g. deleted/closed). It validates any incoming `status` against `CommunityCustomFields::STATUSES` (rejecting unknown values with `422`) and records a status change (see below).

### Status-change history (`TopicStatusChange`)
Every status transition is logged to the `community_custom_fields_topic_status_changes` table (model: `app/models/community_custom_fields/topic_status_change.rb`). `TopicStatusChange.record` is the single writer — it no-ops unless the topic's current `status` differs from the passed `from_status`. It's called from two places, and `topic_created` is intentionally *not* recorded (no initial `"new"` row):

- **Controller** (`source: "api_update"`) — passes the acting admin as `user_id`.
- **`post_created`** (`source: "post_creation"`) — passes the triggering `post_id`.

Row columns:
- **`from_status` / `to_status`** — the transition; `from_status` is null when the topic had no prior status.
- **`assignee_id`** — the assignee *before* the change (attributes the change to whoever owned the ticket during the status being left).
- **`user_id`** (api_update) / **`post_id`** (post_creation) — what triggered the change; only one is set per row.
- **`duration`** — seconds spent in the status being left. Measured from the prior recorded change; for a topic with no table entry yet, from when the current status was set (its `topic_custom_fields` row); otherwise from `topic.created_at`.
- **`source`** — `"api_update"` or `"post_creation"`.

## Commands

Tests are **Discourse system specs** and cannot run standalone from this repo — they run inside a Discourse host app with this plugin symlinked into `plugins/`. From the Discourse core root:

```bash
LOAD_PLUGINS=1 bin/rspec plugins/community-custom-fields/spec/system/core_features_spec.rb
```

Linting uses Discourse's shared configs (`@discourse/lint-configs`). Install with `pnpm install` (pnpm 9.x, Node ≥ 22 required), then:

```bash
pnpm eslint .                  # JS
pnpm ember-template-lint .     # Ember templates
pnpm stylelint "**/*.scss"     # styles
pnpm prettier --check .        # formatting
bundle exec rubocop            # Ruby (rubocop-discourse, stree-compatible)
bundle exec stree check .      # Ruby formatting (syntax_tree, print-width 100)
```

CI (`.github/workflows/discourse-plugin.yml`) runs the shared `discourse/.github` plugin workflow on push to `main` and on PRs.
