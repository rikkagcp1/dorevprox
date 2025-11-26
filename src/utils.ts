export type LogLevel = "debug" | "info" | "warn" | "error" | "log";

export type Logger = (level: LogLevel, source: string, ...args: any[]) => void;

export function createLogger(sessionId: string): Logger {
	const pad2 = (n: number) => String(n).padStart(2, "0");
	const pad6 = (n: number) => String(n).padStart(6, "0");

	// best-effort microsecond timestamp
	const hasPerf =
		typeof performance !== "undefined" &&
		typeof performance.now === "function" &&
		typeof (performance as any).timeOrigin === "number";

	return (level: LogLevel, source: string, ...args: any[]) => {
		const nowMicros = hasPerf
			? Math.floor((performance.timeOrigin + performance.now()) * 1000)
			: Date.now() * 1000;

		const ms = Math.floor(nowMicros / 1000);
		const d = new Date(ms);
		const microsInSecond = nowMicros % 1_000_000;

		const ts =
			`${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ` +
			`${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.` +
			`${pad6(microsInSecond)}`;

		const levelLabel = level === "log" ? "Info" : (level[0].toUpperCase() + level.slice(1));
		const src = source.endsWith(":") ? source : `${source}:`;
		const prefix = `${ts} [${levelLabel}] [${sessionId}] ${src}`;

		const fn = (console as any)[level] ?? console.log;
		fn(prefix, ...args);
	};
}

export type NumberMap = { [key: number]: number };

function assertNonNullObject(obj: unknown) {
	if (typeof obj !== "object" || obj === null) {
		throw new Error(`Expected object, but got ${JSON.stringify(obj)}`);
	}
}

export function newNumberMap(obj: unknown): NumberMap {
	assertNonNullObject(obj);

	const result: NumberMap = {};

	for (const [keyStr, rawValue] of Object.entries(obj as any)) {
		const keyNum = Number.parseInt(keyStr, 10);
		if (Number.isNaN(keyNum)) {
			throw new Error(`Invalid key: "${keyStr}" cannot be parsed as number`);
		}

		let valNum: number;
		if (typeof rawValue === "string") {
			valNum = Number.parseInt(rawValue, 10);
			if (Number.isNaN(valNum)) {
				throw new Error(`Invalid value for key ${keyStr}: string "${rawValue}" cannot be parsed as number`);
			}
		} else if (typeof rawValue === "number") {
			valNum = rawValue;
		} else {
			throw new Error(`Invalid value type for key ${keyStr}: expected string or number, got ${typeof rawValue}`);
		}

		result[keyNum] = valNum;
	}

	return result;
}

export function childStringOf(obj: unknown, key: string, defaultValue?: string): string {
	assertNonNullObject(obj);

	const maybe = (obj as any)[key];
	if (typeof maybe === "string") {
		return maybe;
	}

	if (defaultValue === undefined) {
		throw new Error(`Key ${key} does not present`);
	}
	return defaultValue;
}

export function childIntOf(obj: unknown, key: string, defaultValue?: number): number {
	assertNonNullObject(obj);

	const maybe = (obj as any)[key];

	if (typeof maybe === "number") {
		if (!Number.isInteger(maybe)) {
			throw new Error(`Key "${key}" is not an integer: ${maybe}`);
		}
		return maybe;
	}

	if (typeof maybe === "string") {
		const n = Number.parseInt(maybe, 10);
		if (!Number.isSafeInteger(n)) {
			throw new Error(`Key "${key}" cannot be parsed to a safe integer: ${n}`);
		}
		return n;
	}

	if (defaultValue === undefined) {
		throw new Error(`Key "${key}" does not present`);
	}
	return defaultValue;
}

export function randomBytes(size: number): Uint8Array {
	const arr = new Uint8Array(size);
	for (let i = 0; i < size; i++) {
		arr[i] = Math.floor(Math.random() * 256);
	}
	return arr;
}

export function hexdump(data: Uint8Array): string {
	const lines: string[] = [];
	for (let offset = 0; offset < data.length; offset += 16) {
		const chunk = data.slice(offset, offset + 16);
		const hexBytes = Array.from(chunk)
			.map(b => b.toString(16).padStart(2, "0"))
			.join(" ");
		const line = offset.toString(16).padStart(4, "0") + "  " + hexBytes;
		lines.push(line);
	}
	const result = lines.join("\n");
	console.log(result);
	return result;
}

export function base64ToUint8Array(base64Str: string): {
	success: true,
	data: Uint8Array,
} | {
	success: false,
	error?: unknown,
} {
	if (!base64Str) {
		return {
			success: true,
			data: new Uint8Array(0),
		};
	}

	try {
		// go use modified Base64 for URL rfc4648 which js atob not support
		base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
		const decode = atob(base64Str);
		const data = Uint8Array.from(decode, (c) => c.charCodeAt(0))
		return { success: true, data };
	} catch (error) {
		return { success: false, error };
	}
}

export function u8ArrayConcat(head: Uint8Array, tail: Uint8Array): Uint8Array {
	if (head.byteLength == 0) {
		// Copy-free where possible
		return tail;
	}

	if (tail.byteLength == 0) {
		// Copy-free where possible
		return head;
	}

	const result = new Uint8Array(head.byteLength + tail.byteLength);
	result.set(head, 0);
	result.set(tail, head.byteLength);
	return result;
}

export function randomInt(min: number, max: number): number {
	min = Math.ceil(min);
	max = Math.floor(max);

	// Math.random() gives [0,1)，so the outcome will be [min, max]
	return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function newPromiseWithHandle<T = void>(): {
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
	promise: Promise<T>;
} {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;

	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});

	return { resolve, reject, promise };
}

export function uuidToUint8Array(uuid: string | undefined, defaultValue?: string): Uint8Array {
	if (uuid === undefined) {
		if (defaultValue) {
			uuid = defaultValue;
		} else {
			throw new Error("The given UUID string is undefined and there is no default value!");
		}
	}

	// Check base format: 8-4-4-4-12, 36 chars in total
	const uuidRegex = /^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/;
	if (!uuidRegex.test(uuid)) {
		throw new Error(`Invalid UUID format: ${uuid}`);
	}

	const hex = uuid.replace(/-/g, "");
	if (hex.length !== 32) {
		throw new Error(`Invalid UUID length: ${hex.length}`);
	}

	const bytes = new Uint8Array(16);
	for (let i = 0; i < 16; i++) {
		const byte = hex.substr(i * 2, 2);
		const value = parseInt(byte, 16);
		if (isNaN(value)) {
			throw new Error(`Invalid hex at position ${i * 2}`);
		}
		bytes[i] = value;
	}

	return bytes;
}

export function equalUint8Array(a: Uint8Array, b: Uint8Array): boolean {
	if (a === b) return true;
	if (a.byteLength !== b.byteLength) return false;
	for (let i = 0; i < a.byteLength; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}
