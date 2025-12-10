import { LogLevel, createLogger, randomInt, newPromiseWithHandle, monitorRequestAbort } from "./utils";
import { handlelessRequest, BridgeContext } from "./less";
import { GlobalConfig } from "./config";

// https://streams.spec.whatwg.org/

const ASSOCIATE_TIMEOUT = 3000;

const COMMON_RESP_HEADERS = {
	"X-Accel-Buffering": "no",
	"Cache-Control": "no-store",
}

const SessionModes = {
	"unknown": "http",
	"stream-up": "http/stream-up",
	"packet-up": "http/packet-up",
} as const;

class StatefulSession {
	private associateTimeout: any | null = null;
	private sessionMode: keyof typeof SessionModes = "unknown";

	private upload: ReadableStream<Uint8Array> | null = null;
	private download: WritableStream<Uint8Array> | null = null;
	private upStreamCloseFunc: (() => Promise<void>) | null = null; 
	private downStreamCloseFunc: (() => void) | null = null;

	/** We dont have more data for our peer from the underlying source */
	private uploadDone = newPromiseWithHandle();
	/** We have sent everything from our peer to the underlying source */
	private downloadDone = newPromiseWithHandle();

	readonly logger;
	private readonly _logger;

	private closeTimeout: any | null = null;

	/**
	 * Resolves when both data paths are closed and/or aborted.
	 */
	private _closed = newPromiseWithHandle();

	get closed() {
		return this._closed.promise;
	}

	constructor(
		readonly id: string,
		private bridgeContext: BridgeContext | null,
		readonly globalConfig: GlobalConfig,
	) {
		const logPrefix = id.substring(0, 6);
		const logger = createLogger(logPrefix);
		this.logger = logger;
		this._logger = (level: LogLevel, ...args: any[]) => logger(level, SessionModes[this.sessionMode], ...args);

		this.uploadDone.promise.finally(() => {
			this._logger("info", "upload runs out of data");
		});
		this.downloadDone.promise.then(() => {
			this._logger("info", "download closes noramlly");
		}, (reason)=>{
			this._logger("info", "download closes with error: ", reason);
		});
		Promise.allSettled([this.downloadDone.promise, this.uploadDone.promise]).then(([downloadDone]) => {
			// uploadDone will never reject
			if (downloadDone.status === "fulfilled") {
				this._closed.resolve();
			} else {
				this._closed.reject(downloadDone.reason)
			}
		});

		this.closed.finally(() => {
			if (this.closeTimeout !== null) {
				clearTimeout(this.closeTimeout);
				this.closeTimeout = null;
			}

			this._logger("info", "end of stateful session");
		});
	}

	private tryHandleRequest() {
		if (this.upload && this.download) {
			this.clearAssociateTimer();

			this._logger("info", "start processing request");

			handlelessRequest({
				readable: this.upload,
				writable: this.download,
				close: (reason) => {
					console.log("stateful.close()");
				},
				closed: this.closed,
			}, this.bridgeContext, this.logger, this.globalConfig);
		}
	}

	private associateUpload(upload: ReadableStream<Uint8Array>, isStreamUp: boolean) {
		if (this.upload) {
			throw new Error("already associated");
		}

		if (this.upload === null && this.download === null) {
			this.associateTimeout = setTimeout(() => {
				this._logger("info", "associate downstream timeout");
				this.closeUpload();
			}, ASSOCIATE_TIMEOUT);
		}

		this.sessionMode = isStreamUp ? "stream-up" : "packet-up";

		this.upload = upload;
		this._logger("info", "upstream associated");

		this.tryHandleRequest();
	}

	associateStreamUp(upload: ReadableStream<Uint8Array>) {
		let uploadTerminator: () => void;
		const feedthroughStream = new TransformStream<Uint8Array, Uint8Array>({
			start: (controller) => {
				// Error the @param upload ReadableStream, close the this.upload ReadableStream
				uploadTerminator = () => controller.terminate();
			},
		});

		let uploadRequestTerminator: () => void;
		/**
		 * This ReadableStream just sits there until we close it to signal the end of the POST request.
		 */
		const dummyReadable = new ReadableStream<Uint8Array>({
			start: (controller) => {
				uploadRequestTerminator = () => controller.close();
			},
		});

		this.upStreamCloseFunc = async () => {
			this._logger("debug", "upStreamCloseFunc()");
			if (uploadTerminator) {
				uploadTerminator();
				this._logger("debug", "uploadTerminator()");
			}

			if (uploadRequestTerminator) {
				uploadRequestTerminator();
				this._logger("debug", "uploadRequestTerminator()");
			}
		}

		upload.pipeTo(feedthroughStream.writable).finally(() => {
			this._logger("debug", "client closes the POST body");
			this.upStreamCloseFunc = null;
			this.uploadDone.resolve();
			this.waitForDownloadToClose();
		});

		this.associateUpload(feedthroughStream.readable, true);

		return dummyReadable;
	}

	/**
	 * @param endOfRequest resolves when the client sends a TCP FIN.
	 * In response, we should close the client->server stream.
	 * @returns 
	 */
	associateDownload(endOfRequest: Promise<void>) {
		if (this.download) {
			throw new Error("already associated");
		}

		if (this.upload === null && this.download === null) {
			this.associateTimeout = setTimeout(() => {
				this._logger("info", "associate upstream timeout");
				this.closeDownload();
			}, ASSOCIATE_TIMEOUT);
		}

		endOfRequest.finally(() => {
			this._logger("info", "client-side wants to close");
			this.closeUpload();
		});

		const echoStream = new TransformStream<Uint8Array, Uint8Array>({
			start: (controller) => {
				this.downStreamCloseFunc = () => {
					// Errors this.download, closes the ReadableStream returned by the function.
					try { controller.terminate(); } catch {}
				}
			},
			flush: (controller) => {
				this._logger("debug", "associateDownload feedthroughStream flush");
			},
			cancel: (reason) => {
				this._logger("debug", "associateDownload feedthroughStream cancel");
			},
		});

		const identityStream = new TransformStream<Uint8Array, Uint8Array>();
		identityStream.readable.pipeTo(echoStream.writable)
			.then(this.downloadDone.resolve, this.downloadDone.reject)
			.finally(async () => await this.closeUpload());
		this.download = identityStream.writable;

		this._logger("info", "downstream associated");

		this.tryHandleRequest();

		return echoStream.readable;
	}

	get downloadAssociated() {
		return this.download !== null;
	}

	get uploadAssociated() {
		return this.upload !== null;
	}

	private clearAssociateTimer() {
		if (this.associateTimeout !== null) {
			clearTimeout(this.associateTimeout);
			this.associateTimeout = null;
			this._logger("debug", "timer cleared");
		}
	}

	private waitForDownloadToClose() {
		// we give the peer 1s to close the downstream.
		// Otherwise, we forcely close it.
		if (this.closeTimeout === null) {
			this.closeTimeout = setTimeout(() => {
				clearTimeout(this.closeTimeout);
				this.closeTimeout = null;
				this.closeDownload();
			}, 1000);
		}
	}

	private async closeUpload() {
		this.clearAssociateTimer();

		if (this.upStreamCloseFunc !== null) {
			const upStreamCloseFunc = this.upStreamCloseFunc;
			this.upStreamCloseFunc = null;
			await upStreamCloseFunc();
			this._logger("debug", "close upload stream");
			this.uploadDone.resolve();
			this.waitForDownloadToClose();
		}
	}

	private closeDownload() {
		this.clearAssociateTimer();

		if (this.downStreamCloseFunc !== null) {
			this.downStreamCloseFunc();
			this.downStreamCloseFunc = null;
			this._logger("debug", "close download stream");
		}
	}

	summary(): string {
		return `[${this.id.substring(0, 6)}] ${this.downloadAssociated ? "downloadAssociated " : ""}${this.upStreamCloseFunc ? "upStreamCloseFunc " : ""}${this.uploadAssociated ? "uploadAssociated " : ""}${this.upStreamCloseFunc ? "upStreamCloseFunc" : ""}`;
	}

	// For Packet-up only
	private packetUpWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
	private draining = false;
	private drainQueued = false;
	private fifo: { seq: number, chunk: Uint8Array }[] = [];
	private lastEnqueuedSeq = -1;

	packetIn(seq: number, chunk: Uint8Array): boolean {
		this._logger("debug", "packetIn seq: ", seq, "length: ", chunk.byteLength);
		if (this.sessionMode === "stream-up") {
			throw new Error("Already in stream-up mode!");
		}

		if (!this.packetUpWriter) {
			const feedthroughStream = new TransformStream<Uint8Array, Uint8Array>();
			const writer = feedthroughStream.writable.getWriter();
			this.upStreamCloseFunc = async () => {
				try {
					await writer.ready;
					await writer.close();
				} catch {}
			}
			this.packetUpWriter = writer;
			writer.closed.catch((reason) => {
				this._logger("info", "this.packetUpWriter.closed.catch", reason);
			}).finally(() => {
				this._logger("debug", "packetUpWriter.closed.finally");
			});
			this.associateUpload(feedthroughStream.readable, false);
		}

		if (seq <= this.lastEnqueuedSeq)
			return false; // Duplicated found

		if (this.fifo.find((item) => seq === item.seq))
			return false; // Duplicated found

		// Find a correct location and insert into the FIFO
		let lo = 0;
		let hi = this.fifo.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (this.fifo[mid].seq < seq)
				lo = mid + 1;
			else
				hi = mid;
		}
		this.fifo.splice(lo, 0, { seq, chunk });

		if (this.isDrainable()) {
			this.scheduleDrain();
		} else if (this.fifo.length > 30) {
			// FIFO full
			throw new Error("fifo full");
		}

		return true;
	}

	private isDrainable() {
		return this.fifo.length > 0 && this.fifo[0].seq === this.lastEnqueuedSeq + 1;
	}

	private scheduleDrain() {
		if (this.drainQueued)
			return;

		this.drainQueued = true;
		queueMicrotask(async () => {
			this.drainQueued = false;

			if (this.draining)
				return;
			this.draining = true;

			try {
				while (true) {
					if (this.fifo.length === 0)
						break;

					if (this.fifo[0].seq !== this.lastEnqueuedSeq + 1)
						break;

					// The first item in the FIFO
					const item = this.fifo.shift()!;

					try { await this.packetUpWriter!.ready; } catch {}
					try { await this.packetUpWriter!.write(item.chunk); } catch {}

					this.lastEnqueuedSeq = item.seq;
				}
			} finally {
				this.draining = false;

				if (this.isDrainable()) {
					this.scheduleDrain();
				}
			}
		});
	}
}

function handleStateless(requstBody: ReadableStream<Uint8Array>, endOfRequest: Promise<void>,
	bridgeContext: BridgeContext | null,
	globalConfig: GlobalConfig) {

	const uuid = crypto.randomUUID();
	const logPrefix = uuid.substring(0, 6);
	const logger = createLogger(logPrefix);
	const _logger = (level: LogLevel, ...args: any[]) => logger(level, "http/stream-one", ...args)

	_logger("info", "start stateless session");

	const _closed = newPromiseWithHandle();
	_closed.promise.finally(() => _logger("info", "end of stateless session"));

	/** We dont have more data for our peer from the underlying source */
	const uploadDone = newPromiseWithHandle();
	/** We have sent everything from our peer to the underlying source */
	const downloadDone = newPromiseWithHandle();

	uploadDone.promise.finally(() => {
		_logger("info", "upload runs out of data");
	});
	downloadDone.promise.then(() => {
		_logger("info", "download closes noramlly");
	}, (reason)=>{
		_logger("info", "download closes with error: ", reason);
	});
	Promise.allSettled([downloadDone.promise, uploadDone.promise]).then(([downloadDone]) => {
		// uploadDone will never reject
		if (downloadDone.status === "fulfilled") {
			_closed.resolve();
		} else {
			_closed.reject(downloadDone.reason)
		}
	});

	let closingUpload = false;
	let closeUpload!: () => void;
	const upStreamFeedthrough = new TransformStream<Uint8Array, Uint8Array>({
		start(controller) {
			closeUpload = () => {
				if (!closingUpload) {
					closingUpload = true;

					// Errors request.body, closes the readable that sent to the request handler
					controller.terminate();
					uploadDone.resolve();

					_logger("debug", "close upload stream");
				}
			}
		},
	});

	endOfRequest.finally(() => {
		_logger("info", "client-side wants to close");
		closeUpload();
	});

	const downStreamEcho = new TransformStream<Uint8Array, Uint8Array>();
	const downStreamFeedthrough = new TransformStream<Uint8Array, Uint8Array>();
	downStreamFeedthrough.readable.pipeTo(downStreamEcho.writable)
		.then(downloadDone.resolve, downloadDone.reject)
		.finally(async () => closeUpload());

	requstBody.pipeTo(upStreamFeedthrough.writable).finally(() => {
		_logger("debug", "client closes the POST body");
		closingUpload = true;
		uploadDone.resolve();
	})

	handlelessRequest({
		readable: upStreamFeedthrough.readable,
		writable: downStreamFeedthrough.writable,
		close: () => console.log("stateless.close()"),
		closed: _closed.promise
	}, bridgeContext, logger, globalConfig);

	return new Response(downStreamEcho.readable, {
		status: 200,
		headers: {
			...COMMON_RESP_HEADERS,
			"Connection": "keep-alive",
			"Content-Type": "application/grpc",
			"X-Padding": makeXPadding(),
		},
	});
}

export class StatefulContext {
	sessions: Map<string, StatefulSession> = new Map();

	summary(): string {
		return "Session count: " + this.sessions.size + "\n" + [...this.sessions.values()].map((session) => session.summary()).join("\n");
	}
}

export type HttpInbound =
	| {
		type: "stream-one";
	}
	| {
		type: "stream-unidirectional";
		sessionId: string;
	}
	| {
		type: "packet-up";
		sessionId: string;
		seq: number;
	};

function makeXPadding() {
	return "X".repeat(randomInt(100, 1000));
}

export async function handleHttp(inbound: HttpInbound, request: Request,
	context: StatefulContext | null,
	bridgeContext: BridgeContext | null,
	globalConfig: GlobalConfig) : Promise<Response> {

	const isH1 = request.cf?.httpProtocol === "HTTP/1.1";

	if (inbound.type == "stream-one") {
		if (isH1) {
			return new Response("Stream-one does not work over HTTP 1.1", { status: 501 });
		}

		const requstBody = request.body! as ReadableStream<Uint8Array>;
		const endOfRequest = monitorRequestAbort(request);
		return handleStateless(requstBody, endOfRequest, bridgeContext, globalConfig);
	}

	if (context === null) {
		return new Response("Modes other than stream-one requires in-memory state", { status: 400 });
	}

	let session = context.sessions.get(inbound.sessionId);
	if (!session) {
		session = new StatefulSession(inbound.sessionId, bridgeContext, globalConfig);
		session.closed.finally(() => {
			context.sessions.delete(inbound.sessionId);
		});
		context.sessions.set(inbound.sessionId, session);
	}

	if (inbound.type === "stream-unidirectional") {
		if (request.method === "GET") { // Stream-up download or Packet-up download
			if (session.downloadAssociated) {
				return new Response("downstream has already associated", { status: 400 });
			}

			const endOfRequest = monitorRequestAbort(request);
			const readable = session.associateDownload(endOfRequest);
			const xPadding = makeXPadding();
			const headers = {
				...COMMON_RESP_HEADERS,
				"Content-Type": "text/event-stream",
				"X-Padding": xPadding,
			};
			return new Response(readable, {
				status: 200,
				headers: isH1 ? { ...headers, "Transfer-Encoding": "chunked" } : headers,
			});
		} else if (request.method === "POST") { // Stream-up upload
			if (isH1) {
				return new Response("Stream-up does not work over HTTP 1.1", { status: 501 });
			}

			if (session.uploadAssociated) {
				return new Response("upstream has already associated", { status: 400 });
			}

			const readable = session.associateStreamUp(request.body!);

			/**
			 * Similar to stream-one, we mimic grpc for the upstream. However, if we replies nothing,
			 * worker will throw:
			 * `Can't read from request stream after response has been sent`
			 * 
			 * So, even we don't establish a downstream for this request, we must reply with a stream
			 * that just stays there and never sends anything.
			 */
			return new Response(readable, {
				status: 200,
				headers: {
					...COMMON_RESP_HEADERS,
					"Connection": "keep-alive",
					"Content-Type": "application/grpc",
					"X-Padding": makeXPadding(),
				},
			});
		}
	} else { // Packet-up upload
		session.packetIn(inbound.seq, await request.bytes());
		return new Response(null, {
			status: 200,
			headers: {"X-Padding": makeXPadding() }
		});
	}

	return new Response("Not supported", { status: 501, });
}

export function parseInboundPath(path: string, endpoint: string): HttpInbound | null {
	if (!path.startsWith(endpoint)) {
		return null;
	}

	// Remove "/httpEndpoint/" prefix
	const rest = path.slice(endpoint.length);

	const segments = rest.split("/").filter((s) => s.length > 0);

	switch (segments.length) {
		case 0:
			// /httpEndpoint/, Stream-one
			return { type: "stream-one", };

		case 1:
			// /httpEndpoint/sessionId, Stream-up or Packet-up downstream
			return {
				type: "stream-unidirectional",
				sessionId: segments[0],
			};

		case 2:
			// /httpEndpoint/sessionId/seq, Packet-up upstream
			const seqStr = segments[1];
			const seq = parseInt(seqStr);

			if (!Number.isFinite(seq) || seq < 0) {
				throw new Error(`Invalid seq number in http path: "${seqStr}"`);
			}

			return {
				type: "packet-up",
				sessionId: segments[0],
				seq,
			};

		default:
			// /httpEndpoint/a/b/c, error
			throw new Error(`Invalid http path format: "${path}"`);
	}
}
