import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { z } from "zod";
import { chatJson } from "@aihot/backend/providers/llm";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { tag } from "./setup.ts";

const T = tag();
const temp = await mkdtemp(path.join(os.tmpdir(), "aihot-fake-codex-"));
const executable = path.join(temp, "codex");
const tracePath = path.join(temp, "trace.json");

before(async () => {
  await writeFile(executable, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const valueAfter = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
let input = "";
for await (const chunk of process.stdin) input += chunk.toString();
const output = valueAfter("-o") || valueAfter("--output-last-message");
const schemaPath = valueAfter("--output-schema");
const trace = {
  args,
  input,
  schema: schemaPath ? JSON.parse(fs.readFileSync(schemaPath, "utf8")) : null,
  apiEnv: {
    OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
    CODEX_API_KEY: !!process.env.CODEX_API_KEY,
    CODEX_ACCESS_TOKEN: !!process.env.CODEX_ACCESS_TOKEN,
  },
};
fs.writeFileSync(process.env.CODEX_FAKE_TRACE, JSON.stringify(trace));
fs.writeFileSync(output, JSON.stringify({ label: "PASS", reason: "fake" }));
`, "utf8");
  await chmod(executable, 0o755);
  Object.assign(process.env, {
    CODEX_EXEC_PATH: executable,
    CODEX_FAKE_TRACE: tracePath,
    OPENAI_API_KEY: "must-not-reach-child",
    CODEX_API_KEY: "must-not-reach-child",
    CODEX_ACCESS_TOKEN: "must-not-reach-child",
  });
});

after(async () => {
  delete process.env.CODEX_EXEC_PATH;
  delete process.env.CODEX_FAKE_TRACE;
  delete process.env.OPENAI_API_KEY;
  delete process.env.CODEX_API_KEY;
  delete process.env.CODEX_ACCESS_TOKEN;
  await rm(temp, { recursive: true, force: true });
  await stopBoss();
  await closeDb();
});

test("chatgpt-luna runs one isolated codex exec turn and keeps API keys out of the child", async () => {
  const schema = z.object({ label: z.enum(["PASS", "BLOCK", "UNKNOWN"]), reason: z.string() });
  const subject = `codex-exec-test:${T}`;
  const result = await chatJson({
    model: "chatgpt-luna",
    purpose: "codex_exec_test",
    subject,
    promptVersion: "test@1",
    system: "SYSTEM RULE: return only the requested classification.",
    user: "USER MATERIAL",
    schema,
    temperature: 0,
    maxTokens: 512,
    attemptTag: T,
  });

  assert.deepEqual(result.data, { label: "PASS", reason: "fake" });
  assert.equal(result.model, "chatgpt-luna");
  assert.equal(result.usage, null);

  const trace = JSON.parse(await readFile(tracePath, "utf8")) as {
    args: string[];
    input: string;
    schema: Record<string, unknown> | null;
    apiEnv: Record<string, boolean>;
  };
  assert.equal(trace.input, "USER MATERIAL");
  assert.equal(trace.apiEnv.OPENAI_API_KEY, false);
  assert.equal(trace.apiEnv.CODEX_API_KEY, false);
  assert.equal(trace.apiEnv.CODEX_ACCESS_TOKEN, false);
  assert.ok(trace.args.includes("--ephemeral"));
  assert.ok(trace.args.includes("--ignore-user-config"));
  assert.ok(trace.args.includes("--ignore-rules"));
  assert.ok(trace.args.includes("--skip-git-repo-check"));
  assert.equal(trace.args[trace.args.indexOf("--sandbox") + 1], "read-only");
  assert.equal(trace.args[trace.args.indexOf("--model") + 1], "gpt-5.6-luna");
  assert.ok(trace.args.includes("--output-schema"));
  assert.equal(trace.schema?.type, "object");

  const configs = trace.args.flatMap((arg, i) => arg === "--config" ? [trace.args[i + 1] ?? ""] : []);
  assert.ok(configs.some((v) => v.startsWith("developer_instructions=") && v.includes("SYSTEM RULE")));
  assert.ok(configs.includes('approval_policy="never"'));
  assert.ok(configs.includes('web_search="disabled"'));
  assert.ok(configs.includes("features.shell_tool=false"));
  assert.ok(configs.includes('model_reasoning_effort="low"'));

  const [receipt] = await sql<{ service: string; model: string }[]>`
    SELECT service, model FROM receipts WHERE subject = ${subject} ORDER BY id DESC LIMIT 1`;
  assert.deepEqual(receipt, { service: "chatgpt-codex", model: "gpt-5.6-luna" });
});
