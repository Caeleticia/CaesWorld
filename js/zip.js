/**
 * zip.js —— 最小可用的 ZIP 读写（浏览器 / Node 均可）
 *
 * 只为模组包服务：
 *   · readZip(bytes)  读中央目录，支持 store(0) 与 deflate(8)，
 *                     不依赖 DecompressionStream（老 WebView 也能跑）；
 *   · makeZip(entries) 写 ZIP，只做 store(0)（不压缩），保证任何工具都能打开；
 *   · inflateRaw(bytes) 纯 JS 的 raw deflate 解压，供 readZip 使用。
 *
 * 不支持：ZIP64、加密、分卷。遇到时给出明确错误，不做静默降级。
 * 文件路径统一转成 "/" 分隔；文件名按 UTF-8 解码。
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32（ZIP 校验用） */
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  // 跨 realm（iframe / WebView 传进来的 File）时 instanceof 不可靠，看内部槽
  const tag = Object.prototype.toString.call(input);
  if (input instanceof ArrayBuffer || tag === "[object ArrayBuffer]") return new Uint8Array(input);
  throw new Error("需要 ArrayBuffer 或 Uint8Array");
}

const utf8Decoder = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8") : null;
const utf8Encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

function decodeName(bytes) {
  if (utf8Decoder) return utf8Decoder.decode(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

function encodeName(text) {
  if (utf8Encoder) return utf8Encoder.encode(text);
  const out = [];
  for (let i = 0; i < text.length; i += 1) out.push(text.charCodeAt(i) & 0xff);
  return Uint8Array.from(out);
}

/* ------------------------------------------------------------------ */
/* DEFLATE 解压（raw，无 zlib 头）                                      */
/* ------------------------------------------------------------------ */

const LEN_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

/** 由码长表建规范 Huffman 解码表（符号按「长度升序、同长按符号升序」排列） */
function buildHuffman(lengths) {
  let maxBits = 0;
  for (let i = 0; i < lengths.length; i += 1) if (lengths[i] > maxBits) maxBits = lengths[i];
  const count = new Array(maxBits + 1).fill(0);
  for (let i = 0; i < lengths.length; i += 1) if (lengths[i]) count[lengths[i]] += 1;

  // 校验码表完备（允许空表：maxBits = 0）
  let left = 1;
  for (let len = 1; len <= maxBits; len += 1) {
    left = (left << 1) - count[len];
    if (left < 0) throw new Error("DEFLATE 码表不完整");
  }

  const offsets = new Array(maxBits + 1).fill(0);
  let total = 0;
  for (let len = 1; len <= maxBits; len += 1) {
    offsets[len] = total;
    total += count[len];
  }
  const symbols = new Uint16Array(total);
  const cursor = offsets.slice();
  for (let sym = 0; sym < lengths.length; sym += 1) {
    const len = lengths[sym];
    if (len) {
      symbols[cursor[len]] = sym;
      cursor[len] += 1;
    }
  }
  return { maxBits, count, symbols };
}

function decodeSymbol(state, table) {
  let code = 0;
  let first = 0;
  let index = 0;
  for (let len = 1; len <= table.maxBits; len += 1) {
    code |= state.bits(1);
    const count = table.count[len] || 0;
    if (code - count < first) return table.symbols[index + (code - first)];
    index += count;
    first = (first + count) << 1;
    code <<= 1;
  }
  throw new Error("DEFLATE 解码失败（无效的 Huffman 编码）");
}

let FIXED_LIT = null;
let FIXED_DIST = null;

function fixedTables() {
  if (FIXED_LIT) return { lit: FIXED_LIT, dist: FIXED_DIST };
  const litLengths = new Array(288).fill(0);
  for (let i = 0; i <= 143; i += 1) litLengths[i] = 8;
  for (let i = 144; i <= 255; i += 1) litLengths[i] = 9;
  for (let i = 256; i <= 279; i += 1) litLengths[i] = 7;
  for (let i = 280; i <= 287; i += 1) litLengths[i] = 8;
  FIXED_LIT = buildHuffman(litLengths);
  FIXED_DIST = buildHuffman(new Array(32).fill(5));
  return { lit: FIXED_LIT, dist: FIXED_DIST };
}

/**
 * 解压 raw DEFLATE 数据（无 zlib / gzip 头）。
 * @param {Uint8Array|ArrayBuffer} input
 * @returns {Uint8Array}
 */
export function inflateRaw(input) {
  const src = toBytes(input);
  let pos = 0;
  let bitBuf = 0;
  let bitCnt = 0;

  const readBits = (n) => {
    while (bitCnt < n) {
      if (pos >= src.length) throw new Error("DEFLATE 数据不完整");
      bitBuf |= src[pos] << bitCnt;
      pos += 1;
      bitCnt += 8;
    }
    const value = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCnt -= n;
    return value;
  };

  let out = new Uint8Array(Math.max(1024, src.length * 4));
  let outLen = 0;
  const ensure = (extra) => {
    if (outLen + extra <= out.length) return;
    let size = out.length * 2;
    while (size < outLen + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(out.subarray(0, outLen));
    out = next;
  };
  const push = (byte) => {
    ensure(1);
    out[outLen] = byte;
    outLen += 1;
  };

  const state = { bits: readBits };
  let final = 0;
  while (!final) {
    final = readBits(1);
    const type = readBits(2);
    if (type === 0) {
      // 存储块：丢弃剩余位，对齐到字节
      bitBuf = 0;
      bitCnt = 0;
      if (pos + 4 > src.length) throw new Error("DEFLATE 存储块不完整");
      const len = src[pos] | (src[pos + 1] << 8);
      const nlen = src[pos + 2] | (src[pos + 3] << 8);
      pos += 4;
      if ((len ^ 0xffff) !== nlen) throw new Error("DEFLATE 存储块长度校验失败");
      if (pos + len > src.length) throw new Error("DEFLATE 存储块数据不完整");
      ensure(len);
      out.set(src.subarray(pos, pos + len), outLen);
      outLen += len;
      pos += len;
      continue;
    }

    let litTable;
    let distTable;
    if (type === 1) {
      ({ lit: litTable, dist: distTable } = fixedTables());
    } else if (type === 2) {
      const hlit = readBits(5) + 257;
      const hdist = readBits(5) + 1;
      const hclen = readBits(4) + 4;
      const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
      const clens = new Array(19).fill(0);
      for (let i = 0; i < hclen; i += 1) clens[order[i]] = readBits(3);
      const clTable = buildHuffman(clens);

      const lens = [];
      const need = hlit + hdist;
      while (lens.length < need) {
        const sym = decodeSymbol(state, clTable);
        if (sym < 16) {
          lens.push(sym);
        } else if (sym === 16) {
          if (!lens.length) throw new Error("DEFLATE 码长重复缺少前值");
          const prev = lens[lens.length - 1];
          const repeat = 3 + readBits(2);
          for (let i = 0; i < repeat; i += 1) lens.push(prev);
        } else if (sym === 17) {
          const repeat = 3 + readBits(3);
          for (let i = 0; i < repeat; i += 1) lens.push(0);
        } else if (sym === 18) {
          const repeat = 11 + readBits(7);
          for (let i = 0; i < repeat; i += 1) lens.push(0);
        } else {
          throw new Error("DEFLATE 码长符号非法");
        }
        if (lens.length > need) throw new Error("DEFLATE 码长数量溢出");
      }
      litTable = buildHuffman(lens.slice(0, hlit));
      distTable = buildHuffman(lens.slice(hlit, need));
    } else {
      throw new Error("DEFLATE 块类型非法");
    }

    for (;;) {
      const sym = decodeSymbol(state, litTable);
      if (sym < 256) {
        push(sym);
        continue;
      }
      if (sym === 256) break;
      const li = sym - 257;
      if (li < 0 || li >= LEN_BASE.length) throw new Error("DEFLATE 长度符号非法");
      const length = LEN_BASE[li] + readBits(LEN_EXTRA[li]);
      const dsym = decodeSymbol(state, distTable);
      if (dsym >= DIST_BASE.length) throw new Error("DEFLATE 距离符号非法");
      const distance = DIST_BASE[dsym] + readBits(DIST_EXTRA[dsym]);
      if (distance > outLen) throw new Error("DEFLATE 距离超出已解压数据");
      const start = outLen - distance;
      ensure(length);
      for (let i = 0; i < length; i += 1) {
        out[outLen] = out[start + i];
        outLen += 1;
      }
    }
  }

  return out.slice(0, outLen);
}

/* ------------------------------------------------------------------ */
/* ZIP 读                                                              */
/* ------------------------------------------------------------------ */

/** 是否是 ZIP（本地文件头 / 空包尾部） */
export function isZip(input) {
  const bytes = toBytes(input);
  if (bytes.length < 4) return false;
  return (
    (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) ||
    (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x05 && bytes[3] === 0x06)
  );
}

/**
 * 读 ZIP。
 * @param {Uint8Array|ArrayBuffer} input
 * @returns {Map<string, Uint8Array>} 路径（"a/b.png"）→ 文件字节
 */
export function readZip(input) {
  const bytes = toBytes(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // 从尾部找 EOCD（0x06054b50），注释最长 65535
  let eocd = -1;
  const stop = Math.max(0, bytes.length - 22 - 65535);
  for (let i = bytes.length - 22; i >= stop; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是有效的 ZIP 文件（找不到中央目录结尾）");

  const total = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error("暂不支持 ZIP64 格式的模组包");
  }
  if (cdOffset + cdSize > bytes.length) throw new Error("ZIP 中央目录越界");

  const entries = new Map();
  let p = cdOffset;
  for (let n = 0; n < total; n += 1) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) {
      throw new Error("ZIP 中央目录项损坏");
    }
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const uncompSize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = decodeName(bytes.subarray(p + 46, p + 46 + nameLen)).replace(/\\/g, "/");
    p += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x0001) throw new Error(`ZIP 内的「${name}」已加密，无法读取`);
    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new Error(`ZIP 内「${name}」的本地文件头损坏`);
    }
    const lNameLen = view.getUint16(localOffset + 26, true);
    const lExtraLen = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    if (start + compSize > bytes.length) throw new Error(`ZIP 内「${name}」数据越界`);

    let data;
    if (method === 0) {
      data = bytes.slice(start, start + compSize);
    } else if (method === 8) {
      data = inflateRaw(bytes.subarray(start, start + compSize));
    } else {
      throw new Error(`ZIP 内「${name}」使用了不支持的压缩方式 ${method}`);
    }
    if (data.length !== uncompSize) {
      throw new Error(`ZIP 内「${name}」解压后大小不符（${data.length} ≠ ${uncompSize}）`);
    }
    entries.set(name, data);
  }
  return entries;
}

/* ------------------------------------------------------------------ */
/* ZIP 写（store，不压缩）                                              */
/* ------------------------------------------------------------------ */

/**
 * 生成 ZIP。
 * @param {Array<{name: string, data: string|Uint8Array|ArrayBuffer}>} entries
 * @returns {Uint8Array}
 */
export function makeZip(entries) {
  const files = [];
  let localSize = 0;
  const encoder = utf8Encoder || new TextEncoder();

  for (const entry of entries) {
    if (!entry || !entry.name) continue;
    const name = String(entry.name).replace(/\\/g, "/");
    const nameBytes = encodeName(name);
    if (nameBytes.length > 0xffff) throw new Error(`文件名太长：${name}`);
    const raw = typeof entry.data === "string" ? encoder.encode(entry.data) : toBytes(entry.data);
    const crc = crc32(raw);
    files.push({ name, nameBytes, data: raw, crc, offset: localSize, utf8: /[^\x00-\x7f]/.test(name) });
    localSize += 30 + nameBytes.length + raw.length;
  }

  // 本地文件头 + 数据
  const local = new Uint8Array(localSize);
  const lv = new DataView(local.buffer);
  let lp = 0;
  for (const f of files) {
    const flags = f.utf8 ? 0x0800 : 0;
    lv.setUint32(lp, 0x04034b50, true);
    lv.setUint16(lp + 4, 20, true);
    lv.setUint16(lp + 6, flags, true);
    lv.setUint16(lp + 8, 0, true); // store
    lv.setUint16(lp + 10, 0, true); // time
    lv.setUint16(lp + 12, 0x21, true); // 1980-01-01
    lv.setUint32(lp + 14, f.crc, true);
    lv.setUint32(lp + 18, f.data.length, true);
    lv.setUint32(lp + 22, f.data.length, true);
    lv.setUint16(lp + 26, f.nameBytes.length, true);
    lv.setUint16(lp + 28, 0, true);
    local.set(f.nameBytes, lp + 30);
    local.set(f.data, lp + 30 + f.nameBytes.length);
    lp += 30 + f.nameBytes.length + f.data.length;
  }

  // 中央目录
  let cdSize = 0;
  for (const f of files) cdSize += 46 + f.nameBytes.length;
  const central = new Uint8Array(cdSize);
  const cv = new DataView(central.buffer);
  let cp = 0;
  for (const f of files) {
    const flags = f.utf8 ? 0x0800 : 0;
    cv.setUint32(cp, 0x02014b50, true);
    cv.setUint16(cp + 4, 20, true); // version made by
    cv.setUint16(cp + 6, 20, true); // version needed
    cv.setUint16(cp + 8, flags, true);
    cv.setUint16(cp + 10, 0, true);
    cv.setUint16(cp + 12, 0, true);
    cv.setUint16(cp + 14, 0x21, true);
    cv.setUint32(cp + 16, f.crc, true);
    cv.setUint32(cp + 20, f.data.length, true);
    cv.setUint32(cp + 24, f.data.length, true);
    cv.setUint16(cp + 28, f.nameBytes.length, true);
    cv.setUint16(cp + 30, 0, true); // extra
    cv.setUint16(cp + 32, 0, true); // comment
    cv.setUint16(cp + 34, 0, true); // disk
    cv.setUint16(cp + 36, 0, true); // internal attrs
    cv.setUint32(cp + 38, 0, true); // external attrs
    cv.setUint32(cp + 42, f.offset, true);
    central.set(f.nameBytes, cp + 46);
    cp += 46 + f.nameBytes.length;
  }

  // EOCD
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, local.length, true);
  ev.setUint16(20, 0, true);

  const out = new Uint8Array(local.length + central.length + end.length);
  out.set(local, 0);
  out.set(central, local.length);
  out.set(end, local.length + central.length);
  return out;
}
