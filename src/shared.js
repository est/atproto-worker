/**
 * Shared utilities for ATProto - used by both Worker and CLI
 * No Node.js-specific imports (pure Web Crypto / BigInt)
 */

// ============ TID Generation ============

const B32_SORTISH = '234567abcdefghijklmnopqrstuvwxyz'
let lastTimestamp = 0
let clockSeq = 0

export function generateTID() {
  let timestamp = Date.now() * 1000 // microseconds

  if (timestamp === lastTimestamp) {
    clockSeq++
  } else {
    lastTimestamp = timestamp
    clockSeq = 0
  }

  const combined = BigInt(timestamp) << 10n | BigInt(clockSeq & 0x3ff)

  let tid = ''
  let n = combined
  for (let i = 0; i < 13; i++) {
    tid = B32_SORTISH[Number(n & 31n)] + tid
    n >>= 5n
  }

  return tid
}

// ============ Base32 (RFC 4648 lowercase) ============

const B32_LOWER = 'abcdefghijklmnopqrstuvwxyz234567'

export function base32Encode(bytes) {
  let result = ''
  let bits = 0
  let value = 0

  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8

    while (bits >= 5) {
      bits -= 5
      result += B32_LOWER[(value >> bits) & 31]
    }
  }

  if (bits > 0) {
    result += B32_LOWER[(value << (5 - bits)) & 31]
  }

  return result
}

export function base32Decode(str) {
  const result = []
  let bits = 0
  let value = 0

  for (const char of str.toLowerCase()) {
    const idx = B32_LOWER.indexOf(char)
    if (idx === -1) continue

    value = (value << 5) | idx
    bits += 5

    if (bits >= 8) {
      bits -= 8
      result.push((value >> bits) & 0xff)
    }
  }

  return new Uint8Array(result)
}

// ============ CID ============

export function cidToBytes(cidStr) {
  if (cidStr.startsWith('b')) {
    return base32Decode(cidStr.slice(1))
  }
  throw new Error('Unsupported CID format: ' + cidStr)
}

export async function computeCID(value) {
  const cbor = cborEncode(value)
  const hash = await crypto.subtle.digest('SHA-256', cbor)

  // CID v1: version(1) + codec(dag-cbor=0x71) + hash-type(sha256=0x12) + hash-len(32) + hash
  const cid = new Uint8Array(2 + 2 + 32)
  cid[0] = 0x01
  cid[1] = 0x71
  cid[2] = 0x12
  cid[3] = 0x20
  cid.set(new Uint8Array(hash), 4)

  return 'b' + base32Encode(cid)
}

// ============ CBOR (canonical, supports $link tag 42) ============

export function cborEncode(value) {
  const chunks = []

  function encode(val) {
    if (val === null || val === undefined) {
      chunks.push(new Uint8Array([0xf6]))
    } else if (typeof val === 'boolean') {
      chunks.push(new Uint8Array([val ? 0xf5 : 0xf4]))
    } else if (typeof val === 'number') {
      if (Number.isInteger(val)) {
        if (val >= 0) {
          encodeUint(0, val)
        } else {
          encodeUint(1, -1 - val)
        }
      } else {
        const buf = new ArrayBuffer(9)
        const view = new DataView(buf)
        view.setUint8(0, 0xfb)
        view.setFloat64(1, val, false)
        chunks.push(new Uint8Array(buf))
      }
    } else if (typeof val === 'string') {
      const bytes = new TextEncoder().encode(val)
      encodeUint(3, bytes.length)
      chunks.push(bytes)
    } else if (val instanceof Uint8Array) {
      encodeUint(2, val.length)
      chunks.push(val)
    } else if (Array.isArray(val)) {
      encodeUint(4, val.length)
      for (const item of val) encode(item)
    } else if (typeof val === 'object') {
      // CBOR tag 42 for CID links
      if (val.$link) {
        chunks.push(new Uint8Array([0xd8, 0x2a]))
        const cidBytes = cidToBytes(val.$link)
        encodeUint(2, cidBytes.length + 1)
        chunks.push(new Uint8Array([0x00]))
        chunks.push(cidBytes)
      } else {
        const keys = Object.keys(val).sort((a, b) => {
          if (a.length !== b.length) return a.length - b.length
          return a < b ? -1 : 1
        })
        encodeUint(5, keys.length)
        for (const key of keys) {
          encode(key)
          encode(val[key])
        }
      }
    }
  }

  function encodeUint(major, n) {
    if (n < 24) {
      chunks.push(new Uint8Array([(major << 5) | n]))
    } else if (n < 256) {
      chunks.push(new Uint8Array([(major << 5) | 24, n]))
    } else if (n < 65536) {
      const buf = new Uint8Array(3)
      buf[0] = (major << 5) | 25
      buf[1] = n >> 8
      buf[2] = n & 0xff
      chunks.push(buf)
    } else if (n < 4294967296) {
      const buf = new Uint8Array(5)
      buf[0] = (major << 5) | 26
      new DataView(buf.buffer).setUint32(1, n, false)
      chunks.push(buf)
    } else {
      const buf = new Uint8Array(9)
      buf[0] = (major << 5) | 27
      new DataView(buf.buffer).setBigUint64(1, BigInt(n), false)
      chunks.push(buf)
    }
  }

  encode(value)

  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }

  return result
}

export function cborDecode(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    bytes = new Uint8Array(bytes)
  }

  let pos = 0

  function decode() {
    if (pos >= bytes.length) throw new Error('Unexpected end of CBOR data')

    const initial = bytes[pos++]
    const major = initial >> 5
    const additional = initial & 0x1f

    let value = readUint(additional)

    switch (major) {
      case 0: return value
      case 1: return -1 - value
      case 2: {
        const result = bytes.slice(pos, pos + value)
        pos += value
        return result
      }
      case 3: {
        const result = new TextDecoder().decode(bytes.slice(pos, pos + value))
        pos += value
        return result
      }
      case 4: {
        const arr = []
        for (let i = 0; i < value; i++) arr.push(decode())
        return arr
      }
      case 5: {
        const obj = {}
        for (let i = 0; i < value; i++) {
          const key = decode()
          obj[key] = decode()
        }
        return obj
      }
      case 7:
        if (additional === 20) return false
        if (additional === 21) return true
        if (additional === 22) return null
        if (additional === 23) return undefined
        if (additional === 25) { pos += 2; return 0 }
        if (additional === 26) {
          const view = new DataView(bytes.buffer, bytes.byteOffset + pos, 4)
          pos += 4
          return view.getFloat32(0, false)
        }
        if (additional === 27) {
          const view = new DataView(bytes.buffer, bytes.byteOffset + pos, 8)
          pos += 8
          return view.getFloat64(0, false)
        }
        throw new Error(`Unknown simple value: ${additional}`)
      default:
        throw new Error(`Unknown CBOR major type: ${major}`)
    }
  }

  function readUint(additional) {
    if (additional < 24) return additional
    if (additional === 24) return bytes[pos++]
    if (additional === 25) {
      const val = (bytes[pos] << 8) | bytes[pos + 1]
      pos += 2
      return val
    }
    if (additional === 26) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + pos, 4)
      pos += 4
      return view.getUint32(0, false)
    }
    if (additional === 27) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + pos, 8)
      pos += 8
      return Number(view.getBigUint64(0, false))
    }
    throw new Error(`Invalid additional value: ${additional}`)
  }

  return decode()
}

// ============ Varint ============

export function encodeVarint(n) {
  const bytes = []
  while (n > 0x7f) {
    bytes.push((n & 0x7f) | 0x80)
    n >>>= 7
  }
  bytes.push(n & 0x7f)
  return new Uint8Array(bytes)
}

// ============ CAR File ============

export function createCarFile(rootCid, blocks = []) {
  const parts = []

  const header = cborEncode({
    version: 1,
    roots: [{ $link: rootCid }]
  })
  parts.push(encodeVarint(header.length))
  parts.push(header)

  for (const block of blocks) {
    const cidBytes = cidToBytes(block.cid)
    const blockData = block.data instanceof Uint8Array ? block.data : cborEncode(block.data)

    parts.push(encodeVarint(cidBytes.length + blockData.length))
    parts.push(cidBytes)
    parts.push(blockData)
  }

  const totalLength = parts.reduce((sum, p) => sum + p.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }

  return result
}
