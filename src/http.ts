import { Logger, createLogger } from "./utils";
import { handlelessRequest } from "./less";
import { GlobalConfig } from "./config";

export class HttpContext {

}

export type HttpInbound =
	| {
		type: "stream-one";
	}
	| {
		type: "stream-up";
		sessionId: string;
	}
	| {
		type: "packet-up";
		sessionId: string;
		seq: number;
	};


export function handleHttp(inbound: HttpInbound, request: Request, context: HttpContext | null, globalConfig: GlobalConfig): Response {
	if (inbound.type === 'stream-one') {
		const uuid = crypto.randomUUID();
		const logPrefix = uuid.substring(0, 6);
		const logger = createLogger(logPrefix);
	
		logger("info", "http", `Got request, type: ${inbound.type}`);

		const feedthroughStream = new TransformStream<Uint8Array, Uint8Array>();

		handlelessRequest({
			readable: request.body!,
			writable: feedthroughStream.writable,
			close: () => {
				logger("info", "http", "Http close()");
				feedthroughStream.writable.close();
			},
			closed: new Promise(()=>{})
		}, null, logger, globalConfig);

		return new Response(feedthroughStream.readable, {
			headers: {
				'X-Accel-Buffering': 'no',
				'Cache-Control': 'no-store',
				Connection: 'keep-alive',
				'User-Agent': 'Go-http-client/2.0',
				'Content-Type': 'application/grpc',
			},
		});
	}

	return new Response(
		"Only support stream-one at the moment",
		{
			status: 501,
			headers: {
				'Content-Type': 'text/plain',
			},
		}
	);
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
			return { type: "stream-one" };

		case 1:
			// /httpEndpoint/sessionId, Stream-up
			return {
				type: "stream-up",
				sessionId: segments[0],
			};

		case 2:
			// /httpEndpoint/sessionId/seq, Packet-up
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
