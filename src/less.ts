import * as codec from "./codec";
import * as address from "./address";
import { DuplexStream } from "./stream";
import * as utils from "./utils"
import * as fairmux from "./fairmux"
import * as muxcool from "./muxcool";
import { GlobalConfig, UUIDUsage } from "./config";
import { handleOutBound } from "./outbound";

export const enum InstructionType {
	TCP = 1,
	UDP = 2,
	MUX = 3,
};

export interface LessRequestHeaderPart1 {
	version: number;
	uuid: Uint8Array;
}

export interface LessRequestHeaderPart2 {
	info: Uint8Array; // A ProtoBuf, not used here
	instruction: InstructionType;
	port: number;
	address: address.Address;
}

export interface LessRequestHeader extends LessRequestHeaderPart1, LessRequestHeaderPart2 { }

export const codecLessRequestHeaderPart1 = codec.codecOf<LessRequestHeader>(
	{ key: "version", codec: codec.codecU8 },
	{ key: "uuid", codec: codec.codecOfFixedLenU8Array(16) },
);

export const codecLessRequestHeaderPart2 = codec.codecOf<LessRequestHeader>(
	{ key: "info", codec: codec.codecU8SizedBytes },
	{ key: "instruction", codec: codec.codecU8 },
	{ key: "port", codec: codec.codecU16BE },
	{ key: "address", codec: address.codec_address },
);

export interface LessResponseHeader {
	version: number;
	info: Uint8Array; // A ProtoBuf, not used here
}

export const codecLessResponseHeader = codec.codecOf<LessResponseHeader>(
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

function createMasterKeepalive(internalDomain: string, log: utils.Logger): ReadableStream<fairmux.Datagram> {
	let taskId = NaN;
	return new ReadableStream({
		start(controller) {
			log("debug", "less/bridge", "Master keepalive started");
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
					addr: internalDomain,
					addrType: address.AddrType.DomainName,
				},
				port: 0
			});
		},
		cancel(reason) {
			log("debug", "less/bridge", "Master keepalive stopped");
			if (!Number.isNaN(taskId))
				clearInterval(taskId);
		},
	});
}

export class BridgeContext {
	private portals: fairmux.FairMux[] = [];

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

export function handlelessRequest(lessStream: DuplexStream, bridgeContext: BridgeContext | null, log: utils.Logger, config: GlobalConfig) {
	const { parser: lessRequestProcessor, lessHeaderPromise: lessRequestPromise } = makeLessHeaderProcessor();

	let remoteTrafficSink: WritableStream<Uint8Array> | null = null;
	const lessRequestHandler = new WritableStream({
		async write(chunk, controller) {
			const lessRequest = await lessRequestPromise;

			if (remoteTrafficSink && chunk.byteLength > 0) {
				// After we parse the header and send the first chunk to the remote destination
				// We assume that after the handshake, the stream only contains the original traffic.
				// log('Send traffic from less client to remote host');
				const writer = remoteTrafficSink.getWriter();
				await writer.ready;
				await writer.write(chunk);
				writer.releaseLock();
				return;
			}

			if (lessRequest.instruction == InstructionType.TCP &&
				lessRequest.address.addrType == address.AddrType.DomainName &&
				lessRequest.address.addr === config.portalDomainName) {
				// Reversed proxy

				if (!bridgeContext) {
					log("error", "less/bridge", "No in-memory state, cannot support bridge!");
					lessStream.close();
					return;
				}

				// Check uuid
				if (config.checkUuid(lessRequest.uuid) !== UUIDUsage.PORTAL_JOIN) {
					log("warn", "less/bridge", "Portal UUID is invalid!");
					lessStream.close();
					return;
				}

				// Reverse proxy request
				const mux = new fairmux.FairMux();
				const lessResponse: LessResponseHeader = {
					version: lessRequest.version,
					info: new Uint8Array(0),
				};

				mux.addInput(createMasterKeepalive(config.bridgeInternalDomain, log), createDummySink());

				// mux.addInput(createTestSource({
				// 	networkType: muxcool.NetworkType.UDP,
				// 	address: {
				// 		addr: "127.0.0.1",
				// 		addrType: address.AddrType.DomainName,
				// 	},
				// 	port: 2323
				// }, 2000, 5), createDummySink());

				mux.out.pipeThrough(muxcool.newMuxcollFrameEncoder(lessResponse, codecLessResponseHeader))
					.pipeTo(lessStream.writable).catch((err) => {
					console.log(err);
				});

				const muxcoolFrameDecoder = muxcool.newMuxcoolFrameDecoder();
				remoteTrafficSink = muxcoolFrameDecoder.writable;
				muxcoolFrameDecoder.readable.pipeTo(mux.in);

				const portalRemover = bridgeContext.addPortal(mux);
				lessStream.closed.finally(async () => {
					mux.terminate(true);
					portalRemover();
					log("info", "less/bridge", `portal left, ${bridgeContext.countPortal} available.`);
				});
	
				log("info", "less/bridge", `new portal joined, ${bridgeContext.countPortal} available.`);
			} else if (lessRequest.instruction == InstructionType.TCP || lessRequest.instruction == InstructionType.UDP) {
				// Normal proxy

				// Check uuid
				const uuidUsage = config.checkUuid(lessRequest.uuid);
				if (uuidUsage === UUIDUsage.INVALID || uuidUsage === UUIDUsage.PORTAL_JOIN) {
					log("warn", "less", "UUID is invalid");
					lessStream.close();
					return;
				}
				const protocolString = lessRequest.instruction == InstructionType.TCP ? "TCP" : "UDP";
				log("info", "less/inbound", `new request to ${protocolString}:${address.addressToString(lessRequest.address)}:${lessRequest.port}`);

				let lessResponse: LessResponseHeader | null = {
					version: lessRequest.version,
					info: new Uint8Array(0),
				};

				function lessResponsePrepender<T>(chunkDataGetter: (chunkIn: T) => Uint8Array) {
					return new TransformStream<T, Uint8Array>({
						transform: (chunk, controller) => {
							const u8Chunk = chunkDataGetter(chunk);
							if (lessResponse) {
								const bufferSize = codecLessResponseHeader.byteLength(lessResponse) + u8Chunk.byteLength;
								const buffer = new Uint8Array(bufferSize);
								const ctx = new codec.CodecContext(buffer);
								codecLessResponseHeader.write(lessResponse, ctx);
								ctx.push(u8Chunk);
								controller.enqueue(buffer);
								lessResponse = null;
							} else {
								controller.enqueue(u8Chunk);
							}
						}
					});
				};

				if (uuidUsage === UUIDUsage.TO_FREEDOM) {
					// Handle Client->Freedom

					try {
						const {
							readable,
							writable,
							closed,
						} = await handleOutBound(
							{
								isUDP: !(lessRequest.instruction === InstructionType.TCP),
								port: lessRequest.port,
								address: lessRequest.address,
								firstChunk: chunk,
							},
							config,
							log
						);
						remoteTrafficSink = writable;
						readable.pipeThrough(lessResponsePrepender(chunkIn => chunkIn)).pipeTo(lessStream.writable);
					} catch(e) {
						lessStream.close(e);
					}

					return;
				}

				// Handle Client->Portal
				if (!bridgeContext) {
					log("error", "less/bridge", "No in-memory state, cannot support bridge!");
					lessStream.close();
					return;
				}

				const mux = bridgeContext.findPortal();
				if (mux == null) {
					console.error("[Portal] no portal available");
					lessStream.close();
					return;
				}

				let dest: muxcool.MuxcoolConnectionInfo | null = {
					networkType: lessRequest.instruction as unknown as muxcool.NetworkType,
					address: lessRequest.address,
					port: lessRequest.port,
				}
				const requestProcessor = new TransformStream<Uint8Array, fairmux.Datagram>({
					start: (controller) => { // Process the first data chunk
						controller.enqueue({ info: dest, data: chunk });
						if (lessRequest.instruction == InstructionType.TCP) {
							// For TCP, include the destination only in the first muxcool frame (SUB_LINK_NEW)
							dest = null;
						}
					},
					transform: (chunk, controller) => {
						controller.enqueue({ info: dest, data: chunk });
					},
				});
				remoteTrafficSink = requestProcessor.writable;
	
				const responseProcessor = lessResponsePrepender<fairmux.Datagram>(chunkIn => chunkIn.data);
				responseProcessor.readable.pipeTo(lessStream.writable).catch((err) => {
					console.log(err);
				});

				mux.addInput(requestProcessor.readable, responseProcessor.writable);
			}

		},
		close: async () => {
			if (remoteTrafficSink) {
				await remoteTrafficSink?.close();
			}
		},
		abort: async (reason) => {
			if (remoteTrafficSink) {
				await remoteTrafficSink?.abort(reason);
			}
		},
	} as UnderlyingSink<Uint8Array>);

	lessStream.readable.pipeThrough(lessRequestProcessor)
		// .pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
		// 	transform(chunk, controller) {
		// 		console.log(`From less client: ${chunk.byteLength} bytes.`)
		// 		utils.hexdump(chunk);
		// 		controller.enqueue(chunk);
		// 	},
		// }))
		.pipeTo(lessRequestHandler).finally(() => {
			log("info", "lessStream.readable.pipeThrough(lessRequestProcessor).pipeTo(lessRequestHandler).finally");
		});
}

function makeLessHeaderProcessor() {
	let part1Decoder: codec.IncrementalDeserializer<LessRequestHeaderPart1> | null
		= codec.createIncrementalDeserializer(codecLessRequestHeaderPart1);
	let part2Decoder: codec.IncrementalDeserializer<LessRequestHeaderPart2> | null = null;
	let lessRequestHeaderPart1: LessRequestHeaderPart1 | null = null;
	let lessRequestHeader: LessRequestHeader | null = null;

	const {
		resolve: lessRequestHeaderPromiseResolve,
		promise: lessHeaderPromise,
	} = utils.newPromiseWithHandle<LessRequestHeader>();

	const parser = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			if (part2Decoder) {
				const outcome2 = part2Decoder(chunk);
				if (outcome2.done) {
					lessRequestHeader = {
						...lessRequestHeaderPart1!,
						...outcome2.value,
					};
					lessRequestHeaderPromiseResolve(lessRequestHeader);

					// Here we use a 0-size chunk to kick start
					controller.enqueue(outcome2.residue);
					part2Decoder = null;
				}
			} else if (part1Decoder) {
				const outcome1 = part1Decoder(chunk);
				if (outcome1.done) {
					lessRequestHeaderPart1 = outcome1.value;
					part2Decoder = codec.createIncrementalDeserializer(codecLessRequestHeaderPart2);
					part1Decoder = null;

					// Immediately check if we are able to parse part2
					const outcome2 = part2Decoder(outcome1.residue);
					if (outcome2.done) {
						lessRequestHeader = {
							...lessRequestHeaderPart1!,
							...outcome2.value,
						};
						lessRequestHeaderPromiseResolve(lessRequestHeader);

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

	return { parser, lessHeaderPromise: lessHeaderPromise };
}
