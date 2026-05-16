goal: build in the `atproto-worker` dir that runs on Cloudflare Worker act like PDS (Personal Data Server) for atproto/bsky network

1. write personal "posts" to D1 database
2. users can host `atproto-worker` with their own domain handler for maximum indepency.
3. followers over atproto/bsky can subscribe updates through atprotcol (websocket)
4. user interactions are fetched periodically using http, and saved to D1 database.
5. Write in js, keep simplicity and readablity for human, also make it extendable.
6. the official implementation is under the `atproto` folder. 
7. Perfer a clean-house implementation of the protocol suitable for Cloudflare Worker if possible. Don't use too many external deps, avoid node_modules hell and keep the runtime fast.

