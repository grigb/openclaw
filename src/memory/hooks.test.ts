import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getSessionMemoryManager,
  removeSessionMemoryManager,
  isMemoryAvailable,
  onSessionStart,
  onMessage,
  onToolCall,
  onSessionEnd,
  retrieveContextMemory,
  formatMemoriesForPrompt,
  onPositiveFeedback,
  onNegativeFeedback,
  updateWorkingState,
  buildSessionContext,
  getMemoryRetrievalConfig,
  cleanupAllSessionManagers,
} from "./hooks.js";
import { initializeMemory, shutdownMemory } from "./lifecycle.js";

describe("Memory Hooks", () => {
  const sessionContext = {
    sessionId: "test-session-123",
    sessionKey: "agent:main:main",
    channel: "matrix",
    sessionType: "main",
    agentId: "main",
  };

  beforeEach(async () => {
    cleanupAllSessionManagers();
    await shutdownMemory();
  });

  afterEach(async () => {
    cleanupAllSessionManagers();
    await shutdownMemory();
  });

  describe("buildSessionContext", () => {
    it("should build session context from params", () => {
      const ctx = buildSessionContext({
        sessionId: "sess-123",
        sessionKey: "agent:main:main",
        channel: "discord",
        agentId: "main",
      });

      expect(ctx.sessionId).toBe("sess-123");
      expect(ctx.channel).toBe("discord");
      expect(ctx.sessionType).toBe("main"); // inferred from sessionKey
    });

    it("should use messageProvider as fallback for channel", () => {
      const ctx = buildSessionContext({
        sessionId: "sess-123",
        messageProvider: "whatsapp",
      });

      expect(ctx.channel).toBe("whatsapp");
    });

    it("should infer heartbeat session type", () => {
      const ctx = buildSessionContext({
        sessionId: "sess-123",
        sessionKey: "agent:main:heartbeat-abc123",
      });

      expect(ctx.sessionType).toBe("heartbeat");
    });

    it("should infer subagent session type", () => {
      const ctx = buildSessionContext({
        sessionId: "sess-123",
        sessionKey: "agent:main:subagent:task-xyz",
      });

      expect(ctx.sessionType).toBe("subagent");
    });

    it("should infer cron session type", () => {
      const ctx = buildSessionContext({
        sessionId: "sess-123",
        sessionKey: "cron:daily-backup",
      });

      expect(ctx.sessionType).toBe("cron");
    });
  });

  describe("isMemoryAvailable", () => {
    it("should return false when not initialized", async () => {
      const available = await isMemoryAvailable();
      expect(available).toBe(false);
    });

    it("should return false when disabled", async () => {
      await initializeMemory({ enabled: false });
      const available = await isMemoryAvailable();
      expect(available).toBe(false);
    });
  });

  describe("getMemoryRetrievalConfig", () => {
    it("should return disabled config when not initialized", () => {
      const config = getMemoryRetrievalConfig();
      expect(config.enabled).toBe(false);
      expect(config.maxTokens).toBe(0);
    });

    it("should return config values when enabled", async () => {
      await initializeMemory({
        enabled: true,
        backend: "membrane",
        retrieval: {
          maxTokens: 3000,
          minSalience: 0.5,
          maxRecords: 30,
          includeTypes: ["semantic"],
          defaultMaxSensitivity: "high",
        },
      });

      const config = getMemoryRetrievalConfig();
      expect(config.enabled).toBe(true);
      expect(config.maxTokens).toBe(3000);
      expect(config.minSalience).toBe(0.5);
      expect(config.maxRecords).toBe(30);
    });
  });

  describe("Session lifecycle hooks", () => {
    it("should handle hooks gracefully when memory disabled", async () => {
      await initializeMemory({ enabled: false });

      // These should not throw
      await onSessionStart(sessionContext);
      await onMessage(sessionContext, { role: "user", content: "test" });
      await onToolCall(sessionContext, { toolName: "read", toolCallId: "c1" });
      await onSessionEnd(sessionContext);
    });

    it("should return fallback on retrieveContextMemory when disabled", async () => {
      await initializeMemory({ enabled: false });

      const result = await retrieveContextMemory(sessionContext, { query: "test" });

      expect(result.records).toEqual([]);
      expect(result.source).toBe("fallback");
    });

    it("should return empty string on formatMemoriesForPrompt when disabled", async () => {
      await initializeMemory({ enabled: false });

      const formatted = formatMemoriesForPrompt(sessionContext, []);

      expect(formatted).toBe("");
    });
  });

  describe("getSessionMemoryManager", () => {
    it("should return undefined when memory disabled", async () => {
      await initializeMemory({ enabled: false });

      const manager = getSessionMemoryManager(sessionContext);

      expect(manager).toBeUndefined();
    });

    it("should cache managers by session ID", async () => {
      await initializeMemory({
        enabled: true,
        backend: "membrane",
      });

      const manager1 = getSessionMemoryManager(sessionContext);
      const manager2 = getSessionMemoryManager(sessionContext);

      expect(manager1).toBe(manager2);
    });

    it("should create different managers for different sessions", async () => {
      await initializeMemory({
        enabled: true,
        backend: "membrane",
      });

      const ctx1 = { ...sessionContext, sessionId: "session-1" };
      const ctx2 = { ...sessionContext, sessionId: "session-2" };

      const manager1 = getSessionMemoryManager(ctx1);
      const manager2 = getSessionMemoryManager(ctx2);

      expect(manager1).not.toBe(manager2);
    });
  });

  describe("removeSessionMemoryManager", () => {
    it("should remove cached manager", async () => {
      await initializeMemory({
        enabled: true,
        backend: "membrane",
      });

      const manager1 = getSessionMemoryManager(sessionContext);
      removeSessionMemoryManager(sessionContext.sessionId);
      const manager2 = getSessionMemoryManager(sessionContext);

      expect(manager1).not.toBe(manager2);
    });
  });

  describe("cleanupAllSessionManagers", () => {
    it("should clear all cached managers", async () => {
      await initializeMemory({
        enabled: true,
        backend: "membrane",
      });

      const ctx1 = { ...sessionContext, sessionId: "session-1" };
      const ctx2 = { ...sessionContext, sessionId: "session-2" };

      const m1Before = getSessionMemoryManager(ctx1);
      const m2Before = getSessionMemoryManager(ctx2);

      cleanupAllSessionManagers();

      const m1After = getSessionMemoryManager(ctx1);
      const m2After = getSessionMemoryManager(ctx2);

      expect(m1Before).not.toBe(m1After);
      expect(m2Before).not.toBe(m2After);
    });
  });
});
