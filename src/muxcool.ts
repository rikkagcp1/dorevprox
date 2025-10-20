import * as codec from "./codec";
import * as address from "./address";

export const enum NetworkType {
	TCP = 1,
	UDP = 2,
};

export const enum MuxcoolOpCode {
	SUB_LINK_NEW = 1,
	SUB_LINK_KEEP = 2,
	SUB_LINK_END = 3,
	KEEP_ALIVE = 4,
}

export const enum MuxcoolOptions {
	HAS_DATA = 1,
}

export interface MuxcoolHeader {
	id: number;
	opcode: MuxcoolOpCode;
	options: number;
	connectionInfo: MuxcoolConnectionInfo | null;
}

export interface MuxcoolConnectionInfo {
	networkType: NetworkType;
	port: number;
	address: address.Address;
}

export const codecMuxcoolConnectionInfo = codec.codecOf<MuxcoolConnectionInfo>(
	{ key: "networkType", codec: codec.codecU8 },
	{ key: "port", codec: codec.codecU16BE },
	{ key: "address", codec: address.codec_address },
);

export const codecU16BESizedMuxcoolHeader = codec.codecOfLengthed<MuxcoolHeader>(codec.codecU16BE, {
	byteLength(val) {
		let length = 
			codec.codecU16BE.byteLength(val.id) +
			codec.codecU8.byteLength(val.opcode) +
			codec.codecU8.byteLength(val.options);
		
		if (val.connectionInfo) {
			length += codecMuxcoolConnectionInfo.byteLength(val.connectionInfo);
		}

		return length;
	},
	write(val, context) {
		codec.codecU16BE.write(val.id, context);
		codec.codecU8.write(val.opcode, context);
		codec.codecU8.write(val.options, context);

		if (val.connectionInfo) {
			codecMuxcoolConnectionInfo.write(val.connectionInfo, context);
		}
	},
	read(context, blockLength) {
		const initialOffset = context.offset;

		const result: MuxcoolHeader = {
			id: codec.codecU16BE.read(context),
			opcode: codec.codecU8.read(context),
			options: codec.codecU8.read(context),
			connectionInfo: null
		}

		const lengthRead = context.offset - initialOffset;
		if (blockLength && blockLength > lengthRead) {
			result.connectionInfo = codecMuxcoolConnectionInfo.read(context, blockLength - lengthRead);
		}
		return result;
	},
});

export interface MuxcoolFrame {
	header: MuxcoolHeader
	payload?: Uint8Array
}

export function newMuxcollFrameEncoder<H>(firstHeader: H | null, headerCodec:codec.Codec<H>): TransformStream<MuxcoolFrame, Uint8Array> {
	return new TransformStream({
		transform(chunk, controller) {
			const muxcoolFrameLen = codecU16BESizedMuxcoolHeader.byteLength(chunk.header)
				+ (chunk.payload ? codec.codecU16BESizedBytes.byteLength(chunk.payload) : 0);

			const length = firstHeader ? headerCodec.byteLength(firstHeader) + muxcoolFrameLen : muxcoolFrameLen;
			const buffer = new Uint8Array(length);
			const ctx = new codec.CodecContext(buffer);

			if (firstHeader) {
				headerCodec.write(firstHeader, ctx);
				firstHeader = null;
			}
			codecU16BESizedMuxcoolHeader.write(chunk.header, ctx);
			if (chunk.payload) {
				codec.codecU16BESizedBytes.write(chunk.payload, ctx);
			}

			controller.enqueue(buffer);
		},
	});
}

export function newMuxcoolFrameDecoder(): TransformStream<Uint8Array, MuxcoolFrame> {
	let headerDecoder!: codec.IncrementalDeserializer<MuxcoolHeader>;
	let payloadDecoder!: codec.IncrementalDeserializer<Uint8Array>;

	// Completed header waiting for its payload (null means we are currently parsing a header)
	let pendingHeader: MuxcoolHeader | null = null;

	const resetHeaderDecoder = () => {
		headerDecoder = codec.createIncrementalDeserializer(codecU16BESizedMuxcoolHeader);
	};
	const resetPayloadDecoder = () => {
		payloadDecoder = codec.createIncrementalDeserializer(codec.codecU16BESizedBytes);
	};

	resetHeaderDecoder();
	resetPayloadDecoder();

	return new TransformStream({
		transform(chunk, controller) {
			let buf: Uint8Array | null = chunk;

			// There might be multiple frames in a single incoming chunk
			while (buf && buf.length > 0) {
				// Case A: currently waiting for a header
				if (pendingHeader === null) {
					const h = headerDecoder(buf);
					if (!h.done) {
						// Not enough bytes for the header; wait for the next chunk
						buf = null;
						break;
					}

					const header = h.value;
					// If the least significant bit indicates a payload follows
					if (header.options & MuxcoolOptions.HAS_DATA) {
						pendingHeader = header;
					} else {
						// No payload: emit a frame with header only
						controller.enqueue({ header });
						// Header decoder is in a terminal state after success; reset it
						resetHeaderDecoder();
					}
					buf = h.residue;
				} else {
					// Case B: currently waiting for a payload (pendingHeader != null)
					const p = payloadDecoder(buf);
					if (!p.done) {
						// Not enough bytes for the payload; wait for the next chunk
						buf = null;
						break;
					}

					// Full frame assembled: emit and reset state
					controller.enqueue({ header: pendingHeader!, payload: p.value });
					pendingHeader = null;
					resetHeaderDecoder();
					resetPayloadDecoder();

					// Continue with leftover bytes (might contain the next header)
					buf = p.residue;
				}
			}
		},

		// Optional: if you want to be strict, fail the stream on trailing partial frame.
		// flush() {
		//   if (pendingHeader !== null) {
		//     throw new Error("Stream ended while waiting for payload.");
		//   }
		// }
	});
}
