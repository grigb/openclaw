import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { wrapToolWithAfterToolCallHook } from "./pi-tools.after-tool-call.js";
import * as hookRunnerGlobal from "../plugins/hook-runner-global.js";

describe("after_tool_call hook integration", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("executes tool normally when no hook is registered", async () => {
    vi.spyOn(hookRunnerGlobal, "getGlobalHookRunner").mockReturnValue(null);

    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "result" }] });
    const tool = wrapToolWithAfterToolCallHook({ name: "Read", execute } as any, {
      agentId: "main",
      sessionKey: "agent:main:main",
    });

    const result = await tool.execute!("call-1", { path: "/tmp/test.txt" }, undefined, undefined);

    expect(result).toEqual({ content: [{ type: "text", text: "result" }] });
    expect(execute).toHaveBeenCalledWith("call-1", { path: "/tmp/test.txt" }, undefined, undefined);
  });

  it("calls after_tool_call hook with tool result", async () => {
    const mockRunAfterToolCall = vi.fn().mockResolvedValue(undefined);
    const mockHookRunner = {
      hasHooks: vi.fn().mockReturnValue(true),
      runAfterToolCall: mockRunAfterToolCall,
    };
    vi.spyOn(hookRunnerGlobal, "getGlobalHookRunner").mockReturnValue(mockHookRunner as any);

    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "result" }] });
    const tool = wrapToolWithAfterToolCallHook({ name: "exec", execute } as any, {
      agentId: "main",
      sessionKey: "agent:main:main",
    });

    await tool.execute!("call-2", { command: "ls" }, undefined, undefined);

    // Wait for fire-and-forget hook to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockHookRunner.hasHooks).toHaveBeenCalledWith("after_tool_call");
    expect(mockRunAfterToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "exec",
        params: { command: "ls" },
        result: { content: [{ type: "text", text: "result" }] },
        error: undefined,
      }),
      expect.objectContaining({
        toolName: "exec",
        agentId: "main",
        sessionKey: "agent:main:main",
      }),
    );
  });

  it("calls after_tool_call hook with error when tool throws", async () => {
    const mockRunAfterToolCall = vi.fn().mockResolvedValue(undefined);
    const mockHookRunner = {
      hasHooks: vi.fn().mockReturnValue(true),
      runAfterToolCall: mockRunAfterToolCall,
    };
    vi.spyOn(hookRunnerGlobal, "getGlobalHookRunner").mockReturnValue(mockHookRunner as any);

    const execute = vi.fn().mockRejectedValue(new Error("Tool failed"));
    const tool = wrapToolWithAfterToolCallHook({ name: "read", execute } as any);

    await expect(tool.execute!("call-3", { path: "/tmp/test" }, undefined, undefined)).rejects.toThrow(
      "Tool failed",
    );

    // Wait for fire-and-forget hook to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockRunAfterToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "read",
        error: "Tool failed",
      }),
      expect.objectContaining({
        toolName: "read",
      }),
    );
  });

  it("continues execution even when hook throws", async () => {
    const mockHookRunner = {
      hasHooks: vi.fn().mockReturnValue(true),
      runAfterToolCall: vi.fn().mockRejectedValue(new Error("Hook error")),
    };
    vi.spyOn(hookRunnerGlobal, "getGlobalHookRunner").mockReturnValue(mockHookRunner as any);

    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "success" }] });
    const tool = wrapToolWithAfterToolCallHook({ name: "read", execute } as any);

    const result = await tool.execute!("call-4", { path: "/tmp/file" }, undefined, undefined);

    // Tool should succeed even if hook fails
    expect(result).toEqual({ content: [{ type: "text", text: "success" }] });
  });

  it("includes duration in hook event", async () => {
    const mockRunAfterToolCall = vi.fn().mockResolvedValue(undefined);
    const mockHookRunner = {
      hasHooks: vi.fn().mockReturnValue(true),
      runAfterToolCall: mockRunAfterToolCall,
    };
    vi.spyOn(hookRunnerGlobal, "getGlobalHookRunner").mockReturnValue(mockHookRunner as any);

    const execute = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { content: [] };
    });
    const tool = wrapToolWithAfterToolCallHook({ name: "slow_tool", execute } as any);

    await tool.execute!("call-5", {}, undefined, undefined);

    // Wait for fire-and-forget hook to complete
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mockRunAfterToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        durationMs: expect.any(Number),
      }),
      expect.anything(),
    );

    const call = mockRunAfterToolCall.mock.calls[0][0];
    expect(call.durationMs).toBeGreaterThanOrEqual(10);
  });
});
