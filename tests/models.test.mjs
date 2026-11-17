import test from "node:test";
import assert from "node:assert/strict";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";
import { listCodexModels } from "../plugins/codex/scripts/lib/codex.mjs";
import { newestFamilyModel, resolveModelName } from "../plugins/codex/scripts/lib/models.mjs";

const listed = (...ids) => ids.map((id) => ({ id, model: id, hidden: false }));

test("newestFamilyModel compares versions as numbers, whatever the list order", () => {
  assert.equal(newestFamilyModel(listed("gpt-6.2-sol", "gpt-6.10-sol", "gpt-6-sol", "gpt-6.1-sol"), "sol"), "gpt-6.10-sol");
  assert.equal(newestFamilyModel(listed("gpt-6.9-sol", "gpt-7-sol"), "sol"), "gpt-7-sol");
  assert.equal(newestFamilyModel(listed("gpt-6-astra", "gpt-6.2-astra", "gpt-6.2-sol"), "astra"), "gpt-6.2-astra");
});

test("newestFamilyModel leaves out look-alike, hidden, and other families' models", () => {
  const models = [
    ...listed("gpt-6.1-sol", "gpt-7-sol-mini", "gpt-7-solar", "codex-7-sol", "gpt-8-astra"),
    { id: "gpt-9-sol", model: "gpt-9-sol", hidden: true }
  ];
  assert.equal(newestFamilyModel(models, "sol"), "gpt-6.1-sol");
  assert.equal(newestFamilyModel(listed("gpt-6.1-terra"), "sol"), null);
  assert.equal(newestFamilyModel([], "sol"), null);
});

test("resolveModelName reads the model list only for a family name", async () => {
  let reads = 0;
  const listModels = async () => {
    reads += 1;
    return listed("gpt-6.1-sol", "gpt-6.3-sol");
  };

  assert.deepEqual(await resolveModelName("gpt-6.1-sol", listModels), { model: "gpt-6.1-sol", alias: null, origin: null });
  assert.deepEqual(await resolveModelName("spark", listModels), { model: "gpt-5.3-codex-spark", alias: "spark", origin: null });
  assert.deepEqual(await resolveModelName("  ", listModels), { model: null, alias: null, origin: null });
  assert.deepEqual(await resolveModelName(undefined, listModels), { model: null, alias: null, origin: null });
  assert.equal(reads, 0);

  assert.deepEqual(await resolveModelName("Sol", listModels), {
    model: "gpt-6.3-sol",
    alias: "sol",
    origin: "the newest sol model Codex lists"
  });
  assert.equal(reads, 1);
});

test("resolveModelName falls back to the built-in id and says why", async () => {
  const unreadable = await resolveModelName("sol", async () => {
    throw new Error("no answer within 10s");
  });
  assert.equal(unreadable.model, "gpt-6.2-sol");
  assert.equal(unreadable.origin, "the plugin's built-in id, because Codex's model list could not be read: no answer within 10s");

  const absent = await resolveModelName("astra", async () => listed("gpt-6.2-sol"));
  assert.equal(absent.model, "gpt-6.2-astra");
  assert.equal(absent.origin, "the plugin's built-in id, because Codex lists no astra model");
});

test("listCodexModels returns what the app server lists", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "task-ok");

  const models = await listCodexModels(makeTempDir(), { env: buildEnv(binDir) });
  assert.ok(models.some((model) => model.model === "gpt-9.10-sol"));
});

test("listCodexModels gives up on an app server that does not answer", async () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "model-list-hangs");

  const started = Date.now();
  await assert.rejects(listCodexModels(makeTempDir(), { env: buildEnv(binDir), timeoutMs: 1000 }), /no answer within 1s/);
  assert.ok(Date.now() - started < 5000);
});
