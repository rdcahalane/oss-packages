import dotenv from "dotenv";
dotenv.config({ override: true });

import { startCoordinator } from "./coordinator.js";
import { startDiscordBot } from "./discord-bot.js";
import { startFileBot } from "./file-bot.js";

// TRANSPORT=discord (default) | file | both
const transport = (process.env.TRANSPORT ?? "discord").toLowerCase();

if (transport === "discord" || transport === "both") startDiscordBot();
if (transport === "file"    || transport === "both") startFileBot();

startCoordinator();
