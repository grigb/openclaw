import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

// Type for session hooks returned by createSessionHooks
type MemorySessionHooks = {
  enabled: boolean;
  onSessionStart: () => void;
  onUserMessage: (content: string, messageId?: string) => void;
  onAssistantMessage: (content: string, messageId?: string) => void;
  onToolCall: (
    toolName: string,
    toolCallId: string,
    args?: Record<string, unknown>,
    result?: unknown,
    isError?: boolean,
  ) => void;
  onSessionEnd: (outcome?: "success" | "failure" | "partial", summary?: string) => void;
  retrieveContext: (query: string) => Promise<string>;
};

// Track session hooks by session ID for lifecycle management
const activeSessionHooks = new Map<string, MemorySessionHooks>();

const memoryCorePlugin = {
  id: "memory-core",
  name: "Memory (Core)",
  description: "File-backed memory search tools, CLI, and session lifecycle hooks",
  kind: "memory",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    // =========================================================================
    // Tools Registration
    // =========================================================================
    api.registerTool(
      (ctx) => {
        const memorySearchTool = api.runtime.tools.createMemorySearchTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        const memoryGetTool = api.runtime.tools.createMemoryGetTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        if (!memorySearchTool || !memoryGetTool) {
          return null;
        }
        return [memorySearchTool, memoryGetTool];
      },
      { names: ["memory_search", "memory_get"] },
    );

    // =========================================================================
    // CLI Registration
    // =========================================================================
    api.registerCli(
      ({ program }) => {
        api.runtime.tools.registerMemoryCli(program);
      },
      { commands: ["memory"] },
    );

    // =========================================================================
    // Session Lifecycle Hooks
    // =========================================================================

    // Helper to build session params from hook context
    const buildSessionParams = (ctx: {
      agentId?: string;
      sessionKey?: string;
      workspaceDir?: string;
      messageProvider?: string;
    }) => ({
      sessionId: ctx.sessionKey ?? "unknown",
      sessionKey: ctx.sessionKey,
      messageChannel: ctx.messageProvider,
      messageProvider: ctx.messageProvider,
      agentAccountId: ctx.agentId,
      workspaceDir: ctx.workspaceDir,
    });

    // Helper to get or create session hooks
    const getSessionHooks = (
      sessionKey: string,
      ctx: {
        agentId?: string;
        sessionKey?: string;
        workspaceDir?: string;
        messageProvider?: string;
      },
    ): MemorySessionHooks => {
      let hooks = activeSessionHooks.get(sessionKey);
      if (!hooks) {
        const params = buildSessionParams(ctx);
        hooks = api.runtime.memory.createSessionHooks(params, api.config);
        activeSessionHooks.set(sessionKey, hooks);
      }
      return hooks;
    };

    // session_start: Initialize memory for this session
    api.on("session_start", async (event, ctx) => {
      if (!api.runtime.memory.shouldEnableHooks(api.config, ctx.sessionId)) {
        return;
      }

      const sessionKey = ctx.sessionId;
      const hooks = getSessionHooks(sessionKey, {
        agentId: ctx.agentId,
        sessionKey: ctx.sessionId,
      });

      if (hooks.enabled) {
        hooks.onSessionStart();
        api.logger.debug?.(`[memory] session started: ${sessionKey}`);
      }
    });

    // before_agent_start: Retrieve context memories and inject into prompt
    api.on(
      "before_agent_start",
      async (event, ctx) => {
        if (!api.runtime.memory.shouldEnableHooks(api.config, ctx.sessionKey)) {
          return;
        }

        const sessionKey = ctx.sessionKey ?? "unknown";
        const hooks = getSessionHooks(sessionKey, ctx);

        if (!hooks.enabled) {
          return;
        }

        // Track user message
        if (typeof event.prompt === "string" && event.prompt.trim()) {
          hooks.onUserMessage(event.prompt);
        }

        // Retrieve context memories
        try {
          const memoryContext = await hooks.retrieveContext(event.prompt);
          if (memoryContext && memoryContext.trim()) {
            api.logger.debug?.(
              `[memory] injecting ${memoryContext.length} chars of context for ${sessionKey}`,
            );
            return { prependContext: memoryContext };
          }
        } catch (err) {
          api.logger.warn(`[memory] failed to retrieve context: ${String(err)}`);
        }

        return;
      },
      { priority: 100 }, // High priority to run early
    );

    // agent_end: Track assistant response
    api.on("agent_end", async (event, ctx) => {
      if (!api.runtime.memory.shouldEnableHooks(api.config, ctx.sessionKey)) {
        return;
      }

      const sessionKey = ctx.sessionKey ?? "unknown";
      const hooks = activeSessionHooks.get(sessionKey);

      if (!hooks?.enabled) {
        return;
      }

      // Extract and track the assistant's last text response from messages
      const messages = event.messages as Array<{ role: string; content: unknown }> | undefined;
      if (messages && messages.length > 0) {
        // Find last assistant message and extract text content
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          if (msg.role === "assistant") {
            let textContent: string | undefined;
            if (typeof msg.content === "string") {
              textContent = msg.content;
            } else if (Array.isArray(msg.content)) {
              const textPart = msg.content.find(
                (c: unknown): c is { type: "text"; text: string } =>
                  c != null &&
                  typeof c === "object" &&
                  (c as { type?: string }).type === "text" &&
                  typeof (c as { text?: string }).text === "string",
              );
              if (textPart) {
                textContent = textPart.text;
              }
            }
            if (textContent) {
              hooks.onAssistantMessage(textContent);
              break;
            }
          }
        }
      }
    });

    // after_tool_call: Track tool executions
    api.on("after_tool_call", async (event, ctx) => {
      if (!api.runtime.memory.shouldEnableHooks(api.config, ctx.sessionKey)) {
        return;
      }

      const sessionKey = ctx.sessionKey ?? "unknown";
      const hooks = activeSessionHooks.get(sessionKey);

      if (!hooks?.enabled) {
        return;
      }

      hooks.onToolCall(
        event.toolName,
        `${event.toolName}-${Date.now()}`, // Generate tool call ID
        event.params,
        event.result,
        !!event.error,
      );
    });

    // session_end: Finalize session memory
    api.on("session_end", async (event, ctx) => {
      const sessionKey = ctx.sessionId;
      const hooks = activeSessionHooks.get(sessionKey);

      if (hooks?.enabled) {
        hooks.onSessionEnd("success");
        api.logger.debug?.(`[memory] session ended: ${sessionKey}`);
      }

      // Cleanup
      activeSessionHooks.delete(sessionKey);
    });
  },
};

export default memoryCorePlugin;
