import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PinnedFile } from "../src/services/voice/local/catalog";
import { DownloadError, downloadVerified, partialPath } from "../src/services/voice/local/download";
import { extractTgzEntry } from "../src/services/voice/local/tgz";
import { sha256 } from "./support/fake-downloads";
import { removeTree } from "./support/remove-tree";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-voice-dl-"));
});

afterEach(async () => {
  await removeTree(dir);
});

function pin(body: Buffer, over: Partial<PinnedFile> = {}): PinnedFile {
  return {
    url: "https://example.test/file.bin",
    sha256: sha256(body),
    bytes: body.length,
    ...over,
  };
}

function streamFrom(chunks: Uint8Array[], failAfter?: Error): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[index++];
      if (next !== undefined) {
        controller.enqueue(next);
        return;
      }
      if (failAfter) controller.error(failAfter);
      else controller.close();
    },
  });
}

function tarHeader(opts: {
  name: string;
  size: number | string;
  type?: string;
  prefix?: string;
  magic?: string;
}): Buffer {
  const header = Buffer.alloc(512);
  header.write(opts.name, 0, "utf8");
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  const sizeField =
    typeof opts.size === "number"
      ? `${opts.size.toString(8).padStart(11, "0")}\0`
      : `${opts.size}\0`;
  header.write(sizeField, 124);
  header.write("00000000000\0", 136);
  header.write("        ", 148);
  header.write(opts.type ?? "0", 156);
  header.write(opts.magic ?? "ustar\0", 257);
  header.write("00", 263);
  if (opts.prefix) header.write(opts.prefix, 345, "utf8");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return header;
}

function padTarData(data: Buffer): Buffer {
  const rem = data.length % 512;
  return rem === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - rem)]);
}

describe("downloadVerified", () => {
  it("rejects with size_mismatch and deletes .partial when stream exceeds file.bytes", async () => {
    const expected = Buffer.from("0123456789");
    const dest = join(dir, "model.bin");
    const fetchImpl: typeof fetch = async () =>
      new Response(streamFrom([Buffer.from("012345"), Buffer.from("6789EXTRA")]), { status: 200 });

    await expect(
      downloadVerified({ file: pin(expected), dest, fetch: fetchImpl }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof DownloadError && err.code === "size_mismatch",
    );
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(partialPath(dest))).toBe(false);
  });

  it("deletes a pre-existing .partial larger than file.bytes before downloading from byte 0", async () => {
    const body = Buffer.from("exact-payload");
    const dest = join(dir, "model.bin");
    writeFileSync(partialPath(dest), Buffer.alloc(body.length + 32, 0xaa));

    const seenRanges: Array<string | null> = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const headers = new Headers(init?.headers);
      seenRanges.push(headers.get("range"));
      return new Response(body, { status: 200 });
    };

    await downloadVerified({ file: pin(body), dest, fetch: fetchImpl });
    expect(seenRanges).toEqual([null]);
    expect(readFileSync(dest)).toEqual(body);
    expect(existsSync(partialPath(dest))).toBe(false);
  });

  it("throws DownloadError('http') on HTTP 4xx and 5xx responses", async () => {
    const body = Buffer.from("hello");
    const dest = join(dir, "model.bin");

    for (const [status, statusText] of [
      [404, "Not Found"],
      [503, "Service Unavailable"],
    ] as const) {
      let cancelled = false;
      const fetchImpl: typeof fetch = async () => {
        const res = new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { status, statusText },
        );
        return res;
      };

      await expect(downloadVerified({ file: pin(body), dest, fetch: fetchImpl })).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof DownloadError &&
          err.code === "http" &&
          err.message.includes(`${status} ${statusText}`),
      );
      expect(cancelled).toBe(true);
    }
  });

  it("restarts from byte 0 when a range request gets 416 Range Not Satisfiable", async () => {
    const body = Buffer.from("0123456789abcdef");
    const dest = join(dir, "model.bin");
    writeFileSync(partialPath(dest), body.subarray(0, 6));

    const seenRanges: Array<string | null> = [];
    let attempt = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      seenRanges.push(new Headers(init?.headers).get("range"));
      attempt += 1;
      if (attempt === 1) return new Response(null, { status: 416 });
      return new Response(body, { status: 200 });
    };

    await downloadVerified({ file: pin(body), dest, fetch: fetchImpl });
    expect(seenRanges).toEqual(["bytes=6-", null]);
    expect(readFileSync(dest)).toEqual(body);
    expect(existsSync(partialPath(dest))).toBe(false);
  });

  it("restarts from byte 0 when 206 Partial Content has a mismatched content-range", async () => {
    const body = Buffer.from("0123456789abcdef");
    const dest = join(dir, "model.bin");
    writeFileSync(partialPath(dest), body.subarray(0, 6));

    const seenRanges: Array<string | null> = [];
    let attempt = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      seenRanges.push(new Headers(init?.headers).get("range"));
      attempt += 1;
      if (attempt === 1) {
        return new Response(body, {
          status: 206,
          headers: { "content-range": `bytes 0-${body.length - 1}/${body.length}` },
        });
      }
      return new Response(body, { status: 200 });
    };

    await downloadVerified({ file: pin(body), dest, fetch: fetchImpl });
    expect(seenRanges).toEqual(["bytes=6-", null]);
    expect(readFileSync(dest)).toEqual(body);
  });

  it("throws DownloadError('http') when the response has an empty body", async () => {
    const body = Buffer.from("non-empty");
    const dest = join(dir, "model.bin");
    const fetchImpl: typeof fetch = async () => new Response(null, { status: 200 });

    await expect(downloadVerified({ file: pin(body), dest, fetch: fetchImpl })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof DownloadError && err.code === "http" && /empty response/i.test(err.message),
    );
  });

  it("keeps .partial on incomplete streams and mid-stream transport errors so retry can resume", async () => {
    const body = Buffer.from("0123456789abcdef");
    const dest = join(dir, "model.bin");

    // Stream closes early -> incomplete, .partial kept.
    await expect(
      downloadVerified({
        file: pin(body),
        dest,
        fetch: async () => new Response(streamFrom([body.subarray(0, 5)]), { status: 200 }),
      }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof DownloadError && err.code === "incomplete",
    );
    expect(readFileSync(partialPath(dest))).toEqual(body.subarray(0, 5));

    // Resume fails mid-stream with a non-DownloadError -> .partial keeps newly written bytes.
    await expect(
      downloadVerified({
        file: pin(body),
        dest,
        fetch: async () =>
          new Response(streamFrom([body.subarray(5, 10)], new Error("connection reset")), {
            status: 206,
            headers: { "content-range": `bytes 5-${body.length - 1}/${body.length}` },
          }),
      }),
    ).rejects.toThrow("connection reset");
    expect(readFileSync(partialPath(dest))).toEqual(body.subarray(0, 10));

    // Final resume finishes and verifies the full file.
    const progress: Array<[number, number]> = [];
    await downloadVerified({
      file: pin(body),
      dest,
      onProgress: (r, t) => progress.push([r, t]),
      fetch: async (_url, init) => {
        expect(new Headers(init?.headers).get("range")).toBe("bytes=10-");
        return new Response(streamFrom([body.subarray(10)]), {
          status: 206,
          headers: { "content-range": `bytes 10-${body.length - 1}/${body.length}` },
        });
      },
    });
    expect(progress).toEqual([
      [10, body.length],
      [body.length, body.length],
    ]);
    expect(readFileSync(dest)).toEqual(body);
    expect(existsSync(partialPath(dest))).toBe(false);
  });

  it("verifies an already-complete .partial without making an HTTP request", async () => {
    const body = Buffer.from("already-downloaded");
    const dest = join(dir, "model.bin");
    writeFileSync(partialPath(dest), body);

    let called = false;
    await downloadVerified({
      file: pin(body),
      dest,
      fetch: async () => {
        called = true;
        throw new Error("should not fetch");
      },
    });
    expect(called).toBe(false);
    expect(readFileSync(dest)).toEqual(body);
    expect(existsSync(partialPath(dest))).toBe(false);
  });
});

describe("extractTgzEntry", () => {
  it("assembles USTAR prefix + name paths and ignores prefix for non-ustar headers", () => {
    const payload = Buffer.from("nested binary");
    const ustarTar = Buffer.concat([
      tarHeader({ name: "index.node", prefix: "package/build/Release", size: payload.length }),
      padTarData(payload),
      Buffer.alloc(1024),
    ]);
    expect(extractTgzEntry(gzipSync(ustarTar), "package/build/Release/index.node")).toEqual(
      payload,
    );

    // Non-ustar magic ignores the prefix field and uses only name.
    const oldPayload = Buffer.from("old format");
    const oldTar = Buffer.concat([
      tarHeader({
        name: "index.node",
        prefix: "ignored/prefix",
        magic: "      ",
        type: "\0",
        size: oldPayload.length,
      }),
      padTarData(oldPayload),
      Buffer.alloc(1024),
    ]);
    expect(extractTgzEntry(gzipSync(oldTar), "index.node")).toEqual(oldPayload);
  });

  it("throws when the matching entry is truncated before its declared size", () => {
    const partialPayload = Buffer.from("short");
    const truncatedTar = Buffer.concat([
      tarHeader({ name: "package/index.node", size: 2048 }),
      partialPayload,
    ]);
    expect(() => extractTgzEntry(gzipSync(truncatedTar), "package/index.node")).toThrow(
      "Archive is truncated",
    );
  });

  it("throws on corrupt or negative octal size headers", () => {
    for (const badSize of ["not-octal!!", "-0000000010"]) {
      const corruptTar = Buffer.concat([
        tarHeader({ name: "package/index.node", size: badSize }),
        Buffer.alloc(1024),
      ]);
      expect(() => extractTgzEntry(gzipSync(corruptTar), "package/index.node")).toThrow(
        "Corrupt archive header",
      );
    }
  });

  it("skips directories and symlinks sharing the entry name and extracts a later regular file", () => {
    const target = "package/index.node";
    const onlyNonRegular = Buffer.concat([
      tarHeader({ name: target, size: 0, type: "5" }), // directory
      tarHeader({ name: target, size: 0, type: "2" }), // symlink
      Buffer.alloc(1024),
    ]);
    expect(() => extractTgzEntry(gzipSync(onlyNonRegular), target)).toThrow(
      `${target} is not in the archive`,
    );

    const regularBytes = Buffer.from("real-addon-bytes");
    const mixed = Buffer.concat([
      tarHeader({ name: target, size: 0, type: "5" }),
      tarHeader({ name: target, size: 0, type: "2" }),
      tarHeader({ name: target, size: regularBytes.length, type: "0" }),
      padTarData(regularBytes),
      Buffer.alloc(1024),
    ]);
    expect(extractTgzEntry(gzipSync(mixed), target)).toEqual(regularBytes);
  });
});
