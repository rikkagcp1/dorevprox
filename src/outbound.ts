import { Address, addressToString } from "./address";
import { DuplexStream } from "./stream";
import { GlobalConfig } from "./config";
import { NumberMap, newNumberMap, childStringOf, childIntOf, uuidToUint8Array, Logger, withTimeout } from "./utils";

interface OutboundRequest {
	isUDP: boolean,
	/**
	 * Remote destionation
	 */
	address: Address,
	port: number,
	/**
	 * The first chunk of data send to the remote destionation
	 */
	firstChunk: Uint8Array,
}

export interface SocketFactory {
	newTcp: (host: string, port: number) => Promise<DuplexStream>,
}

interface OutboundContext extends SocketFactory {
	log: Logger,
}

type OutboundProtocol = "freedom" | "forward" | "socks" | "ws";

export interface OutboundHandler {
	readonly protocol: OutboundProtocol;
	readonly mayDoUDP: (request: OutboundRequest) => boolean;
	readonly handler: (request: OutboundRequest, context: OutboundContext) => Promise<DuplexStream>;
}

async function writeChunk(writableStream: WritableStream<Uint8Array>, chunk: Uint8Array) {
	const writer = writableStream.getWriter();
	await writer.write(chunk);
	writer.releaseLock();
}

async function handleFreedom(request: OutboundRequest, context: OutboundContext, dnsTCPServer: string | null) {
	const logSource = "less/outbound/freedom";

	let addressString = addressToString(request.address);
	if (request.isUDP && request.port == 53 && dnsTCPServer != null) {
		// Forward the UDP DNS request to a TCP DNS server
		addressString = dnsTCPServer;
		context.log("info", logSource, `Redirect DNS request to tcp://${addressString}:${request.port}`)
	} else if (request.isUDP) {
		// UDP to other port, or dnsTCPServer is not set
		// TODO: Handle UDP
		throw new Error("UDP unimplemented!");
	}

	context.log("info", logSource, `Connecting to tcp://${addressString}:${request.port}`);

	const tcpSocket = await context.newTcp(addressString, request.port);
	tcpSocket.closed.then(() => context.log("info", logSource, "TCP Closed"));
	tcpSocket.closed.catch(error => context.log("info", logSource, "Tcp socket closed with error: ", error.message));
	await writeChunk(tcpSocket.writable, request.firstChunk);
	return tcpSocket;
}

async function handleForward(request: OutboundRequest, context: OutboundContext, proxyServer: string, portMap: NumberMap | null) {
	const logSource = "less/outbound/forward";

	let portDest = request.port;
	if (portMap) {
		portDest = portMap[request.port];

		if (!portDest) {
			portDest = request.port;
		}
	}

	const addressString = addressToString(request.address);
	context.log("info", logSource, `Forwarding tcp://${addressString}:${request.port} to ${proxyServer}:${portDest}`);

	const tcpSocketPromise = context.newTcp(proxyServer, portDest);
	const tcpSocket = await withTimeout(tcpSocketPromise, 3000, "TCP connection timeout");
	tcpSocket.closed.catch(error => console.log('[forward] tcpSocket closed with error: ', error.message));
	await writeChunk(tcpSocket.writable, request.firstChunk);
	return tcpSocket;
}

async function handleSocks5(request: OutboundRequest, context: OutboundContext, proxyServer: string, proxyPort: number, user: string|null, pass: number) {
	throw new Error("Not implemented!");
	return {} as unknown as DuplexStream;
}

async function handleWs(request: OutboundRequest, context: OutboundContext, proxyServer: string, proxyPort: number, path: string, uuid: Uint8Array) {
	throw new Error("Not implemented!");
	return {} as unknown as DuplexStream;
}

export function parseOutboundConfig(jsonArray: any[]) {
	const outboundHandlers: OutboundHandler[] = [];

	let i = 0;
	for (const jsonObject of jsonArray) {
		if (typeof jsonObject !== "object" || jsonObject === null) {
			throw new Error(`Invalid config item at index ${i}: not an object`);
		}

		const protocolString = jsonObject["protocol"];
		switch (protocolString) {
			case "freedom": {
				let dnsTCPServer: string | null = null;
				try {
					dnsTCPServer = childStringOf(jsonObject, "dnsTCPServer");
				} catch {}
				outboundHandlers.push({
					protocol: "freedom",
					mayDoUDP: (request) => {
						// Check if we should forward UDP DNS requests to a designated TCP DNS server.
						// The less packing of UDP datagrams is identical to the one used in TCP DNS protocol,
						// so we can directly send raw less traffic to the TCP DNS server.
						// TCP DNS requests will not be touched.
						// If fail to directly reach the TCP DNS server, UDP DNS request will be attempted on the other outbounds
						// TODO: check platform supports UDP outbound first
						return request.port == 53 && dnsTCPServer != null;
					},
					handler: async (request, context) => handleFreedom (request, context, dnsTCPServer),
				});
			} break;

			case "forward": {
				const portMapObj = jsonObject["portMap"];
				const portMap: NumberMap | null =
					(portMapObj && typeof portMapObj === "object") ? newNumberMap(portMapObj) : null;
				const proxyServer = childStringOf(jsonObject, "address");

				outboundHandlers.push({
					protocol: "forward",
					mayDoUDP: () => false,
					handler: async (request, context) => handleForward(request, context, proxyServer, portMap),
				});
			} break;

			case "socks": {
				const proxyServer = childStringOf(jsonObject, "address");
				const proxyPort = childIntOf(jsonObject, "port");

				// These are optional
				let user: string | null = null;
				try {
					user = childStringOf(jsonObject, "user");
				} catch {}
				const pass = childIntOf(jsonObject, "pass", 0);
				outboundHandlers.push({
					protocol: "socks",
					mayDoUDP: () => false,
					handler: async (request, context) => handleSocks5(request, context, proxyServer, proxyPort, user, pass),
				});
			} break;

			case "ws": {
				const proxyServer = childStringOf(jsonObject, "address");
				const proxyPort = childIntOf(jsonObject, "port");
				const path = childStringOf(jsonObject, "path");
				const uuidString = childStringOf(jsonObject, "uuid");
				const uuid = uuidToUint8Array(uuidString);
				outboundHandlers.push({
					protocol: "ws",
					mayDoUDP: () => true,
					handler: async (request, context) => handleWs(request, context, proxyServer, proxyPort, path, uuid),
				});
			} break;

			default:
				throw new Error(`Invalid protocol "${protocolString}"`);
		}

		i++;
	}

	return outboundHandlers;
}

export async function handleOutBound(request: OutboundRequest, globalConfig: GlobalConfig, log: Logger,): Promise<DuplexStream> {
	// Try each outbound method until we find a working one.
	for (const outbound of globalConfig.outbounds) {
		if (request.isUDP && !outbound.mayDoUDP(request)) {
			continue; // This outbound method does not support UDP
		}

		log("debug", "less/outbound", `attemping ${outbound.protocol}`);

		try {
			// Wait for this handler to establish a remote connection
			const toDest = await outbound.handler(request, {
				log,
				...globalConfig.socketFactory,
			});

			const remoteReader = toDest.readable.getReader();

			const { done, value: firstChunk } = await remoteReader.read();

			if (done || firstChunk == undefined) {
				// Normal closure, no data. Likely being actively rejected.
				remoteReader.releaseLock();
				continue;
			}

			// Connection established and the remote replied us something
			const newReadable = new ReadableStream<Uint8Array>({
				start(controller) {
					// Don't forget to send the first chunk
					controller.enqueue(firstChunk);
				},
				async pull(controller) {
					const { done, value } = await remoteReader.read();
					if (done) {
						controller.close();
					} else {
						controller.enqueue(value);
					}
				},
				cancel(reason) {
					return remoteReader.cancel(reason);
				}
			});

			log("debug", "less/outbound", `handled by ${outbound.protocol}`);
			return { 
				readable: newReadable,
				writable: toDest.writable,
				close: () => toDest.close(),
				closed: toDest.closed,
			};
		} catch(e) {
			log("debug", `${outbound.protocol} failed with:`, e);
		}
	}

	throw new Error('No more available outbound chain, abort!')
}
