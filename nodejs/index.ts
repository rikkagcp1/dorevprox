import { createServer } from "node:http";
import { WebSocketServer, WebSocket as WebSocketFromLib } from "ws";
import * as net from "node:net";

import { WebSocketCloseInfoLike } from "../src/wsstream";
import { DuplexStream } from "../src/stream";
import {
	Logger, createLogger,
	newPromiseWithHandle,
	base64ToUint8Array, equalUint8Array, uuidToUint8Array
} from "../src/utils";
import { handlelessRequest, BridgeContext } from "../src/less";
import { UUIDUsage, GlobalConfig } from "../src/config";
import { parseOutboundConfig } from "../src/outbound";

const textEncoder = new TextEncoder();

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
				const value = event.data;
				if (value instanceof Uint8Array)
					controller.enqueue(value);
				else if (typeof value === "string")
					controller.enqueue(textEncoder.encode(value));
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
				log("info", "websocket", "to-websocket closed");
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

async function DuplexStreamFromTcp(hostname: string, port: number): Promise<DuplexStream> {
	const client = new net.Socket({
		allowHalfOpen: true,
	});

	const host = (hostname.startsWith('[') && hostname.endsWith(']')) ? hostname.slice(1, -1) : hostname;
	const opened = newPromiseWithHandle();
	client.once("error", opened.reject);
	client.connect({
		host,
		port,
	}, opened.resolve);
	await opened.promise;

	const closed = newPromiseWithHandle(); 

	const readable = new ReadableStream<Uint8Array>({
		start: (controller) => {
			client.on("error", (error) => {
				try { controller.error(error); } catch {}
				closed.reject(error);
			});

			client.on("data", (data) => {
				if (data instanceof Uint8Array)
					controller.enqueue(data);
				else if (typeof data === "string")
					controller.enqueue(textEncoder.encode(data));
				else
					controller.error(new TypeError(`Unsupported chunk type: ${typeof data}`));

				if (!client.isPaused() && controller.desiredSize !== null && controller.desiredSize <= 0) {
					client.pause();
				}
			});

			client.on("end", () => {
				if (client.readyState === "writeOnly") {
					console.log("tcp: TCP peer send FIN, start close handshake");
					controller.close();
				} else if (client.readyState === "closed") {
					closed.resolve();
				}
			})

			client.on("finish", () => {
				if (client.readyState === "readOnly") {
					console.log("tcp: got FIN from tcp peer, TCP close handshake completes");
					controller.close();
				} else if (client.readyState === "closed") {
					closed.resolve();
				}
			});
		},
		pull: (controller) => {
			if (client.isPaused())
				client.resume();
		},
		cancel: (reason) => {
			console.log("tcp: duplex peer cancelled: ", reason);
			client.resetAndDestroy();
		},
	});

	const writable = new WritableStream<Uint8Array>({
		start: (controller) => {
			client.on("error", (error) => {
				try { controller.error(error); } catch {}
			});
		},
		write: async (chunk) => {
			if (client.readyState !== "open" && client.readyState !== "writeOnly")
				return;

			const {
				resolve: onSendOkay,
				reject: onSendFailed,
				promise: sent,
			} = newPromiseWithHandle();

			client.write(chunk, (error) => {
				if (error) {
					onSendFailed(error)
				} else {
					onSendOkay();
				}
			});

			await sent;
		},
		close: async () => {
			if (client.readyState === "open") {
				console.log("tcp: duplex peer requires a TCP close handshake");
			} else {
				console.log("tcp: send FIN to close finish TCP close handshake");
			}
			return new Promise<void>(resolve => client.end(resolve));
		},
		abort: (reason)  => {
			if (client.readyState === "open") {
				console.log("tcp: duplex peer wants to abort the TCP connection: ", reason);
				client.resetAndDestroy();
			}
		},
	});

	closed.promise.then(() => {
		console.log("tcp: closed resolved");
	}, (error) => {
		console.log("tcp: closed rejected: ", error);
	})

	return {
		readable, writable,
		closed: closed.promise,
		close: () => console.log("tcp.close()")
	}
}

// ---- HTTP/1.1 server + Upgrade -> WebSocket ----

const server = createServer((req, res) => {
	res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
	res.end("ok (http/1.1). try websocket upgrade.\n");
});

// ws server in "noServer" mode; we manually handle upgrade on the http server.
const wss = new WebSocketServer({ noServer: true });
const uuid_portal = uuidToUint8Array("8d46562e-9530-4c01-9fae-972bf9c209c5");
const uuid_client = uuidToUint8Array("61ade8f1-b8cf-4265-a631-9251b1a55724");
const uuid_user = uuidToUint8Array("15627d34-cce2-4add-9bff-68312ab8e1da");
const bridgeContext = new BridgeContext();

const globalConfig: GlobalConfig = {
	portalDomainName: "portal.internal",
	bridgeInternalDomain: "reverse",
	checkUuid: (uuid) => {
		if (equalUint8Array(uuid, uuid_portal))
			return UUIDUsage.PORTAL_JOIN;

		if (equalUint8Array(uuid, uuid_client))
			return UUIDUsage.TO_PORTAL;

		if (equalUint8Array(uuid, uuid_user))
			return UUIDUsage.TO_FREEDOM;

		return UUIDUsage.INVALID;
	},
	outbounds: parseOutboundConfig([
		{
			protocol: "freedom"
		}
	]),
	socketFactory: {
		newTcp: DuplexStreamFromTcp,
	}
}

server.on("upgrade", (request, socket, head) => {
	// accept any path; just ensure it's websocket upgrade
	const upgrade = request.headers.upgrade;
	if (!upgrade || String(upgrade).toLowerCase() !== "websocket") {
		socket.destroy();
		return;
	}

	wss.handleUpgrade(request, socket, head, (ws) => {
		const earlyDataHeader = request.headers["sec-websocket-protocol"] || '';
		const earlyDataParseResult = base64ToUint8Array(earlyDataHeader);
		if (!earlyDataParseResult.success) {
			return new Response(null, { status: 500 });
		}

		const uuid = crypto.randomUUID();
		const logPrefix = uuid.substring(0, 6);
		const logger = createLogger(logPrefix);
	
		const lessStream = DuplexStreamFromWs(ws, earlyDataParseResult.data, logger);
		handlelessRequest(lessStream, bridgeContext, logger, globalConfig);
	});
});

server.listen(8787);
