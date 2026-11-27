import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { extractTarGz } from "../src/util/tar";

interface RawEntry {
  name: string;
  prefix?: string;
  type?: string;
  data?: Buffer | string;
  magic?: string;
  corruptChecksum?: boolean;
  sizeField?: string;
  truncatePayloadBy?: number;
}

/** Build a tar header + padded data block, allowing raw ustar/GNU/PAX/corrupt fixtures. */
function buildRawEntry(entry: RawEntry): Buffer {
  const data = Buffer.from(entry.data ?? "");
  const header = Buffer.alloc(512);
  header.write(entry.name, 0, 100, "utf8");
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(entry.sizeField ?? `${data.length.toString(8).padStart(11, "0")}\0`, 124, 12);
  header.write(`${(0).toString(8).padStart(11, "0")}\0`, 136);
  header.write("        ", 148);
  header.write(entry.type ?? "0", 156, 1, "latin1");
  const magic = entry.magic ?? "ustar\0";
  header.write(magic, 257, 6, "latin1");
  header.write("00", 263, 2, "latin1");
  if (entry.prefix) header.write(entry.prefix, 345, 155, "utf8");

  let sum = 0;
  for (const byte of header) sum += byte;
  if (entry.corruptChecksum) sum += 1;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);

  const payload =
    entry.truncatePayloadBy && entry.truncatePayloadBy > 0
      ? data.subarray(0, Math.max(0, data.length - entry.truncatePayloadBy))
      : Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
  return Buffer.concat([header, payload]);
}

function packTarGz(entries: RawEntry[], opts: { endBlocks?: boolean } = {}): Buffer {
  const parts = entries.map(buildRawEntry);
  if (opts.endBlocks !== false) parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

function paxLine(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (len !== Buffer.byteLength(`${len}${body}`)) {
    len = Buffer.byteLength(`${len}${body}`);
  }
  return Buffer.from(`${len}${body}`, "utf8");
}

const dirs: string[] = [];
const tempDest = () => {
  const dir = mkdtempSync(join(tmpdir(), "codeden-tar-test-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("extractTarGz", () => {
  it("extracts regular, NUL-type, contiguous and zero-byte files, and directories", () => {
    const dest = tempDest();
    const archive = packTarGz([
      { name: "package/empty-dir/", type: "5" },
      { name: "package/a.txt", type: "0", data: "alpha" },
      { name: "package/old.txt", type: "\0", data: "legacy" },
      { name: "package/contig.txt", type: "7", data: "contiguous" },
      { name: "package/zero.txt", type: "0", data: "" },
    ]);

    const written = extractTarGz(archive, dest, { strip: 1 });
    expect(written).toEqual(["a.txt", "old.txt", "contig.txt", "zero.txt"]);
    expect(existsSync(join(dest, "empty-dir"))).toBe(true);
    expect(readFileSync(join(dest, "a.txt"), "utf8")).toBe("alpha");
    expect(readFileSync(join(dest, "old.txt"), "utf8")).toBe("legacy");
    expect(readFileSync(join(dest, "contig.txt"), "utf8")).toBe("contiguous");
    expect(readFileSync(join(dest, "zero.txt"), "utf8")).toBe("");
  });

  it("handles strip depths, dot segments, and entries shallower than strip", () => {
    const dest = tempDest();
    const archive = packTarGz([
      { name: "package/top.txt", data: "dropped when strip=2" },
      { name: "package/sub/./nested/./file.js", data: "kept" },
    ]);

    const written = extractTarGz(archive, dest, { strip: 2 });
    expect(written).toEqual(["nested/file.js"]);
    expect(existsSync(join(dest, "top.txt"))).toBe(false);
    expect(readFileSync(join(dest, "nested", "file.js"), "utf8")).toBe("kept");
  });

  it("assembles ustar prefix paths and ignores prefix on non-ustar headers", () => {
    const dest = tempDest();
    const archive = packTarGz([
      { name: "file.txt", prefix: "package/deep/sub", data: "ustar-prefix" },
      {
        name: "package/plain.txt",
        prefix: "ignored/prefix",
        magic: "old\0\0\0",
        data: "no-prefix",
      },
    ]);

    const written = extractTarGz(archive, dest, { strip: 1 });
    expect(written).toEqual(["deep/sub/file.txt", "plain.txt"]);
    expect(readFileSync(join(dest, "deep", "sub", "file.txt"), "utf8")).toBe("ustar-prefix");
    expect(readFileSync(join(dest, "plain.txt"), "utf8")).toBe("no-prefix");
  });

  it("reads GNU LongName (L) headers and resets them for subsequent entries", () => {
    const dest = tempDest();
    const longPath = `package/${"segment/".repeat(16)}target.js`;
    const archive = packTarGz([
      { name: "././@LongLink", type: "L", data: `${longPath}\0` },
      { name: "truncated", type: "0", data: "long-body" },
      { name: "package/next.js", type: "0", data: "next-body" },
    ]);

    const written = extractTarGz(archive, dest, { strip: 1 });
    const expectedLong = `${"segment/".repeat(16)}target.js`;
    expect(written).toEqual([expectedLong, "next.js"]);
    expect(readFileSync(join(dest, ...expectedLong.split("/")), "utf8")).toBe("long-body");
    expect(readFileSync(join(dest, "next.js"), "utf8")).toBe("next-body");
  });

  it("reads PAX extended headers with multi-byte UTF-8 paths and skips PAX global headers", () => {
    const dest = tempDest();
    const utf8Path = "package/café/日本語/résumé-✓.txt";
    const paxData = Buffer.concat([
      paxLine("mtime", "1700000000.123"),
      paxLine("path", utf8Path),
      paxLine("comment", "ignored"),
    ]);
    const archive = packTarGz([
      { name: "pax_global_header", type: "g", data: paxLine("comment", "global") },
      { name: "PaxHeader", type: "x", data: paxData },
      { name: "placeholder", type: "0", data: "utf8-content" },
      { name: "package/after.txt", type: "0", data: "after-pax" },
    ]);

    const written = extractTarGz(archive, dest, { strip: 1 });
    expect(written).toEqual(["café/日本語/résumé-✓.txt", "after.txt"]);
    expect(readFileSync(join(dest, "café", "日本語", "résumé-✓.txt"), "utf8")).toBe("utf8-content");
    expect(readFileSync(join(dest, "after.txt"), "utf8")).toBe("after-pax");
  });

  it("skips hardlinks, symlinks, device nodes and FIFOs", () => {
    const dest = tempDest();
    const archive = packTarGz([
      { name: "package/hardlink", type: "1" },
      { name: "package/symlink", type: "2" },
      { name: "package/chardev", type: "3" },
      { name: "package/blockdev", type: "4" },
      { name: "package/fifo", type: "6" },
      { name: "package/real.txt", type: "0", data: "safe" },
    ]);

    const written = extractTarGz(archive, dest, { strip: 1 });
    expect(written).toEqual(["real.txt"]);
    for (const skipped of ["hardlink", "symlink", "chardev", "blockdev", "fifo"]) {
      expect(existsSync(join(dest, skipped)), skipped).toBe(false);
    }
  });

  it("rejects traversal, absolute, drive-letter, backslash, PAX and GNU LongName escape paths", () => {
    const badNames = [
      "../escape.txt",
      "package/../../escape.txt",
      "package\\..\\..\\escape.txt",
      "/etc/passwd",
      "C:/Windows/win.ini",
      "D:\\evil.txt",
    ];
    for (const name of badNames) {
      const archive = packTarGz([{ name, data: "x" }]);
      expect(() => extractTarGz(archive, tempDest(), { strip: 1 }), name).toThrow(/Unsafe path/);
    }

    // Traversal smuggled via a PAX extended header or GNU LongName header.
    const paxEscape = packTarGz([
      { name: "PaxHeader", type: "x", data: paxLine("path", "package/../../evil.txt") },
      { name: "package/innocent.txt", type: "0", data: "x" },
    ]);
    expect(() => extractTarGz(paxEscape, tempDest(), { strip: 1 })).toThrow(/Unsafe path/);

    const gnuEscape = packTarGz([
      { name: "././@LongLink", type: "L", data: "/etc/shadow\0" },
      { name: "package/innocent.txt", type: "0", data: "x" },
    ]);
    expect(() => extractTarGz(gnuEscape, tempDest(), { strip: 1 })).toThrow(/Unsafe path/);
  });

  it("fails on bad header checksum, truncated entry, invalid octal size and bad gzip", () => {
    const badChecksum = packTarGz([{ name: "package/a.txt", data: "hi", corruptChecksum: true }]);
    expect(() => extractTarGz(badChecksum, tempDest())).toThrow(/bad header checksum/);

    const truncated = packTarGz(
      [{ name: "package/a.txt", data: "0123456789", truncatePayloadBy: 4 }],
      { endBlocks: false },
    );
    expect(() => extractTarGz(truncated, tempDest())).toThrow(/truncated entry/);

    const badSize = packTarGz([{ name: "package/a.txt", sizeField: "not-octal!!\0" }]);
    expect(() => extractTarGz(badSize, tempDest())).toThrow(/bad size/);

    expect(() => extractTarGz(Buffer.from("not gzip bytes"), tempDest())).toThrow();
  });
});
