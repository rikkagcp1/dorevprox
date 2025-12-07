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
	let readableStreamCancel = false;

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
				if (readableStreamCancel) {
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
				onWsNormalClose({code: event.code, reason: event.reason});

				// client send close, need close server
				// if stream is cancel, skip controller.close
				safeCloseWebSocket(webSocket);
				if (readableStreamCancel) {
					return;
				}
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
			// 1. pipe WritableStream has error, this cancel will called, so ws handle server close into here
			// 2. if readableStream is cancel, all controller.close/enqueue need skip,
			// 3. but from testing controller.error still work even if readableStream is cancel
			if (readableStreamCancel) {
				return;
			}
			log("error", "websocket", `ReadableStream was canceled, due to ${reason}`)
			readableStreamCancel = true;
			safeCloseWebSocket(webSocket);
		}
	});

	const writable = new WritableStream<Uint8Array>({
		write: (chunk) => webSocket.send(chunk),
		close: () => {
			// The server dont need to close the websocket first, as it will cause ERR_CONTENT_LENGTH_MISMATCH
			// The client will close the connection anyway.
			// TODO: Setup a timer to close the websocket after 10 seconds.
			log("info", "websocket", "writable close()");
			// server.close()
		},
	});

	closedPromise.then((info) => {
		log("info", "websocket", `closed normally with code: ${info.code}, reason: ${info.reason}`);
	});

	closedPromise.catch((error) => {
		log("error", "websocket", "closed with error:", error);
	});

	return {
		readable,
		writable,
		close: () => {
			webSocket.close();
		},
		closed: closedPromise,
	}
}

export async function DuplexStreamOfTcp(hostname: string, port: number) : Promise<DuplexStream> {
	const socket = connect({hostname, port}, {allowHalfOpen: true});
	await socket.opened;

	// When the remote pair starts the close handshake,
	// Make sure we explicitly call `tcpSocket.close()` after `tcpSocket.writable` closes(unlocked).
	async function closeOnceUnlocked() {
		const maxSpins = 10;
		for (let i = 0; i < maxSpins && socket.writable.locked; i++) {
			await new Promise(resolve => setTimeout(resolve, 1));
		}
		return socket.close();
	}

	let downStreamRequestClose = false;
	let upStreamRequestClose = false;
	const upStream = new TransformStream<Uint8Array, Uint8Array>();
	upStream.readable.pipeTo(socket.writable)
		.catch(() => {})
		.finally(() => {
			if (downStreamRequestClose) {
				closeOnceUnlocked();
			} else {
				upStreamRequestClose = true;
			}
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
		writable: upStream.writable,
		closed: socket.closed,
		close: () => closeOnceUnlocked(),
	};
}
