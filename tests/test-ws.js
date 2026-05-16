import WebSocket from 'ws'
import { cborDecode } from '../src/utils.js'

const ws = new WebSocket('ws://localhost:49879/xrpc/com.atproto.sync.subscribeRepos?cursor=-1')

ws.on('open', () => {
    console.log('Connected to firehose')
})

ws.on('message', (data) => {
    console.log('Received message, length:', data.length)
    try {
        const decoded = cborDecode(new Uint8Array(data))
        console.log('Decoded message type:', decoded.$type)
        console.log('Seq:', decoded.seq)
        console.log('Ops:', JSON.stringify(decoded.ops))
        process.exit(0)
    } catch (e) {
        console.error('Failed to decode CBOR:', e)
        process.exit(1)
    }
})

ws.on('error', (err) => {
    console.error('WS Error:', err)
    process.exit(1)
})

setTimeout(() => {
    console.log('Timeout waiting for message')
    process.exit(1)
}, 5000)
