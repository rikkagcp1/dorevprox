import { DurableObject } from "cloudflare:workers";
import * as vless from "./vless"
import * as utils from "./utils"
import * as wsstream from "./wsstream"

export function populateStatPage(portalLoad: number[]): string {
	const now = new Date().toISOString();

	const loads = (portalLoad ?? []).map(n =>
		Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0
	);

	const portalCount = loads.length;
	const totalConnections = loads.reduce((s, n) => s + n, 0);

	const lines: string[] = [];
	lines.push("Portal Status");
	lines.push("==============");
	lines.push(`Portals: ${portalCount}`);
	lines.push(`Total connections: ${totalConnections}`);
	lines.push(`Generated at: ${now}`);
	lines.push("");

	if (portalCount === 0) {
		lines.push("No portals found.");
	} else {
		lines.push("Per-portal load:");
		loads.forEach((cnt, idx) => {
			lines.push(`- Portal #${idx + 1}: ${cnt} connection${cnt === 1 ? "" : "s"}`);
		});
	}

	return lines.join("\n");
}


/**
 * Welcome to Cloudflare Workers! This is your first Durable Objects application.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your Durable Object in action
 * - Run `npm run deploy` to publish your application
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/durable-objects
 */
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const upgradeHeader = request.headers.get('Upgrade');
		if (request.method === 'GET') {
			if (upgradeHeader && upgradeHeader === 'websocket') {
				// Since we are hard coding the Durable Object ID by providing the constant name 'foo',
				// all requests to this Worker will be sent to the same Durable Object instance.
				const durableObj = env.WEBSOCKET_HIBERNATION_SERVER.getByName("foo");

				return durableObj.fetch(request);
			} else if (url.pathname === "/stats") {
				const durableObj = env.WEBSOCKET_HIBERNATION_SERVER.getByName("foo");

				return durableObj.statPage();
			}
		}

		return new Response(
			"Expects a WebSocket upgrade request",
			{
				status: 200,
				headers: {
					'Content-Type': 'text/plain',
				},
			}
		);
	},
};

interface WebSocketConnection {
	uuid: string,
	enqueueChunk: (chunk: Uint8Array) => void,
	onWsNormalClose: (closeInfo: wsstream.WebSocketCloseInfoLike) => void,
	onWsUncleanClose: (closeInfo: wsstream.WebSocketCloseInfoLike) => void,
}

// Durable Object
export class WebSocketHibernationServer extends DurableObject {
	// Keeps track of all WebSocket connections
	// When the DO hibernates, gets reconstructed in the constructor
	sessions: Map<WebSocket, WebSocketConnection>;
	vlessSharedContext = new vless.SharedContext();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sessions = new Map();

		// As part of constructing the Durable Object,
		// we wake up any hibernating WebSockets and
		// place them back in the `sessions` map.

		// Get all WebSocket connections from the DO
		/*
		this.ctx.getWebSockets().forEach((ws) => {
			let attachment = ws.deserializeAttachment();
			if (attachment) {
				// If we previously attached state to our WebSocket,
				// let's add it to `sessions` map to restore the state of the connection.
				this.sessions.set(ws, { ...attachment });
			}
		});
		*/

		// Sets an application level auto response that does not wake hibernated WebSockets.
		// this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
	}

	statPage() {
		const portalLoad = this.vlessSharedContext.getPortalLoad();
		return new Response(populateStatPage(portalLoad));
	}

	async fetch(request: Request): Promise<Response> {
		// Creates two ends of a WebSocket connection.
		const webSocketPair = new WebSocketPair();
		const [client, server] = Object.values(webSocketPair);

		// Calling `acceptWebSocket()` informs the runtime that this WebSocket is to begin terminating
		// request within the Durable Object. It has the effect of "accepting" the connection,
		// and allowing the WebSocket to send and receive messages.
		// Unlike `ws.accept()`, `this.ctx.acceptWebSocket(ws)` informs the Workers Runtime that the WebSocket
		// is "hibernatable", so the runtime does not need to pin this Durable Object to memory while
		// the connection is open. During periods of inactivity, the Durable Object can be evicted
		// from memory, but the WebSocket connection will remain open. If at some later point the
		// WebSocket receives a message, the runtime will recreate the Durable Object
		// (run the `constructor`) and deliver the message to the appropriate handler.
		this.ctx.acceptWebSocket(server);

		// Generate a random UUID for the session.
		const uuid = crypto.randomUUID();

		// Attach the session ID to the WebSocket connection and serialize it.
		// This is necessary to restore the state of the connection when the Durable Object wakes up.
		// server.serializeAttachment({ id });
		const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
		const earlyDataParseResult = utils.base64ToUint8Array(earlyDataHeader);
		if (!earlyDataParseResult.success) {
			return new Response(null, { status: 500 });
		}

		const {
			resolve: onWsNormalClose,
			reject: onWsUncleanClose,
			promise: closedPromise,
		} = utils.newPromiseWithHandle<wsstream.WebSocketCloseInfoLike>();

		const readable = new ReadableStream<Uint8Array>({
			start: (controller) => {
				if (earlyDataParseResult.data && earlyDataParseResult.data.byteLength > 0)
					controller.enqueue(earlyDataParseResult.data);

				const WebSocketConnection: WebSocketConnection = {
					uuid,
					enqueueChunk: (chunk) => controller.enqueue(chunk),
					onWsNormalClose,
					onWsUncleanClose,
				}
				// Add the WebSocket connection to the map of active sessions.
				closedPromise.finally(() => {
					controller.close();
					console.debug(`[WebSocketStream] closed`);
				});
				this.sessions.set(server, WebSocketConnection);
			},
			cancel: (reason) => {
				server.close();
			},
		});

		const writable = new WritableStream<Uint8Array>({
			write: (chunk) => server.send(chunk),
			close: () => server.close(),
			abort: () => server.close(),
		});

		const openInfo: wsstream.WebSocketOpenInfoLike = {
			protocol: "",
			extensions: "",
			readable,
			writable,
		};

		const websocketStream:wsstream.WebSocketStreamLike = {
			url: request.url,
			opened: Promise.resolve(openInfo),
			closed: closedPromise,
			close: ({ code, reason }: wsstream.WebSocketCloseInfoLike = {}) => server.close(code, reason)
		};

		await vless.handleVlessRequest(websocketStream, this.vlessSharedContext);

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
		// Get the session associated with the WebSocket connection.
		const session = this.sessions.get(ws)!;

		if (typeof message == "string") {
			message = new TextEncoder().encode(message);
		}

		session.enqueueChunk(new Uint8Array(message));
	}

	webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
		// Get the session associated with the WebSocket connection.
		const session = this.sessions.get(ws)!;

		if (wasClean) {
			session.onWsNormalClose({ code, reason });
		} else {
			session.onWsUncleanClose({ code, reason });
		}
		this.sessions.delete(ws);

		// If the client closes the connection, the runtime will invoke the webSocketClose() handler.
		// ws.close(code, 'Durable Object is closing WebSocket');
	}
}
