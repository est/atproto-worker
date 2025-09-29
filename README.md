# atproto-worker
serverless worker that map your static JSON in a git to atproto/bsky with wss/xrpc

## why

[`atproto`](https://atproto.com) is a generic protocol trying to solve social network data portability problem with PDS, `did:plc` and `Repo`      

bsky.social is the inventor company that runs microblogging service on top of `atproto`

bsky.app is the largest `AppView` that renders bsky.social data with a preference.

You can host your data on bsky.social by signup an account there

The official [self-host](https://atproto.com/guides/self-hosting) is quite lengthy and heavyweight, like setup a Wordpress blog with LAMP

Why not save your own data in a `git` repo, like a static generated site, like Github Pages?   

Coincidentally, both atproto and git are basically Merkle Search Tree anyway.

Since .git is static, then the missing piece is

 - how to publish to atproto/bsky network
 - receive interactions (likes, comments, reposts, etc)

Cloudflare have tried this in July 2025   
https://blog.cloudflare.com/serverless-atproto/

It's written in Rust and the build time took a whooping 6m22s and the statusphere demo failed to work.     
HOW HARD COULD THIS BE? Lets reinvent the wheel.

## overview

```mermaid
flowchart LR
    G[git repo] -->|git actions| W(atproto-worker)
    W --> |change events| A(app)
    A --> |write updates| W
    W --> |git comimt| G
    A <--> |interactions| E(Audience)
```

## ToDo

- [ ] the actual code
