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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- HTTP ----
async function api(method, path, opts = {}, attempt = 0) {
  const { body, username } = opts;
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
  // Honor Discourse rate limits (topic/post creation, per-IP, Data Explorer "block" mode).
  if (res.status === 429 && attempt < 6) {
    const wait = Math.min((json?.extras?.wait_seconds ?? 10) + 1, 60);
    console.log(`  … rate limited on ${method} ${path.split("?")[0]}; waiting ${wait}s`);
    await sleep(wait * 1000);
    return api(method, path, opts, attempt + 1);
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
      skip_validations: true, // API-only; disables rate limits so the suite can create many topics
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
    skip_validations: true, // API-only; disables rate limits
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

// create a fresh topic as admin (topic_created seeds status="new")
async function freshTopic() {
  const { topicId } = await createTopic(cfg.admin);
  return topicId;
}

// drive a topic into a precondition state via api_update (itself records api_update rows)
async function seed(topicId, custom_field) {
  const r = await setFields(topicId, custom_field);
  if (r.status !== 200) throw new Error(`seed ${JSON.stringify(custom_field)} failed: ${snippet(r)}`);
}

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
const STATUSES = ["new", "open", "snoozed", "closed"];
const iso = (ms) => new Date(ms).toISOString();

test("topic_created seeds status=new and records no history row", async () => {
  const topicId = await freshTopic();
  eq((await customFields(topicId)).status, "new", "status after creation");
  eq((await historyRows(topicId)).length, 0, "history rows after creation");
});

// --- api_update: every ordered (from -> to) status pair ---
for (const from of STATUSES) {
  for (const to of STATUSES) {
    if (from === to) continue;
    test(`api_update transition ${from} -> ${to}`, async () => {
      const topicId = await freshTopic(); // status "new"
      let expected = 0;
      if (from !== "new") {
        await seed(topicId, { status: from }); // new -> from
        expected += 1;
      }
      eq((await setFields(topicId, { status: to })).status, 200, `PUT ${from}->${to}`);
      expected += 1;
      eq((await customFields(topicId)).status, to, "status after PUT");
      const rows = await historyRows(topicId);
      eq(rows.length, expected, "row count");
      const r = rows.at(-1);
      eq(r.from_status, from, "from_status");
      eq(r.to_status, to, "to_status");
      eq(r.source, "api_update", "source");
      eq(num(r.user_id), adminId, "user_id = acting admin");
      eq(r.post_id, null, "post_id null");
      assert(num(r.duration) >= 0, `duration >= 0 (got ${r.duration})`);
    });
  }
}

// --- api_update edge cases ---
test("api_update with an invalid status is rejected (422) and records nothing", async () => {
  const topicId = await freshTopic();
  eq((await setFields(topicId, { status: "bogus" })).status, 422, "422 for invalid status");
  eq((await customFields(topicId)).status, "new", "status unchanged");
  eq((await historyRows(topicId)).length, 0, "no rows");
});

test("api_update that changes no status records no row", async () => {
  const topicId = await freshTopic();
  await seed(topicId, { status: "open" }); // 1 row
  eq((await setFields(topicId, { priority: "high" })).status, 200, "PUT ok");
  eq((await historyRows(topicId)).length, 1, "still exactly one row");
});

test("api_update attributes the row to the pre-change assignee", async () => {
  const topicId = await freshTopic();
  await seed(topicId, { status: "open", assignee_id: customerId }); // assigned to customer
  eq((await setFields(topicId, { status: "closed", assignee_id: "" })).status, 200, "close + unassign");
  eq((await customFields(topicId)).status, "closed", "closed");
  const r = (await historyRows(topicId)).at(-1);
  eq(r.from_status, "open", "from");
  eq(r.to_status, "closed", "to");
  eq(num(r.assignee_id), customerId, "row attributed to the pre-change assignee");
});

// --- post_created: customer (non-admin) replies ---
test("customer reply reopens a snoozed topic -> open (post_creation row)", async () => {
  const topicId = await freshTopic();
  await seed(topicId, { status: "snoozed", assignee_id: customerId }); // 1 row
  const { postId } = await reply(cfg.customer, topicId);
  eq((await customFields(topicId)).status, "open", "reopened");
  const rows = await historyRows(topicId);
  eq(rows.length, 2, "seed + reopen");
  const r = rows.at(-1);
  eq(r.from_status, "snoozed", "from");
  eq(r.to_status, "open", "to");
  eq(r.source, "post_creation", "source");
  eq(num(r.post_id), postId, "post_id = reply");
  eq(r.user_id, null, "user_id null");
  eq(num(r.assignee_id), customerId, "assignee = pre-change");
});

test("customer reply reopens a recently-closed, assigned topic -> open + reassign", async () => {
  const topicId = await freshTopic();
  await seed(topicId, { status: "closed", last_assigned_to_id: customerId, closed_at: iso(Date.now()) });
  const { postId } = await reply(cfg.customer, topicId);
  const cf = await customFields(topicId);
  eq(cf.status, "open", "reopened to open");
  eq(num(cf.assignee_id), customerId, "reassigned to the last assignee");
  const r = (await historyRows(topicId)).at(-1);
  eq(r.from_status, "closed", "from");
  eq(r.to_status, "open", "to");
  eq(num(r.post_id), postId, "post_id");
  eq(r.assignee_id, null, "row attributed to pre-change assignee (none)");
});

test("customer reply reopens a closed topic with no last assignee -> new", async () => {
  const topicId = await freshTopic();
  await seed(topicId, { status: "closed", closed_at: iso(Date.now()) });
  await reply(cfg.customer, topicId);
  eq((await customFields(topicId)).status, "new", "reopened to new");
  eq((await historyRows(topicId)).at(-1).to_status, "new", "row to=new");
});

test("customer reply reopens a >1-month-closed topic -> new despite a last assignee", async () => {
  const topicId = await freshTopic();
  const twoMonthsAgo = iso(Date.now() - 62 * 24 * 3600 * 1000);
  await seed(topicId, { status: "closed", last_assigned_to_id: customerId, closed_at: twoMonthsAgo });
  await reply(cfg.customer, topicId);
  eq((await customFields(topicId)).status, "new", "stale close reopens to new");
  eq((await historyRows(topicId)).at(-1).to_status, "new", "row to=new");
});

test("customer reply to an open topic sets waiting_* and records no row", async () => {
  const topicId = await freshTopic();
  await seed(topicId, { status: "open" }); // 1 row
  await reply(cfg.customer, topicId);
  const cf = await customFields(topicId);
  eq(cf.status, "open", "status unchanged");
  eq(num(cf.waiting_id), customerId, "waiting_id set to customer");
  assert(cf.waiting_since, "waiting_since set");
  eq((await historyRows(topicId)).length, 1, "no new row");
});

test("customer reply to a new topic sets waiting_* and records no row", async () => {
  const topicId = await freshTopic(); // status "new", 0 rows
  await reply(cfg.customer, topicId);
  const cf = await customFields(topicId);
  eq(cf.status, "new", "status unchanged");
  eq(num(cf.waiting_id), customerId, "waiting_id set");
  eq((await historyRows(topicId)).length, 0, "no row");
});

// --- post_created: admin whisper (post_type 4); skipped if whispers are disabled ---
test("admin whisper reopens a snoozed topic -> open", async () => {
  const topicId = await freshTopic();
  await seed(topicId, { status: "snoozed" });
  const { postType } = await reply(cfg.admin, topicId, { whisper: true });
  if (Number(postType) !== 4) skip("whispers not enabled");
  eq((await customFields(topicId)).status, "open", "reopened");
  const r = (await historyRows(topicId)).at(-1);
  eq(r.from_status, "snoozed", "from");
  eq(r.to_status, "open", "to");
  eq(r.source, "post_creation", "source");
});

test("admin whisper reopens a closed, assigned topic -> open", async () => {
  const topicId = await freshTopic();
  await seed(topicId, { status: "closed", last_assigned_to_id: customerId });
  const { postType } = await reply(cfg.admin, topicId, { whisper: true });
  if (Number(postType) !== 4) skip("whispers not enabled");
  eq((await customFields(topicId)).status, "open", "reopened to open");
  eq((await historyRows(topicId)).at(-1).to_status, "open", "row to=open");
});

test("admin whisper reopens a closed topic with no last assignee -> new", async () => {
  const topicId = await freshTopic();
  await seed(topicId, { status: "closed" });
  const { postType } = await reply(cfg.admin, topicId, { whisper: true });
  if (Number(postType) !== 4) skip("whispers not enabled");
  eq((await customFields(topicId)).status, "new", "reopened to new");
  eq((await historyRows(topicId)).at(-1).to_status, "new", "row to=new");
});

test("admin whisper on an open topic changes nothing and records no row", async () => {
  const topicId = await freshTopic();
  await seed(topicId, { status: "open" }); // 1 row
  const { postType } = await reply(cfg.admin, topicId, { whisper: true });
  if (Number(postType) !== 4) skip("whispers not enabled");
  eq((await customFields(topicId)).status, "open", "unchanged");
  eq((await historyRows(topicId)).length, 1, "no new row");
});

// --- post_created: admin regular reply ---
test("admin regular reply clears waiting_* and records no row", async () => {
  const topicId = await freshTopic();
  await seed(topicId, { status: "open", waiting_since: iso(Date.now()), waiting_id: customerId }); // 1 row
  await reply(cfg.admin, topicId);
  const cf = await customFields(topicId);
  eq(cf.status, "open", "status unchanged");
  assert(cf.waiting_id == null, "waiting_id cleared");
  eq((await historyRows(topicId)).length, 1, "no new row");
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
