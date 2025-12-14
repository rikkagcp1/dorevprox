import { createServer } from "node:http";
import { WebSocketServer, WebSocket as WebSocketFromLib } from "ws";

import { WebSocketCloseInfoLike } from "../src/wsstream";
import { DuplexStream } from "../src/stream";
import { Logger, newPromiseWithHandle } from "../src/utils";

function safeCloseWebSocket(webSocket: WebSocketFromLib, code = 1000, reason?: string) {
	const WS_READY_STATE_OPEN = 1;
	const WS_READY_STATE_CLOSING = 2;

	try {
		if (webSocket.readyState === WS_READY_STATE_OPEN || webSocket.readyState === WS_READY_STATE_CLOSING) {
			webSocket.close(code, reason);
		}
	} catch (error) {
		console.error('safeCloseWebSocket error', error);
	}
}

function DuplexStreamFromWs(webSocket: WebSocketFromLib, earlyData: Uint8Array, log: Logger): DuplexStream {
	let duplexRequestClose = false;
	let serverWantToClose = false;

	const {
		resolve: onWsNormalClose,
		reject: onWsUncleanClose,
		promise: closedPromise,
	} = newPromiseWithHandle<WebSocketCloseInfoLike>();

	const readable = new ReadableStream<Uint8Array>({
		start: (controller) => {
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
				let value = event.data;
				if (value instanceof Uint8Array)
					controller.enqueue(value);
				else if (typeof value === "string")
					controller.enqueue(new TextEncoder().encode(value));
				else if (value instanceof ArrayBuffer)
					controller.enqueue(new Uint8Array(value));
				else
					controller.error(new TypeError(`Unsupported chunk type: ${typeof value}`));

				if (!webSocket.isPaused && controller.desiredSize !== null && controller.desiredSize <= 0) {
					webSocket.pause();
				}
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

				if (event.code === 1000 || event.code === 1001 || event.code === 1005) {
					try { controller.close(); } catch {};
					onWsNormalClose({code: event.code, reason: event.reason});
				} else {
					try { controller.error(event.reason); } catch {};
					onWsUncleanClose(event.reason);
				}
			});

			webSocket.addEventListener("error", (event) => {
				onWsUncleanClose(event.error);
				try { controller.error(event.error); } catch {};
			});
		},
		pull: (controller) => {
			// if ws can stop read if stream is full, we can implement backpressure
			// https://streams.spec.whatwg.org/#example-rs-push-backpressure
			if (webSocket.isPaused)
				webSocket.resume();
		},
		cancel: (reason) => {
			if (serverWantToClose) {
				log("info", "websocket", "duplex peer cancelled: ", reason);
			} else {
				duplexRequestClose = true;
			}

			safeCloseWebSocket(webSocket, 1011, reason);
		}
	});

	const writable = new WritableStream<Uint8Array>({
		start: (controller) => {
			webSocket.addEventListener("error", (event) => {
				try { controller.error(event.error); } catch {}
			});
		},
		write: async (chunk) => {
			if (webSocket.readyState === WebSocketFromLib.CONNECTING) {
				await new Promise(resolve => webSocket.once("open", resolve));
			}

			if (duplexRequestClose || serverWantToClose) {
				return;
			}

			const {
				resolve: onSendOkay,
				reject: onSendFailed,
				promise: sent,
			} = newPromiseWithHandle();

			webSocket.send(chunk, (error) => {
				if (error) {
					onSendFailed(error)
				} else {
					onSendOkay();
				}
			});

			await sent;
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
		abort: (reason)  => {
			if (serverWantToClose) {
				log("info", "websocket", "duplex peer aborted: ", reason);
			} else {
				duplexRequestClose = true;
			}

			safeCloseWebSocket(webSocket, 1011, reason);
		},
	});

	closedPromise.then((info) => {
		log("info", "websocket", `closed normally with code: ${info.code}, reason: ${info.reason}`);
	}, (error) => {
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

// ---- HTTP/1.1 server + Upgrade -> WebSocket ----

const server = createServer((req, res) => {
	res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
	res.end("ok (http/1.1). try websocket upgrade.\n");
});

// ws server in "noServer" mode; we manually handle upgrade on the http server.
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
	// accept any path; just ensure it's websocket upgrade
	const upgrade = request.headers.upgrade;
	if (!upgrade || String(upgrade).toLowerCase() !== "websocket") {
		socket.destroy();
		return;
	}

	wss.handleUpgrade(request, socket, head, (ws) => {
		// Wrap into your DuplexStream-like object
		const ds = DuplexStreamFromWs(ws, new Uint8Array(0), (level, source, ...args) => {
			console.log(source, ...args);
		});

		let errorReadable!: (reason?: any) => void;
		ds.readable.pipeTo(new WritableStream({
			start(controller) {
				errorReadable = (reason) => {
					try {
						controller.error(reason);
					} catch {};
				}
			},
			async write(chunk) {
				console.log(`Got ${chunk.byteLength} of data.`);
			},
			async close() {
				console.log("ds.readable.pipeTo close");
			},
			async abort(reason) {
				console.log("ds.readable.pipeTo abort: ", reason);
			},
		})).catch(() => {});

		const writer = ds.writable.getWriter();
		writer.closed.then(() => {
			console.log("Writer closed");
		}, (e) => {
			console.log("Writer closed with error: ", e);
		});

		let i = 0;
		const encoder = new TextEncoder();
		const timer = setInterval(async () => {
			if (i < 3) {
				i++;
				try {
					await writer.ready;
					writer.write(encoder.encode(`${i}\n`)).catch((e) => {
						console.log("write failed with:", e);
					});
				} catch { }
			} else {
				clearInterval(timer);
				await writer.ready;
				await writer.close();
				// await writer.abort("QAQ");
				//ds.readable.cancel();
				// errorReadable("qwQ");
				console.log("await writer.close();");
			}
		}, 1000);

		ds.closed.then(
			() => console.log("ds.closed.then"),
			(e) => console.log("ds.closed.catch:", e),
		);
	});
});

server.listen(8000, () => {
	console.log("HTTP/1.1 listening on http://127.0.0.1:8000");
	console.log("WebSocket upgrade supported on same port (any path).");
});
