/**
 * Merkle Search Tree (MST) - port of the atproto reference implementation
 * (packages/repo/src/mst/mst.ts) using this project's shared CBOR/CID.
 *
 * MST is an ordered, insert-order-independent, deterministic tree:
 * - keys are `collection/rkey`, sorted lexicographically
 * - each key's layer = leading zeros on sha256(key) (~4 fanout, 2 bits/layer)
 * - node CBOR: { l: subtreeCID|null, e: [{p: prefixLen, k: keyRest, v: valueCID, t: nextSubtree|null}] }
 * - node CID = dag-cbor CID of the serialized node
 *
 * Pure/immutable: every mutation returns a new tree. Nodes are stored in a
 * blockstore (Map<cid, Uint8Array>) exactly like the reference.
 */

import { cborEncode, computeCID, base32Encode } from '../src/shared.js'
import { sha256 } from './sha.js'

// ---------- Key / layer helpers ----------

export function isValidMstKey(str) {
  const split = str.split('/')
  return (
    str.length <= 1024 &&
    split.length === 2 &&
    split[0].length > 0 &&
    split[1].length > 0 &&
    /^[a-zA-Z0-9_~\-:.]*$/.test(split[0]) &&
    /^[a-zA-Z0-9_~\-:.]*$/.test(split[1])
  )
}

export async function leadingZerosOnHash(key) {
  const hash = await sha256(key)
  let leadingZeros = 0
  for (let i = 0; i < hash.length; i++) {
    const byte = hash[i]
    if (byte < 64) leadingZeros++
    if (byte < 16) leadingZeros++
    if (byte < 4) leadingZeros++
    if (byte === 0) {
      leadingZeros++
    } else {
      break
    }
  }
  return leadingZeros
}

function countPrefixLen(a, b) {
  let i
  for (i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) break
  }
  return i
}

// ---------- Leaf ----------

export class Leaf {
  constructor(key, value) {
    this.key = key
    this.value = value
  }
  isLeaf() {
    return true
  }
  isTree() {
    return false
  }
}

// ---------- MST ----------

export class MST {
  /**
   * @param {Map<string, Uint8Array>} blockstore - cid -> raw CBOR bytes
   * @param {string|null} pointer - node CID
   * @param {Array<Leaf|MST>|null} entries - cached entries
   * @param {number|null} layer
   */
  constructor(blockstore, pointer, entries, layer) {
    this.blockstore = blockstore
    this.pointer = pointer
    this.entries = entries
    this.layer = layer
    this.outdatedPointer = false
  }

  isLeaf() {
    return false
  }

  isTree() {
    return true
  }

  static async create(blockstore, entries = [], layer = null) {
    const mst = new MST(blockstore, null, entries, layer)
    mst.outdatedPointer = true
    await mst.getPointer()
    return mst
  }

  static async fromData(blockstore, data) {
    const entries = await deserializeNodeData(blockstore, data)
    const cid = await computeCID(data)
    return new MST(blockstore, cid, entries, null)
  }

  static load(blockstore, cid) {
    return new MST(blockstore, cid, null, null)
  }

  // Immutability: never mutate, return new MST
  newTree(entries) {
    const mst = new MST(this.blockstore, this.pointer, entries, this.layer)
    mst.outdatedPointer = true
    return mst
  }

  async getEntries() {
    if (this.entries) return [...this.entries]
    if (this.pointer) {
      const data = await readObj(this.blockstore, this.pointer)
      const firstLeaf = data.e[0]
      const layer =
        firstLeaf !== undefined
          ? await leadingZerosOnHash(firstLeaf.k)
          : undefined
      this.entries = await deserializeNodeData(this.blockstore, data, layer)
      return this.entries
    }
    throw new Error('No entries or CID provided')
  }

  async getPointer() {
    if (!this.outdatedPointer) return this.pointer
    const { cid } = await this.serialize()
    this.pointer = cid
    this.outdatedPointer = false
    return this.pointer
  }

  async serialize() {
    let entries = await this.getEntries()
    const outdated = entries.filter((e) => e.isTree() && e.outdatedPointer)
    if (outdated.length > 0) {
      await Promise.all(outdated.map((e) => e.getPointer()))
      entries = await this.getEntries()
    }
    const data = serializeNodeData(entries)
    const cid = await computeCID(data)
    const bytes = cborEncode(data)
    return { cid, bytes }
  }

  async getLayer() {
    this.layer = await this.attemptGetLayer()
    if (this.layer === null) this.layer = 0
    return this.layer
  }

  async attemptGetLayer() {
    if (this.layer !== null) return this.layer
    const entries = await this.getEntries()
    const firstLeaf = entries.find((entry) => entry.isLeaf())
    let layer = firstLeaf ? await leadingZerosOnHash(firstLeaf.key) : null
    if (layer === null) {
      for (const entry of entries) {
        if (entry.isTree()) {
          const childLayer = await entry.attemptGetLayer()
          if (childLayer !== null) {
            layer = childLayer + 1
            break
          }
        }
      }
    }
    return layer
  }

  // ---------- Core ops ----------

  async add(key, value, knownZeros) {
    const keyZeros = knownZeros ?? (await leadingZerosOnHash(key))
    const layer = await this.getLayer()
    const newLeaf = new Leaf(key, value)

    if (keyZeros === layer) {
      // belongs in this layer
      const index = await this.findGtOrEqualLeafIndex(key)
      const found = await this.atIndex(index)
      if (found?.isLeaf() && found.key === key) {
        throw new Error(`There is already a value at key: ${key}`)
      }
      const prevNode = await this.atIndex(index - 1)
      if (!prevNode || prevNode.isLeaf()) {
        return this.spliceIn(newLeaf, index)
      } else {
        const splitSubTree = await prevNode.splitAround(key)
        return this.replaceWithSplit(
          index - 1,
          splitSubTree[0],
          newLeaf,
          splitSubTree[1],
        )
      }
    } else if (keyZeros < layer) {
      // belongs on a lower layer
      const index = await this.findGtOrEqualLeafIndex(key)
      const prevNode = await this.atIndex(index - 1)
      if (prevNode && prevNode.isTree()) {
        const newSubtree = await prevNode.add(key, value, keyZeros)
        return this.updateEntry(index - 1, newSubtree)
      } else {
        const subTree = await this.createChild()
        const newSubTree = await subTree.add(key, value, keyZeros)
        return this.spliceIn(newSubTree, index)
      }
    } else {
      // belongs on a higher layer, push rest of tree down
      const split = await this.splitAround(key)
      let left = split[0]
      let right = split[1]
      const extraLayersToAdd = keyZeros - layer
      for (let i = 1; i < extraLayersToAdd; i++) {
        if (left !== null) left = await left.createParent()
        if (right !== null) right = await right.createParent()
      }
      const updated = []
      if (left) updated.push(left)
      updated.push(new Leaf(key, value))
      if (right) updated.push(right)
      const newRoot = await MST.create(this.blockstore, updated, keyZeros)
      newRoot.outdatedPointer = true
      return newRoot
    }
  }

  async get(key) {
    const index = await this.findGtOrEqualLeafIndex(key)
    const found = await this.atIndex(index)
    if (found && found.isLeaf() && found.key === key) {
      return found.value
    }
    const prev = await this.atIndex(index - 1)
    if (prev && prev.isTree()) {
      return prev.get(key)
    }
    return null
  }

  async update(key, value) {
    const index = await this.findGtOrEqualLeafIndex(key)
    const found = await this.atIndex(index)
    if (found && found.isLeaf() && found.key === key) {
      return this.updateEntry(index, new Leaf(key, value))
    }
    const prev = await this.atIndex(index - 1)
    if (prev && prev.isTree()) {
      const updatedTree = await prev.update(key, value)
      return this.updateEntry(index - 1, updatedTree)
    }
    throw new Error(`Could not find a record with key: ${key}`)
  }

  async delete(key) {
    const altered = await this.deleteRecurse(key)
    return altered.trimTop()
  }

  async deleteRecurse(key) {
    const index = await this.findGtOrEqualLeafIndex(key)
    const found = await this.atIndex(index)
    if (found?.isLeaf() && found.key === key) {
      const prev = await this.atIndex(index - 1)
      const next = await this.atIndex(index + 1)
      if (prev?.isTree() && next?.isTree()) {
        const merged = await prev.appendMerge(next)
        return this.newTree([
          ...(await this.slice(0, index - 1)),
          merged,
          ...(await this.slice(index + 2)),
        ])
      } else {
        return this.removeEntry(index)
      }
    }
    const prev = await this.atIndex(index - 1)
    if (prev?.isTree()) {
      const subtree = await prev.deleteRecurse(key)
      const subTreeEntries = await subtree.getEntries()
      if (subTreeEntries.length === 0) {
        return this.removeEntry(index - 1)
      } else {
        return this.updateEntry(index - 1, subtree)
      }
    } else {
      throw new Error(`Could not find a record with key: ${key}`)
    }
  }

  // ---------- Entry ops ----------

  async updateEntry(index, entry) {
    const update = [
      ...(await this.slice(0, index)),
      entry,
      ...(await this.slice(index + 1)),
    ]
    return this.newTree(update)
  }

  async removeEntry(index) {
    const updated = [
      ...(await this.slice(0, index)),
      ...(await this.slice(index + 1)),
    ]
    return this.newTree(updated)
  }

  async append(entry) {
    const entries = await this.getEntries()
    return this.newTree([...entries, entry])
  }

  async prepend(entry) {
    const entries = await this.getEntries()
    return this.newTree([entry, ...entries])
  }

  async atIndex(index) {
    const entries = await this.getEntries()
    return entries[index] ?? null
  }

  async slice(start, end) {
    const entries = await this.getEntries()
    return entries.slice(start, end)
  }

  async spliceIn(entry, index) {
    const update = [
      ...(await this.slice(0, index)),
      entry,
      ...(await this.slice(index)),
    ]
    return this.newTree(update)
  }

  async replaceWithSplit(index, left, leaf, right) {
    const update = await this.slice(0, index)
    if (left) update.push(left)
    update.push(leaf)
    if (right) update.push(right)
    update.push(...(await this.slice(index + 1)))
    return this.newTree(update)
  }

  async trimTop() {
    const entries = await this.getEntries()
    if (entries.length === 1 && entries[0].isTree()) {
      return entries[0].trimTop()
    }
    return this
  }

  async splitAround(key) {
    const index = await this.findGtOrEqualLeafIndex(key)
    const leftData = await this.slice(0, index)
    const rightData = await this.slice(index)
    let left = await this.newTree(leftData)
    let right = await this.newTree(rightData)

    const lastInLeft = leftData[leftData.length - 1]
    if (lastInLeft?.isTree()) {
      left = await left.removeEntry(leftData.length - 1)
      const split = await lastInLeft.splitAround(key)
      if (split[0]) {
        left = await left.append(split[0])
      }
      if (split[1]) {
        right = await right.prepend(split[1])
      }
    }

    return [
      (await left.getEntries()).length > 0 ? left : null,
      (await right.getEntries()).length > 0 ? right : null,
    ]
  }

  async appendMerge(toMerge) {
    if ((await this.getLayer()) !== (await toMerge.getLayer())) {
      throw new Error('Trying to merge two nodes from different layers of the MST')
    }
    const thisEntries = await this.getEntries()
    const toMergeEntries = await toMerge.getEntries()
    const lastInLeft = thisEntries[thisEntries.length - 1]
    const firstInRight = toMergeEntries[0]
    if (lastInLeft?.isTree() && firstInRight?.isTree()) {
      const merged = await lastInLeft.appendMerge(firstInRight)
      return this.newTree([
        ...thisEntries.slice(0, thisEntries.length - 1),
        merged,
        ...toMergeEntries.slice(1),
      ])
    } else {
      return this.newTree([...thisEntries, ...toMergeEntries])
    }
  }

  async createChild() {
    const layer = await this.getLayer()
    return MST.create(this.blockstore, [], layer - 1)
  }

  async createParent() {
    const layer = await this.getLayer()
    const parent = await MST.create(this.blockstore, [this], layer + 1)
    parent.outdatedPointer = true
    return parent
  }

  async findGtOrEqualLeafIndex(key) {
    const entries = await this.getEntries()
    const maybeIndex = entries.findIndex(
      (entry) => entry.isLeaf() && entry.key >= key,
    )
    return maybeIndex >= 0 ? maybeIndex : entries.length
  }

  // ---------- Traversal ----------

  async *walk() {
    yield this
    const entries = await this.getEntries()
    for (const entry of entries) {
      if (entry.isTree()) {
        for await (const e of entry.walk()) {
          yield e
        }
      } else {
        yield entry
      }
    }
  }

  async leaves() {
    const leaves = []
    for await (const entry of this.walk()) {
      if (entry.isLeaf()) leaves.push(entry)
    }
    return leaves
  }

  /**
   * Collect all node blocks that need to be persisted for this tree.
   * Returns { root: string, blocks: Map<cid, Uint8Array> }
   */
  async getUnstoredBlocks() {
    const blocks = new Map()
    const pointer = await this.getPointer()
    if (this.blockstore.has(pointer)) {
      return { root: pointer, blocks }
    }
    const entries = await this.getEntries()
    const data = serializeNodeData(entries)
    blocks.set(pointer, cborEncode(data))
    for (const entry of entries) {
      if (entry.isTree()) {
        const subtree = await entry.getUnstoredBlocks()
        for (const [cid, bytes] of subtree.blocks) {
          blocks.set(cid, bytes)
        }
      }
    }
    return { root: pointer, blocks }
  }
}

// ---------- Serialization ----------

export function serializeNodeData(entries) {
  const data = { l: null, e: [] }
  let i = 0
  if (entries[0]?.isTree()) {
    i++
    data.l = { $link: entries[0].pointer }
  }
  let lastKey = ''
  while (i < entries.length) {
    const leaf = entries[i]
    const next = entries[i + 1]
    if (!leaf.isLeaf()) {
      throw new Error('Not a valid node: two subtrees next to each other')
    }
    i++
    let subtree = null
    if (next?.isTree()) {
      subtree = { $link: next.pointer }
      i++
    }
    const prefixLen = countPrefixLen(lastKey, leaf.key)
    data.e.push({
      p: prefixLen,
      k: new TextEncoder().encode(leaf.key.slice(prefixLen)),
      v: { $link: leaf.value },
      t: subtree,
    })
    lastKey = leaf.key
  }
  return data
}

export async function deserializeNodeData(blockstore, data, layer) {
  const entries = []
  if (data.l !== null && data.l !== undefined) {
    entries.push(MST.load(blockstore, data.l.$link ?? data.l))
  }
  let lastKey = ''
  for (const entry of data.e) {
    const keyStr = entry.k instanceof Uint8Array
      ? new TextDecoder().decode(entry.k)
      : entry.k
    const key = lastKey.slice(0, entry.p) + keyStr
    const value = entry.v && entry.v.$link ? entry.v.$link : entry.v
    entries.push(new Leaf(key, value))
    lastKey = key
    if (entry.t !== null && entry.t !== undefined) {
      entries.push(MST.load(blockstore, entry.t.$link ?? entry.t))
    }
  }
  return entries
}

// ---------- Blockstore helpers ----------

export function readObj(blockstore, cid) {
  const bytes = blockstore.get(cid)
  if (!bytes) {
    throw new Error(`Missing block: ${cid}`)
  }
  // Decode CBOR manually: our cborDecode expects Uint8Array.
  // We store raw CBOR bytes in the blockstore; decode via computeCID? No -
  // use a minimal CBOR decode for MST node data ({l, e:[{p,k,v,t}]}).
  return decodeNodeData(bytes)
}

/**
 * Minimal CBOR decoder for MST node data.
 * Node data shape: { l: cid|null, e: [{p:int, k:bytes, v:cid, t:cid|null}] }
 * cid values are encoded as tag 42 ($link).
 */
export function decodeNodeData(bytes) {
  let pos = 0

  function readUint() {
    const b = bytes[pos++]
    const major = b >> 5
    const add = b & 0x1f
    if (add < 24) return add
    if (add === 24) return bytes[pos++]
    if (add === 25) {
      const v = (bytes[pos] << 8) | bytes[pos + 1]
      pos += 2
      return v
    }
    if (add === 26) {
      let v = 0
      for (let i = 0; i < 4; i++) v = v * 256 + bytes[pos++]
      return v
    }
    if (add === 27) {
      let v = 0n
      for (let i = 0; i < 8; i++) v = v * 256n + BigInt(bytes[pos++])
      return Number(v)
    }
    throw new Error(`Unsupported uint additional: ${add}`)
  }

  function readBytes(len) {
    const v = bytes.slice(pos, pos + len)
    pos += len
    return v
  }

  function readString() {
    const b = bytes[pos++]
    const major = b >> 5
    const add = b & 0x1f
    let len = add
    if (add === 24) len = bytes[pos++]
    else if (add === 25) {
      len = (bytes[pos] << 8) | bytes[pos + 1]
      pos += 2
    }
    if (major === 3) {
      const v = readBytes(len)
      return new TextDecoder().decode(v)
    }
    if (major === 2) {
      return readBytes(len)
    }
    throw new Error(`Expected string/bytes, got major ${major}`)
  }

  function readTag42() {
    // tag 42 is encoded as 0xd8 0x2a (major 6, add 24, then value 42)
    // followed by a byte string (major 2) containing 1-byte prefix 0x00 + 36-byte CID
    if (bytes[pos] !== 0xd8 || bytes[pos + 1] !== 0x2a) {
      throw new Error('Expected CBOR tag 42 for CID')
    }
    pos += 2
    const lenHeader = bytes[pos]
    const lenMajor = lenHeader >> 5
    let lenAdd = lenHeader & 0x1f
    pos++
    if (lenMajor !== 2) {
      throw new Error(`Expected byte string after tag 42, got major ${lenMajor}`)
    }
    let len = lenAdd
    if (lenAdd === 24) { len = bytes[pos]; pos++ }
    else if (lenAdd === 25) { len = (bytes[pos] << 8) | bytes[pos + 1]; pos += 2 }
    if (len !== 37) {
      throw new Error(`Unexpected CID bytes length: ${len}`)
    }
    const prefix = bytes[pos]
    if (prefix !== 0x00) {
      throw new Error(`Unexpected CID prefix: ${prefix}`)
    }
    pos++
    const cidBytes = readBytes(36)
    return cidBytesToStr(cidBytes)
  }

  function readValue() {
    const b = bytes[pos]
    const major = b >> 5
    const add = b & 0x1f

    if (major === 0) return readUint()
    if (major === 1) return -1 - readUint()
    if (major === 2) {
      pos++
      let len = add
      if (add === 24) { len = bytes[pos]; pos++ }
      else if (add === 25) { len = (bytes[pos] << 8) | bytes[pos + 1]; pos += 2 }
      return readBytes(len)
    }
    if (major === 3) {
      return readString()
    }
    if (major === 4) {
      pos++
      let len = add
      if (add === 24) { len = bytes[pos]; pos++ }
      else if (add === 25) { len = (bytes[pos] << 8) | bytes[pos + 1]; pos += 2 }
      const arr = []
      for (let i = 0; i < len; i++) arr.push(readValue())
      return arr
    }    if (major === 5) {
      pos++
      let len = add
      if (add === 24) { len = bytes[pos]; pos++ }
      else if (add === 25) { len = (bytes[pos] << 8) | bytes[pos + 1]; pos += 2 }
      const obj = {}
      for (let i = 0; i < len; i++) {
        const k = readValue()
        obj[k] = readValue()
      }
      return obj
    }
    if (major === 6) {
      // tag - only 42 ($link) is used in MST node data
      if (b === 0xd8 && bytes[pos + 1] === 0x2a) {
        return readTag42()
      }
      throw new Error(`Unsupported CBOR tag: ${b}`)
    }
    if (major === 7) {
      pos++
      if (add === 22 || add === 23) return null
      if (add === 20) return false
      if (add === 21) return true
      throw new Error(`Unsupported simple value: ${add}`)
    }
    throw new Error(`Unsupported major type: ${major}`)
  }

  const result = readValue()
  return result
}

function cidBytesToStr(cidBytes) {
  // CID bytes: version(1) + codec(2) + hashAlg(2) + hashLen(1) + hash(32)
  // -> base32lower multibase 'b' prefix
  return 'b' + base32Encode(cidBytes)
}
