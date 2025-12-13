import { WebSocketStreamLike, WebSocketCloseInfoLike } from "./wsstream";
import { Logger, newPromiseWithHandle, safeCloseWebSocket } from "./utils";

/**
 * This interface defines a duplex stream that can be considered as
 * the base class of the Cloudflare socket connection：
 * ```ts
 * import { connect } from "cloudflare:sockets";
 * ```
 */
export interface DuplexStream {
	/**
	 * Our source. We send data to peer from here.
	 * 
	 * To notice the peer that this DuplexStream itself wants to close normally, we close the readable on our side.
	 * To notice the peer that this DuplexStream itself wants to abort, we error the readable on our side.
	 * 
	 * If the readable is errored externally, the effect is the same as abort.
	 * 
	 * Calling controller.close() on readable does NOT drop already enqueued chunks; they will still be delivered to the peer before the close is observed.
	 */
	get readable(): ReadableStream<Uint8Array>,

	/**
	 * Our sink. We recv data from peer from here.
	 * 
	 * Peer closes this writable (e.g. by calling `writable.close()`) to start a close sequence. (e.g. TCP FIN)
	 * Peer aborts this writable (e.g. by calling `writable.abort()`) to abort the connection. (e.g. TCP RST)
	 * 
	 * If we have to abort the DuplexStream, we abort writable.
	 */
	get writable(): WritableStream<Uint8Array>,

	/**
	 * A Promise that resolves when:
	 * 1. We dont have more data for our peer from the underlying source (readable enters closed state)
	 * AND
	 * 2. Our peer's underlying source dont have more data for us (writable enters closed state)
	 * 
	 * Note:
	 * Even if this promise settles, there could be chunks in the readable.pipeTo chain.
	 * 
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
	let duplexRequestClose = false;
	let serverWantToClose = false;

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
				if (duplexRequestClose || serverWantToClose) {
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
				if (duplexRequestClose) {
					log("info", "websocket", "duplex peer wants to close");
				} else {
					log("info", "websocket", "websocket peer wants to close");
					serverWantToClose = true;
				}

				if (event.code === 1000) {
					controller.close();
					onWsNormalClose({code: event.code, reason: event.reason});
				} else {
					controller.error(event.reason);
					onWsUncleanClose(event.reason);
				}
			});

			webSocket.addEventListener("error", (event) => {
				onWsUncleanClose(event.error);
				controller.error(event.error);
			});
		},
		//pull(controller) {
			// if ws can stop read if stream is full, we can implement backpressure
			// https://streams.spec.whatwg.org/#example-rs-push-backpressure
		//},
		cancel(reason) {
			log("error", "websocket", `ReadableStream was canceled, due to ${reason}`)
			safeCloseWebSocket(webSocket);
		}
	});

	const writable = new WritableStream<Uint8Array>({
		start: (controller) => {
			webSocket.addEventListener("error", (event) => {
				controller.error(event.error);
			});
		},
		write: (chunk) => {
			if (duplexRequestClose || serverWantToClose) {
				return;
			}

			webSocket.send(chunk);
		},
		close: () => {
			if (serverWantToClose) {
				log("info", "websocket", "to-websocket closed (initiated by websocket peer)");
			} else {
				duplexRequestClose = true;
			}

			// https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API/Using_WebSocketStream#closing_the_connection
			// Closing the underlying WritableStream or WritableStreamDefaultWriter also closes the connection.
			safeCloseWebSocket(webSocket);
		},
		abort(reason) {
			if (serverWantToClose) {
				log("info", "ws", "duplex peer aborted");
			} else {
				duplexRequestClose = true;
			}

			safeCloseWebSocket(webSocket, 1006, reason);
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
			console.log("websocket.close()");
		},
		closed: closedPromise,
	}
}
