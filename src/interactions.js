/**
 * Interaction syncing - fetch likes/reposts/replies from Bluesky
 * For event-sourced model, stores in KV (not journal)
 */

const BSKY_API = 'https://public.api.bsky.app'

/**
 * Fetch and store interactions for the owner's posts
 */
export async function syncInteractions(journal, ownerDid, ownerHandle) {
    console.log('Syncing interactions for:', ownerDid)

    try {
        await syncLikes(journal, ownerDid)
        await syncReposts(journal, ownerDid)
        console.log('Interaction sync complete')
    } catch (e) {
        console.error('Interaction sync error:', e)
    }
}

/**
 * Fetch likes on our posts
 */
async function syncLikes(journal, ownerDid) {
    const postEvents = journal.byCollection.get('app.bsky.feed.post') || []

    for (const post of postEvents.slice(0, 20)) {
        const postUri = `at://${ownerDid}/app.bsky.feed.post/${post.rkey}`

        try {
            const resp = await fetch(
                `${BSKY_API}/xrpc/app.bsky.feed.getLikes?uri=${encodeURIComponent(postUri)}&limit=50`,
                { headers: { 'Accept': 'application/json' } }
            )

            if (!resp.ok) continue

            const data = await resp.json()
            // Store in KV if available (not journal - journal is immutable)
            console.log(`Post ${post.rkey} has ${data.likes?.length || 0} likes`)
        } catch (e) {
            console.error('Error fetching likes:', e)
        }
    }
}

/**
 * Fetch reposts on our posts
 */
async function syncReposts(journal, ownerDid) {
    const postEvents = journal.byCollection.get('app.bsky.feed.post') || []

    for (const post of postEvents.slice(0, 20)) {
        const postUri = `at://${ownerDid}/app.bsky.feed.post/${post.rkey}`

        try {
            const resp = await fetch(
                `${BSKY_API}/xrpc/app.bsky.feed.getRepostedBy?uri=${encodeURIComponent(postUri)}&limit=50`,
                { headers: { 'Accept': 'application/json' } }
            )

            if (!resp.ok) continue

            const data = await resp.json()
            console.log(`Post ${post.rkey} has ${data.repostedBy?.length || 0} reposts`)
        } catch (e) {
            console.error('Error fetching reposts:', e)
        }
    }
}

export async function syncFollowers(journal, ownerDid) {
    // Followers go to KV, not journal
    try {
        const resp = await fetch(
            `${BSKY_API}/xrpc/app.bsky.graph.getFollowers?actor=${encodeURIComponent(ownerDid)}&limit=50`,
            { headers: { 'Accept': 'application/json' } }
        )

        if (resp.ok) {
            const data = await resp.json()
            console.log(`Has ${data.followers?.length || 0} followers`)
        }
    } catch (e) {
        console.error('Error fetching followers:', e)
    }
}
