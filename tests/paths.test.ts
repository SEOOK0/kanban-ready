import assert from "node:assert/strict";
import test from "node:test";
import { AGENTS, STATUSES, canTransition, isAgent } from "../src/core/paths.ts";
import { DRAFT_BODY_TEMPLATE } from "../src/core/card.ts";
import {
  InputValidationError,
  normalizeAgentInput,
  normalizeDependsOnInput,
  normalizeSessionIdInput,
} from "../src/core/meta.ts";

test("allows one-step moves in both directions across active statuses", () => {
  const adjacent = [
    ["draft", "agent_working"],
    ["agent_working", "ready"],
    ["ready", "done"],
    ["done", "deploy"],
  ] as const;

  for (const [left, right] of adjacent) {
    assert.equal(canTransition(left, right), true, `${left} -> ${right}`);
    assert.equal(canTransition(right, left), true, `${right} -> ${left}`);
  }
});

test("keeps the draft to ready shortcut but rejects wider skips", () => {
  assert.equal(canTransition("draft", "ready"), true);

  assert.equal(canTransition("draft", "done"), false);
  assert.equal(canTransition("draft", "deploy"), false);
  assert.equal(canTransition("done", "agent_working"), false);
  assert.equal(canTransition("deploy", "ready"), false);
});

test("allows discard from every active status and restore to every active status", () => {
  const activeStatuses = STATUSES.filter((status) => status !== "discarded");

  for (const status of activeStatuses) {
    assert.equal(canTransition(status, "discarded"), true, `${status} -> discarded`);
    assert.equal(canTransition("discarded", status), true, `discarded -> ${status}`);
  }
});

test("isAgent narrows to the two known agent ids", () => {
  for (const a of AGENTS) {
    assert.equal(isAgent(a), true, `${a} is an agent`);
  }
  for (const v of ["", "claude", "CC", "openai", 1, null, undefined]) {
    assert.equal(isAgent(v), false, `${String(v)} is not an agent`);
  }
});

test("draft body template covers the four required sections", () => {
  for (const heading of ["## 목표", "## 컨텍스트", "## 작업 단계", "## 검증 기준"]) {
    assert.ok(DRAFT_BODY_TEMPLATE.includes(heading), `template includes ${heading}`);
  }
});

test("normalizes card metadata API inputs", () => {
  assert.deepEqual(normalizeDependsOnInput([3, 7, 3]), [3, 7]);
  assert.equal(normalizeDependsOnInput(undefined), undefined);
  assert.equal(normalizeSessionIdInput("  session-123  "), "session-123");
  assert.equal(normalizeSessionIdInput("   "), null);
  assert.equal(normalizeAgentInput("cc"), "cc");
  assert.equal(normalizeAgentInput(null), null);
});

test("rejects malformed card metadata instead of clearing existing values", () => {
  for (const raw of [null, "#3", ["3"], [0], [1.5], [1, null]]) {
    assert.throws(
      () => normalizeDependsOnInput(raw),
      InputValidationError,
      `depends_on rejects ${JSON.stringify(raw)}`,
    );
  }
  assert.throws(() => normalizeSessionIdInput(123), InputValidationError);
  assert.throws(() => normalizeAgentInput("claude"), InputValidationError);
});
