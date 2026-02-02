/**
 * GAS Bridge Hook Handler
 *
 * Bridges OpenClaw internal events to the Global Agents System (GAS) hooks.
 * Calls ~/.agents/hooks/session-start.sh and session-stop.sh with JSON stdin.
 */

import { execSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import type { HookHandler } from "../../hooks.js";

const GAS_HOOKS_DIR = path.join(os.homedir(), ".agents", "hooks");

interface GASPayload {
  tool_name: string;
  session_id: string;
  timestamp: string;
  cwd: string;
  project_name: string;
  user: string;
  hook_event: string;
  metadata: {
    model: string;
    tokens: {
      input: number;
      output: number;
      cache_creation_input: number;
      cache_read_input: number;
    };
    cost_usd: number;
    duration_ms: number;
  };
}

/**
 * Build a GAS-compatible JSON payload from an OpenClaw event
 */
function buildGASPayload(
  event: Parameters<HookHandler>[0],
  hookEvent: string,
): GASPayload {
  const context = event.context || {};
  const sessionEntry = (context.sessionEntry || {}) as Record<string, unknown>;
  const cfg = context.cfg as { agents?: { defaults?: { model?: { primary?: string } } } } | undefined;
  
  // Extract workspace dir or use cwd
  const workspaceDir = (context.workspaceDir as string) || process.cwd();
  const projectName = path.basename(workspaceDir);
  
  // Get model from config if available
  const model = cfg?.agents?.defaults?.model?.primary || "unknown";

  return {
    tool_name: "OpenClaw",
    session_id: event.sessionKey,
    timestamp: event.timestamp.toISOString(),
    cwd: workspaceDir,
    project_name: projectName,
    user: os.userInfo().username,
    hook_event: hookEvent,
    metadata: {
      model,
      tokens: {
        input: 0,
        output: 0,
        cache_creation_input: 0,
        cache_read_input: 0,
      },
      cost_usd: 0,
      duration_ms: 0,
    },
  };
}

/**
 * Call a GAS hook script with JSON payload
 */
function callGASHook(scriptName: string, payload: GASPayload): void {
  const scriptPath = path.join(GAS_HOOKS_DIR, scriptName);
  const jsonPayload = JSON.stringify(payload);

  try {
    // Check if script exists
    execSync(`test -x "${scriptPath}"`, { stdio: "ignore" });
    
    // Pipe JSON to the script
    execSync(`echo '${jsonPayload.replace(/'/g, "'\\''")}' | "${scriptPath}"`, {
      stdio: "ignore",
      timeout: 5000, // 5 second timeout
    });

    console.log(`[gas-bridge] Called ${scriptName} for session ${payload.session_id}`);
  } catch (err) {
    // Log but don't fail - GAS hooks are optional
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.log(`[gas-bridge] GAS hook not found: ${scriptPath}`);
    } else {
      console.error(
        `[gas-bridge] Failed to call ${scriptName}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

/**
 * GAS Bridge Hook Handler
 *
 * Maps OpenClaw events to GAS hooks:
 * - command:new → session-start.sh
 * - command:reset → session-stop.sh + session-start.sh
 * - command:stop → session-stop.sh
 * - gateway:startup → session-start.sh
 */
const gasBridgeHandler: HookHandler = async (event) => {
  const { type, action } = event;

  // Handle gateway startup
  if (type === "gateway" && action === "startup") {
    const payload = buildGASPayload(event, "SessionStart");
    callGASHook("session-start.sh", payload);
    return;
  }

  // Handle command events
  if (type !== "command") {
    return;
  }

  switch (action) {
    case "new":
      // New session started
      callGASHook("session-start.sh", buildGASPayload(event, "SessionStart"));
      break;

    case "reset":
      // Reset = end old session + start new one
      callGASHook("session-stop.sh", buildGASPayload(event, "SessionStop"));
      callGASHook("session-start.sh", buildGASPayload(event, "SessionStart"));
      break;

    case "stop":
      // Session ended
      callGASHook("session-stop.sh", buildGASPayload(event, "SessionStop"));
      break;

    default:
      // Other commands - no GAS mapping
      break;
  }
};

export default gasBridgeHandler;
