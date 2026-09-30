import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProviderRejectedError } from "./receipts.ts";

export interface CodexExecCall {
  model: string;
  system: string;
  user: string;
  outputSchema?: unknown;
  timeoutMs: number;
  reasoningEffort?: string;
}

export interface CodexExecResult {
  content: string;
  stderr: string;
}

const DIAGNOSTIC_LIMIT = 12_000;

function appendBounded(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  return next.length <= DIAGNOSTIC_LIMIT ? next : next.slice(next.length - DIAGNOSTIC_LIMIT);
}

/**
 * Runs one fresh, non-interactive Codex turn using the user's existing ChatGPT login.
 * API/access-token environment variables are stripped so this transport cannot silently
 * fall back to metered API billing when the ChatGPT session is unavailable.
 */
export async function runCodexExec(call: CodexExecCall): Promise<CodexExecResult> {
  const executable = process.env.CODEX_EXEC_PATH || "codex";
  const dir = await mkdtemp(path.join(os.tmpdir(), "aihot-codex-"));
  const outputPath = path.join(dir, "output.txt");
  const schemaPath = path.join(dir, "schema.json");
  try {
    const args = [
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--sandbox", "read-only",
      "--model", call.model,
      "-o", outputPath,
      "--config", `approval_policy=${JSON.stringify("never")}`,
      "--config", `web_search=${JSON.stringify("disabled")}`,
      "--config", "features.apps=false",
      "--config", "features.goals=false",
      "--config", "features.hooks=false",
      "--config", "features.multi_agent=false",
      "--config", "features.remote_plugin=false",
      "--config", "features.shell_snapshot=false",
      "--config", "features.shell_tool=false",
    ];
    if (call.system) args.push("--config", `developer_instructions=${JSON.stringify(call.system)}`);
    if (call.reasoningEffort) args.push("--config", `model_reasoning_effort=${JSON.stringify(call.reasoningEffort)}`);
    if (call.outputSchema !== undefined) {
      await writeFile(schemaPath, JSON.stringify(call.outputSchema), "utf8");
      args.push("--output-schema", schemaPath);
    }
    // A positional '-' makes codex exec read the task from stdin, avoiding argv limits and shell quoting.
    args.push("-");

    const env = { ...process.env };
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    delete env.CODEX_ACCESS_TOKEN;

    let stdout = "";
    let stderr = "";
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      let child;
      try {
        child = spawn(executable, args, { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
      } catch (error) {
        reject(new ProviderRejectedError(`codex exec could not start: ${String(error)}`, null, false));
        return;
      }
      child.stdout.on("data", (chunk) => (stdout = appendBounded(stdout, chunk)));
      child.stderr.on("data", (chunk) => (stderr = appendBounded(stderr, chunk)));
      child.once("error", (error) => reject(new ProviderRejectedError(`codex exec could not start: ${String(error)}`, null, false)));
      child.once("close", (code, signal) => resolve({ code, signal }));
      child.stdin.end(call.user);

      let hardKill: NodeJS.Timeout | null = null;
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        hardKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
        hardKill.unref();
      }, call.timeoutMs);
      timer.unref();
      child.once("close", () => {
        clearTimeout(timer);
        if (hardKill) clearTimeout(hardKill);
      });
    });

    if (result.code !== 0) {
      throw new Error(`codex exec failed (${result.signal ?? `exit ${result.code}`}): ${stderr.trim().slice(-2000)}`);
    }
    const content = (await readFile(outputPath, "utf8").catch(() => stdout)).trim();
    if (!content) throw new Error(`codex exec returned no final message: ${stderr.trim().slice(-2000)}`);
    return { content, stderr };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
