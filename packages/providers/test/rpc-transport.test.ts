import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { AcpRpc, AcpRpcError, METHOD_NOT_FOUND } from "../src/acp/rpc";
import { AsyncQueue } from "../src/async-queue";
import { CodexRpc, CodexRpcError } from "../src/codex/rpc";

/** In-memory stand-in for a spawned stdio child process. */
class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly written: string[] = [];

  constructor() {
    super();
    let buf = "";
    this.stdin.setEncoding("utf8").on("data", (chunk: string) => {
      buf += chunk;
      for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
        this.written.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
  }

  sendLine(line: string): void {
    this.stdout.write(`${line}\n`);
  }

  sendJson(value: unknown): void {
    this.sendLine(JSON.stringify(value));
  }

  parsedWritten(): Array<Record<string, unknown>> {
    return this.written.map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("AcpRpc", () => {
  it("requires piped stdin and stdout", () => {
    const bare = new EventEmitter() as unknown as ChildProcess;
    expect(
      () =>
        new AcpRpc(bare, {
          onNotification: () => {},
          onRequest: async () => null,
          onExit: () => {},
        }),
    ).toThrow(/piped stdio/);
  });

  it("correlates concurrent out-of-order requests, notifications and error replies", async () => {
    const child = new FakeChild();
    const notifications: unknown[] = [];
    const rpc = new AcpRpc(
      child as unknown as ChildProcess,
      {
        onNotification: (n) => notifications.push(n),
        onRequest: async () => null,
        onExit: () => {},
      },
      "cursor",
    );

    const first = rpc.request<{ ok: number }>("session/new", { cwd: "/a" });
    const second = rpc.request<string>("session/prompt", { text: "hi" });
    const failing = rpc.request("session/bad", {}).catch((error: unknown) => error);
    rpc.notify("session/cancel", { sessionId: "s1" });
    rpc.notify("session/ping");

    expect(child.parsedWritten()).toEqual([
      { jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/a" } },
      { jsonrpc: "2.0", id: 2, method: "session/prompt", params: { text: "hi" } },
      { jsonrpc: "2.0", id: 3, method: "session/bad", params: {} },
      { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s1" } },
      { jsonrpc: "2.0", method: "session/ping" },
    ]);

    // Replies arrive out of order, interspersed with stray prints, blank lines and unknown ids.
    child.sendLine("");
    child.sendLine("debug: starting up...");
    child.sendLine("null");
    child.sendLine("42");
    child.sendJson({ jsonrpc: "2.0", id: 999, result: "unknown" });
    child.sendJson({ jsonrpc: "2.0", method: "session/update", params: { step: 1 } });
    child.sendJson({ jsonrpc: "2.0", id: 2, result: "done" });
    child.sendJson({
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32602, message: "Bad params", data: { field: "x" } },
    });
    child.sendJson({ jsonrpc: "2.0", id: 1, result: { ok: 1 } });

    expect(await second).toBe("done");
    expect(await first).toEqual({ ok: 1 });
    expect(await failing).toMatchObject({
      name: "AcpRpcError",
      code: -32602,
      message: "Bad params",
      data: { field: "x" },
    });
    expect(notifications).toEqual([{ method: "session/update", params: { step: 1 } }]);
  });

  it("answers agent-to-client requests including id 0 and encodes handler errors", async () => {
    const child = new FakeChild();
    new AcpRpc(child as unknown as ChildProcess, {
      onNotification: () => {},
      onRequest: async (msg) => {
        if (msg.method === "fs/read") return { content: "abc" };
        if (msg.method === "void/call") return undefined;
        if (msg.method === "unknown/method") {
          throw new AcpRpcError(METHOD_NOT_FOUND, "Not supported");
        }
        throw new Error("boom");
      },
      onExit: () => {},
    });

    child.sendJson({ jsonrpc: "2.0", id: 0, method: "fs/read", params: { path: "a" } });
    child.sendJson({ jsonrpc: "2.0", id: "req-1", method: "void/call" });
    child.sendJson({ jsonrpc: "2.0", id: 2, method: "unknown/method" });
    child.sendJson({ jsonrpc: "2.0", id: 3, method: "crash" });
    await flush();

    expect(child.parsedWritten()).toEqual([
      { jsonrpc: "2.0", id: 0, result: { content: "abc" } },
      { jsonrpc: "2.0", id: "req-1", result: null },
      { jsonrpc: "2.0", id: 2, error: { code: METHOD_NOT_FOUND, message: "Not supported" } },
      { jsonrpc: "2.0", id: 3, error: { code: -32603, message: "boom" } },
    ]);
  });

  it("rejects pending requests on exit, caps stderr tail at 4000 chars and handles close", async () => {
    const child = new FakeChild();
    const exits: Array<{ code: number | null; stderr: string }> = [];
    const rpc = new AcpRpc(
      child as unknown as ChildProcess,
      {
        onNotification: () => {},
        onRequest: async () => null,
        onExit: (code, stderr) => exits.push({ code, stderr }),
      },
      "gemini",
    );

    const pending = rpc.request("session/prompt", {}).catch((error: unknown) => error);
    child.stderr.write("a".repeat(3500));
    child.stderr.write(`${"b".repeat(1000)}TAIL`);
    await flush();

    const closing = rpc.close();
    expect(child.stdin.writableEnded).toBe(true);
    child.emit("exit", 137);
    child.emit("exit", 137); // second exit is ignored
    await closing;

    expect(rpc.isClosed).toBe(true);
    expect(await pending).toMatchObject({
      name: "AcpRpcError",
      code: -32000,
      message: "gemini exited (code 137)",
    });
    expect(exits).toHaveLength(1);
    expect(exits[0]?.code).toBe(137);
    expect(exits[0]?.stderr.length).toBe(4000);
    expect(exits[0]?.stderr.endsWith("TAIL")).toBe(true);

    // Calling request after exit rejects immediately and close is idempotent.
    await expect(rpc.request("session/new", {})).rejects.toThrow(/gemini is not running/);
    await rpc.close();
  });

  it("records spawn error in stderr tail and transitions to closed", async () => {
    const child = new FakeChild();
    const exits: Array<{ code: number | null; stderr: string }> = [];
    const rpc = new AcpRpc(child as unknown as ChildProcess, {
      onNotification: () => {},
      onRequest: async () => null,
      onExit: (code, stderr) => exits.push({ code, stderr }),
    });

    child.emit("error", new Error("ENOENT"));
    expect(rpc.isClosed).toBe(true);
    expect(exits).toEqual([{ code: null, stderr: "\nENOENT" }]);
  });
});

describe("CodexRpc", () => {
  it("requires piped stdin and stdout", () => {
    const bare = new EventEmitter() as unknown as ChildProcess;
    expect(
      () =>
        new CodexRpc(bare, {
          onNotification: () => {},
          onRequest: async () => null,
          onExit: () => {},
        }),
    ).toThrow(/piped stdio/);
  });

  it("handles requests, notifications, id 0 server requests, error replies and non-object JSON", async () => {
    const child = new FakeChild();
    const notifications: unknown[] = [];
    const rpc = new CodexRpc(child as unknown as ChildProcess, {
      onNotification: (n) => notifications.push(n),
      onRequest: async (req) => {
        if (req.method === "item/commandExecution/requestApproval") return { decision: "accept" };
        if (req.method === "account/chatgptAuthTokens/refresh") {
          throw new CodexRpcError(-32001, "refresh denied");
        }
        throw new Error("unexpected failure");
      },
      onExit: () => {},
    });

    const req1 = rpc.request<{ id: string }, "thread/start">("thread/start", {} as never);
    const req2 = rpc
      .request<unknown, "thread/read">("thread/read", { threadId: "t1" } as never)
      .catch((error: unknown) => error);
    rpc.notify("initialized");

    expect(child.parsedWritten()).toEqual([
      { id: 1, method: "thread/start", params: {} },
      { id: 2, method: "thread/read", params: { threadId: "t1" } },
      { method: "initialized" },
    ]);

    // Stray lines, null/primitive JSON, and unknown response ids are ignored without crashing.
    child.sendLine("");
    child.sendLine("not json");
    child.sendLine("null");
    child.sendLine("123");
    child.sendJson({ id: 99, result: "ignored" });

    // Server-to-client requests with numeric id 0 and string id.
    child.sendJson({ id: 0, method: "item/commandExecution/requestApproval", params: {} });
    child.sendJson({ id: "srv-1", method: "account/chatgptAuthTokens/refresh", params: {} });
    child.sendJson({ id: 7, method: "item/fileChange/requestApproval", params: {} });

    // Notification + responses to our requests.
    child.sendJson({ method: "turn/completed", params: { threadId: "t1" } });
    child.sendJson({ id: 1, result: { id: "t1" } });
    child.sendJson({ id: 2, error: { code: -32002, message: "missing", data: "t1" } });
    await flush();

    expect(await req1).toEqual({ id: "t1" });
    expect(await req2).toMatchObject({
      name: "CodexRpcError",
      code: -32002,
      message: "missing",
      data: "t1",
    });
    expect(notifications).toEqual([{ method: "turn/completed", params: { threadId: "t1" } }]);
    expect(child.parsedWritten().slice(3)).toEqual([
      { id: 0, result: { decision: "accept" } },
      { id: "srv-1", error: { code: -32001, message: "refresh denied" } },
      { id: 7, error: { code: -32603, message: "unexpected failure" } },
    ]);
  });

  it("rejects in-flight requests on exit and rejects calls once closed", async () => {
    const child = new FakeChild();
    const exits: Array<{ code: number | null; stderr: string }> = [];
    const rpc = new CodexRpc(child as unknown as ChildProcess, {
      onNotification: () => {},
      onRequest: async () => null,
      onExit: (code, stderr) => exits.push({ code, stderr }),
    });

    const pending = rpc.request("thread/start", {} as never).catch((error: unknown) => error);
    child.stderr.write("fatal error\n");
    await flush();
    child.emit("exit", 1);

    expect(await pending).toMatchObject({
      name: "CodexRpcError",
      code: -32000,
      message: "codex app-server exited (code 1)",
    });
    expect(exits).toEqual([{ code: 1, stderr: "fatal error\n" }]);
    expect(rpc.isClosed).toBe(true);
    await expect(rpc.request("thread/start", {} as never)).rejects.toThrow(/is not running/);
    await rpc.close();
  });
});

describe("AsyncQueue", () => {
  it("delivers buffered items in FIFO order and drains them after close", async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.close();
    q.push(3); // ignored after close
    expect(q.isClosed).toBe(true);

    const seen: number[] = [];
    for await (const item of q) seen.push(item);
    expect(seen).toEqual([1, 2]);
  });

  it("wakes waiting consumers in order and ends them when closed", async () => {
    const q = new AsyncQueue<string>();
    const iter = q[Symbol.asyncIterator]();
    const p1 = iter.next();
    const p2 = iter.next();
    const p3 = iter.next();

    q.push("a");
    q.push("b");
    q.close();
    q.close(); // idempotent

    expect(await p1).toEqual({ value: "a", done: false });
    expect(await p2).toEqual({ value: "b", done: false });
    expect(await p3).toEqual({ value: undefined, done: true });
    expect(await iter.next()).toEqual({ value: undefined, done: true });
  });

  it("closes the queue when the consumer breaks out of iteration early", async () => {
    const q = new AsyncQueue<number>();
    q.push(10);
    q.push(20);

    const seen: number[] = [];
    for await (const value of q) {
      seen.push(value);
      break;
    }
    expect(seen).toEqual([10]);
    expect(q.isClosed).toBe(true);
  });
});
