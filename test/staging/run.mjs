#!/usr/bin/env node
// Integration suite for the community-custom-fields status-history feature,
// run against a live Discourse instance (e.g. staging) over the HTTP API.
//
// It drives the real surfaces — creating topics/posts as an admin and a
// customer, and calling the admin PUT endpoint — then verifies both the
// observable topic `custom_fields` AND the actual rows written to
// community_custom_fields_topic_status_changes (read back via Data Explorer).
//
// Requirements:
//   - Node >= 18 (uses global fetch)
//   - An admin API key. Use an "All Users" (global) key so the suite can act
//     as both the admin and a non-admin customer via the Api-Username header.
//   - discourse-data-explorer enabled on the target instance.
//
// Usage:
//   DISCOURSE_URL=https://staging.example.com \
//   DISCOURSE_API_KEY=xxxxxxxx \
//   DISCOURSE_API_USERNAME=admin_user \
//   node test/staging/run.mjs
//
// Optional env:
//   CUSTOMER_USERNAME   existing non-admin user to act as (else creates ccf_test_customer)
//   CATEGORY_ID         category to create test topics in (else first unrestricted one)
//   KEEP_DATA=1         skip cleanup (leave test topics + the Data Explorer query)

import process from "node:process";

const cfg = {
  url: reqEnv("DISCOURSE_URL").replace(/\/+$/, ""),
  key: reqEnv("DISCOURSE_API_KEY"),
  admin: reqEnv("DISCOURSE_API_USERNAME"),
  customer: process.env.CUSTOMER_USERNAME || "ccf_test_customer",
  categoryId: process.env.CATEGORY_ID ? Number(process.env.CATEGORY_ID) : null,
  keep: !!process.env.KEEP_DATA,
  prefix: "CCF-STAGING-TEST",
};

function reqEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(2);
  }
  return v;
}

// ---- HTTP ----
async function api(method, path, { body, username } = {}) {
  const headers = {
    "Api-Key": cfg.key,
    "Api-Username": username || cfg.admin,
    "X-Requested-With": "XMLHttpRequest",
    Accept: "application/json",
  };
  let payload;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(cfg.url + path, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON response */
  }
  return { status: res.status, ok: res.ok, json, text };
}

const snippet = (r) => `HTTP ${r.status} ${(r.text || "").replace(/\s+/g, " ").slice(0, 300)}`;

// ---- domain helpers ----
let adminId;
let customerId;
let categoryId;
let queryId;
const createdTopics = new Set();

const num = (x) => (x === null || x === undefined ? null : Number(x));
const title = () => `${cfg.prefix} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function whoami(username) {
  const r = await api("GET", `/u/${encodeURIComponent(username)}.json`);
  if (!r.ok) throw new Error(`cannot fetch user '${username}': ${snippet(r)}`);
  return r.json.user;
}

async function resolveCategory() {
  if (cfg.categoryId) return cfg.categoryId;
  const r = await api("GET", "/site.json");
  const site = r.json || {};
  const uncategorized = site.uncategorized_category_id;
  // skip read-restricted, the reserved uncategorized category, and read-only ones
  // (permission: 1=full, 2=create_post both allow creating topics; 3=readonly)
  const postable = (c) =>
    !c.read_restricted && c.id !== uncategorized && (c.permission == null || c.permission <= 2);
  const cat = (site.categories || []).find(postable);
  if (!cat) throw new Error("no postable category found; set CATEGORY_ID to one you can create topics in");
  return cat.id;
}

async function ensureCustomer() {
  const existing = await api("GET", `/u/${encodeURIComponent(cfg.customer)}.json`);
  if (existing.ok) return existing.json.user;
  const created = await api("POST", "/users.json", {
    body: {
      name: cfg.customer,
      username: cfg.customer,
      email: `${cfg.customer}@example.com`,
      password: `Ccf-${Math.random().toString(36).slice(2)}A1!`,
      active: true,
      approved: true,
    },
  });
  if (!created.ok || created.json?.success === false) {
    throw new Error(
      `could not find or create customer '${cfg.customer}'. ` +
        `Set CUSTOMER_USERNAME to an existing non-admin user. Detail: ${snippet(created)}`,
    );
  }
  return whoami(cfg.customer);
}

async function createTopic(username) {
  const r = await api("POST", "/posts.json", {
    username,
    body: {
      title: title(),
      raw: "Automated staging test topic body, comfortably long enough to pass validations.",
      category: categoryId,
    },
  });
  if (!r.ok) throw new Error(`createTopic failed: ${snippet(r)}`);
  createdTopics.add(r.json.topic_id);
  return { topicId: r.json.topic_id, postId: r.json.id };
}

async function reply(username, topicId, { whisper } = {}) {
  const body = {
    topic_id: topicId,
    raw: "Automated staging test reply body, comfortably long enough to pass.",
  };
  if (whisper) body.whisper = "true";
  const r = await api("POST", "/posts.json", { username, body });
  if (!r.ok) throw new Error(`reply failed: ${snippet(r)}`);
  return { postId: r.json.id, postType: r.json.post_type };
}

async function customFields(topicId) {
  const r = await api("GET", `/t/${topicId}.json`);
  if (!r.ok) throw new Error(`getTopic failed: ${snippet(r)}`);
  return r.json.custom_fields || {};
}

const setFields = (topicId, custom_field) =>
  api("PUT", `/admin/plugins/community-custom-fields/${topicId}.json`, { body: { custom_field } });

// ---- Data Explorer (read TopicStatusChange rows) ----
const HISTORY_SQL = `-- [params]
-- integer :topic_id

SELECT id, topic_id, from_status, to_status, source, user_id, post_id, assignee_id, duration, created_at
FROM community_custom_fields_topic_status_changes
WHERE topic_id = :topic_id
ORDER BY id`;

async function setupExplorer() {
  const r = await api("POST", "/admin/plugins/explorer/queries.json", {
    body: {
      query: {
        name: "CCF staging test — status changes",
        description: "Temporary query created by test/staging/run.mjs",
        sql: HISTORY_SQL,
      },
    },
  });
  if (!r.ok) {
    throw new Error(
      `Data Explorer create-query failed (is the plugin enabled and the key an admin key?): ${snippet(r)}`,
    );
  }
  queryId = r.json.query.id;
}

async function historyRows(topicId) {
  const r = await api("POST", `/admin/plugins/explorer/queries/${queryId}/run.json`, {
    body: { params: JSON.stringify({ topic_id: String(topicId) }) },
  });
  if (!r.ok) throw new Error(`Data Explorer run failed: ${snippet(r)}`);
  const cols = r.json.columns || [];
  return (r.json.rows || []).map((row) => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

// ---- assertions / harness ----
class SkipError extends Error {}
const skip = (msg) => {
  throw new SkipError(msg);
};
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---- tests ----
test("topic_created seeds status=new and records no history row", async () => {
  const { topicId } = await createTopic(cfg.admin);
  eq((await customFields(topicId)).status, "new", "status after creation");
  eq((await historyRows(topicId)).length, 0, "history rows after creation");
});

test("api_update new->open records an api_update row (user set, no post, duration>=0)", async () => {
  const { topicId } = await createTopic(cfg.admin);
  const res = await setFields(topicId, { status: "open" });
  eq(res.status, 200, "PUT status code");
  eq((await customFields(topicId)).status, "open", "status after PUT");
  const rows = await historyRows(topicId);
  eq(rows.length, 1, "row count");
  const r = rows[0];
  eq(r.from_status, "new", "from_status");
  eq(r.to_status, "open", "to_status");
  eq(r.source, "api_update", "source");
  eq(num(r.user_id), adminId, "user_id = acting admin");
  eq(r.post_id, null, "post_id is null");
  assert(num(r.duration) >= 0, `duration >= 0 (got ${r.duration})`);
});

test("api_update with invalid status is rejected (422) and records nothing", async () => {
  const { topicId } = await createTopic(cfg.admin);
  const res = await setFields(topicId, { status: "bogus" });
  eq(res.status, 422, "PUT status code for invalid status");
  eq((await customFields(topicId)).status, "new", "status unchanged");
  eq((await historyRows(topicId)).length, 0, "no rows written");
});

test("api_update that doesn't change status records no row", async () => {
  const { topicId } = await createTopic(cfg.admin);
  await setFields(topicId, { status: "open" }); // row 1
  const res = await setFields(topicId, { priority: "high" }); // no status change
  eq(res.status, 200, "PUT status code");
  eq((await historyRows(topicId)).length, 1, "still exactly one row");
});

test("customer reply reopens a snoozed topic and records a post_creation row", async () => {
  const { topicId } = await createTopic(cfg.admin);
  eq((await setFields(topicId, { status: "snoozed", assignee_id: customerId })).status, 200, "precondition PUT");
  const { postId } = await reply(cfg.customer, topicId);
  eq((await customFields(topicId)).status, "open", "reopened to open");
  const rows = await historyRows(topicId);
  const last = rows[rows.length - 1];
  eq(last.from_status, "snoozed", "from_status");
  eq(last.to_status, "open", "to_status");
  eq(last.source, "post_creation", "source");
  eq(num(last.post_id), postId, "post_id = triggering reply");
  eq(last.user_id, null, "user_id is null for post_creation");
  eq(num(last.assignee_id), customerId, "assignee_id = pre-change assignee");
});

test("admin whisper reopens a closed topic and records a post_creation row", async () => {
  const { topicId } = await createTopic(cfg.admin);
  await setFields(topicId, { status: "open" });
  eq(
    (await setFields(topicId, { status: "closed", last_assigned_to_id: customerId })).status,
    200,
    "precondition closed PUT",
  );
  const { postType } = await reply(cfg.admin, topicId, { whisper: true });
  if (Number(postType) !== 4) skip("whispers not enabled on this instance");
  const cf = await customFields(topicId);
  assert(cf.status === "open" || cf.status === "new", `reopened away from closed (got ${cf.status})`);
  const last = (await historyRows(topicId)).at(-1);
  eq(last.from_status, "closed", "from_status");
  eq(last.to_status, cf.status, "to_status matches topic");
  eq(last.source, "post_creation", "source");
});

test("admin regular reply changes no status and records no new row", async () => {
  const { topicId } = await createTopic(cfg.admin);
  await setFields(topicId, { status: "open", waiting_since: new Date().toISOString(), waiting_id: customerId });
  const before = (await historyRows(topicId)).length;
  await reply(cfg.admin, topicId); // clears waiting_*, leaves status "open"
  eq((await customFields(topicId)).status, "open", "status unchanged");
  eq((await historyRows(topicId)).length, before, "no new row");
});

test("all valid statuses are accepted by the endpoint", async () => {
  for (const s of ["open", "snoozed", "closed", "new"]) {
    const { topicId } = await createTopic(cfg.admin);
    if (s === "new") await setFields(topicId, { status: "open" }); // avoid new->new no-op
    eq((await setFields(topicId, { status: s })).status, 200, `status '${s}' accepted`);
    eq((await customFields(topicId)).status, s, `status set to '${s}'`);
  }
});

// ---- runner ----
async function main() {
  const admin = await whoami(cfg.admin);
  adminId = admin.id;
  assert(admin.admin, `DISCOURSE_API_USERNAME '${cfg.admin}' is not an admin`);
  categoryId = await resolveCategory();
  const customer = await ensureCustomer();
  customerId = customer.id;
  if (customer.admin || customer.moderator) {
    console.warn(`⚠ customer '${cfg.customer}' is staff — the customer-reply state machine differs for staff`);
  }
  const who = await api("GET", "/session/current.json", { username: cfg.customer });
  if (who.ok && who.json?.current_user?.username !== cfg.customer) {
    console.warn(
      `⚠ API key does not seem to be an "All Users"/global key — acting as '${cfg.customer}' resolved to ` +
        `'${who.json?.current_user?.username}'. Customer-reply tests may be inaccurate.`,
    );
  }
  await setupExplorer();

  console.log(
    `Target ${cfg.url} | admin=${cfg.admin}#${adminId} customer=${cfg.customer}#${customerId} category=${categoryId}\n`,
  );

  let pass = 0;
  let failCount = 0;
  let skipped = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`✓ ${t.name}`);
      pass += 1;
    } catch (e) {
      if (e instanceof SkipError) {
        console.log(`↷ ${t.name} — SKIP: ${e.message}`);
        skipped += 1;
      } else {
        console.error(`✗ ${t.name}\n    ${e.message}`);
        failCount += 1;
      }
    }
  }

  if (cfg.keep) {
    console.log(`\nKEEP_DATA set — left ${createdTopics.size} topics and Data Explorer query #${queryId}.`);
  } else {
    for (const id of createdTopics) {
      try {
        await api("DELETE", `/t/${id}.json`);
      } catch {
        /* best effort */
      }
    }
    if (queryId) await api("DELETE", `/admin/plugins/explorer/queries/${queryId}.json`);
    console.log(`\nCleaned up ${createdTopics.size} topics + the Data Explorer query.`);
  }

  console.log(`\n${pass} passed, ${failCount} failed, ${skipped} skipped`);
  process.exit(failCount ? 1 : 0);
}

main().catch((e) => {
  console.error(`\nFATAL: ${e.message}`);
  process.exit(2);
});
