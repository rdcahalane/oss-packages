import { spawn } from "child_process";
import { writeFileSync, readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AgentTask } from "../coordinator.js";

const CODEX_BIN = process.env.CODEX_BIN ?? "/Applications/Codex.app/Contents/Resources/codex";

function run(prompt: string, timeoutMs: number): Promise<string> {
  const outFile = join(tmpdir(), `codex-${Date.now()}.txt`);

  return new Promise((resolve, reject) => {
    const proc = spawn(
      CODEX_BIN,
      ["exec", "--dangerously-bypass-approvals-and-sandbox", "-o", outFile, "-"],
      { env: { ...process.env } }
    );

    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("error", reject);

    const timer = setTimeout(() => { proc.kill(); reject(new Error("codex-cli timeout")); }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      try {
        const text = readFileSync(outFile, "utf8").trim();
        unlinkSync(outFile);
        if (text) { resolve(text); return; }
      } catch {}
      reject(new Error(stderr.trim() || `codex-cli exit ${code}`));
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

export async function execute(task: AgentTask): Promise<string> {
  const prompt = task.payload.context
    ? `${task.payload.context}\n\n${task.payload.prompt}`
    : task.payload.prompt;
  return run(prompt, 120_000);
}
