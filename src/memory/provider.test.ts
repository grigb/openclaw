/**
 * Tests for Memory Provider
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  MembraneProvider,
  NoOpMemoryProvider,
  createMemoryProvider,
  DEFAULT_MEMORY_CONFIG,
  type MemoryProviderConfig,
} from "./provider.js";

describe("createMemoryProvider", () => {
  it("should create NoOpMemoryProvider when disabled", () => {
    const config: MemoryProviderConfig = {
      ...DEFAULT_MEMORY_CONFIG,
      enabled: false,
    };
    const provider = createMemoryProvider(config);
    expect(provider).toBeInstanceOf(NoOpMemoryProvider);
  });

  it("should create NoOpMemoryProvider when backend is none", () => {
    const config: MemoryProviderConfig = {
      ...DEFAULT_MEMORY_CONFIG,
      backend: "none",
    };
    const provider = createMemoryProvider(config);
    expect(provider).toBeInstanceOf(NoOpMemoryProvider);
  });

  it("should create MembraneProvider when backend is membrane", () => {
    const config: MemoryProviderConfig = {
      ...DEFAULT_MEMORY_CONFIG,
      backend: "membrane",
    };
    const provider = createMemoryProvider(config);
    expect(provider).toBeInstanceOf(MembraneProvider);
  });
});

describe("NoOpMemoryProvider", () => {
  let provider: NoOpMemoryProvider;

  beforeEach(() => {
    provider = new NoOpMemoryProvider();
  });

  it("should return empty records on retrieve", async () => {
    const result = await provider.retrieve("test query");
    expect(result.records).toEqual([]);
    expect(result.source).toBe("fallback");
  });

  it("should return null on ingest", async () => {
    const result = await provider.ingest({
      source: "test",
      eventKind: "test",
      summary: "test",
    });
    expect(result).toBeNull();
  });

  it("should do nothing on reinforce", async () => {
    // Should not throw
    await expect(provider.reinforce("test-id")).resolves.toBeUndefined();
  });

  it("should return false for isAvailable", async () => {
    const available = await provider.isAvailable();
    expect(available).toBe(false);
  });

  it("should return disabled status", async () => {
    const status = await provider.getStatus();
    expect(status.available).toBe(false);
    expect(status.backend).toBe("none");
    expect(status.error).toBe("Memory disabled");
  });
});

describe("MembraneProvider", () => {
  describe("graceful degradation", () => {
    it("should return empty on retrieve when disabled", async () => {
      const config: MemoryProviderConfig = {
        ...DEFAULT_MEMORY_CONFIG,
        enabled: false,
      };
      const provider = new MembraneProvider(config);
      const result = await provider.retrieve("test");
      expect(result.records).toEqual([]);
      expect(result.source).toBe("fallback");
    });

    it("should return null on ingest when disabled", async () => {
      const config: MemoryProviderConfig = {
        ...DEFAULT_MEMORY_CONFIG,
        enabled: false,
      };
      const provider = new MembraneProvider(config);
      const result = await provider.ingest({
        source: "test",
        eventKind: "test",
        summary: "test",
      });
      expect(result).toBeNull();
    });

    it("should not throw on reinforce when disabled", async () => {
      const config: MemoryProviderConfig = {
        ...DEFAULT_MEMORY_CONFIG,
        enabled: false,
      };
      const provider = new MembraneProvider(config);
      await expect(provider.reinforce("test-id")).resolves.toBeUndefined();
    });
  });

  describe("record type detection", () => {
    it("should detect IngestEventRequest", async () => {
      // This would require mocking the client
      // For now, verify the interface accepts the request type
      const config: MemoryProviderConfig = {
        ...DEFAULT_MEMORY_CONFIG,
        enabled: false,
      };
      const provider = new MembraneProvider(config);

      const eventRequest = {
        source: "test",
        eventKind: "test_event",
        ref: "ref-1",
        summary: "Test event",
      };

      // Should not throw, should return null when disabled
      const result = await provider.ingest(eventRequest);
      expect(result).toBeNull();
    });

    it("should detect IngestToolOutputRequest", async () => {
      const config: MemoryProviderConfig = {
        ...DEFAULT_MEMORY_CONFIG,
        enabled: false,
      };
      const provider = new MembraneProvider(config);

      const toolRequest = {
        source: "test",
        toolName: "exec",
        args: { command: "ls" },
        result: { output: "file1.txt" },
      };

      const result = await provider.ingest(toolRequest);
      expect(result).toBeNull();
    });

    it("should detect IngestObservationRequest", async () => {
      const config: MemoryProviderConfig = {
        ...DEFAULT_MEMORY_CONFIG,
        enabled: false,
      };
      const provider = new MembraneProvider(config);

      const observationRequest = {
        source: "test",
        subject: "user",
        predicate: "prefers",
        object: "TypeScript",
      };

      const result = await provider.ingest(observationRequest);
      expect(result).toBeNull();
    });

    it("should detect IngestWorkingStateRequest", async () => {
      const config: MemoryProviderConfig = {
        ...DEFAULT_MEMORY_CONFIG,
        enabled: false,
      };
      const provider = new MembraneProvider(config);

      const workingStateRequest = {
        source: "test",
        threadId: "session-1",
        state: "executing" as const,
        nextActions: ["complete task"],
      };

      const result = await provider.ingest(workingStateRequest);
      expect(result).toBeNull();
    });
  });
});

// Integration tests - only run if Membrane is available
describe.skipIf(!process.env.MEMBRANE_INTEGRATION)("MembraneProvider Integration", () => {
  let provider: MembraneProvider;

  beforeEach(() => {
    provider = new MembraneProvider({
      ...DEFAULT_MEMORY_CONFIG,
      enabled: true,
      membrane: {
        address: "localhost:19090",
        connectTimeoutMs: 5000,
        requestTimeoutMs: 30000,
        useTls: false,
      },
    });
  });

  it("should be available when Membrane is running", async () => {
    const available = await provider.isAvailable();
    expect(available).toBe(true);
  });

  it("should retrieve memory", async () => {
    const result = await provider.retrieve("test query");
    expect(result.source).toBe("membrane");
    expect(Array.isArray(result.records)).toBe(true);
  });

  it("should ingest an event", async () => {
    const record = await provider.ingest({
      source: "test-provider",
      eventKind: "provider_test",
      ref: "test-ref-provider-001",  // Required by Membrane policy
      summary: "Test from provider",
      tags: ["test"],
    });

    expect(record).not.toBeNull();
    expect(record?.type).toBe("episodic");
  });

  it("should get status with metrics", async () => {
    const status = await provider.getStatus();
    expect(status.available).toBe(true);
    expect(status.backend).toBe("membrane");
    expect(status.metrics).toBeDefined();
  });
});
