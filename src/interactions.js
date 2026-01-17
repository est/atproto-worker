/**
 * Interaction syncing - fetch likes/reposts/replies from Bluesky
 */

const BSKY_API = 'https://public.api.bsky.app'

/**
 * Fetch and store interactions for the owner's posts
 */
export async function syncInteractions(db, ownerDid, ownerHandle) {
    console.log('Syncing interactions for:', ownerDid)

    try {
        // Fetch recent likes on our posts
        await syncLikes(db, ownerDid)

        // Fetch recent reposts
        await syncReposts(db, ownerDid)

        // Fetch recent replies (notifications)
        await syncReplies(db, ownerDid, ownerHandle)

        console.log('Interaction sync complete')
    } catch (e) {
        console.error('Interaction sync error:', e)
    }
}

/**
 * Fetch likes on our posts via getActorLikes (limited to what's public)
 * Note: This fetches the author's feed and checks for interactions
 */
async function syncLikes(db, ownerDid) {
    // Get our recent posts
    const { records } = await db.listRecords('app.bsky.feed.post', { limit: 50 })

    for (const post of records) {
        const postUri = `at://${ownerDid}/app.bsky.feed.post/${post.rkey}`

        try {
            // Fetch likes for this post
            const resp = await fetch(
                `${BSKY_API}/xrpc/app.bsky.feed.getLikes?uri=${encodeURIComponent(postUri)}&limit=50`,
                { headers: { 'Accept': 'application/json' } }
            )

            if (!resp.ok) continue

            const data = await resp.json()

            for (const like of data.likes || []) {
                await db.saveInteraction({
                    uri: like.actor.did + '/like/' + Date.now(), // synthetic URI
                    type: 'like',
                    actorDid: like.actor.did,
                    actorHandle: like.actor.handle,
                    targetUri: postUri,
                    record: { indexedAt: like.indexedAt }
                })
            }
        } catch (e) {
            console.error('Error fetching likes for', postUri, e)
        }
    }
}

/**
 * Fetch reposts on our posts
 */
async function syncReposts(db, ownerDid) {
    const { records } = await db.listRecords('app.bsky.feed.post', { limit: 50 })

    for (const post of records) {
        const postUri = `at://${ownerDid}/app.bsky.feed.post/${post.rkey}`

        try {
            const resp = await fetch(
                `${BSKY_API}/xrpc/app.bsky.feed.getRepostedBy?uri=${encodeURIComponent(postUri)}&limit=50`,
                { headers: { 'Accept': 'application/json' } }
            )

            if (!resp.ok) continue

            const data = await resp.json()

            for (const actor of data.repostedBy || []) {
                await db.saveInteraction({
                    uri: actor.did + '/repost/' + Date.now(),
                    type: 'repost',
                    actorDid: actor.did,
                    actorHandle: actor.handle,
                    targetUri: postUri,
                    record: {}
                })
            }
        } catch (e) {
            console.error('Error fetching reposts for', postUri, e)
        }
    }
}

/**
 * Fetch replies via notifications or thread lookup
 */
async function syncReplies(db, ownerDid, ownerHandle) {
    const { records } = await db.listRecords('app.bsky.feed.post', { limit: 20 })

    for (const post of records) {
        const postUri = `at://${ownerDid}/app.bsky.feed.post/${post.rkey}`

        try {
            // Get thread to find replies
            const resp = await fetch(
                `${BSKY_API}/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(postUri)}&depth=1`,
                { headers: { 'Accept': 'application/json' } }
            )

            if (!resp.ok) continue

            const data = await resp.json()

            // Extract replies from thread
            const replies = data.thread?.replies || []

            for (const reply of replies) {
                if (reply.post) {
                    await db.saveInteraction({
                        uri: reply.post.uri,
                        type: 'reply',
                        actorDid: reply.post.author.did,
                        actorHandle: reply.post.author.handle,
                        targetUri: postUri,
                        record: {
                            text: reply.post.record?.text,
                            createdAt: reply.post.record?.createdAt
                        }
                    })
                }
            }
        } catch (e) {
            console.error('Error fetching replies for', postUri, e)
        }
    }
}

/**
 * Fetch follower count and new followers
 */
export async function syncFollowers(db, ownerDid) {
    try {
        const resp = await fetch(
            `${BSKY_API}/xrpc/app.bsky.graph.getFollowers?actor=${encodeURIComponent(ownerDid)}&limit=50`,
            { headers: { 'Accept': 'application/json' } }
        )

        if (!resp.ok) return

        const data = await resp.json()

        // Store follower information
        for (const follower of data.followers || []) {
            await db.saveInteraction({
                uri: `${follower.did}/follow/${ownerDid}`,
                type: 'follower',
                actorDid: follower.did,
                actorHandle: follower.handle,
                targetUri: ownerDid,
                record: {
                    displayName: follower.displayName,
                    avatar: follower.avatar,
                    indexedAt: follower.indexedAt
                }
            })
        }
    } catch (e) {
        console.error('Error fetching followers:', e)
    }
}
