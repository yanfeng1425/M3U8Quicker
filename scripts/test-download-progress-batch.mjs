import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const exports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(
  new URL("../src/hooks/downloadProgressBatch.ts", import.meta.url), "utf8",
), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText, { exports });

function harness() {
  const commits = [];
  const timers = new Map();
  let next = 0;
  const batch = exports.createDownloadProgressBatch(
    (events) => commits.push(Array.from(events)),
    (callback) => { timers.set(++next, callback); return next; },
    (id) => timers.delete(id),
  );
  return { batch, commits, timers, tick() {
    const callbacks = [...timers.values()];
    timers.clear();
    callbacks.forEach((callback) => callback());
  } };
}
const progress = (id = "a", extra = {}) => ({
  id, group: "active", status: "Downloading", failed_segment_count: 0,
  completed_segments: 1, ...extra,
});

test("a burst across tasks has one timer and commits only the newest values", () => {
  const h = harness();
  h.batch.push(progress("a"));
  h.batch.push(progress("b"));
  h.commits.length = 0;
  for (let i = 2; i <= 100; i++) {
    h.batch.push(progress("a", { completed_segments: i }));
    h.batch.push(progress("b", { completed_segments: i + 1 }));
  }
  assert.equal(h.commits.length, 0);
  assert.equal(h.timers.size, 1);
  h.tick();
  assert.deepEqual(h.commits[0].map((event) => event.completed_segments), [100, 101]);
  assert.equal(h.timers.size, 0);
});

for (const status of ["Paused", "Pending", "Merging", "Converting", "Completed", "Cancelled", { Failed: "network" }]) {
  test(`${JSON.stringify(status)} bypasses the timer and discards queued progress`, () => {
    const h = harness();
    h.batch.push(progress());
    h.batch.push(progress("a", { completed_segments: 2 }));
    h.batch.push(progress("a", { status, group: ["Completed", "Cancelled"].includes(status) || typeof status === "object" ? "history" : "active" }));
    assert.deepEqual(h.commits.at(-1)[0].status, status);
    const count = h.commits.length;
    h.tick();
    assert.equal(h.commits.length, count);
  });
}

test("failure count changes are immediate without discarding other tasks", () => {
  const h = harness();
  for (const id of ["a", "b"]) { h.batch.push(progress(id)); h.batch.push(progress(id)); }
  h.batch.push(progress("a", { failed_segment_count: 1 }));
  assert.equal(h.commits.at(-1)[0].failed_segment_count, 1);
  h.tick();
  assert.deepEqual(h.commits.at(-1).map((event) => event.id), ["b"]);
});

test("dispose cancels pending work and a subsequent mount starts clean", () => {
  const h = harness();
  h.batch.push(progress()); h.batch.push(progress());
  h.batch.dispose();
  assert.equal(h.timers.size, 0);
  const count = h.commits.length;
  h.tick();
  assert.equal(h.commits.length, count);
  h.batch.push(progress());
  assert.equal(h.commits.length, count + 1);
});
