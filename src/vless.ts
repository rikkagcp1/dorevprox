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

function createTestSource(dest: muxcool.MuxcoolConnectionInfo | null, interval: number, count?: number) {
	let taskId = NaN;
	return new ReadableStream<fairmux.Datagram>({
		start(controller) {
			console.log("[TestSource] started");
			const sendDatagram = () => {
				const length = utils.randomInt(3, 10);
				const chunk = new Uint8Array(length);
				for (let i = 0; i < chunk.byteLength - 1; i++) {
					chunk[i] = utils.randomInt(97, 97 + 26);
				}
				chunk[chunk.byteLength - 1] = 10;
				controller.enqueue({info: dest, data: chunk});
				console.log(`Random data sent to outlet ${new TextDecoder().decode(chunk.subarray(0, chunk.byteLength - 1))}`);

				if (count) {
					count--;
					if (count === 0) {
						controller.close();
						return;
					}
				}

				taskId = setTimeout(sendDatagram, interval);
			}
			sendDatagram();
		},
		cancel(reason) {
			console.log("[TestSource] stopped");
			if (!Number.isNaN(taskId))
				clearInterval(taskId);
		},
	});
}

function createDummySink(prefix = "") {
	return new WritableStream<fairmux.Datagram>({
		write: (chunk, controller) => {
			console.log(`${prefix} Sent to remote sink: ${chunk.data.byteLength} bytes`);
			utils.hexdump(chunk.data);
		},
	} as UnderlyingSink<fairmux.Datagram>)
}

function createMasterKeepalive(): ReadableStream<fairmux.Datagram> {
	let taskId = NaN;
	return new ReadableStream({
		start(controller) {
			console.log("[Master keepalive] started");
			const keepAlive = (dest?: muxcool.MuxcoolConnectionInfo) => {
				const length = utils.randomInt(4, 100);
				const chunk = new Uint8Array(3 + length);
				// A Protobuf string
				chunk[0] = 0x9a;
				chunk[1] = 0x06;
				chunk[2] = length;
				for (let i = 3; i < chunk.byteLength; i++) {
					chunk[i] = Math.floor(Math.random() * 256);
				}
				controller.enqueue({
					info: dest ? dest : null,
					data: chunk,
				});
				// console.log(`Keep alive sent to outlet ${length}`);
				taskId = setTimeout(keepAlive, 5000);
			}

			// First packet
			keepAlive({
				networkType: muxcool.NetworkType.UDP,
				address: {
					addr: "reverse.internal.v2fly.org",
					addrType: address.AddrType.DomainName,
				},
				port: 0
			});
		},
		cancel(reason) {
			console.log("[Master keepalive] stopped");
			if (!Number.isNaN(taskId))
				clearInterval(taskId);
		},
	});
}

export interface SharedContext {
	portals: fairmux.FairMux[];
}

export function defaultSharedContext(): SharedContext {
	return {
		portals: []
	}
}

export async function handleVlessRequest(websocketStream: wsstream.WebSocketStreamLike, context: SharedContext) {
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
				const mux = new fairmux.FairMux();
				const vlessResponse: VlessResponseHeader = {
					version: vlessRequest.version,
					info: new Uint8Array(0),
				};

				mux.addInput(createMasterKeepalive(), createDummySink());

				mux.addInput(createTestSource({
					networkType: muxcool.NetworkType.UDP,
					address: {
						addr: "127.0.0.1",
						addrType: address.AddrType.DomainName,
					},
					port: 2323
				}, 2000, 5), createDummySink());

				mux.out.pipeThrough(muxcool.newMuxcollFrameEncoder(vlessResponse, codecVlessResponseHeader))
					.pipeTo(opened.writable).catch((err) => {
					console.log(err);
				});

				const muxcoolFrameDecoder = muxcool.newMuxcoolFrameDecoder();
				remoteTrafficSink = muxcoolFrameDecoder.writable;
				muxcoolFrameDecoder.readable.pipeTo(mux.in);

				websocketStream.closed.finally(async () => {
					mux.terminate(true);
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

	const {
		resolve: vlessRequestHeaderPromiseResolve,
		reject: vlessRequestHeaderPromiseReject,
		promise: vlessHeaderPromise,
	} = utils.newPromiseWithHandle<VlessRequestHeader>();

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
