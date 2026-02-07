/**
 * Tests for Membrane gRPC Client
 *
 * These tests verify the client implementation works correctly.
 * Integration tests require a running Membrane daemon on localhost:19090.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  MembraneClient,
  createMembraneClient,
  MembraneConnectionError,
  type MembraneClientConfig,
} from "./membrane-client.js";

describe("MembraneClient", () => {
  describe("construction", () => {
    it("should create client with default config", () => {
      const client = createMembraneClient();
      expect(client).toBeInstanceOf(MembraneClient);
    });

    it("should create client with custom config", () => {
      const config: MembraneClientConfig = {
        address: "localhost:9999",
        connectTimeoutMs: 1000,
        requestTimeoutMs: 5000,
        apiKey: "test-key",
        useTls: false,
      };
      const client = createMembraneClient(config);
      expect(client).toBeInstanceOf(MembraneClient);
    });
  });

  describe("connection", () => {
    it("should return false for isConnected when server is not running", async () => {
      const client = createMembraneClient({
        address: "localhost:59999", // Non-existent port
        connectTimeoutMs: 100,
      });
      const connected = await client.isConnected();
      expect(connected).toBe(false);
    });

    it("should throw MembraneConnectionError on healthCheck failure", async () => {
      const client = createMembraneClient({
        address: "localhost:59999",
        connectTimeoutMs: 100,
      });
      await expect(client.healthCheck()).rejects.toThrow(MembraneConnectionError);
    });
  });
});

// Integration tests - only run if Membrane is available
describe.skipIf(!process.env.MEMBRANE_INTEGRATION)("MembraneClient Integration", () => {
  let client: MembraneClient;

  beforeAll(async () => {
    client = createMembraneClient({
      address: "localhost:19090",
      connectTimeoutMs: 5000,
    });
  });

  afterAll(() => {
    client.disconnect();
  });

  it("should connect to Membrane", async () => {
    const connected = await client.isConnected();
    expect(connected).toBe(true);
  });

  it("should ingest an event", async () => {
    const record = await client.ingestEvent({
      source: "test-client",
      eventKind: "test_event",
      ref: "test-ref-001",
      summary: "Test event from TypeScript client",
      tags: ["test", "integration"],
      scope: "test",
      sensitivity: "low",
    });

    expect(record).toBeDefined();
    expect(record.id).toBeTruthy();
    expect(record.type).toBe("episodic");
  });

  it("should ingest an observation", async () => {
    const record = await client.ingestObservation({
      source: "test-client",
      subject: "user",
      predicate: "prefers_language",
      object: "TypeScript",
      tags: ["preferences", "test"],
      sensitivity: "low",
    });

    expect(record).toBeDefined();
    expect(record.id).toBeTruthy();
    expect(record.type).toBe("semantic");
  });

  it("should retrieve memory records", async () => {
    const response = await client.retrieve({
      taskDescriptor: "testing the TypeScript client",
      trust: {
        maxSensitivity: "medium",
        authenticated: true,
        actorId: "test-client",
      },
      limit: 10,
    });

    expect(response).toBeDefined();
    expect(Array.isArray(response.records)).toBe(true);
  });

  it("should get metrics", async () => {
    const metrics = await client.getMetrics();
    expect(metrics).toBeDefined();
    expect(metrics.snapshot).toBeDefined();
  });
});
