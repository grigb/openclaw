import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  MemoryLifecycleManager,
  initializeMemory,
  getMemoryProvider,
  getMemoryConfig,
  createSessionMemoryManager,
  shutdownMemory,
  type SessionContext,
} from "./lifecycle.js";
import type { MemoryConfig } from "./config-schema.js";
import { NoOpMemoryProvider } from "./provider.js";

describe("MemoryLifecycleManager", () => {
  const mockProvider = {
    retrieve: vi.fn().mockResolvedValue({ records: [], source: "membrane" }),
    ingest: vi.fn().mockResolvedValue({ id: "test-id" }),
    reinforce: vi.fn().mockResolvedValue(undefined),
    isAvailable: vi.fn().mockResolvedValue(true),
    getStatus: vi.fn().mockResolvedValue({ available: true, backend: "membrane" }),
  };

  const mockConfig: MemoryConfig = {
    enabled: true,
    backend: "membrane",
    ingestion: {
      enabled: true,
      async: true,
      filterToolPatterns: [],
      excludeSessionTypes: ["heartbeat"],
    },
    retrieval: {
      maxRecords: 20,
      maxTokens: 2000,
      minSalience: 0.3,
      includeTypes: ["semantic", "competence", "working", "episodic"],
      defaultMaxSensitivity: "medium",
    },
    session: {
      idFormat: "{channel}:{type}:{uuid}",
      workingMemoryTtlHours: 48,
    },
  };

  const sessionContext: SessionContext = {
    sessionId: "test-session-123",
    sessionKey: "agent:main:main",
    channel: "matrix",
    sessionType: "main",
    agentId: "main",
    actorId: "user-123",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("onSessionStart", () => {
    it("should ingest session start event", async () => {
      const manager = new MemoryLifecycleManager({
        provider: mockProvider as any,
        config: mockConfig,
        sessionContext,
      });

      await manager.onSessionStart();

      expect(mockProvider.ingest).toHaveBeenCalledTimes(1);
      expect(mockProvider.ingest).toHaveBeenCalledWith(
        expect.objectContaining({
          eventKind: "session_start",
          ref: "test-session-123",
        }),
      );
    });

    it("should skip excluded session types", async () => {
      const heartbeatContext: SessionContext = {
        ...sessionContext,
        sessionType: "heartbeat",
      };

      const manager = new MemoryLifecycleManager({
        provider: mockProvider as any,
        config: mockConfig,
        sessionContext: heartbeatContext,
      });

      await manager.onSessionStart();

      expect(mockProvider.ingest).not.toHaveBeenCalled();
    });

    it("should handle disabled ingestion", async () => {
      const disabledConfig: MemoryConfig = {
        ...mockConfig,
        ingestion: { ...mockConfig.ingestion!, enabled: false },
      };

      const manager = new MemoryLifecycleManager({
        provider: mockProvider as any,
        config: disabledConfig,
        sessionContext,
      });

      await manager.onSessionStart();

      expect(mockProvider.ingest).not.toHaveBeenCalled();
    });
  });

  describe("onMessage", () => {
    it("should ingest user messages", async () => {
      const manager = new MemoryLifecycleManager({
        provider: mockProvider as any,
        config: mockConfig,
        sessionContext,
      });

      await manager.onMessage({
        role: "user",
        content: "Hello, world!",
        timestamp: "2026-02-06T12:00:00Z",
      });

      expect(mockProvider.ingest).toHaveBeenCalledWith(
        expect.objectContaining({
          eventKind: "message_user",
          summary: "Hello, world!",
        }),
      );
    });

    it("should ingest assistant messages", async () => {
      const manager = new MemoryLifecycleManager({
        provider: mockProvider as any,
        config: mockConfig,
        sessionContext,
      });

      await manager.onMessage({
        role: "assistant",
        content: "I can help with that.",
      });

      expect(mockProvider.ingest).toHaveBeenCalledWith(
        expect.objectContaining({
          eventKind: "message_assistant",
        }),
      );
    });

    it("should truncate long content", async () => {
      const manager = new MemoryLifecycleManager({
        provider: mockProvider as any,
        config: mockConfig,
        sessionContext,
      });

      const longContent = "a".repeat(1000);
      await manager.onMessage({
        role: "user",
        content: longContent,
      });

      const call = mockProvider.ingest.mock.calls[0][0];
      expect(call.summary.length).toBeLessThanOrEqual(503); // 500 + "..."
    });

    it("should detect sensitive content", async () => {
      const manager = new MemoryLifecycleManager({
        provider: mockProvider as any,
        config: mockConfig,
        sessionContext,
      });

      await manager.onMessage({
        role: "user",
        content: "My password is secret123",
      });

      expect(mockProvider.ingest).toHaveBeenCalledWith(
        expect.objectContaining({
          sensitivity: "high",
        }),
      );
    });
  });

  describe("onToolCall", () => {
    it("should ingest tool calls", async () => {
      const manager = new MemoryLifecycleManager({
        provider: mockProvider as any,
        config: mockConfig,
        sessionContext,
      });

      await manager.onToolCall({
        toolName: "read",
        toolCallId: "call-123",
        args: { path: "/test/file.txt" },
        result: { content: "file contents" },
        isError: false,
      });

      expect(mockProvider.ingest).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "read",
          args: { path: "/test/file.txt" },
        }),
      );
    });

    it("should filter tools by pattern", async () => {
      const configWithFilter: MemoryConfig = {
        ...mockConfig,
        ingestion: {
          ...mockConfig.ingestion!,
          filterToolPatterns: ["^internal_.*"],
        },
      };

      const manager = new MemoryLifecycleManager({
        provider: mockProvider as any,
        config: configWithFilter,
        sessionContext,
      });

      await manager.onToolCall({
        toolName: "internal_debug",
        toolCallId: "call-123",
        args: {},
      });

      expect(mockProvider.ingest).not.toHaveBeenCalled();
    });

    it("should track error tools", async () => {
      const manager = new MemoryLifecycleManager({
        provider: mockProvider as any,
        config: mockConfig,
        sessionContext,
      });

      await manager.onToolCall({
        toolName: "exec",
        toolCallId: "call-123",
        args: { command: "ls" },
        result: { error: "Permission denied" },
        isError: true,
      });

      expect(mockProvider.ingest).toHaveBeenCalledWith(
        expect.objectContaining({
          tags: expect.arrayContaining(["error"]),
        }),
      );
    });
  });

  describe("retrieveContext", () => {
    it("should retrieve memory context", async () => {
      mockProvider.retrieve.mockResolvedValueOnce({
        records: [
          {
            id: "mem-1",
            type: "semantic",
            salience: 0.8,
            payload: { kind: "semantic", subject: "test", predicate: "is", object: "working" },
          },
        ],
        source: "membrane",
      });

      const manager = new MemoryLifecycleManager({
        provider: mockProvider as any,
        config: mockConfig,
        sessionContext,
      });

      const result = await manager.retrieveContext({
        query: "test query",
        maxTokens: 1000,
      });

      expect(mockProvider.retrieve).toHaveBeenCalledWith("test query", expect.any(Object));
      expect(result.records).toHaveLength(1);
      expect(result.source).toBe("membrane");
    });

    it("should use config defaults for retrieval", async () => {
      const manager = new MemoryLifecycleManager({
        provider: mockProvider as any,
        config: mockConfig,
        sessionContext,
      });

      await manager.retrieveContext({ query: "test" });

      expect(mockProvider.retrieve).toHaveBeenCalledWith(
        "test",
        expect.objectContaining({
          maxTokens: 2000,
          minSalience: 0.3,
          limit: 20,
        }),
      );
    });
  });

  describe("formatMemoriesForPrompt", () => {
    it("should format semantic memories", () => {
      const manager = new MemoryLifecycleManager({
        provider: mockProvider as any,
        config: mockConfig,
        sessionContext,
      });

      const records = [
        {
          id: "mem-1",
          type: "semantic" as const,
          salience: 0.8,
          confidence: 0.9,
          sensitivity: "low" as const,
          createdAt: "2026-02-06T12:00:00Z",
          updatedAt: "2026-02-06T12:00:00Z",
          lifecycle: {
            decay: { curve: "exponential" as const, deletionPolicy: "auto_prune" as const },
            lastReinforcedAt: "2026-02-06T12:00:00Z",
            deletionPolicy: "auto_prune" as const,
          },
          provenance: { sources: [] },
          payload: {
            kind: "semantic" as const,
            subject: "user",
            predicate: "prefers",
            object: "dark mode",
          },
          auditLog: [],
        },
      ];

      const formatted = manager.formatMemoriesForPrompt(records);

      expect(formatted).toContain("## Retrieved Memories");
      expect(formatted).toContain("user prefers");
      expect(formatted).toContain("[80%]");
    });

    it("should respect maxChars limit", () => {
      const manager = new MemoryLifecycleManager({
        provider: mockProvider as any,
        config: mockConfig,
        sessionContext,
      });

      const records = Array.from({ length: 100 }, (_, i) => ({
        id: `mem-${i}`,
        type: "semantic" as const,
        salience: 0.8,
        confidence: 0.9,
        sensitivity: "low" as const,
        createdAt: "2026-02-06T12:00:00Z",
        updatedAt: "2026-02-06T12:00:00Z",
        lifecycle: {
          decay: { curve: "exponential" as const, deletionPolicy: "auto_prune" as const },
          lastReinforcedAt: "2026-02-06T12:00:00Z",
          deletionPolicy: "auto_prune" as const,
        },
        provenance: { sources: [] },
        payload: {
          kind: "semantic" as const,
          subject: `subject${i}`,
          predicate: "has",
          object: "a very long description that takes up space",
        },
        auditLog: [],
      }));

      const formatted = manager.formatMemoriesForPrompt(records, 500);

      expect(formatted.length).toBeLessThanOrEqual(600); // Some margin for the header
    });

    it("should return empty string for no records", () => {
      const manager = new MemoryLifecycleManager({
        provider: mockProvider as any,
        config: mockConfig,
        sessionContext,
      });

      const formatted = manager.formatMemoriesForPrompt([]);

      expect(formatted).toBe("");
    });
  });

  describe("onPositiveFeedback", () => {
    it("should reinforce memory", async () => {
      const manager = new MemoryLifecycleManager({
        provider: mockProvider as any,
        config: mockConfig,
        sessionContext,
      });

      await manager.onPositiveFeedback({
        type: "positive",
        recordId: "mem-123",
        rationale: "This was helpful",
      });

      expect(mockProvider.reinforce).toHaveBeenCalledWith("mem-123", "This was helpful");
    });
  });

  describe("onSessionEnd", () => {
    it("should ingest session end event", async () => {
      const manager = new MemoryLifecycleManager({
        provider: mockProvider as any,
        config: mockConfig,
        sessionContext,
      });

      await manager.onSessionEnd({ outcome: "success", summary: "Task completed" });

      expect(mockProvider.ingest).toHaveBeenCalledWith(
        expect.objectContaining({
          eventKind: "session_end",
          tags: expect.arrayContaining(["success"]),
        }),
      );
    });
  });
});

describe("Memory initialization", () => {
  afterEach(async () => {
    await shutdownMemory();
  });

  it("should initialize with disabled config", async () => {
    await initializeMemory({ enabled: false });

    expect(getMemoryProvider()).toBeNull();
    expect(getMemoryConfig()?.enabled).toBe(false);
  });

  it("should initialize with enabled config", async () => {
    await initializeMemory({
      enabled: true,
      backend: "membrane",
      membrane: {
        address: "localhost:19090",
        connectTimeoutMs: 5000,
        requestTimeoutMs: 30000,
        useTls: false,
      },
    });

    expect(getMemoryProvider()).not.toBeNull();
    expect(getMemoryConfig()?.enabled).toBe(true);
  });

  it("should return null manager when disabled", async () => {
    await initializeMemory({ enabled: false });

    const manager = createSessionMemoryManager({
      sessionId: "test-session",
      sessionKey: "agent:main:main",
    });

    expect(manager).toBeNull();
  });
});
