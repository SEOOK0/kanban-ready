import assert from "node:assert/strict";
import test from "node:test";
import { EVENT_ACTIONS, decideMoveAction } from "../src/core/store.ts";

test("decideMoveAction returns 'update' when status stays and only meta changed", () => {
  assert.equal(decideMoveAction("draft", "draft", true), "update");
  assert.equal(decideMoveAction("agent_working", "agent_working", true), "update");
  assert.equal(decideMoveAction("ready", "ready", true), "update");
});

test("decideMoveAction returns 'claim' for any transition INTO agent_working", () => {
  for (const from of ["draft", "ready", "done", "discarded"] as const) {
    assert.equal(
      decideMoveAction(from, "agent_working", false),
      "claim",
      `${from} → agent_working`,
    );
  }
});

test("decideMoveAction returns 'release' only when leaving agent_working back to draft", () => {
  assert.equal(decideMoveAction("agent_working", "draft", false), "release");
  // Going from agent_working to other statuses is NOT a release.
  assert.equal(decideMoveAction("agent_working", "ready", false), "status_change");
  assert.equal(decideMoveAction("agent_working", "done", false), "complete");
});

test("decideMoveAction returns 'complete' when arriving at done from any non-agent_working source", () => {
  assert.equal(decideMoveAction("ready", "done", false), "complete");
  assert.equal(decideMoveAction("deploy", "done", false), "complete");
  // Also covers agent_working → done (preferred over status_change since to=done).
  assert.equal(decideMoveAction("agent_working", "done", false), "complete");
});

test("decideMoveAction falls back to 'status_change' for non-special transitions", () => {
  assert.equal(decideMoveAction("draft", "ready", false), "status_change");
  assert.equal(decideMoveAction("done", "deploy", false), "status_change");
  assert.equal(decideMoveAction("deploy", "done", false), "complete"); // still complete
  assert.equal(decideMoveAction("done", "ready", false), "status_change");
  assert.equal(decideMoveAction("ready", "discarded", false), "status_change");
  assert.equal(decideMoveAction("discarded", "draft", false), "status_change");
});

test("EVENT_ACTIONS exposes the exact action set the card_events CHECK constraint expects", () => {
  // Keep this list in sync with migrations/0006_add_card_events.sql.
  assert.deepEqual(
    [...EVENT_ACTIONS].sort(),
    ["claim", "comment", "complete", "release", "status_change", "update"],
  );
});
