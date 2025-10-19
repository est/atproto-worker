/**
 * atproto-worker
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */
import { ExecutionContext, KVNamespace, ScheduledController, WebSocket } from '@cloudflare/workers-types';
import {} from '@atproto/common-web';
import { Decoder } from 'cbor-x';

export interface Env {
	ATPROTO_KV: KVNamespace;
}

export default {
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		const subscribedDids = (await env.ATPROTO_KV.get('subscribed_dids', 'json')) as string[];
		if (!subscribedDids) {
			console.log('No subscribed DIDs found');
			return;
		}

		const cursor = await env.ATPROTO_KV.get('cursor');
		const url = `wss://bsky.social/xrpc/com.atproto.sync.subscribeRepos${cursor ? `?cursor=${cursor}` : ''}`;
		const firehose = new WebSocket(url);
		const decoder = new Decoder();

		firehose.addEventListener('message', async (event) => {
			try {
				const message = decoder.decode(event.data);

				if (message.repo && subscribedDids.includes(message.repo)) {
					// Process the message
					console.log(message);
				}

				if (message.seq) {
					await env.ATPROTO_KV.put('cursor', message.seq.toString());
				}
			} catch (err) {
				console.error('Failed to decode message', err);
			}
		});

		firehose.addEventListener('error', (err) => {
			console.error('Firehose error', err);
		});

		firehose.addEventListener('close', () => {
			console.log('Firehose connection closed');
		});
	},
};
