import { LogLevel, createLogger, randomInt } from "./utils";
import { handlelessRequest } from "./less";
import { GlobalConfig } from "./config";

// https://streams.spec.whatwg.org/

const ASSOCIATE_TIMEOUT = 30000;

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
	private associateTimeout = -1;
	private sessionMode: keyof typeof SessionModes = "unknown";
	private closeStreamUp?: () => void;
	private upload: ReadableStream<Uint8Array> | null = null;
	private download: WritableStream<Uint8Array> | null = null;
	private uploadCanceling = false;
	private downloadCanceling = false;
	private removed = false;
	protected readonly logger;

	constructor(
		readonly id: string,
		readonly removeSession: () => void,
		readonly globalConfig: GlobalConfig,
	) {
		const logPrefix = id.substring(0, 6);
		const logger = createLogger(logPrefix);
		this.logger = (level: LogLevel, ...args: any[]) => logger(level, SessionModes[this.sessionMode], ...args);
	}

	private tryHandleRequest() {
		if (this.upload && this.download && this.associateTimeout > 0) {
			clearTimeout(this.associateTimeout);
			this.associateTimeout = -1;

			this.logger("info", "start processing request");
			handlelessRequest({
				readable: this.upload,
				writable: this.download,
				close: (reason) => this.close(reason),
				closed: new Promise(() => { })
			}, null, this.logger, this.globalConfig);
		}
	}

	private associateUpload(upload: ReadableStream<Uint8Array>, isStreamUp: boolean) {
		if (this.upload) {
			throw new Error("already associated");
		}

		if (this.upload === null && this.download === null) {
			this.associateTimeout = setTimeout(() => {
				this.close("associate downstream timeout");
			}, ASSOCIATE_TIMEOUT);
		}

		this.sessionMode = isStreamUp ? "stream-up" : "packet-up";

		this.upload = upload;
		this.logger("info", "upstream associated");

		this.tryHandleRequest();
	}

	associateStreamUp(upload: ReadableStream<Uint8Array>) {
		this.associateUpload(upload, true);

		return new ReadableStream<Uint8Array>({
			start: (controller) => {
				this.closeStreamUp = () => controller.close();
			},
			cancel: (reason) => {
				// Only in Stream-up mode
				this.logger("info", "Remote closes the upload channel");
				this.close(reason);
			},
		});
	}

	associateDownload() {
		if (this.download) {
			throw new Error("already associated");
		}

		if (this.upload === null && this.download === null) {
			this.associateTimeout = setTimeout(() => {
				this.close("associate downstream timeout");
			}, ASSOCIATE_TIMEOUT);
		}

		const feedthroughStream = new TransformStream<Uint8Array, Uint8Array>();
		const downWriter = feedthroughStream.writable.getWriter();

		// Wrap downstream writable to observe close/abort.
		this.download = new WritableStream<Uint8Array>({
			write: (chunk) => downWriter.write(chunk), // or cache a writer once; see note below
			close: async () => {
				// Close underlying writable first (flush)
				await downWriter.close();

				// Then close upstream and cleanup
				this.logger("info", "downstream closed -> closing upload");
				this.close("downstream closed");
			},
			abort: async (reason) => {
				await downWriter.abort(reason).catch(() => { });
				this.logger("info", "downstream aborted -> closing upload", reason);
				this.close("downstream aborted");
			},
		});
		this.logger("info", "downstream associated");

		this.tryHandleRequest();

		return feedthroughStream.readable;
	}

	get downloadAssociated() {
		return this.download !== null;
	}

	get uploadAssociated() {
		return this.upload !== null;
	}

	close(reason?: string): void {
		this.logger("debug", "Call session.close() with reason", reason);

		if (this.download && !this.downloadCanceling) {
			this.downloadCanceling = true;
			this.download.close();
		} else if (!this.download) {
			// No downstream exists; treat as already closed.
			this.downloadCanceling = true;
		}

		// For Stream-up mode
		if (this.closeStreamUp && !this.uploadCanceling) {
			this.uploadCanceling = true;
			this.closeStreamUp();
		}

		// For Packet-up mode
		if (this.packetUpWriter && !this.uploadCanceling) {
			this.uploadCanceling = true;
			this.packetUpWriter.close().catch(() => {});
		} else if (!this.upload) {
			// No upstream exists; treat as already closed.
			this.uploadCanceling = true;
		}

		if (this.downloadCanceling && this.uploadCanceling && !this.removed) {
			this.logger("info", "session closed with reason:", reason);
			this.removeSession();
			this.removed = true;
		}
	}

	summary(): string {
		return `[${this.id.substring(0, 6)}] ${this.downloadAssociated ? "downloadAssociated " : ""}${this.uploadCanceling ? "uploadCanceling" : ""}${this.uploadAssociated ? "uploadAssociated " : ""}${this.downloadCanceling ? "downloadCanceling" : ""}`;
	}

	// For Packet-up only
	private packetUpWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
	private draining = false;
	private drainQueued = false;
	private fifo: { seq: number, chunk: Uint8Array }[] = [];
	private lastEnqueuedSeq = -1;

	packetIn(seq: number, chunk: Uint8Array): boolean {
		this.logger("debug", "packetIn seq: ", seq, "length: ", chunk.byteLength);
		if (this.sessionMode === "stream-up") {
			throw new Error("Already in stream-up mode!");
		}

		if (!this.packetUpWriter) {
			const feedthroughStream = new TransformStream<Uint8Array, Uint8Array>();
			this.packetUpWriter = feedthroughStream.writable.getWriter();
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

					await this.packetUpWriter!.ready;
					await this.packetUpWriter!.write(item.chunk);

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

		const uuid = crypto.randomUUID();
		const logPrefix = uuid.substring(0, 6);
		const logger = createLogger(logPrefix);

		logger("info", "http/stream-one", "start stateless session");

		const feedthroughStream = new TransformStream<Uint8Array, Uint8Array>();

		handlelessRequest({
			readable: request.body!,
			writable: feedthroughStream.writable,
			close: () => {
				logger("info", "http", "Http close()");
				feedthroughStream.writable.close();
			},
			closed: new Promise(() => { })
		}, null, logger, globalConfig);

		return new Response(feedthroughStream.readable, {
			status: 200,
			headers: {
				...COMMON_RESP_HEADERS,
				"Connection": "keep-alive",
				"Content-Type": "application/grpc",
				"Referer": makeXPadding(),
			},
		});
	}

	if (context === null) {
		return new Response("Modes other than stream-one requires in-memory state", { status: 400 });
	}

	let session = context.sessions.get(inbound.sessionId);
	if (!session) {
		session = new StatefulSession(inbound.sessionId, () => context.sessions.delete(inbound.sessionId), globalConfig);
		context.sessions.set(inbound.sessionId, session);
	}

	if (inbound.type === "stream-unidirectional") {
		if (request.method === "GET") { // Stream-up download or Packet-up download
			if (session.downloadAssociated) {
				return new Response("downstream has already associated", { status: 400 });
			}

			const readable = session.associateDownload();
			return new Response(readable, {
				status: 200,
				headers: isH1 ? {
					...COMMON_RESP_HEADERS,
					"Content-Type": "text/event-stream",
					"Transfer-Encoding": "chunked",
					"Referer": makeXPadding(),
				} : {
					...COMMON_RESP_HEADERS,
					"Content-Type": "text/event-stream",
					"Connection": "keep-alive",
					"Referer": makeXPadding(),
				},
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
					"Referer": makeXPadding(),
				},
			});
		}
	} else { // Packet-up upload
		session.packetIn(inbound.seq, await request.bytes());
		return new Response(null, { status: 200 });
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
