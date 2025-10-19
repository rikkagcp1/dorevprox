import { u8ArrayConcat } from "./utils"

export class CodecContext {
	private _offset = 0;
	private _buffer: Uint8Array;

	constructor(buffer: Uint8Array) {
		this._buffer = buffer;
	}

	assertRange(len: number) {
		if (this.offset + len > this.length) {
			throw new RangeError(`Out of bounds: need ${len} bytes, only ${this.remaining} remaining`);
		}
	}

	get offset() {
		return this._offset;
	}

	get length() {
		return this._buffer.length;
	}

	get remaining() {
		return this.length - this.offset;
	}

	push(bytes: number | Uint8Array) {
		if (typeof bytes === "number") {
			this.assertRange(1);
			this._buffer[this._offset++] = bytes;
		} else {
			this.assertRange(bytes.byteLength);
			this._buffer.set(bytes, this._offset);
			this._offset += bytes.byteLength;
		}
	}

	shift() {
		this.assertRange(1);
		return this._buffer[this._offset++];
	}

	shiftBy(length: number) {
		this.assertRange(length);
		const nextOffset = this._offset + length;
		const result = this._buffer.subarray(this._offset, nextOffset);
		this._offset = nextOffset;
		return result;
	}
}

export interface Codec<T> {
	byteLength(val: T): number;	// Val doesnt have to be specified for fixed-lengthed types
	write(val: T, context: CodecContext): void;

	/**
	 * @param context 
	 * @param length indicates the maximum length can be read. If undefined, follow {@link CodecContext.remaining}
	 */
	read(context: CodecContext, length?: number): T;
}

export const codecEmpty: Codec<{}> = {
	byteLength: () => 0,
	write: (_val, _ctx) => { },
	read: (_ctx) => ({}),
};

export const codecU8: Codec<number> = {
	byteLength: (val) => 1,
	write: (val, context) => context.push(val),
	read: (context) => context.shift(),
}

export const codecU16BE: Codec<number> = {
	byteLength: () => 2,
	write: (val, context) => {
		context.push(val >> 8);
		context.push(val & 0xFF);
	},
	read: (context) => {
		let result = context.shift() << 8;
		result |= context.shift() & 0xFF;
		return result;
	},
}

export const codecU8Array: Codec<Uint8Array> = {
	byteLength: (val) => val.byteLength,
	write: (val, context) => context.push(val),
	read: (context, length) => {
		if (length === undefined)
			throw new Error("codec_U8Array.read requires length to be specified");
		return context.shiftBy(length);
	}
}

export function codecOfFixedLenU8Array(length: number): Codec<Uint8Array> {
	return {
		byteLength: () => length,
		write: (val, context) => context.push(val),
		read: (context) => context.shiftBy(length),
	}
}

export function codecOfLengthed<T>(lengthCodec: Codec<number>, dataCodec: Codec<T>): Codec<T> {
	return {
		byteLength: (val) => lengthCodec.byteLength(0) + dataCodec.byteLength(val),
		write: (val, context) => {
			const dataLen = dataCodec.byteLength(val);
			lengthCodec.write(dataLen, context);
			dataCodec.write(val, context);
		},
		read: (context) => {
			const dataLen = lengthCodec.read(context);
			const data = dataCodec.read(context, dataLen);
			return data;
		},
	}
}

export const codecU8SizedBytes: Codec<Uint8Array> = codecOfLengthed(codecU8, codecU8Array);
export const codecU16BESizedBytes: Codec<Uint8Array> = codecOfLengthed(codecU16BE, codecU8Array);

export type Field<T> = {
	key: keyof T;
	codec: Codec<any>;
}

export function codecOf<T>(...fields: Field<T>[]): Codec<T> {
	return {
		byteLength(val) {
			return fields.reduce((oldVal, field) => {
				const obj = (val as any)[field.key];
				const len = field.codec.byteLength(obj);
				return oldVal + len;
			}, 0);
		},
		write(val, context) {
			for (const field of fields) {
				const fieldVal = (val as any)[field.key];
				field.codec.write(fieldVal, context);
			}
		},
		read(context) {
			const out: any = {};
			for (const field of fields) {
				out[field.key] = field.codec.read(context);
			}
			return out as T;
		}
	}
}

export function codecOfTaggedUnion<
	Tag extends string | number,
	BASE extends Record<string, any>,
	FULL extends BASE,                                // union of concrete cases (header + tail)
>(
	headerCodec: Codec<BASE>,
	tagOf: (base: Readonly<BASE>) => Tag,
	caseCodecs: Record<Tag, Codec<Partial<FULL>>>,    // one tail codec per Tag
): Codec<FULL> {
	function getTailCodec(from: BASE) {
		const tag = tagOf(from) as Tag;
		const tail = caseCodecs[tag];
		if (!tail) throw new Error(`Unknown tag ${String(tag)} in codecOfTaggedUnion`);
		return tail;
	}

	return {
		byteLength(val: FULL) {
			return headerCodec.byteLength(val as BASE) + getTailCodec(val as BASE).byteLength(val);
		},
		write(val: FULL, ctx: CodecContext) {
			headerCodec.write(val as BASE, ctx);
			getTailCodec(val as BASE).write(val, ctx);
		},
		read(ctx: CodecContext): FULL {
			const header = headerCodec.read(ctx) as BASE;
			const tail = getTailCodec(header).read(ctx) as Partial<FULL>;
			return Object.assign({}, header, tail) as FULL;
		},
	};
}

export function serialize<T>(codec: Codec<T>, value: T): Uint8Array {
	const length = codec.byteLength(value);
	const buffer = new Uint8Array(length);
	const context = new CodecContext(buffer);
	codec.write(value, context);
	return buffer;
}

export function deserialize<T>(codec: Codec<T>, buf: Uint8Array): T {
	const r = new CodecContext(buf);
	return codec.read(r);
}

export type IncrementalDeserializer<T> = (chunk: Uint8Array) => {
	done: false;
} | {
	done: true;
	value: T;
	residue: Uint8Array;
}

export function createIncrementalDeserializer<T>(codec: Codec<T>, maxBufferBytes?: number) : IncrementalDeserializer<T> {
	let bufferred : Uint8Array | null = new Uint8Array(0);

	return (chunk: Uint8Array) => {
		if (!bufferred) {
			throw new Error("Incremental deserializer has terminated");
		}

		bufferred = u8ArrayConcat(bufferred, chunk);
		if (maxBufferBytes && bufferred.length > maxBufferBytes) {
			throw new Error(`incremental buffer exceeded ${maxBufferBytes} bytes`);
		}

		try {
			// Retry until we successfully decode something
			const ctx = new CodecContext(bufferred);
			const value = codec.read(ctx); // May throw RangeError
			const residue = bufferred.subarray(ctx.offset);
			bufferred = null;
			return { done: true, value, residue };
		} catch (e) {
			// Not enough data, need more chunks
			if (e instanceof RangeError)
				return { done: false };

			// Forward other errors
			throw e;
		}
	};
}
