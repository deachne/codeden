import { afterEach, describe, expect, it, vi } from "vitest";
import { KeyringSecretStore, MemorySecretStore } from "../src/services/secrets";

afterEach(() => {
  vi.doUnmock("@napi-rs/keyring");
  vi.resetModules();
});

describe("MemorySecretStore", () => {
  it("stores, overwrites, isolates, and deletes secrets in memory", async () => {
    const store = new MemorySecretStore();
    expect(store.backend).toBe("memory");
    expect(await store.get("openai.apiKey")).toBeNull();

    await store.set("openai.apiKey", "sk-first");
    await store.set("github.token", "ghp-token");
    expect(await store.get("openai.apiKey")).toBe("sk-first");
    expect(await store.get("github.token")).toBe("ghp-token");

    await store.set("openai.apiKey", "sk-updated");
    expect(await store.get("openai.apiKey")).toBe("sk-updated");

    await store.delete("openai.apiKey");
    expect(await store.get("openai.apiKey")).toBeNull();
    expect(await store.get("github.token")).toBe("ghp-token");

    // Deleting a key that is not present is a safe no-op.
    await expect(store.delete("elevenlabs.apiKey")).resolves.toBeUndefined();
  });
});

describe("KeyringSecretStore", () => {
  function makeFakeEntry() {
    const calls: Array<{
      op: "get" | "set" | "delete";
      service: string;
      account: string;
      password?: string;
    }> = [];
    const data = new Map<string, string>();

    class FakeEntry {
      constructor(
        private readonly service: string,
        private readonly account: string,
      ) {}

      async getPassword(): Promise<string | null> {
        calls.push({ op: "get", service: this.service, account: this.account });
        return data.get(`${this.service}:${this.account}`) ?? null;
      }

      async setPassword(password: string): Promise<void> {
        calls.push({ op: "set", service: this.service, account: this.account, password });
        data.set(`${this.service}:${this.account}`, password);
      }

      async deletePassword(): Promise<boolean> {
        calls.push({ op: "delete", service: this.service, account: this.account });
        return data.delete(`${this.service}:${this.account}`);
      }
    }

    return { FakeEntry, calls };
  }

  it("delegates get, set, and delete using the default 'codeden' service name", async () => {
    const { FakeEntry, calls } = makeFakeEntry();
    const store = new KeyringSecretStore(FakeEntry);
    expect(store.backend).toBe("keyring");

    expect(await store.get("anthropic.apiKey")).toBeNull();
    await store.set("anthropic.apiKey", "sk-ant-123");
    expect(await store.get("anthropic.apiKey")).toBe("sk-ant-123");
    await store.delete("anthropic.apiKey");
    expect(await store.get("anthropic.apiKey")).toBeNull();

    expect(calls).toEqual([
      { op: "get", service: "codeden", account: "anthropic.apiKey" },
      { op: "set", service: "codeden", account: "anthropic.apiKey", password: "sk-ant-123" },
      { op: "get", service: "codeden", account: "anthropic.apiKey" },
      { op: "delete", service: "codeden", account: "anthropic.apiKey" },
      { op: "get", service: "codeden", account: "anthropic.apiKey" },
    ]);
  });

  it("passes a custom service name to the Entry constructor", async () => {
    const { FakeEntry, calls } = makeFakeEntry();
    const store = new KeyringSecretStore(FakeEntry, "codeden-dev");

    await store.set("gemini.apiKey", "gm-secret");
    expect(await store.get("gemini.apiKey")).toBe("gm-secret");
    await store.delete("gemini.apiKey");

    expect(calls.map((c) => [c.op, c.service, c.account])).toEqual([
      ["set", "codeden-dev", "gemini.apiKey"],
      ["get", "codeden-dev", "gemini.apiKey"],
      ["delete", "codeden-dev", "gemini.apiKey"],
    ]);
  });
});

describe("createSecretStore", () => {
  it("falls back to MemorySecretStore and logs when @napi-rs/keyring cannot load", async () => {
    vi.resetModules();
    vi.doMock("@napi-rs/keyring", () => {
      throw new Error("native addon missing");
    });

    const { createSecretStore } = await import("../src/services/secrets");
    const logs: string[] = [];
    const store = await createSecretStore((m) => logs.push(m));

    expect(store.backend).toBe("memory");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^keychain unavailable, keeping secrets in memory:/);

    await store.set("elevenlabs.apiKey", "el-key");
    expect(await store.get("elevenlabs.apiKey")).toBe("el-key");
  });

  it("returns KeyringSecretStore backed by AsyncEntry when @napi-rs/keyring loads", async () => {
    vi.resetModules();
    const seen: Array<[string, string]> = [];
    class MockAsyncEntry {
      constructor(
        private readonly service: string,
        private readonly account: string,
      ) {}
      async getPassword() {
        seen.push([this.service, this.account]);
        return "from-keyring";
      }
      async setPassword() {}
      async deletePassword() {
        return true;
      }
    }
    vi.doMock("@napi-rs/keyring", () => ({ AsyncEntry: MockAsyncEntry }));

    const { createSecretStore } = await import("../src/services/secrets");
    const logs: string[] = [];
    const store = await createSecretStore((m) => logs.push(m));

    expect(store.backend).toBe("keyring");
    expect(logs).toEqual([]);
    expect(await store.get("github.token")).toBe("from-keyring");
    expect(seen).toEqual([["codeden", "github.token"]]);
  });
});
