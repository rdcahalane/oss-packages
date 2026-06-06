import { spawn } from "child_process";
import type { AgentTask } from "../coordinator.js";

const GEMINI_BIN = process.env.GEMINI_BIN ?? "gemini";

function run(prompt: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      GEMINI_BIN,
      ["-p", prompt, "--output-format", "text", "--yolo"],
      { env: { ...process.env } }
    );

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("error", reject);

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("gemini-cli timeout"));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      const text = stdout.trim();
      if (code === 0 && text) resolve(text);
      else reject(new Error(`gemini-cli exit ${code}: ${stderr.slice(0, 200)}`));
    });
  });
}

export async function execute(task: AgentTask): Promise<string> {
  const prompt = task.payload.context
    ? `${task.payload.context}\n\n${task.payload.prompt}`
    : task.payload.prompt;
  return run(prompt, 120_000);
}
