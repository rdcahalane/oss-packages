import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";
import { loadAdvisors } from "./advisors.js";

const ROSTER_FILE = path.join(process.cwd(), "advisor-roster.json");

type RosterData = Record<string, Record<string, boolean>>;

function load(): RosterData {
  if (!existsSync(ROSTER_FILE)) return {};
  try { return JSON.parse(readFileSync(ROSTER_FILE, "utf8")); } catch { return {}; }
}

function save(data: RosterData): void {
  writeFileSync(ROSTER_FILE, JSON.stringify(data, null, 2));
}

export function kickAdvisor(id: string, context = "global"): string {
  const all = loadAdvisors();
  const advisor = all.find(a => a.id === id.toLowerCase());
  if (!advisor) return `Unknown advisor: "${id}". Run !roster to see available advisors.`;
  const data = load();
  (data[context] ??= {})[advisor.id] = false;
  save(data);
  return `${advisor.name} has left the room.`;
}

export function inviteAdvisor(id: string, context = "global"): string {
  const all = loadAdvisors();
  const advisor = all.find(a => a.id === id.toLowerCase());
  if (!advisor) return `Unknown advisor: "${id}". Run !roster to see available advisors.`;
  const data = load();
  (data[context] ??= {})[advisor.id] = true;
  save(data);
  return `${advisor.name} is back at the table.`;
}

export function isActive(id: string, context = "global"): boolean {
  const data = load();
  // Context-specific overrides global; default is active
  if (data[context]?.[id] !== undefined) return data[context][id];
  if (data["global"]?.[id] !== undefined) return data["global"][id];
  return true;
}

export function getRosterText(context = "global"): string {
  const all = loadAdvisors();
  const active = all.filter(a => isActive(a.id, context));
  const inactive = all.filter(a => !isActive(a.id, context));

  const lines = [
    "**Board Roster**",
    "",
    "✅ **Active:**",
    ...active.map(a => `  • ${a.name} (\`!kick ${a.id}\` to remove)`),
  ];
  if (inactive.length) {
    lines.push("", "❌ **Kicked:**", ...inactive.map(a => `  • ${a.name} (\`!invite ${a.id}\` to reinstate)`));
  }
  lines.push("", "_Roster is per-channel. Changes persist across restarts._");
  return lines.join("\n");
}
