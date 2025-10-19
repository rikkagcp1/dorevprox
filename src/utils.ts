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

export function newPromiseWithHandle<T>(): {
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
