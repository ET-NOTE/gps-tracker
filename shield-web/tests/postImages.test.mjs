import test from "node:test";
import assert from "node:assert/strict";
import { moveStep, removeStep } from "../src/postImages.js";
const post = {
  steps: ["A", "B", "C"],
  images: [0, 1, 2, 3].map((after_step) => ({
    id: String(after_step),
    after_step,
  })),
};
test("moving a step keeps its photos with the text", () => {
  const next = moveStep(post, 0, 1);
  assert.deepEqual(next.steps, ["B", "A", "C"]);
  assert.deepEqual(
    next.images.map((x) => x.after_step),
    [0, 2, 1, 3],
  );
  assert.deepEqual(post.steps, ["A", "B", "C"]);
});
test("removing text retains all images and shifts later anchors", () => {
  const next = removeStep(post, 1);
  assert.deepEqual(next.steps, ["A", "C"]);
  assert.deepEqual(
    next.images.map((x) => x.after_step),
    [0, 1, 1, 2],
  );
});

test("step titles and multiple downloads follow edits without losing files", () => {
  const source = { ...post, step_titles: ["Connect", "Upload", "Read"], attachments: post.images };
  const moved = moveStep(source, 2, 0);
  assert.deepEqual(moved.step_titles, ["Read", "Upload", "Connect"]);
  assert.deepEqual(moved.attachments.map(x => x.after_step), [0, 3, 2, 1]);
  const removed = removeStep(moved, 0);
  assert.equal(removed.attachments.length, 4);
  assert.deepEqual(removed.step_titles, ["Upload", "Connect"]);
  assert.deepEqual(removed.attachments.map(x => x.after_step), [0, 2, 1, 0]);
});
