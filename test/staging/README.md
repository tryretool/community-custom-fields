# Staging integration suite

`run.mjs` exercises the status-history feature against a **live** Discourse
instance over the HTTP API. It drives the real surfaces — creating topics and
posts as an admin and as a customer, and calling the admin custom-fields
endpoint — then verifies both the observable topic `custom_fields` **and** the
actual rows written to `community_custom_fields_topic_status_changes`, read
back through Data Explorer.

## Requirements

- **Node ≥ 18** (uses the built-in `fetch`); no npm install needed.
- An **admin API key**. Use an **"All Users" (global)** key so the suite can
  act as both the admin and a non-admin customer via the `Api-Username` header.
- **discourse-data-explorer** enabled on the target instance (used to read the
  history table, which the plugin does not expose over the API).

## Usage

```bash
DISCOURSE_URL=https://staging.example.com \
DISCOURSE_API_KEY=xxxxxxxxxxxxxxxx \
DISCOURSE_API_USERNAME=your_admin \
node test/staging/run.mjs
```

Exit code is `0` if all checks pass, `1` if any fail, `2` on a fatal setup error.

### Environment variables

| Var | Required | Purpose |
|-----|----------|---------|
| `DISCOURSE_URL` | yes | Base URL of the target instance |
| `DISCOURSE_API_KEY` | yes | Admin, ideally global ("All Users") API key |
| `DISCOURSE_API_USERNAME` | yes | Admin username the key acts as |
| `CUSTOMER_USERNAME` | no | Existing non-admin user to post as; otherwise a `ccf_test_customer` user is created |
| `CATEGORY_ID` | no | Category to create test topics in; otherwise the first postable one |
| `KEEP_DATA` | no | Set to any value to skip cleanup (leave test topics + the temp query) |

Do **not** hardcode the key in a file or paste it into chat — pass it via the
environment at run time.

## What it checks

**`api_update` (admin PUT):**
- Every ordered status transition among `new/open/snoozed/closed` (all 12 pairs)
  → a row with `source="api_update"`, the acting `user_id`, null `post_id`, and
  a non-negative `duration`.
- Invalid status → `422`, nothing persisted or recorded.
- An update that changes no status → no row.
- The row is attributed to the assignee *before* the change.

**`post_created`:**
- Customer reply reopening a snoozed topic → `post_creation` row (triggering
  `post_id`, null `user_id`, pre-change `assignee_id`).
- Customer reply to a closed topic: recent + last-assigned → `open` (reassigned);
  no last-assignee → `new`; closed > 1 month ago → `new`.
- Customer reply to a new/open topic → sets `waiting_*`, records no row.
- Admin whisper reopening snoozed → `open`, and closed → `open`/`new`
  (skipped if whispers are disabled).
- Admin whisper on an open topic → no change, no row.
- Admin regular reply → clears `waiting_*`, records no row.
- `topic_created` seeds `status="new"` and records no row.

## Safety notes

- Creates topics titled `CCF-STAGING-TEST …` and **deletes them** at the end
  (unless `KEEP_DATA` is set). Deleted topics are trashed, not purged.
- The `TopicStatusChange` rows for those topics are **not** removed — the plugin
  exposes no delete path, and Data Explorer is read-only. They reference
  now-deleted topics; purge them directly in the DB if you care.
- If `CUSTOMER_USERNAME` is unset it creates `ccf_test_customer`; on instances
  with restricted signup this may fail — set `CUSTOMER_USERNAME` to an existing
  non-admin user instead.
- A full run creates ~30 topics. The suite honors rate limits automatically
  (it waits out any `429` and retries), so on a heavily rate-limited instance a
  run can take a few minutes; an admin/API key exempt from create limits is
  fastest.
