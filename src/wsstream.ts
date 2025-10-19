/**
 * Information returned when a WebSocketStream (or wrapper) is opened.
 */
export interface WebSocketOpenInfoLike {
	/** The negotiated sub-protocol (if any) */
	protocol: string;
	/** The negotiated extensions (if any) */
	extensions: string;
	/** A readable stream of incoming messages (Uint8Array or string) */
	readable: ReadableStream<Uint8Array | string>;
	/** A writable stream for outgoing messages */
	writable: WritableStream<Uint8Array | string>;
}

/**
 * Close information (or “like”) type for when connection closes.
 */
export interface WebSocketCloseInfoLike {
	/** Close code (e.g. 1000, 1001, etc.) */
	code?: number;
	/** Optional close reason text */
	reason?: string;
}

/**
 * A "WebSocketStream-like" abstraction:
 * either backed by the native WebSocketStream (if available),
 * or a wrapper around standard WebSocket.
 */
export interface WebSocketStreamLike {
	/** The WebSocket URL used */
	readonly url: string;

	/**
	 * A Promise that resolves to WebSocketOpenInfo when
	 * the connection successfully opens.
	 */
	readonly opened: Promise<WebSocketOpenInfoLike>;

	/**
	 * A Promise that resolves to close info when the connection closes.
	 * May reject in case of abnormal termination (e.g. network error).
	 */
	readonly closed: Promise<WebSocketCloseInfoLike>;

	/**
	 * Actively close the connection.
	 * @param closeInfo Optional close code + reason.
	 */
	close(closeInfo?: WebSocketCloseInfoLike): void;
}
