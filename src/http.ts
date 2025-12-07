import { LogLevel, createLogger, randomInt, newPromiseWithHandle, monitorRequestAbort } from "./utils";
import { handlelessRequest } from "./less";
import { GlobalConfig } from "./config";
import { connect } from "cloudflare:sockets";

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
	private upStreamCloseFunc: (() => void) | null = null; 
	private downStreamCloseFunc: (() => void) | null = null;

	readonly logger;
	private readonly _logger;

	private weWantToClose = false;

	/**
	 * Resolves when both data paths are closed and/or aborted.
	 */
	private _closed = newPromiseWithHandle();

	get closed() {
		return this._closed.promise;
	}

	constructor(
		readonly id: string,
		readonly globalConfig: GlobalConfig,
	) {
		const logPrefix = id.substring(0, 6);
		const logger = createLogger(logPrefix);
		this.logger = logger;
		this._logger = (level: LogLevel, ...args: any[]) => logger(level, SessionModes[this.sessionMode], ...args);

		this.closed.finally(() => this._logger("info", "end of stateful session"));
	}

	private tryHandleRequest() {
		if (this.upload && this.download) {
			this.clearAssociateTimer();

			this._logger("info", "start processing request");

			handlelessRequest({
				readable: this.upload,
				writable: this.download,
				close: (reason) => {
					this.close();
				},
				closed: this.closed,
			}, null, this.logger, this.globalConfig);
		}
	}

	private associateUpload(upload: ReadableStream<Uint8Array>, isStreamUp: boolean) {
		if (this.upload) {
			throw new Error("already associated");
		}

		if (this.upload === null && this.download === null) {
			this.associateTimeout = setTimeout(() => {
				this._logger("info", "associate downstream timeout");
				this.weWantToClose = true;
				this.closeUpload();
			}, ASSOCIATE_TIMEOUT);
		}

		this.sessionMode = isStreamUp ? "stream-up" : "packet-up";

		this.upload = upload;
		this._logger("info", "upstream associated");

		this.tryHandleRequest();
	}

	associateStreamUp(upload: ReadableStream<Uint8Array>) {
		let uploadTerminator! : () => void;
		const feedthroughStream = new TransformStream<Uint8Array, Uint8Array>({
			start: (controller) => {
				uploadTerminator = () => controller.terminate();
			},
		});

		let uploadRequestTerminator! : () => void;
		/**
		 * This ReadableStream just sits there until we close it to signal the end of the POST request.
		 */
		const dummyReadable = new ReadableStream<Uint8Array>({
			start: (controller) => {
				uploadRequestTerminator = () => controller.close();
			},
		});

		this.upStreamCloseFunc = () => {
			this._logger("info", "upStreamCloseFunc()");
			uploadTerminator();
			uploadRequestTerminator();
		}

		upload.pipeTo(feedthroughStream.writable).finally(() => {
			this._logger("info", "upload.pipeTo finally in associateStreamUp");
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
				this.weWantToClose = true;
				this.closeDownload();
			}, ASSOCIATE_TIMEOUT);
		}

		endOfRequest.finally(() => {
			this._logger("info", "client-side wants to close");
			this.weWantToClose = true;
			this.closeUpload();
		});

		const echoStream = new TransformStream<Uint8Array, Uint8Array>({
			start: (controller) => {
				this.downStreamCloseFunc = () => {
					// Errors this.download, closes the ReadableStream returned by the function.
					try { controller.terminate(); } catch {}

					// If the downStream pipeTo chain is not complete, we need to close from the end.
					this.download?.close().catch(() => {});
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
		identityStream.readable.pipeTo(echoStream.writable).finally(async () => {
			this._logger("info", "downstream closes");
			this.downStreamCloseFunc = null;

			// Attempt to close the upload, skip if already closed
			this.closeUpload();

			// When we start the close "handshake", this is the last step
			if (this.weWantToClose) {
				this._closed.resolve();
			}
		});
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
		if (this.associateTimeout) {
			clearTimeout(this.associateTimeout);
			this.associateTimeout = null;
			this._logger("debug", "timer cleared");
		}
	}

	private closeUpload() {
		//this.logger("debug", "closeUpload()");
		this.clearAssociateTimer();

		if (this.upStreamCloseFunc) {
			this.upStreamCloseFunc!();
			this.upStreamCloseFunc = null;
			this._logger("debug", "close upload stream");
		}
	}

	private closeDownload() {
		this.clearAssociateTimer();

		if (this.downStreamCloseFunc) {
			this.downStreamCloseFunc!();
			this.downStreamCloseFunc = null;
			this._logger("debug", "close download stream");
		}
	}

	close() {
		//const uploadUnlocked = this.upload ? !this.upload.locked : true;
		//const downloadUnlocked = this.download ? !this.download.locked : true;
		if (this.upStreamCloseFunc === null && this.downStreamCloseFunc === null) {
			// We have already closed
			this._closed.resolve();
			return;
		}

		this.weWantToClose = true;
		this.closeDownload();
		this.closeUpload();
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
			this.upStreamCloseFunc = () => writer.close();
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

function handleStateless(requstBody: ReadableStream<Uint8Array>, endOfRequest: Promise<void>, globalConfig: GlobalConfig) {
	const uuid = crypto.randomUUID();
	const logPrefix = uuid.substring(0, 6);
	const _logger = createLogger(logPrefix);
	const logger = (level: LogLevel, ...args: any[]) => _logger(level, "http/stream-one", ...args)

	logger("info", "start stateless session");

	const _closed = newPromiseWithHandle();

	let upStreamCloseFunc: (() => void) | null = null;
	function closeUpload() {
		if (upStreamCloseFunc) {
			upStreamCloseFunc();
			upStreamCloseFunc = null;
			logger("debug", "close upload stream");
		}
	}
	const upStreamFeedthrough = new TransformStream<Uint8Array, Uint8Array>({
		start(controller) {
			// Errors request.body, closes the readable that sent to the request handler
			upStreamCloseFunc = () => controller.terminate();
		},
	});

	endOfRequest.finally(() => {
		logger("info", "client-side wants to close");
		weWantToClose = true;
		closeUpload();
	});

	let weWantToClose = false;
	function close() {
		logger("info", "close()");
		if (upStreamCloseFunc === null && downStreamCloseFunc === null) {
			// We have already closed
			_closed.resolve();
			return;
		}

		weWantToClose = true;
		closeDownload();
		closeUpload();
	}

	let downStreamCloseFunc: (() => void) | null = null;
	function closeDownload() {
		if (downStreamCloseFunc) {
			downStreamCloseFunc();
			downStreamCloseFunc = null;
			logger("debug", "close download stream");
		}
	}
	const downStreamEcho = new TransformStream<Uint8Array, Uint8Array>({
		start(controller) {
			downStreamCloseFunc = () => controller.terminate();
		},
	});
	const downStreamFeedthrough = new TransformStream<Uint8Array, Uint8Array>();
	downStreamFeedthrough.readable.pipeTo(downStreamEcho.writable).finally(async () => {
		logger("info", "downstream closes");
		downStreamCloseFunc = null;

		// Attempt to close the upload, skip if already closed
		closeUpload();

		if (weWantToClose) {
			_closed.resolve();
		}
	});

	_closed.promise.finally(() => logger("info", "end of stateless session"));

	handlelessRequest({
		readable: requstBody.pipeThrough(upStreamFeedthrough),
		writable: downStreamFeedthrough.writable,
		close,
		closed: _closed.promise
	}, null, _logger, globalConfig);

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

export async function handleHttp(inbound: HttpInbound, request: Request, context: StatefulContext | null, globalConfig: GlobalConfig): Promise<Response> {
	const isH1 = request.cf?.httpProtocol === "HTTP/1.1";

	if (inbound.type == "stream-one") {
		if (isH1) {
			return new Response("Stream-one does not work over HTTP 1.1", { status: 501 });
		}

		const requstBody = request.body! as ReadableStream<Uint8Array>;
		const endOfRequest = monitorRequestAbort(request);
		return handleStateless(requstBody, endOfRequest, globalConfig);
	}

	if (context === null) {
		return new Response("Modes other than stream-one requires in-memory state", { status: 400 });
	}

	let session = context.sessions.get(inbound.sessionId);
	if (!session) {
		session = new StatefulSession(inbound.sessionId, globalConfig);
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
