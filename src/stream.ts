import { WebSocketStreamLike } from "./wsstream";

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
