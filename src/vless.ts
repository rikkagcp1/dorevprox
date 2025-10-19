import * as codec from "./codec";
import * as address from "./address";
import * as wsstream from "./wsstream"
import * as utils from "./utils"
import * as fairmux from "./fairmux"
import * as muxcool from "./muxcool";

const PORTAL_DOMAIN_NAME = "cyka.blayt.su";
const maxMuxCurrency = 8;

export type UUID = Uint8Array & { readonly length: 16 };

export const enum InstructionType {
	TCP = 1,
	UDP = 2,
	MUX = 3,
};

export interface VlessRequestHeaderPart1 {
	version: number;
	uuid: UUID;
}

export interface VlessRequestHeaderPart2 {
	info: Uint8Array; // A ProtoBuf, not used here
	instruction: InstructionType;
	port: number;
	address: address.Address;
}

export interface VlessRequestHeader extends VlessRequestHeaderPart1, VlessRequestHeaderPart2 { }

export const codecVlessRequestHeaderPart1 = codec.codecOf<VlessRequestHeader>(
	{ key: "version", codec: codec.codecU8 },
	{ key: "uuid", codec: codec.codecOfFixedLenU8Array(16) },
);

export const codecVlessRequestHeaderPart2 = codec.codecOf<VlessRequestHeader>(
	{ key: "info", codec: codec.codecU8SizedBytes },
	{ key: "instruction", codec: codec.codecU8 },
	{ key: "port", codec: codec.codecU16BE },
	{ key: "address", codec: address.codec_address },
);

export interface VlessResponseHeader {
	version: number;
	info: Uint8Array; // A ProtoBuf, not used here
}

export const codecVlessResponseHeader = codec.codecOf<VlessResponseHeader>(
	{ key: "version", codec: codec.codecU8 },
	{ key: "info", codec: codec.codecU8SizedBytes },
);

function equalUint8Array(a: Uint8Array, b: Uint8Array): boolean {
	if (a === b) return true;
	if (a.byteLength !== b.byteLength) return false;
	for (let i = 0; i < a.byteLength; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function checkUUID(uuid: Uint8Array) {
	return true; // TODO: Fix me
}

function createTestSource(count: number) {
	return new ReadableStream({
		start(controller) {
			const keepAlive = () => {
				const length = utils.randomInt(3, 10);
				const chunk = new Uint8Array(length);
				for (let i = 0; i < chunk.byteLength - 1; i++) {
					chunk[i] = utils.randomInt(97, 97+26);
				}
				chunk[chunk.byteLength - 1] = 10;
				controller.enqueue(chunk);
				console.log(`Random data sent to outlet ${new TextDecoder().decode(chunk.subarray(0, chunk.byteLength - 1))}`);

				count--;
				if (count)
					setTimeout(keepAlive, 500);
				else
					controller.close();
			}
			keepAlive();
		},
	});
}

function createDummySink() {
	return new WritableStream<Uint8Array>({
		write(chunk, controller) {
			console.log(`Sent to remote sink: ${chunk.byteLength} bytes`);
			utils.hexdump(chunk);
		},
	} as UnderlyingSink<Uint8Array>)
}

function createMasterKeepalive() {
	return new ReadableStream({
		start(controller) {
			const keepAlive = () => {
				const length = utils.randomInt(4, 100);
				const chunk = new Uint8Array(3 + length);
				// A Protobuf string
				chunk[0] = 0x9a;
				chunk[1] = 0x06;
				chunk[2] = length;
				for (let i = 3; i < chunk.byteLength; i++) {
					chunk[i] = Math.floor(Math.random() * 256);
				}
				controller.enqueue(chunk);
				// console.log(`Keep alive sent to outlet ${length}`);
				setTimeout(keepAlive, 5000);
			}
			keepAlive();
		},
	});
}

export async function handleVlessRequest(websocketStream: wsstream.WebSocketStreamLike) {
	const opened = await websocketStream.opened;
	const { parser: vlessRequestProcessor, vlessHeaderPromise: vlessRequestPromise } = makeVlessHeaderProcessor();

	let remoteTrafficSink: WritableStream<Uint8Array> | null = null;
	const vlessRequestHandler = new WritableStream({
		async write(chunk, controller) {
			const vlessRequest = await vlessRequestPromise;

			if (remoteTrafficSink && chunk.byteLength > 0) {
				// After we parse the header and send the first chunk to the remote destination
				// We assume that after the handshake, the stream only contains the original traffic.
				// log('Send traffic from vless client to remote host');
				const writer = remoteTrafficSink.getWriter();
				await writer.ready;
				await writer.write(chunk);
				writer.releaseLock();
				return;
			}

			if (vlessRequest.instruction == InstructionType.TCP &&
				vlessRequest.address.addrType == address.AddrType.DomainName &&
				vlessRequest.address.addr === PORTAL_DOMAIN_NAME) {

				// Reverse proxy request
				remoteTrafficSink = createDummySink();
				const mux = new fairmux.FairMux();
				let vlessResponse:VlessResponseHeader | null = {
					version: vlessRequest.version,
					info: new Uint8Array(0),
				}

				mux.addInput(createMasterKeepalive(), {
					networkType: muxcool.NetworkType.UDP,
					address: {
						addr: "reverse.internal.v2fly.org",
						addrType: address.AddrType.DomainName,
					},
					port: 0
				});

				mux.addInput(createTestSource(5), {
					networkType: muxcool.NetworkType.UDP,
					address: {
						addr: "127.0.0.1",
						addrType: address.AddrType.DomainName,
					},
					port: 2323
				});

				mux.out.pipeThrough(new TransformStream<muxcool.MuxcoolFrame, Uint8Array>({
					transform(chunk, controller) {
						const muxcoolFrameLen = muxcool.codecU16BESizedMuxcoolHeaders.byteLength(chunk.header)
							+ (chunk.payload ? codec.codecU16BESizedBytes.byteLength(chunk.payload) : 0);

						const length = vlessResponse ? codecVlessResponseHeader.byteLength(vlessResponse) + muxcoolFrameLen : muxcoolFrameLen;
						const buffer = new Uint8Array(length);
						const ctx = new codec.CodecContext(buffer);

						if (vlessResponse) {
							codecVlessResponseHeader.write(vlessResponse, ctx);
							vlessResponse = null;
							console.log(JSON.stringify(vlessRequest));
						}
						muxcool.codecU16BESizedMuxcoolHeaders.write(chunk.header, ctx);
						if (chunk.payload) {
							codec.codecU16BESizedBytes.write(chunk.payload, ctx);
						}

						controller.enqueue(buffer);
					},
				})).pipeTo(opened.writable).catch((err) => {
					console.log(err);
				});
			}
		},
	} as UnderlyingSink<Uint8Array>);

	opened.readable.pipeThrough(vlessRequestProcessor)
		.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				console.log(`From vless client: ${chunk.byteLength} bytes.`)
				utils.hexdump(chunk);
				controller.enqueue(chunk);
			},
		}))
		.pipeTo(vlessRequestHandler);
}

function makeVlessHeaderProcessor() {
	let part1Decoder: codec.IncrementalDeserializer<VlessRequestHeaderPart1> | null
		= codec.createIncrementalDeserializer(codecVlessRequestHeaderPart1);
	let part2Decoder: codec.IncrementalDeserializer<VlessRequestHeaderPart2> | null = null;
	let vlessRequestHeaderPart1: VlessRequestHeaderPart1 | null = null;
	let vlessRequestHeader: VlessRequestHeader | null = null;

	let vlessRequestHeaderPromiseResolve: (result: VlessRequestHeader) => void;
	let vlessRequestHeaderPromiseReject: (error: any) => void;
	const vlessHeaderPromise = new Promise<VlessRequestHeader>((resolve, reject) => {
		vlessRequestHeaderPromiseResolve = resolve;
		vlessRequestHeaderPromiseReject = reject;
	});

	const parser = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			if (part2Decoder) {
				const outcome2 = part2Decoder(chunk);
				if (outcome2.done) {
					vlessRequestHeader = {
						...vlessRequestHeaderPart1!,
						...outcome2.value,
					};
					vlessRequestHeaderPromiseResolve(vlessRequestHeader);

					// Here we use a 0-size chunk to kick start
					controller.enqueue(outcome2.residue);
					part2Decoder = null;
				}
			} else if (part1Decoder) {
				const outcome1 = part1Decoder(chunk);
				if (outcome1.done) {
					if (!checkUUID(outcome1.value.uuid)) {
						const error = new Error("Wrong UUID");
						vlessRequestHeaderPromiseReject(error);
						controller.error(error);
					}

					vlessRequestHeaderPart1 = outcome1.value;
					part2Decoder = codec.createIncrementalDeserializer(codecVlessRequestHeaderPart2);
					part1Decoder = null;

					// Immediately check if we are able to parse part2
					const outcome2 = part2Decoder(outcome1.residue);
					if (outcome2.done) {
						vlessRequestHeader = {
							...vlessRequestHeaderPart1!,
							...outcome2.value,
						};
						vlessRequestHeaderPromiseResolve(vlessRequestHeader);

						// Here we use a 0-size chunk to kick start
						controller.enqueue(outcome2.residue);
						part2Decoder = null;
					}
				}
			} else {
				// Direct passthrough after we parsed the header
				controller.enqueue(chunk);
			}
		},
	});

	return { parser, vlessHeaderPromise };
}
