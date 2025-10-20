import * as codec from "./codec";
import * as address from "./address";
import * as wsstream from "./wsstream"
import * as utils from "./utils"
import * as fairmux from "./fairmux"
import * as muxcool from "./muxcool";

const PORTAL_DOMAIN_NAME = "cyka.blayt.su";

export const enum InstructionType {
	TCP = 1,
	UDP = 2,
	MUX = 3,
};

export interface VlessRequestHeaderPart1 {
	version: number;
	uuid: Uint8Array;
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

export class SharedContext {
	private portals: fairmux.FairMux[] = [];

	constructor(readonly checkUuid: (uuid: Uint8Array, isPortal: boolean) => boolean) {}

	/**
	 * Add a portal to the list
	 * @param portal 
	 * @returns a function that removes this portal from the list
	 */
	addPortal(portal: fairmux.FairMux): ()=>void {
		this.portals.push(portal);
		return () => this.portals = this.portals.filter(x => x !== portal);
	}

	/**
	 * @returns a portal with least number of sublinks
	 */
	findPortal(): fairmux.FairMux | null {
		let candidate: fairmux.FairMux | null = null;
		for (const portal of this.portals) {
			if (!candidate || candidate.count > portal.count)
				candidate = portal;
		}
		return candidate;
	}

	get countPortal() {
		return this.portals.length;
	}

	getPortalLoad() {
		return this.portals.map((portal) => portal.count);
	}
}

export async function handleVlessRequest(websocketStream: wsstream.WebSocketStreamLike, sharedContext: SharedContext) {
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
				// Reversed proxy

				// Check uuid
				if (!sharedContext.checkUuid(vlessRequest.uuid, true)) {
					console.error("[Portal] UUID is invalid");
					websocketStream.close();
					return;
				}

				// Reverse proxy request
				const mux = new fairmux.FairMux();
				const vlessResponse: VlessResponseHeader = {
					version: vlessRequest.version,
					info: new Uint8Array(0),
				};

				mux.addInput(createMasterKeepalive(), createDummySink());

				// mux.addInput(createTestSource({
				// 	networkType: muxcool.NetworkType.UDP,
				// 	address: {
				// 		addr: "127.0.0.1",
				// 		addrType: address.AddrType.DomainName,
				// 	},
				// 	port: 2323
				// }, 2000, 5), createDummySink());

				mux.out.pipeThrough(muxcool.newMuxcollFrameEncoder(vlessResponse, codecVlessResponseHeader))
					.pipeTo(opened.writable).catch((err) => {
					console.log(err);
				});

				const muxcoolFrameDecoder = muxcool.newMuxcoolFrameDecoder();
				remoteTrafficSink = muxcoolFrameDecoder.writable;
				muxcoolFrameDecoder.readable.pipeTo(mux.in);

				const portalRemover = sharedContext.addPortal(mux);
				websocketStream.closed.finally(async () => {
					mux.terminate(true);
					portalRemover();
					console.log(`[Portal] portal left, ${sharedContext.countPortal} available.`);
				});
	
				console.log(`[Portal] new portal joined, ${sharedContext.countPortal} available.`);
			} else if (vlessRequest.instruction == InstructionType.TCP || vlessRequest.instruction == InstructionType.UDP) {
				// Normal proxy

				// Check uuid
				if (!sharedContext.checkUuid(vlessRequest.uuid, false)) {
					console.error("[Portal] UUID is invalid");
					websocketStream.close();
					return;
				}
				const protocolString = vlessRequest.instruction == InstructionType.TCP ? "TCP" : "UDP";
				console.log(`[Inbound] new request to ${protocolString}:${address.addressToString(vlessRequest.address)}:${vlessRequest.port}`);

				const mux = sharedContext.findPortal();
				if (mux == null) {
					console.error("[Portal] no portal available");
					websocketStream.close();
					return;
				}

				let vlessResponse: VlessResponseHeader | null = {
					version: vlessRequest.version,
					info: new Uint8Array(0),
				};

				let dest: muxcool.MuxcoolConnectionInfo | null = {
					networkType: vlessRequest.instruction as unknown as muxcool.NetworkType,
					address: vlessRequest.address,
					port: vlessRequest.port,
				}
				const requestProcessor = new TransformStream<Uint8Array, fairmux.Datagram>({
					start: (controller) => { // Process the first data chunk
						controller.enqueue({ info: dest, data: chunk });
						if (vlessRequest.instruction == InstructionType.TCP) {
							// For TCP, include the destination only in the first muxcool frame (SUB_LINK_NEW)
							dest = null;
						}
					},
					transform: (chunk, controller) => {
						controller.enqueue({ info: dest, data: chunk });
					},
				});
				remoteTrafficSink = requestProcessor.writable;

				const responseProcessor = new TransformStream<fairmux.Datagram, Uint8Array>({
					transform: (chunk, controller) => {
						if (vlessResponse) {
							const bufferSize = codecVlessResponseHeader.byteLength(vlessResponse) + chunk.data.byteLength;
							const buffer = new Uint8Array(bufferSize);
							const ctx = new codec.CodecContext(buffer);
							codecVlessResponseHeader.write(vlessResponse, ctx);
							ctx.push(chunk.data);
							controller.enqueue(buffer);
							vlessResponse = null;
						} else {
							controller.enqueue(chunk.data);
						}
					}
				});
				responseProcessor.readable.pipeTo(opened.writable).catch((err) => {
					console.log(err);
				});

				mux.addInput(requestProcessor.readable, responseProcessor.writable);
			}

		},
	} as UnderlyingSink<Uint8Array>);

	opened.readable.pipeThrough(vlessRequestProcessor)
		// .pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
		// 	transform(chunk, controller) {
		// 		console.log(`From vless client: ${chunk.byteLength} bytes.`)
		// 		utils.hexdump(chunk);
		// 		controller.enqueue(chunk);
		// 	},
		// }))
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
