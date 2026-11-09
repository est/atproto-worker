// src/shared.js
var B32_SORTISH = "234567abcdefghijklmnopqrstuvwxyz";
var lastTimestamp = 0;
var clockSeq = 0;
function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++)
    bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function bytesToBase64(bytes) {
  let bin = "";
  for (const b of bytes)
    bin += String.fromCharCode(b);
  return btoa(bin);
}
function generateTID() {
  let timestamp = Date.now() * 1e3;
  if (timestamp === lastTimestamp) {
    clockSeq++;
  } else {
    lastTimestamp = timestamp;
    clockSeq = 0;
  }
  const combined = BigInt(timestamp) << 10n | BigInt(clockSeq & 1023);
  let tid = "";
  let n = combined;
  for (let i = 0; i < 13; i++) {
    tid = B32_SORTISH[Number(n & 31n)] + tid;
    n >>= 5n;
  }
  return tid;
}
function nextTID(prev) {
  const nowMicros = Date.now() * 1e3;
  let timestamp = nowMicros;
  let clockid = 0;
  if (prev) {
    if (typeof prev !== "string" || prev.length !== 13) {
      throw new Error(`Invalid TID: ${prev}`);
    }
    let n2 = 0n;
    for (const ch of prev) {
      const idx = B32_SORTISH.indexOf(ch);
      if (idx === -1)
        throw new Error(`Invalid TID character: ${ch}`);
      n2 = n2 << 5n | BigInt(idx);
    }
    const prevTs = n2 >> 10n;
    clockid = Number(n2 & 0x3ffn);
    if (BigInt(nowMicros) <= prevTs) {
      timestamp = Number(prevTs + 1n);
    }
  }
  const combined = BigInt(timestamp) << 10n | BigInt(clockid & 1023);
  let tid = "";
  let n = combined;
  for (let i = 0; i < 13; i++) {
    tid = B32_SORTISH[Number(n & 31n)] + tid;
    n >>= 5n;
  }
  return tid;
}
async function sha256(input) {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const hash = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(hash);
}
var B32_LOWER = "abcdefghijklmnopqrstuvwxyz234567";
function base32Encode(bytes) {
  let result = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = value << 8 | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += B32_LOWER[value >> bits & 31];
    }
  }
  if (bits > 0) {
    result += B32_LOWER[value << 5 - bits & 31];
  }
  return result;
}
function base32Decode(str) {
  const result = [];
  let bits = 0;
  let value = 0;
  for (const char of str.toLowerCase()) {
    const idx = B32_LOWER.indexOf(char);
    if (idx === -1)
      continue;
    value = value << 5 | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      result.push(value >> bits & 255);
    }
  }
  return new Uint8Array(result);
}
function cidToBytes(cidStr) {
  if (cidStr.startsWith("b")) {
    return base32Decode(cidStr.slice(1));
  }
  throw new Error("Unsupported CID format: " + cidStr);
}
function bytesToCid(cidBytes) {
  return "b" + base32Encode(cidBytes);
}
async function computeCID(value) {
  return computeCidFromBytes(cborEncode(value));
}
async function computeCidFromBytesCodec(bytes, codec) {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const cid = new Uint8Array(2 + 2 + 32);
  cid[0] = 1;
  cid[1] = codec;
  cid[2] = 18;
  cid[3] = 32;
  cid.set(new Uint8Array(hash), 4);
  return "b" + base32Encode(cid);
}
async function computeCidFromBytes(cbor) {
  return computeCidFromBytesCodec(cbor, 113);
}
function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0) {
    throw new Error("Invalid hex string: " + String(hex).slice(0, 20));
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
function commitToCbor(commit) {
  const { did, version, rev, data, prev, sig } = commit;
  const obj = { did, rev, data: { $link: data }, prev: prev ? { $link: prev } : null };
  if (sig)
    obj.sig = typeof sig === "string" ? hexToBytes(sig) : sig;
  obj.version = version;
  return cborEncode(obj);
}
async function commitCid(commit) {
  return computeCidFromBytes(commitToCbor(commit));
}
function cborEncode(value) {
  const chunks = [];
  function encode(val) {
    if (val === null || val === void 0) {
      chunks.push(new Uint8Array([246]));
    } else if (typeof val === "boolean") {
      chunks.push(new Uint8Array([val ? 245 : 244]));
    } else if (typeof val === "number") {
      if (Number.isInteger(val)) {
        if (val >= 0) {
          encodeUint(0, val);
        } else {
          encodeUint(1, -1 - val);
        }
      } else {
        const buf = new ArrayBuffer(9);
        const view = new DataView(buf);
        view.setUint8(0, 251);
        view.setFloat64(1, val, false);
        chunks.push(new Uint8Array(buf));
      }
    } else if (typeof val === "string") {
      const bytes = new TextEncoder().encode(val);
      encodeUint(3, bytes.length);
      chunks.push(bytes);
    } else if (val instanceof Uint8Array) {
      encodeUint(2, val.length);
      chunks.push(val);
    } else if (Array.isArray(val)) {
      encodeUint(4, val.length);
      for (const item of val)
        encode(item);
    } else if (typeof val === "object") {
      if (val.$link) {
        chunks.push(new Uint8Array([216, 42]));
        const cidBytes = cidToBytes(val.$link);
        encodeUint(2, cidBytes.length + 1);
        chunks.push(new Uint8Array([0]));
        chunks.push(cidBytes);
      } else {
        const keys = Object.keys(val).sort((a, b) => {
          if (a.length !== b.length)
            return a.length - b.length;
          return a < b ? -1 : 1;
        });
        encodeUint(5, keys.length);
        for (const key of keys) {
          encode(key);
          encode(val[key]);
        }
      }
    }
  }
  function encodeUint(major, n) {
    if (n < 24) {
      chunks.push(new Uint8Array([major << 5 | n]));
    } else if (n < 256) {
      chunks.push(new Uint8Array([major << 5 | 24, n]));
    } else if (n < 65536) {
      const buf = new Uint8Array(3);
      buf[0] = major << 5 | 25;
      buf[1] = n >> 8;
      buf[2] = n & 255;
      chunks.push(buf);
    } else if (n < 4294967296) {
      const buf = new Uint8Array(5);
      buf[0] = major << 5 | 26;
      new DataView(buf.buffer).setUint32(1, n, false);
      chunks.push(buf);
    } else {
      const buf = new Uint8Array(9);
      buf[0] = major << 5 | 27;
      new DataView(buf.buffer).setBigUint64(1, BigInt(n), false);
      chunks.push(buf);
    }
  }
  encode(value);
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
function cborDecode(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    bytes = new Uint8Array(bytes);
  }
  let pos = 0;
  function decode() {
    if (pos >= bytes.length)
      throw new Error("Unexpected end of CBOR data");
    const initial = bytes[pos++];
    const major = initial >> 5;
    const additional = initial & 31;
    let value = readUint(additional);
    switch (major) {
      case 0:
        return value;
      case 1:
        return -1 - value;
      case 2: {
        const result = bytes.slice(pos, pos + value);
        pos += value;
        return result;
      }
      case 3: {
        const result = new TextDecoder().decode(bytes.slice(pos, pos + value));
        pos += value;
        return result;
      }
      case 4: {
        const arr = [];
        for (let i = 0; i < value; i++)
          arr.push(decode());
        return arr;
      }
      case 5: {
        const obj = {};
        for (let i = 0; i < value; i++) {
          const key = decode();
          obj[key] = decode();
        }
        return obj;
      }
      case 6:
        if (value === 42) {
          const linkBytes = decode();
          if (!(linkBytes instanceof Uint8Array)) {
            throw new Error("CBOR tag 42 must be followed by a byte string");
          }
          const prefix = linkBytes[0] === 0 ? 1 : 0;
          const cidBytes = linkBytes.slice(prefix);
          return { $link: "b" + base32Encode(cidBytes) };
        }
        throw new Error(`Unsupported CBOR tag: ${value}`);
      case 7:
        if (additional === 20)
          return false;
        if (additional === 21)
          return true;
        if (additional === 22)
          return null;
        if (additional === 23)
          return void 0;
        if (additional === 25) {
          pos += 2;
          return 0;
        }
        if (additional === 26) {
          const view = new DataView(bytes.buffer, bytes.byteOffset + pos, 4);
          pos += 4;
          return view.getFloat32(0, false);
        }
        if (additional === 27) {
          const view = new DataView(bytes.buffer, bytes.byteOffset + pos, 8);
          pos += 8;
          return view.getFloat64(0, false);
        }
        throw new Error(`Unknown simple value: ${additional}`);
      default:
        throw new Error(`Unknown CBOR major type: ${major}`);
    }
  }
  function readUint(additional) {
    if (additional < 24)
      return additional;
    if (additional === 24)
      return bytes[pos++];
    if (additional === 25) {
      const val = bytes[pos] << 8 | bytes[pos + 1];
      pos += 2;
      return val;
    }
    if (additional === 26) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + pos, 4);
      pos += 4;
      return view.getUint32(0, false);
    }
    if (additional === 27) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + pos, 8);
      pos += 8;
      return Number(view.getBigUint64(0, false));
    }
    throw new Error(`Invalid additional value: ${additional}`);
  }
  return decode();
}
function encodeVarint(n) {
  const bytes = [];
  while (n > 127) {
    bytes.push(n & 127 | 128);
    n >>>= 7;
  }
  bytes.push(n & 127);
  return new Uint8Array(bytes);
}
function decodeVarint(bytes, offset = 0) {
  let value = 0;
  let shift = 0;
  while (true) {
    if (offset >= bytes.length)
      throw new Error("Unexpected end of varint");
    const b = bytes[offset++];
    value += (b & 127) * 2 ** shift;
    if ((b & 128) === 0)
      break;
    shift += 7;
    if (shift > 49)
      throw new Error("Varint too long");
  }
  return { value, offset };
}
function readCidBytes(bytes, offset = 0) {
  const start = offset;
  const version = decodeVarint(bytes, offset);
  offset = version.offset;
  const codec = decodeVarint(bytes, offset);
  offset = codec.offset;
  const hashCode = decodeVarint(bytes, offset);
  offset = hashCode.offset;
  const hashLen = decodeVarint(bytes, offset);
  offset = hashLen.offset;
  const digest = bytes.slice(offset, offset + hashLen.value);
  offset += hashLen.value;
  const cidBytes = bytes.slice(start, offset);
  return {
    version: version.value,
    codec: codec.value,
    hashCode: hashCode.value,
    digest,
    cid: bytesToCid(cidBytes),
    offset
  };
}
function createCarFile(rootCid, blocks = []) {
  const parts = [];
  const header = cborEncode({
    version: 1,
    roots: [{ $link: rootCid }]
  });
  parts.push(encodeVarint(header.length));
  parts.push(header);
  for (const block of blocks) {
    const cidBytes = cidToBytes(block.cid);
    const blockData = block.data instanceof Uint8Array ? block.data : cborEncode(block.data);
    parts.push(encodeVarint(cidBytes.length + blockData.length));
    parts.push(cidBytes);
    parts.push(blockData);
  }
  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
function readCarFile(carBytes) {
  const bytes = carBytes instanceof Uint8Array ? carBytes : new Uint8Array(carBytes);
  let offset = 0;
  const headerLen = decodeVarint(bytes, offset);
  offset = headerLen.offset;
  const header = cborDecode(bytes.slice(offset, offset + headerLen.value));
  offset += headerLen.value;
  const roots = (header.roots || []).map((r) => typeof r === "string" ? r : r.$link);
  const blocks = /* @__PURE__ */ new Map();
  while (offset < bytes.length) {
    const blockLen = decodeVarint(bytes, offset);
    offset = blockLen.offset;
    const end = offset + blockLen.value;
    if (end > bytes.length)
      throw new Error("CAR block extends past end of file");
    const blockBytes = bytes.slice(offset, end);
    const parsed = readCidBytes(blockBytes, 0);
    blocks.set(parsed.cid, blockBytes.slice(parsed.offset));
    offset = end;
  }
  return { roots, blocks, header };
}

// src/commit.js
function buildUnsignedCommit(did, dataCid, rev, prevCid) {
  return {
    did,
    version: 3,
    data: dataCid,
    rev,
    prev: prevCid || null
  };
}
async function recordCid(record) {
  return computeCID(record);
}
async function commitCid2(commit) {
  return commitCid(commit);
}
async function signCommit(unsigned, signFn) {
  const encoded = commitToCbor(unsigned);
  const sig = await signFn(encoded);
  return { ...unsigned, sig };
}

// cli/mst.js
function isValidMstKey(str) {
  const split = str.split("/");
  return str.length <= 1024 && split.length === 2 && split[0].length > 0 && split[1].length > 0 && /^[a-zA-Z0-9_~\-:.]*$/.test(split[0]) && /^[a-zA-Z0-9_~\-:.]*$/.test(split[1]);
}
async function leadingZerosOnHash(key) {
  const hash = await sha256(key);
  let leadingZeros = 0;
  for (let i = 0; i < hash.length; i++) {
    const byte = hash[i];
    if (byte < 64)
      leadingZeros++;
    if (byte < 16)
      leadingZeros++;
    if (byte < 4)
      leadingZeros++;
    if (byte === 0) {
      leadingZeros++;
    } else {
      break;
    }
  }
  return leadingZeros;
}
function countPrefixLen(a, b) {
  let i;
  for (i = 0; i < a.length; i++) {
    if (a[i] !== b[i])
      break;
  }
  return i;
}
var Leaf = class {
  constructor(key, value) {
    this.key = key;
    this.value = value;
  }
  isLeaf() {
    return true;
  }
  isTree() {
    return false;
  }
};
var MST = class {
  /**
   * @param {Map<string, Uint8Array>} blockstore - cid -> raw CBOR bytes
   * @param {string|null} pointer - node CID
   * @param {Array<Leaf|MST>|null} entries - cached entries
   * @param {number|null} layer
   */
  constructor(blockstore, pointer, entries, layer) {
    this.blockstore = blockstore;
    this.pointer = pointer;
    this.entries = entries;
    this.layer = layer;
    this.outdatedPointer = false;
  }
  isLeaf() {
    return false;
  }
  isTree() {
    return true;
  }
  static async create(blockstore, entries = [], layer = null) {
    const mst = new MST(blockstore, null, entries, layer);
    mst.outdatedPointer = true;
    await mst.getPointer();
    return mst;
  }
  static async fromData(blockstore, data) {
    const entries = await deserializeNodeData(blockstore, data);
    const cid = await computeCID(data);
    return new MST(blockstore, cid, entries, null);
  }
  static load(blockstore, cid) {
    return new MST(blockstore, cid, null, null);
  }
  // Immutability: never mutate, return new MST
  newTree(entries) {
    const mst = new MST(this.blockstore, this.pointer, entries, this.layer);
    mst.outdatedPointer = true;
    return mst;
  }
  async getEntries() {
    if (this.entries)
      return [...this.entries];
    if (this.pointer) {
      const data = await readObj(this.blockstore, this.pointer);
      const firstLeaf = data.e[0];
      const layer = firstLeaf !== void 0 ? await leadingZerosOnHash(firstLeaf.k) : void 0;
      this.entries = await deserializeNodeData(this.blockstore, data, layer);
      return this.entries;
    }
    throw new Error("No entries or CID provided");
  }
  async getPointer() {
    if (!this.outdatedPointer)
      return this.pointer;
    const { cid } = await this.serialize();
    this.pointer = cid;
    this.outdatedPointer = false;
    return this.pointer;
  }
  async serialize() {
    let entries = await this.getEntries();
    const outdated = entries.filter((e) => e.isTree() && e.outdatedPointer);
    if (outdated.length > 0) {
      await Promise.all(outdated.map((e) => e.getPointer()));
      entries = await this.getEntries();
    }
    const data = serializeNodeData(entries);
    const cid = await computeCID(data);
    const bytes = cborEncode(data);
    return { cid, bytes };
  }
  async getLayer() {
    this.layer = await this.attemptGetLayer();
    if (this.layer === null)
      this.layer = 0;
    return this.layer;
  }
  async attemptGetLayer() {
    if (this.layer !== null)
      return this.layer;
    const entries = await this.getEntries();
    const firstLeaf = entries.find((entry) => entry.isLeaf());
    let layer = firstLeaf ? await leadingZerosOnHash(firstLeaf.key) : null;
    if (layer === null) {
      for (const entry of entries) {
        if (entry.isTree()) {
          const childLayer = await entry.attemptGetLayer();
          if (childLayer !== null) {
            layer = childLayer + 1;
            break;
          }
        }
      }
    }
    return layer;
  }
  // ---------- Core ops ----------
  async add(key, value, knownZeros) {
    const keyZeros = knownZeros ?? await leadingZerosOnHash(key);
    const layer = await this.getLayer();
    const newLeaf = new Leaf(key, value);
    if (keyZeros === layer) {
      const index = await this.findGtOrEqualLeafIndex(key);
      const found = await this.atIndex(index);
      if (found?.isLeaf() && found.key === key) {
        throw new Error(`There is already a value at key: ${key}`);
      }
      const prevNode = await this.atIndex(index - 1);
      if (!prevNode || prevNode.isLeaf()) {
        return this.spliceIn(newLeaf, index);
      } else {
        const splitSubTree = await prevNode.splitAround(key);
        return this.replaceWithSplit(
          index - 1,
          splitSubTree[0],
          newLeaf,
          splitSubTree[1]
        );
      }
    } else if (keyZeros < layer) {
      const index = await this.findGtOrEqualLeafIndex(key);
      const prevNode = await this.atIndex(index - 1);
      if (prevNode && prevNode.isTree()) {
        const newSubtree = await prevNode.add(key, value, keyZeros);
        return this.updateEntry(index - 1, newSubtree);
      } else {
        const subTree = await this.createChild();
        const newSubTree = await subTree.add(key, value, keyZeros);
        return this.spliceIn(newSubTree, index);
      }
    } else {
      const split = await this.splitAround(key);
      let left = split[0];
      let right = split[1];
      const extraLayersToAdd = keyZeros - layer;
      for (let i = 1; i < extraLayersToAdd; i++) {
        if (left !== null)
          left = await left.createParent();
        if (right !== null)
          right = await right.createParent();
      }
      const updated = [];
      if (left)
        updated.push(left);
      updated.push(new Leaf(key, value));
      if (right)
        updated.push(right);
      const newRoot = await MST.create(this.blockstore, updated, keyZeros);
      newRoot.outdatedPointer = true;
      return newRoot;
    }
  }
  async get(key) {
    const index = await this.findGtOrEqualLeafIndex(key);
    const found = await this.atIndex(index);
    if (found && found.isLeaf() && found.key === key) {
      return found.value;
    }
    const prev = await this.atIndex(index - 1);
    if (prev && prev.isTree()) {
      return prev.get(key);
    }
    return null;
  }
  async update(key, value) {
    const index = await this.findGtOrEqualLeafIndex(key);
    const found = await this.atIndex(index);
    if (found && found.isLeaf() && found.key === key) {
      return this.updateEntry(index, new Leaf(key, value));
    }
    const prev = await this.atIndex(index - 1);
    if (prev && prev.isTree()) {
      const updatedTree = await prev.update(key, value);
      return this.updateEntry(index - 1, updatedTree);
    }
    throw new Error(`Could not find a record with key: ${key}`);
  }
  async delete(key) {
    const altered = await this.deleteRecurse(key);
    return altered.trimTop();
  }
  async deleteRecurse(key) {
    const index = await this.findGtOrEqualLeafIndex(key);
    const found = await this.atIndex(index);
    if (found?.isLeaf() && found.key === key) {
      const prev2 = await this.atIndex(index - 1);
      const next = await this.atIndex(index + 1);
      if (prev2?.isTree() && next?.isTree()) {
        const merged = await prev2.appendMerge(next);
        return this.newTree([
          ...await this.slice(0, index - 1),
          merged,
          ...await this.slice(index + 2)
        ]);
      } else {
        return this.removeEntry(index);
      }
    }
    const prev = await this.atIndex(index - 1);
    if (prev?.isTree()) {
      const subtree = await prev.deleteRecurse(key);
      const subTreeEntries = await subtree.getEntries();
      if (subTreeEntries.length === 0) {
        return this.removeEntry(index - 1);
      } else {
        return this.updateEntry(index - 1, subtree);
      }
    } else {
      throw new Error(`Could not find a record with key: ${key}`);
    }
  }
  // ---------- Entry ops ----------
  async updateEntry(index, entry) {
    const update = [
      ...await this.slice(0, index),
      entry,
      ...await this.slice(index + 1)
    ];
    return this.newTree(update);
  }
  async removeEntry(index) {
    const updated = [
      ...await this.slice(0, index),
      ...await this.slice(index + 1)
    ];
    return this.newTree(updated);
  }
  async append(entry) {
    const entries = await this.getEntries();
    return this.newTree([...entries, entry]);
  }
  async prepend(entry) {
    const entries = await this.getEntries();
    return this.newTree([entry, ...entries]);
  }
  async atIndex(index) {
    const entries = await this.getEntries();
    return entries[index] ?? null;
  }
  async slice(start, end) {
    const entries = await this.getEntries();
    return entries.slice(start, end);
  }
  async spliceIn(entry, index) {
    const update = [
      ...await this.slice(0, index),
      entry,
      ...await this.slice(index)
    ];
    return this.newTree(update);
  }
  async replaceWithSplit(index, left, leaf, right) {
    const update = await this.slice(0, index);
    if (left)
      update.push(left);
    update.push(leaf);
    if (right)
      update.push(right);
    update.push(...await this.slice(index + 1));
    return this.newTree(update);
  }
  async trimTop() {
    const entries = await this.getEntries();
    if (entries.length === 1 && entries[0].isTree()) {
      return entries[0].trimTop();
    }
    return this;
  }
  async splitAround(key) {
    const index = await this.findGtOrEqualLeafIndex(key);
    const leftData = await this.slice(0, index);
    const rightData = await this.slice(index);
    let left = await this.newTree(leftData);
    let right = await this.newTree(rightData);
    const lastInLeft = leftData[leftData.length - 1];
    if (lastInLeft?.isTree()) {
      left = await left.removeEntry(leftData.length - 1);
      const split = await lastInLeft.splitAround(key);
      if (split[0]) {
        left = await left.append(split[0]);
      }
      if (split[1]) {
        right = await right.prepend(split[1]);
      }
    }
    return [
      (await left.getEntries()).length > 0 ? left : null,
      (await right.getEntries()).length > 0 ? right : null
    ];
  }
  async appendMerge(toMerge) {
    if (await this.getLayer() !== await toMerge.getLayer()) {
      throw new Error("Trying to merge two nodes from different layers of the MST");
    }
    const thisEntries = await this.getEntries();
    const toMergeEntries = await toMerge.getEntries();
    const lastInLeft = thisEntries[thisEntries.length - 1];
    const firstInRight = toMergeEntries[0];
    if (lastInLeft?.isTree() && firstInRight?.isTree()) {
      const merged = await lastInLeft.appendMerge(firstInRight);
      return this.newTree([
        ...thisEntries.slice(0, thisEntries.length - 1),
        merged,
        ...toMergeEntries.slice(1)
      ]);
    } else {
      return this.newTree([...thisEntries, ...toMergeEntries]);
    }
  }
  async createChild() {
    const layer = await this.getLayer();
    return MST.create(this.blockstore, [], layer - 1);
  }
  async createParent() {
    const layer = await this.getLayer();
    const parent = await MST.create(this.blockstore, [this], layer + 1);
    parent.outdatedPointer = true;
    return parent;
  }
  async findGtOrEqualLeafIndex(key) {
    const entries = await this.getEntries();
    const maybeIndex = entries.findIndex(
      (entry) => entry.isLeaf() && entry.key >= key
    );
    return maybeIndex >= 0 ? maybeIndex : entries.length;
  }
  // ---------- Traversal ----------
  async *walk() {
    yield this;
    const entries = await this.getEntries();
    for (const entry of entries) {
      if (entry.isTree()) {
        for await (const e of entry.walk()) {
          yield e;
        }
      } else {
        yield entry;
      }
    }
  }
  async leaves() {
    const leaves = [];
    for await (const entry of this.walk()) {
      if (entry.isLeaf())
        leaves.push(entry);
    }
    return leaves;
  }
  /**
   * Collect all node blocks that need to be persisted for this tree.
   * Returns { root: string, blocks: Map<cid, Uint8Array> }
   */
  async getUnstoredBlocks() {
    const blocks = /* @__PURE__ */ new Map();
    const pointer = await this.getPointer();
    if (this.blockstore.has(pointer)) {
      return { root: pointer, blocks };
    }
    const entries = await this.getEntries();
    const data = serializeNodeData(entries);
    blocks.set(pointer, cborEncode(data));
    for (const entry of entries) {
      if (entry.isTree()) {
        const subtree = await entry.getUnstoredBlocks();
        for (const [cid, bytes] of subtree.blocks) {
          blocks.set(cid, bytes);
        }
      }
    }
    return { root: pointer, blocks };
  }
};
function serializeNodeData(entries) {
  const data = { l: null, e: [] };
  let i = 0;
  if (entries[0]?.isTree()) {
    i++;
    data.l = { $link: entries[0].pointer };
  }
  let lastKey = "";
  while (i < entries.length) {
    const leaf = entries[i];
    const next = entries[i + 1];
    if (!leaf.isLeaf()) {
      throw new Error("Not a valid node: two subtrees next to each other");
    }
    i++;
    let subtree = null;
    if (next?.isTree()) {
      subtree = { $link: next.pointer };
      i++;
    }
    const prefixLen = countPrefixLen(lastKey, leaf.key);
    data.e.push({
      p: prefixLen,
      k: new TextEncoder().encode(leaf.key.slice(prefixLen)),
      v: { $link: leaf.value },
      t: subtree
    });
    lastKey = leaf.key;
  }
  return data;
}
async function deserializeNodeData(blockstore, data, layer) {
  const entries = [];
  if (data.l !== null && data.l !== void 0) {
    entries.push(MST.load(blockstore, data.l.$link ?? data.l));
  }
  let lastKey = "";
  for (const entry of data.e) {
    const keyStr = entry.k instanceof Uint8Array ? new TextDecoder().decode(entry.k) : entry.k;
    const key = lastKey.slice(0, entry.p) + keyStr;
    const value = entry.v && entry.v.$link ? entry.v.$link : entry.v;
    entries.push(new Leaf(key, value));
    lastKey = key;
    if (entry.t !== null && entry.t !== void 0) {
      entries.push(MST.load(blockstore, entry.t.$link ?? entry.t));
    }
  }
  return entries;
}
function readObj(blockstore, cid) {
  const bytes = blockstore.get(cid);
  if (!bytes) {
    throw new Error(`Missing block: ${cid}`);
  }
  return cborDecode(bytes);
}

// src/keys.js
var P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
var P256_P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
var P256_A = P256_P - 3n;
var P256_PREFIX = new Uint8Array([128, 36]);
var K256_PREFIX = new Uint8Array([231, 1]);
var B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bigIntToBytes(n, length = 32) {
  const out = new Uint8Array(length);
  let v = n;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n)
    throw new Error("BigInt does not fit in " + length + " bytes");
  return out;
}
function bytesToBigInt(bytes) {
  let n = 0n;
  for (const b of bytes)
    n = n << 8n | BigInt(b);
  return n;
}
function base58Encode(bytes) {
  let num = 0n;
  for (const byte of bytes)
    num = num * 256n + BigInt(byte);
  let result = "";
  while (num > 0n) {
    result = B58_ALPHABET[Number(num % 58n)] + result;
    num /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0)
      break;
    result = "1" + result;
  }
  return result;
}
function compressP256Point(uncompressed) {
  if (!(uncompressed instanceof Uint8Array) || uncompressed.length !== 65 || uncompressed[0] !== 4) {
    throw new Error("Expected 65-byte uncompressed P-256 point");
  }
  const out = new Uint8Array(33);
  out[0] = 2 + (uncompressed[64] & 1);
  out.set(uncompressed.slice(1, 33), 1);
  return out;
}
function multikeyEncode(curve, compressed33) {
  if (!(compressed33 instanceof Uint8Array) || compressed33.length !== 33) {
    throw new Error("Expected 33-byte compressed public key");
  }
  const prefix = curve === "p256" ? P256_PREFIX : curve === "k256" ? K256_PREFIX : null;
  if (!prefix)
    throw new Error("Unsupported curve: " + curve);
  const bytes = new Uint8Array(prefix.length + compressed33.length);
  bytes.set(prefix, 0);
  bytes.set(compressed33, prefix.length);
  return "z" + base58Encode(bytes);
}
function multikeyToDidKey(multibase) {
  return "did:key:" + multibase;
}
function normalizeLowS(signature64) {
  if (!(signature64 instanceof Uint8Array) || signature64.length !== 64) {
    throw new Error("Expected 64-byte compact ECDSA signature");
  }
  const s = bytesToBigInt(signature64.slice(32));
  if (s <= P256_N / 2n)
    return signature64;
  const out = new Uint8Array(signature64);
  out.set(bigIntToBytes(P256_N - s, 32), 32);
  return out;
}
function base64UrlToBytes(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  return base64ToBytes(b64);
}
async function generateP256Keypair({ extractable = true } = {}) {
  const keypair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    extractable,
    ["sign", "verify"]
  );
  const publicKeyJwk = await crypto.subtle.exportKey("jwk", keypair.publicKey);
  const x = base64UrlToBytes(publicKeyJwk.x);
  const y = base64UrlToBytes(publicKeyJwk.y);
  if (x.length !== 32 || y.length !== 32)
    throw new Error("Unexpected P-256 coordinate length");
  const uncompressed = new Uint8Array(65);
  uncompressed[0] = 4;
  uncompressed.set(x, 1);
  uncompressed.set(y, 33);
  const compressed = compressP256Point(uncompressed);
  const multikey = multikeyEncode("p256", compressed);
  const result = {
    privateKey: keypair.privateKey,
    publicKey: keypair.publicKey,
    publicKeyJwk,
    publicKeyUncompressedHex: bytesToHex(uncompressed),
    publicKeyCompressedHex: bytesToHex(compressed),
    publicKeyMultibase: multikey,
    didKey: multikeyToDidKey(multikey)
  };
  if (extractable) {
    result.privateKeyJwk = await crypto.subtle.exportKey("jwk", keypair.privateKey);
    const pkcs8 = await crypto.subtle.exportKey("pkcs8", keypair.privateKey);
    result.privateKeyPkcs8 = bytesToBase64(new Uint8Array(pkcs8));
  }
  return result;
}
async function importP256PrivateKey(input) {
  if (input && input.type === "private" && input.algorithm?.name === "ECDSA")
    return input;
  if (input && typeof input === "object" && input.kty === "EC") {
    return crypto.subtle.importKey("jwk", input, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  }
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.startsWith("{")) {
      return crypto.subtle.importKey("jwk", JSON.parse(trimmed), { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
    }
    return crypto.subtle.importKey("pkcs8", base64ToBytes(trimmed), { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  }
  throw new Error("Unsupported P-256 private key input");
}
async function signP256(privateKeyInput, message) {
  const key = await importP256PrivateKey(privateKeyInput);
  const data = typeof message === "string" ? new TextEncoder().encode(message) : message;
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data));
  if (signature.length !== 64) {
    throw new Error("Unexpected ECDSA signature length: " + signature.length);
  }
  return bytesToHex(normalizeLowS(signature));
}

// src/repo-core.js
function normalizeCommit(decoded) {
  const link = (value) => {
    if (value === null || value === void 0)
      return null;
    return typeof value === "object" && value.$link ? value.$link : value;
  };
  return {
    did: decoded.did,
    version: decoded.version,
    data: link(decoded.data),
    rev: decoded.rev,
    prev: link(decoded.prev),
    sig: decoded.sig instanceof Uint8Array ? bytesToHex(decoded.sig) : decoded.sig
  };
}
var Repo = class {
  /**
   * @param {object} opts
   * @param {string} opts.did
   * @param {any} [opts.signingKey] - P-256 CryptoKey / JWK / PKCS#8 string, or
   *   any value accepted by `signP256` when `applyWrite` has no `signFn`.
   * @param {Map<string, Uint8Array>} [opts.blockstore]
   * @param {MST|null} [opts.mst]
   * @param {string|null} [opts.commitCid]
   * @param {string|null} [opts.rev]
   */
  constructor({ did, signingKey = null, blockstore, mst = null, commitCid: commitCid3 = null, rev = null }) {
    if (!did || typeof did !== "string")
      throw new Error("Repo requires a did");
    this.did = did;
    this.signingKey = signingKey;
    this.blockstore = blockstore instanceof Map ? blockstore : /* @__PURE__ */ new Map();
    this.mst = mst;
    this.commitCid = commitCid3;
    this.rev = rev;
  }
  /**
   * Create a repo handle. With `mstRoot` the MST is loaded lazily from the
   * blockstore; without it the repo starts empty (first `applyWrite` builds
   * the first tree).
   */
  static async create({
    did,
    signingKey = null,
    blockstore,
    mstRoot = null,
    commitCid: commitCid3 = null,
    rev = null
  } = {}) {
    if (!did || typeof did !== "string")
      throw new Error("Repo.create requires a did");
    const store = blockstore instanceof Map ? blockstore : /* @__PURE__ */ new Map();
    let mst = null;
    if (mstRoot) {
      if (!store.has(mstRoot))
        throw new Error(`Missing MST root block: ${mstRoot}`);
      mst = MST.load(store, mstRoot);
    }
    return new Repo({ did, signingKey, blockstore: store, mst, commitCid: commitCid3, rev });
  }
  /**
   * Load a repo from a CAR (`getRepo` output or a full-repo export).
   *
   * The CAR root must be the head commit; the commit block and MST root block
   * must be present. `did` and commit `version` are validated, and the head
   * commit CID is recomputed from its canonical encoding.
   */
  static async fromCar(carBytes, { did, signingKey = null } = {}) {
    if (!did || typeof did !== "string")
      throw new Error("Repo.fromCar requires a did");
    const { roots, blocks, header } = readCarFile(carBytes);
    if (header?.version !== 1) {
      throw new Error(`Unsupported CAR version: ${header?.version}`);
    }
    if (roots.length !== 1) {
      throw new Error(`Expected exactly one CAR root, got ${roots.length}`);
    }
    const root = roots[0];
    const blockstore = new Map(blocks);
    const commitBytes = blockstore.get(root);
    if (!commitBytes)
      throw new Error(`CAR is missing its root commit block: ${root}`);
    const commit = normalizeCommit(cborDecode(commitBytes));
    if (commit.did !== did) {
      throw new Error(`Repo did mismatch: expected ${did}, got ${commit.did}`);
    }
    if (commit.version !== 3) {
      throw new Error(`Unsupported repo commit version: ${commit.version}`);
    }
    if (!commit.rev || typeof commit.rev !== "string") {
      throw new Error("Commit is missing a valid rev");
    }
    if (!commit.data || typeof commit.data !== "string") {
      throw new Error("Commit is missing its MST root (data)");
    }
    const derived = await commitCid2(commit);
    if (derived !== root) {
      throw new Error(`Commit CID mismatch: CAR root ${root}, canonical ${derived}`);
    }
    if (!blockstore.has(commit.data)) {
      throw new Error(`CAR is missing the MST root block: ${commit.data}`);
    }
    return new Repo({
      did,
      signingKey,
      blockstore,
      mst: MST.load(blockstore, commit.data),
      commitCid: root,
      rev: commit.rev
    });
  }
  /** Merge all blocks from a CAR into this repo's blockstore. */
  loadBlocksFromCar(carBytes) {
    const { roots, blocks } = readCarFile(carBytes);
    for (const [cid, bytes] of blocks)
      this.blockstore.set(cid, bytes);
    return { roots, blocks };
  }
  /**
   * Apply one write and produce a signed commit v3.
   *
   * @param {{action: 'create'|'update'|'delete', collection: string,
   *   rkey: string, record?: object}} write
   * @param {(encoded: Uint8Array) => Promise<string>} [signFn]
   *   Optional signer. Defaults to `signP256(this.signingKey, encoded)`.
   * @returns {Promise<{recordCid: string|null, mstRoot: string,
   *   prevMstRoot: string|null, commit: object, commitCid: string,
   *   rev: string, newBlocks: Map<string, Uint8Array>}>}
   */
  async applyWrite({ action, collection, rkey, record } = {}, signFn) {
    if (!["create", "update", "delete"].includes(action)) {
      throw new Error(`Unsupported write action: ${action}`);
    }
    if (typeof collection !== "string" || typeof rkey !== "string") {
      throw new Error("applyWrite requires collection and rkey strings");
    }
    const key = `${collection}/${rkey}`;
    if (!isValidMstKey(key))
      throw new Error(`Invalid MST key: ${key}`);
    if (action !== "delete" && (record === void 0 || record === null)) {
      throw new Error(`applyWrite ${action} requires a record`);
    }
    const recCid = action === "delete" ? null : await recordCid(record);
    let mst = this.mst || await MST.create(this.blockstore, [], 0);
    const prevMstRoot = this.mst ? await this.mst.getPointer() : null;
    if (action === "delete") {
      mst = await mst.delete(key);
    } else if (action === "update") {
      mst = await mst.update(key, recCid);
    } else {
      mst = await mst.add(key, recCid);
    }
    const { root: mstRoot, blocks } = await mst.getUnstoredBlocks();
    if (recCid && !this.blockstore.has(recCid) && !blocks.has(recCid)) {
      blocks.set(recCid, cborEncode(record));
    }
    const rev = nextTID(this.rev);
    const unsigned = buildUnsignedCommit(this.did, mstRoot, rev, this.commitCid);
    const sign = signFn || ((encoded) => {
      if (!this.signingKey)
        throw new Error("No signFn or signingKey provided");
      return signP256(this.signingKey, encoded);
    });
    const commit = await signCommit(unsigned, sign);
    const cid = await commitCid2(commit);
    blocks.set(cid, commitToCbor(commit));
    for (const [bcid, bytes] of blocks)
      this.blockstore.set(bcid, bytes);
    this.mst = mst;
    this.commitCid = cid;
    this.rev = rev;
    return {
      recordCid: recCid,
      mstRoot,
      prevMstRoot,
      commit,
      commitCid: cid,
      rev,
      newBlocks: blocks
    };
  }
  /**
   * Build the incremental CAR for one `applyWrite` result: root = new commit,
   * blocks = new commit + new MST nodes + new record. This is the payload for
   * a firehose-style `#commit` event / append endpoint.
   */
  buildCar(result) {
    if (!result || !result.commitCid || !result.newBlocks) {
      throw new Error("buildCar requires an applyWrite result");
    }
    const blocks = [];
    for (const [cid, data] of result.newBlocks) {
      blocks.push({ cid, data });
    }
    return createCarFile(result.commitCid, blocks);
  }
  /**
   * Build a complete CAR containing the current head and every block in the
   * blockstore. Use this for export/backup and for full-repo verification.
   */
  buildFullCar() {
    if (!this.commitCid)
      throw new Error("Cannot build a CAR for an empty repo");
    if (!this.blockstore.has(this.commitCid)) {
      throw new Error(`Missing head commit block: ${this.commitCid}`);
    }
    const blocks = [];
    for (const [cid, data] of this.blockstore) {
      blocks.push({ cid, data });
    }
    return createCarFile(this.commitCid, blocks);
  }
  getHead() {
    return { commitCid: this.commitCid, rev: this.rev };
  }
  /**
   * Read all leaves from the MST and decode their record blocks.
   * @returns {Promise<Array<{collection: string, rkey: string, cid: string,
   *   record: object}>>}
   */
  async getRecords() {
    if (!this.mst)
      return [];
    const leaves = await this.mst.leaves();
    const records = [];
    for (const leaf of leaves) {
      const split = leaf.key.indexOf("/");
      if (split < 0)
        continue;
      const bytes = this.blockstore.get(leaf.value);
      if (!bytes)
        throw new Error(`Missing record block: ${leaf.value}`);
      records.push({
        collection: leaf.key.slice(0, split),
        rkey: leaf.key.slice(split + 1),
        cid: leaf.value,
        record: cborDecode(bytes)
      });
    }
    return records;
  }
  /** Read and decode one record, or null if the key is absent. */
  async getRecord(collection, rkey) {
    if (!this.mst)
      return null;
    const cid = await this.mst.get(`${collection}/${rkey}`);
    if (!cid)
      return null;
    const bytes = this.blockstore.get(cid);
    if (!bytes)
      throw new Error(`Missing record block: ${cid}`);
    return cborDecode(bytes);
  }
  /** CID of one record key from the MST, or null. */
  async getRecordCid(collection, rkey) {
    if (!this.mst)
      return null;
    return this.mst.get(`${collection}/${rkey}`);
  }
};

// app/main.js
var STORAGE_KEY = "atproto-worker-key-v1";
var PBKDF2_ITERATIONS = 21e4;
var AES_KEY_BITS = 256;
var encoder = new TextEncoder();
var decoder = new TextDecoder();
var COLLECTION = "app.bsky.feed.post";
var MAX_LOG_LINES = 200;
var state = {
  record: null,
  privateKey: null,
  repo: null,
  records: [],
  did: "",
  handle: "",
  workerUrl: "",
  publicKeyMultibase: "",
  busy: false,
  loading: false
};
var $ = (id) => document.getElementById(id);
function init() {
  wireEvents();
  applySetupDefaults();
  if (!globalThis.crypto?.subtle) {
    setStatus("error", "WebCrypto unavailable - use HTTPS or localhost");
    showNotice($("setup-error"), "WebCrypto is not available. Serve this page over HTTPS (or localhost) in a modern browser.", "error");
  }
  const stored = loadStoredRecord();
  if (stored) {
    state.record = stored;
    applyRecordMeta(stored);
    showUnlock();
  } else {
    showSetup();
  }
}
function wireEvents() {
  $("create-key-btn").addEventListener("click", onCreateKey);
  $("unlock-btn").addEventListener("click", onUnlock);
  $("export-backup-btn").addEventListener("click", onExportBackup);
  $("export-backup-btn-2").addEventListener("click", onExportBackup);
  $("forget-key-btn").addEventListener("click", onForgetKey);
  $("lock-btn").addEventListener("click", onLock);
  $("refresh-btn").addEventListener("click", () => loadRepo());
  $("post-btn").addEventListener("click", onPost);
  $("copy-didjson-btn").addEventListener("click", onCopyDidJson);
  $("check-did-btn").addEventListener("click", onCheckPublishedKey);
  $("clear-log-btn").addEventListener("click", () => {
    $("log").replaceChildren();
  });
  for (const radio of document.querySelectorAll('input[name="key-mode"]')) {
    radio.addEventListener("change", syncKeyMode);
  }
  const compose = $("compose-text");
  compose.addEventListener("input", () => {
    $("compose-count").textContent = String(compose.value.length);
  });
  $("unlock-passphrase").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      onUnlock();
    }
  });
}
function applySetupDefaults() {
  const isHttp = location.protocol === "http:" || location.protocol === "https:";
  const host = isHttp ? location.host : "";
  $("setup-did").value = host ? `did:web:${host}` : "";
  $("setup-handle").value = host;
  $("setup-worker").value = isHttp ? location.origin : "";
  syncKeyMode();
}
function syncKeyMode() {
  const mode = getKeyMode();
  $("import-field").classList.toggle("hidden", mode !== "import");
}
function getKeyMode() {
  const checked = document.querySelector('input[name="key-mode"]:checked');
  return checked ? checked.value : "generate";
}
function showSetup() {
  $("setup-view").classList.remove("hidden");
  $("unlock-view").classList.add("hidden");
  $("app-view").classList.add("hidden");
  setStatus("idle", "Not connected");
}
function showUnlock() {
  $("setup-view").classList.add("hidden");
  $("unlock-view").classList.remove("hidden");
  $("app-view").classList.add("hidden");
  $("unlock-did").textContent = state.did;
  $("unlock-handle").textContent = state.handle;
  $("unlock-worker").textContent = state.workerUrl;
  $("unlock-key").textContent = state.publicKeyMultibase;
  setStatus("idle", "Key locked");
}
function showApp() {
  $("setup-view").classList.add("hidden");
  $("unlock-view").classList.add("hidden");
  $("app-view").classList.remove("hidden");
  $("meta-did").textContent = state.did;
  $("meta-handle").textContent = state.handle;
  $("meta-worker").textContent = state.workerUrl;
  $("meta-key").textContent = state.publicKeyMultibase;
  renderDidJson();
  updateControls();
}
function applyRecordMeta(record) {
  state.did = record.did || "";
  state.handle = record.handle || "";
  try {
    state.workerUrl = normalizeUrl(record.workerUrl || "");
  } catch {
    state.workerUrl = record.workerUrl || "";
  }
  state.publicKeyMultibase = record.publicKeyMultibase || "";
}
function loadStoredRecord() {
  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw)
    return null;
  try {
    const record = JSON.parse(raw);
    if (record?.v !== 1)
      return null;
    for (const field of ["did", "handle", "workerUrl", "publicKeyMultibase", "salt", "iv", "ciphertext"]) {
      if (typeof record[field] !== "string" || !record[field])
        return null;
    }
    return record;
  } catch {
    return null;
  }
}
function saveStoredRecord(record) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch (e) {
    throw new Error(`Could not save the encrypted key in localStorage: ${e.message}`);
  }
}
async function deriveAesKey(passphrase, salt, iterations) {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: AES_KEY_BITS },
    false,
    ["encrypt", "decrypt"]
  );
}
async function encryptRecord(jwk, meta, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await deriveAesKey(passphrase, salt, PBKDF2_ITERATIONS);
  const plaintext = encoder.encode(JSON.stringify(jwk));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, plaintext);
  plaintext.fill(0);
  return {
    v: 1,
    iterations: PBKDF2_ITERATIONS,
    did: meta.did,
    handle: meta.handle,
    workerUrl: meta.workerUrl,
    publicKeyMultibase: meta.publicKeyMultibase,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext))
  };
}
async function decryptRecord(record, passphrase) {
  const salt = base64ToBytes(record.salt);
  const iv = base64ToBytes(record.iv);
  const ciphertext = base64ToBytes(record.ciphertext);
  const iterations = Number.isInteger(record.iterations) ? record.iterations : PBKDF2_ITERATIONS;
  const aesKey = await deriveAesKey(passphrase, salt, iterations);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, aesKey, ciphertext);
  try {
    return JSON.parse(decoder.decode(plaintext));
  } finally {
    new Uint8Array(plaintext).fill(0);
  }
}
async function onCreateKey() {
  const button = $("create-key-btn");
  showNotice($("setup-error"), "", "error");
  button.disabled = true;
  setStatus("busy", "Preparing key\u2026");
  try {
    const fields = readSetupFields();
    const mode = getKeyMode();
    let material;
    if (mode === "import") {
      material = await importKeyMaterial(fields.importText, fields.expected);
    } else {
      material = await generateKeyMaterial(fields.expected);
    }
    const record = await encryptRecord(
      material.jwk,
      {
        did: fields.did,
        handle: fields.handle,
        workerUrl: fields.workerUrl,
        publicKeyMultibase: material.publicKeyMultibase
      },
      fields.passphrase
    );
    saveStoredRecord(record);
    state.record = record;
    state.privateKey = material.privateKey;
    applyRecordMeta(record);
    $("setup-import").value = "";
    $("setup-passphrase").value = "";
    $("setup-passphrase2").value = "";
    showApp();
    log(`Encrypted key created for ${state.did}`, "ok");
    log(`Public key: ${state.publicKeyMultibase}`, "");
    log("Publish the DID document shown on the right before writing to the Worker.", "warn");
    setStatus("busy", "Key ready - loading repo\u2026");
    await loadRepo();
  } catch (e) {
    showNotice($("setup-error"), e.message || String(e), "error");
    setStatus("error", "Key setup failed");
  } finally {
    button.disabled = false;
  }
}
function readSetupFields() {
  const did = $("setup-did").value.trim();
  const handle = $("setup-handle").value.trim();
  const workerInput = $("setup-worker").value.trim();
  const passphrase = $("setup-passphrase").value;
  const passphrase2 = $("setup-passphrase2").value;
  const importText = $("setup-import").value.trim();
  const expected = $("setup-expected").value.trim();
  if (!/^did:[a-z0-9]+:.+/i.test(did))
    throw new Error("Enter a valid DID (for example did:web:example.com).");
  if (!handle)
    throw new Error("Enter the handle for this account.");
  if (!workerInput)
    throw new Error("Enter the Worker URL.");
  const workerUrl = normalizeUrl(workerInput);
  if (!passphrase || passphrase.length < 8)
    throw new Error("Use a passphrase of at least 8 characters.");
  if (passphrase !== passphrase2)
    throw new Error("The passphrase confirmation does not match.");
  if (getKeyMode() === "import" && !importText)
    throw new Error("Paste the PKCS#8 base64 private key, or switch to Generate.");
  return { did, handle, workerUrl, passphrase, importText, expected };
}
async function generateKeyMaterial(expectedMultikey) {
  const keypair = await generateP256Keypair({ extractable: true });
  if (!keypair.privateKeyJwk)
    throw new Error("Could not export the generated private key for encryption.");
  if (expectedMultikey && expectedMultikey !== keypair.publicKeyMultibase) {
    throw new Error(
      `The generated key (${keypair.publicKeyMultibase}) does not match the current DID document key (${expectedMultikey}). Refusing to rotate accidentally. Clear that field or publish the new DID document first.`
    );
  }
  return {
    privateKey: keypair.privateKey,
    jwk: keypair.privateKeyJwk,
    publicKeyMultibase: keypair.publicKeyMultibase
  };
}
async function importKeyMaterial(pkcs8Base64, expectedMultikey) {
  if (!pkcs8Base64)
    throw new Error("Paste the PKCS#8 base64 private key.");
  const trimmed = pkcs8Base64.trim();
  const input = trimmed.startsWith("{") ? trimmed : trimmed.replace(/\s+/g, "");
  const privateKey = await importP256PrivateKey(input);
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  const publicKeyMultibase = multikeyFromJwk(jwk);
  if (expectedMultikey && expectedMultikey !== publicKeyMultibase) {
    throw new Error(
      `The imported key (${publicKeyMultibase}) does not match the current DID document key (${expectedMultikey}).`
    );
  }
  return { privateKey, jwk, publicKeyMultibase };
}
function multikeyFromJwk(jwk) {
  if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
    throw new Error("The imported key is not a P-256 private JWK.");
  }
  const x = base64UrlToBytes2(jwk.x);
  const y = base64UrlToBytes2(jwk.y);
  if (x.length !== 32 || y.length !== 32)
    throw new Error("Unexpected P-256 coordinate length.");
  const uncompressed = new Uint8Array(65);
  uncompressed[0] = 4;
  uncompressed.set(x, 1);
  uncompressed.set(y, 33);
  return multikeyEncode("p256", compressP256Point(uncompressed));
}
async function onUnlock() {
  const button = $("unlock-btn");
  const input = $("unlock-passphrase");
  const passphrase = input.value;
  showNotice($("unlock-error"), "", "error");
  if (!state.record) {
    showSetup();
    return;
  }
  if (!passphrase) {
    showNotice($("unlock-error"), "Enter the passphrase.", "error");
    return;
  }
  button.disabled = true;
  setStatus("busy", "Unlocking\u2026");
  try {
    const jwk = await decryptRecord(state.record, passphrase);
    state.privateKey = await importP256PrivateKey(jwk);
    input.value = "";
    applyRecordMeta(state.record);
    showApp();
    log(`Unlocked key for ${state.did}`, "ok");
    setStatus("busy", "Unlocked - loading repo\u2026");
    await loadRepo();
  } catch (e) {
    input.value = "";
    showNotice($("unlock-error"), "Could not unlock. Check the passphrase (or the encrypted backup is corrupt).", "error");
    setStatus("error", "Locked");
    log(`Unlock failed: ${e.name || "Error"}`, "error");
  } finally {
    button.disabled = false;
  }
}
function onLock() {
  state.privateKey = null;
  state.repo = null;
  state.records = [];
  showNotice($("compose-status"), "", "");
  showUnlock();
  log("Locked. The CryptoKey was dropped from memory.", "");
}
function onForgetKey() {
  if (!state.record)
    return;
  const ok = window.confirm(
    "Forget this key?\n\nThis removes the encrypted key record from this browser. Without an exported backup and the passphrase, the key cannot be recovered."
  );
  if (!ok)
    return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    showNotice($("unlock-error"), `Could not remove the key record: ${e.message}`, "error");
    return;
  }
  state.record = null;
  state.privateKey = null;
  state.repo = null;
  state.records = [];
  state.did = "";
  state.handle = "";
  state.workerUrl = "";
  state.publicKeyMultibase = "";
  applySetupDefaults();
  showSetup();
  log("Encrypted key record removed from this browser.", "warn");
}
function onExportBackup() {
  if (!state.record)
    return;
  const safeDid = (state.record.did || "key").replace(/[^a-z0-9._-]+/gi, "_");
  downloadJson(`atproto-worker-key-${safeDid}.json`, state.record);
  log("Downloaded encrypted key backup (still requires the passphrase).", "ok");
}
function downloadJson(filename, value) {
  const blob = new Blob([JSON.stringify(value, null, 2) + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1e3);
}
function buildDidDocument() {
  let worker = state.workerUrl;
  try {
    worker = normalizeUrl(state.workerUrl);
  } catch {
  }
  return {
    "@context": [
      "https://www.w3.org/ns/did/v1",
      "https://w3id.org/security/multikey/multikey-v1.jsonld"
    ],
    id: state.did,
    alsoKnownAs: [`at://${state.handle}`],
    verificationMethod: [
      {
        id: `${state.did}#atproto`,
        type: "Multikey",
        controller: state.did,
        publicKeyMultibase: state.publicKeyMultibase
      }
    ],
    service: [
      {
        id: "#atproto_pds",
        type: "AtprotoPersonalDataServer",
        serviceEndpoint: worker
      }
    ]
  };
}
function renderDidJson() {
  if (!state.did || !state.publicKeyMultibase)
    return;
  $("didjson").textContent = JSON.stringify(buildDidDocument(), null, 2);
  $("didjson-status").textContent = "";
}
async function onCopyDidJson() {
  const text = $("didjson").textContent;
  if (!text)
    return;
  const ok = await copyText(text);
  $("didjson-status").textContent = ok ? "Copied DID document JSON." : "Copy failed; select the JSON manually.";
}
async function onCheckPublishedKey() {
  const target = publishedDidUrl();
  if (!target) {
    $("didjson-status").textContent = "Only did:web documents can be checked from the browser.";
    return;
  }
  $("didjson-status").textContent = `Checking ${target} \u2026`;
  try {
    const response = await fetch(`${target}${target.includes("?") ? "&" : "?"}t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok)
      throw new Error(`HTTP ${response.status}`);
    const doc = await response.json();
    const published = findAtprotoKey(doc);
    if (!published)
      throw new Error("no verificationMethod with publicKeyMultibase was found");
    if (published === state.publicKeyMultibase) {
      $("didjson-status").textContent = "Published #atproto key matches this browser key.";
      log("Published DID document key matches.", "ok");
    } else {
      $("didjson-status").textContent = `Mismatch: published ${shorten(published)} but this page holds ${shorten(state.publicKeyMultibase)}.`;
      log("Published DID document key does not match.", "warn");
    }
  } catch (e) {
    $("didjson-status").textContent = `Could not verify the published key: ${e.message}`;
  }
}
function publishedDidUrl() {
  if (!state.did.startsWith("did:web:"))
    return null;
  const rest = state.did.slice("did:web:".length);
  const parts = rest.split(":");
  const didHost = decodeURIComponent(parts[0] || "");
  if (state.workerUrl) {
    try {
      const worker = new URL(state.workerUrl);
      if (worker.host === didHost) {
        return `${normalizeUrl(state.workerUrl)}/.well-known/did.json`;
      }
    } catch {
    }
  }
  if (parts.length === 1)
    return `https://${didHost}/.well-known/did.json`;
  const path = parts.slice(1).map((part) => decodeURIComponent(part)).join("/");
  return `https://${didHost}/${path}/did.json`;
}
function findAtprotoKey(doc) {
  const methods = Array.isArray(doc?.verificationMethod) ? doc.verificationMethod : [];
  const preferred = methods.find((method2) => typeof method2?.id === "string" && method2.id.endsWith("#atproto"));
  const method = preferred || methods.find((item) => typeof item?.publicKeyMultibase === "string");
  return typeof method?.publicKeyMultibase === "string" ? method.publicKeyMultibase : null;
}
async function loadRepo() {
  if (!state.did || !state.workerUrl)
    return;
  if (state.loading)
    return;
  state.loading = true;
  state.repo = null;
  updateControls();
  showNotice($("head-error"), "", "error");
  setStatus("busy", "Contacting Worker\u2026");
  const base = normalizeUrl(state.workerUrl);
  const didParam = encodeURIComponent(state.did);
  const bust = `t=${Date.now()}`;
  try {
    await pingWorker(base);
    const repoResponse = await fetch(
      `${base}/xrpc/com.atproto.sync.getRepo?did=${didParam}&${bust}`,
      { cache: "no-store" }
    );
    if (repoResponse.status === 404) {
      state.repo = await Repo.create({ did: state.did, signingKey: state.publicKeyMultibase });
      state.records = [];
      renderRecords([]);
      setHeadDisplay("\u2014", "\u2014", "No repo yet - the first post will create it");
      setStatus("ok", "Connected. No repo yet.");
      log("Worker reports no repo for this DID yet.", "warn");
      return;
    }
    if (!repoResponse.ok) {
      throw new Error(`getRepo failed: ${await describeHttpError(repoResponse)}`);
    }
    const carBytes = new Uint8Array(await repoResponse.arrayBuffer());
    const latest = await fetchLatestCommit(base, didParam, bust);
    let repo;
    try {
      repo = await Repo.fromCar(carBytes, {
        did: state.did,
        signingKey: state.publicKeyMultibase
      });
    } catch (e) {
      throw new Error(`Could not parse the CAR returned by getRepo: ${e.message}`);
    }
    const head = repo.getHead();
    if (latest?.cid && head.commitCid !== latest.cid) {
      const records = await repo.getRecords().catch(() => []);
      state.repo = null;
      state.records = records;
      renderRecords(records);
      setHeadDisplay(
        head.commitCid,
        head.rev,
        `MISMATCH - getLatestCommit reports ${latest.cid}`
      );
      showNotice(
        $("head-error"),
        `Stale/conflict: getRepo is rooted at ${head.commitCid}, but getLatestCommit reports ${latest.cid} (rev ${latest.rev || "?"}). The snapshot is stale, so writing is disabled. Refresh the repo and retry.`,
        "error"
      );
      setStatus("error", "Repo head mismatch - refresh before writing");
      log("Head mismatch detected between getRepo and getLatestCommit.", "error");
      return;
    }
    state.repo = repo;
    state.records = await repo.getRecords();
    renderRecords(state.records);
    setHeadDisplay(
      head.commitCid,
      head.rev,
      latest?.cid ? "matches getLatestCommit" : "getRepo root only"
    );
    setStatus("ok", `Connected - head verified (${shorten(head.commitCid)})`);
    log(`Loaded repo head ${head.commitCid} (rev ${head.rev}) with ${state.records.length} record(s).`, "ok");
  } catch (e) {
    state.repo = null;
    state.records = [];
    renderRecords([]);
    setHeadDisplay("\u2014", "\u2014", "unavailable");
    showNotice($("head-error"), e.message || String(e), "error");
    setStatus("error", e.message || "Repo load failed");
    log(`Repo load failed: ${e.message || e}`, "error");
  } finally {
    state.loading = false;
    updateControls();
  }
}
async function pingWorker(base) {
  const response = await fetch(`${base}/xrpc/_health?t=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Worker health check failed (${await describeHttpError(response)})`);
  }
}
async function fetchLatestCommit(base, didParam, bust) {
  const response = await fetch(
    `${base}/xrpc/com.atproto.sync.getLatestCommit?did=${didParam}&${bust}`,
    { cache: "no-store" }
  );
  if (response.status === 404)
    return null;
  if (!response.ok) {
    throw new Error(`getLatestCommit failed: ${await describeHttpError(response)}`);
  }
  return response.json();
}
function setHeadDisplay(cid, rev, verification) {
  $("head-cid").textContent = cid || "\u2014";
  $("head-rev").textContent = rev || "\u2014";
  $("head-verified").textContent = verification || "\u2014";
}
function renderRecords(records) {
  const container = $("records");
  container.replaceChildren();
  $("records-count").textContent = String(records.length);
  if (!records.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No records yet.";
    container.appendChild(empty);
    return;
  }
  const sorted = [...records].sort((a, b) => {
    const ta = Date.parse(a.record?.createdAt || "") || 0;
    const tb = Date.parse(b.record?.createdAt || "") || 0;
    if (tb !== ta)
      return tb - ta;
    return String(b.rkey).localeCompare(String(a.rkey));
  });
  for (const item of sorted) {
    const card = document.createElement("article");
    card.className = "record";
    const head = document.createElement("div");
    head.className = "record-head";
    const key = document.createElement("span");
    key.className = "record-key";
    key.textContent = `${item.collection}/${item.rkey}`;
    head.appendChild(key);
    const del = document.createElement("button");
    del.type = "button";
    del.className = "danger record-delete";
    del.textContent = "Delete";
    del.addEventListener("click", () => onDelete(item));
    head.appendChild(del);
    card.appendChild(head);
    const record = item.record || {};
    if (typeof record.text === "string" && record.text) {
      const text = document.createElement("p");
      text.className = "record-text";
      text.textContent = record.text;
      card.appendChild(text);
    } else if (record.$type !== COLLECTION) {
      const raw = document.createElement("pre");
      raw.className = "mono wrap";
      raw.textContent = JSON.stringify(record, null, 2);
      card.appendChild(raw);
    }
    const meta = document.createElement("div");
    meta.className = "record-meta";
    if (record.createdAt) {
      const created = document.createElement("span");
      created.textContent = record.createdAt;
      meta.appendChild(created);
    }
    const type = document.createElement("span");
    type.textContent = record.$type || item.collection;
    meta.appendChild(type);
    const cid = document.createElement("span");
    cid.className = "mono";
    cid.textContent = item.cid;
    meta.appendChild(cid);
    card.appendChild(meta);
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Raw record";
    details.appendChild(summary);
    const pre = document.createElement("pre");
    pre.className = "mono";
    pre.textContent = JSON.stringify(record, null, 2);
    details.appendChild(pre);
    card.appendChild(details);
    container.appendChild(card);
  }
  updateControls();
}
async function onPost() {
  if (state.busy || !state.repo || !state.privateKey)
    return;
  const textarea = $("compose-text");
  const text = textarea.value.trim();
  showNotice($("compose-status"), "", "");
  if (!text) {
    showNotice($("compose-status"), "Write something first.", "warn");
    return;
  }
  const record = {
    $type: COLLECTION,
    text,
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  const rkey = generateTID();
  await runWrite({ action: "create", collection: COLLECTION, rkey, record }, () => {
    textarea.value = "";
    $("compose-count").textContent = "0";
  });
}
async function onDelete(item) {
  if (state.busy || !state.repo || !state.privateKey)
    return;
  const ok = window.confirm(`Delete ${item.collection}/${item.rkey}?

This creates a signed delete commit.`);
  if (!ok)
    return;
  await runWrite({ action: "delete", collection: item.collection, rkey: item.rkey });
}
async function runWrite(write, onSuccess) {
  state.busy = true;
  updateControls();
  setStatus("busy", `Signing ${write.action}\u2026`);
  showNotice($("compose-status"), "", "");
  try {
    const result = await state.repo.applyWrite(write, (encoded) => signP256(state.privateKey, encoded));
    const car = state.repo.buildCar(result);
    const event = {
      did: state.did,
      op: write.action,
      collection: write.collection,
      rkey: write.rkey,
      rev: result.rev,
      recordCid: result.recordCid,
      commit: result.commit,
      commitCid: result.commitCid,
      mstRoot: result.mstRoot,
      blocksB64: bytesToBase64(car),
      signingKey: state.publicKeyMultibase
    };
    if (write.action !== "delete")
      event.record = write.record;
    log(
      `Signed ${write.action} ${write.collection}/${write.rkey} (commit ${shorten(result.commitCid)}, rev ${result.rev}).`,
      ""
    );
    let response;
    try {
      response = await appendEvent(event);
    } catch (e) {
      await handleWriteFailure(e);
      return;
    }
    log(`Append accepted: ${JSON.stringify(response)}`, "ok");
    if (typeof onSuccess === "function")
      onSuccess();
    showNotice(
      $("compose-status"),
      `Accepted: ${response.uri} (cid ${shorten(response.cid)}, seq ${response.seq}, commit ${shorten(response.commit?.cid)}, rev ${response.commit?.rev}).`,
      "ok"
    );
    setStatus("ok", `Write accepted (seq ${response.seq})`);
    await loadRepo();
  } catch (e) {
    state.repo = null;
    showNotice($("compose-status"), `Write failed before it was sent: ${e.message || e}`, "error");
    log(`Write failed: ${e.message || e}`, "error");
    await loadRepo();
  } finally {
    state.busy = false;
    updateControls();
  }
}
async function appendEvent(event) {
  const response = await fetch(`${normalizeUrl(state.workerUrl)}/xrpc/com.atproto.worker.appendEvent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event }),
    cache: "no-store"
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
  }
  if (!response.ok) {
    const error = new Error(
      data && (data.message || data.error) || `HTTP ${response.status}`
    );
    error.status = response.status;
    error.code = data?.error;
    error.details = data;
    throw error;
  }
  return data;
}
async function handleWriteFailure(error) {
  state.repo = null;
  if (error.status === 409) {
    const head = error.details?.head;
    showNotice(
      $("compose-status"),
      "409 RepoConflict: the Worker head changed. The local commit was discarded and was NOT re-signed. The page will reload the new head - review the text and retry." + (head?.commitCid ? `
New head: ${head.commitCid} (rev ${head.rev}).` : ""),
      "warn"
    );
    log(`409 RepoConflict: ${error.message}. Discarding local commit.`, "warn");
    setStatus("busy", "Conflict - refreshing head\u2026");
  } else if (error.status) {
    showNotice(
      $("compose-status"),
      `Write rejected (HTTP ${error.status}${error.code ? ", " + error.code : ""}): ${error.message}`,
      "error"
    );
    log(`Write rejected (${error.status} ${error.code || ""}): ${error.message}`, "error");
    setStatus("error", `Write rejected: ${error.code || error.status}`);
  } else {
    showNotice($("compose-status"), `Network error while appending: ${error.message}`, "error");
    log(`Append network error: ${error.message}`, "error");
    setStatus("error", "Network error");
  }
  await loadRepo();
}
function updateControls() {
  const disabled = state.busy || state.loading;
  const canWrite = !disabled && !!state.repo && !!state.privateKey;
  $("post-btn").disabled = !canWrite;
  $("refresh-btn").disabled = disabled || !state.workerUrl;
  $("lock-btn").disabled = state.busy;
  for (const button of document.querySelectorAll(".record-delete")) {
    button.disabled = !canWrite;
  }
}
function setStatus(kind, text) {
  const dot = $("status-dot");
  dot.className = `dot dot-${kind}`;
  $("status-text").textContent = text;
}
function showNotice(element, message, kind = "error") {
  if (!element)
    return;
  element.classList.remove("hidden", "error", "ok", "warn");
  if (!message) {
    element.textContent = "";
    element.classList.add("hidden");
    return;
  }
  element.textContent = message;
  element.classList.add(kind);
}
function log(message, kind = "") {
  const container = $("log");
  const line = document.createElement("div");
  line.className = `log-line${kind ? " " + kind : ""}`;
  const time = document.createElement("span");
  time.className = "time";
  time.textContent = (/* @__PURE__ */ new Date()).toISOString().slice(11, 19) + " ";
  line.appendChild(time);
  line.appendChild(document.createTextNode(message));
  container.appendChild(line);
  while (container.childElementCount > MAX_LOG_LINES) {
    container.firstElementChild.remove();
  }
  container.scrollTop = container.scrollHeight;
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}
function describeHttpError(response) {
  return response.clone().json().then((body) => `${response.status} ${body.error || ""}${body.message ? ": " + body.message : ""}`.trim()).catch(async () => {
    try {
      const text = await response.text();
      return `HTTP ${response.status}${text ? ": " + text.slice(0, 200) : ""}`;
    } catch {
      return `HTTP ${response.status}`;
    }
  });
}
function normalizeUrl(value) {
  const trimmed = String(value || "").trim().replace(/\/+$/, "");
  if (!trimmed)
    return "";
  const url = new URL(trimmed);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("URL must start with http:// or https://");
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}
function base64UrlToBytes2(value) {
  const b64 = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - b64.length % 4) % 4);
  return base64ToBytes(padded);
}
function shorten(value, size = 12) {
  const text = String(value || "");
  if (text.length <= size * 2 + 1)
    return text;
  return `${text.slice(0, size)}\u2026${text.slice(-size)}`;
}
init();
