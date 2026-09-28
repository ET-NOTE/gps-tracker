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
