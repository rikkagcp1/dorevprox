import { WebSocketStreamLike, WebSocketCloseInfoLike } from "./wsstream";
import { Logger, newPromiseWithHandle, safeCloseWebSocket } from "./utils";
import { connect } from "cloudflare:sockets";

/**
 * This interface defines a duplex stream that can be considered as
 * the base class of the Cloudflare socket connection：
 * ```ts
 * import { connect } from "cloudflare:sockets";
 * ```
 */
export interface DuplexStream {
	get readable(): ReadableStream<Uint8Array>,
	get writable(): WritableStream<Uint8Array>,

	/**
	 * A Promise that resolves when the connection closes.
	 * May reject in case of abnormal termination (e.g. network error).
	 */
	get closed(): Promise<any>,

	/**
	 * Actively close the connection.
	 */
	get close(): (reason?: any)=>void,
}

export async function DuplexStreamFromWsStream(websocketStream: WebSocketStreamLike): Promise<DuplexStream> {
	const opened = await websocketStream.opened;

	return {
		readable: opened.readable as unknown as ReadableStream<Uint8Array>,
		writable: opened.writable as unknown as WritableStream<Uint8Array>,
		closed: websocketStream.closed,
		close: websocketStream.close,
	};
}

export function DuplexStreamFromWs(webSocket: WebSocket, earlyData: Uint8Array, log: Logger): DuplexStream {
	let downStreamRequestClose = false;
	let upStreamRequestClose = false;

	const {
		resolve: onWsNormalClose,
		reject: onWsUncleanClose,
		promise: closedPromise,
	} = newPromiseWithHandle<WebSocketCloseInfoLike>();

	const readable = new ReadableStream<Uint8Array>({
		start(controller) {
			if (earlyData && earlyData.byteLength > 0) {
				controller.enqueue(earlyData);
			}
			
			webSocket.addEventListener("message", (event) => {
				if (downStreamRequestClose || upStreamRequestClose) {
					return;
				}

				// Make sure that we use Uint8Array through out the process.
				// On Nodejs, event.data can be a Buffer or an ArrayBuffer
				// On Cloudflare Workers, event.data tend to be an ArrayBuffer
				controller.enqueue(new Uint8Array(event.data));
			});

			// The event means that the client closed the client -> server stream.
			// However, the server -> client stream is still open until you call close() on the server side.
			// The WebSocket protocol says that a separate close message must be sent in each direction to fully close the socket.
			webSocket.addEventListener("close", (event) => {
				if (downStreamRequestClose) {
					log("info", "websocket", "duplex peer wants to close");
				} else {
					log("info", "websocket", "websocket peer wants to close");
					upStreamRequestClose = true;
				}

				onWsNormalClose({code: event.code, reason: event.reason});
				controller.close();
			});

			webSocket.addEventListener("error", (event) => {
				onWsUncleanClose(event.error);
				controller.error(event);
			});
		},
		pull(controller) {
			// if ws can stop read if stream is full, we can implement backpressure
			// https://streams.spec.whatwg.org/#example-rs-push-backpressure
		},
		cancel(reason) {
			log("error", "websocket", `ReadableStream was canceled, due to ${reason}`)
			safeCloseWebSocket(webSocket);
		}
	});

	const writable = new WritableStream<Uint8Array>({
		write: (chunk) => webSocket.send(chunk),
		close: () => {
			if (upStreamRequestClose) {
				log("info", "ws", "duplex peer closed");
				onWsNormalClose({code: 1000});
			} else {
				downStreamRequestClose = true;
			}

			// https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API/Using_WebSocketStream#closing_the_connection
			// Closing the underlying WritableStream or WritableStreamDefaultWriter also closes the connection.
			safeCloseWebSocket(webSocket);
		},
		abort(reason) {
			if (upStreamRequestClose) {
				log("info", "ws", "duplex peer aborted");
			} else {
				downStreamRequestClose = true;
			}

			try {
				webSocket.close(1006, reason);
			} catch {}
		},
	});

	// closedPromise.then((info) => {
	// 	log("info", "websocket", `closed normally with code: ${info.code}, reason: ${info.reason}`);
	// });

	// closedPromise.catch((error) => {
	// 	log("error", "websocket", "closed with error:", error);
	// });

	return {
		readable,
		writable,
		close: () => {
			safeCloseWebSocket(webSocket);
		},
		closed: closedPromise,
	}
}

export async function DuplexStreamOfTcp(hostname: string, port: number) : Promise<DuplexStream> {
	let downStreamRequestClose = false;
	let upStreamRequestClose = false;

	const socket = connect({hostname, port}, {allowHalfOpen: true});
	await socket.opened;

	const writer = socket.writable.getWriter();
	writer.closed.finally(async () => {
		writer.releaseLock();
		if (downStreamRequestClose) {
			socket.close();
		} else {
			upStreamRequestClose = true;
		}
	});

	const writable = new WritableStream<Uint8Array>({
		write: async (chunk, controller) => {
			await writer.ready;
			writer.write(chunk);
		},

		// When the remote pair starts the close handshake,
		// Make sure we explicitly call `tcpSocket.close()` after `tcpSocket.writable` closes(unlocked).
		close: async () => {
			await writer.close();
		},
		abort: async (reason) => {
			await writer.abort(reason);
		},
	});

	const downStream = new TransformStream<Uint8Array, Uint8Array>();
	socket.readable.pipeTo(downStream.writable)
		.catch(() => {})
		.finally(() => {
			if (!upStreamRequestClose) {
				downStreamRequestClose = true;
			}
		});

	return {
		readable: downStream.readable,
		writable: writable,
		closed: socket.closed,
		close: () => socket.close().catch(() => {}),
	};
}
