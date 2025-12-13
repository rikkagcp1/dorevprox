import { uuidToUint8Array, equalUint8Array } from "./utils";
import { OutboundHandler, SocketFactory, parseOutboundConfig } from "./outbound";
import { DuplexStreamOfTcp } from "./socket";

export const enum UUIDUsage {
	INVALID = -1,
	PORTAL_JOIN = 0,
	TO_PORTAL = 1,
	TO_FREEDOM = 2,
};

export interface GlobalConfig {
	readonly portalDomainName: string;
	readonly bridgeInternalDomain: string;
	readonly checkUuid: (uuid: Uint8Array) => UUIDUsage;
	readonly outbounds: OutboundHandler[];
	readonly socketFactory: SocketFactory;
}

export function parseEnv(env: Env) : GlobalConfig {
	const uuid_portal = uuidToUint8Array(env.UUID_PORTAL, "3bcd5018-a42f-4584-a1db-bc7a3592037a");
	const uuid_client = uuidToUint8Array(env.UUID_CLIENT, "f4e37f87-9156-4698-bba8-87847d23c83e");
	const uuid_user = uuidToUint8Array(env.UUID, "f1f8dc41-64d4-4c21-898c-035fe9c55763");

	let outbounds: OutboundHandler[];
	const outboundString = env.OUTBOUNDS;
	if (outboundString) {
		const outboundsRawJson = JSON.parse(outboundString);
		outbounds = parseOutboundConfig(outboundsRawJson);
	} else {
		const outboundsRawJson: unknown[] = [];

		// Freedom
		const freedomRawJson: { [key: string]: any } = {
			protocol: "freedom",
		};

		if (env.TCPDNS) {
			freedomRawJson.dnsTCPServer = env.TCPDNS;
		}
		outboundsRawJson.push(freedomRawJson);

		// Forward
		if (env.PROXYIP) {
			const forwardRawJson: { [key: string]: any } = {
				protocol: "forward",
				address: env.PROXYIP,
			};

			if (env.PORTMAP) {
				forwardRawJson.portMap = JSON.parse(env.PORTMAP);
			}

			outboundsRawJson.push(forwardRawJson);
		}

		// End of parsing individual env
		outbounds = parseOutboundConfig(outboundsRawJson);
	}

	return {
		portalDomainName: env.PORTAL ?? "portal.internal",
		bridgeInternalDomain: env.BRIDGE ?? "reverse",
		checkUuid: (uuid) => {
			if (equalUint8Array(uuid, uuid_portal))
				return UUIDUsage.PORTAL_JOIN;

			if (equalUint8Array(uuid, uuid_client))
				return UUIDUsage.TO_PORTAL;

			if (equalUint8Array(uuid, uuid_user))
				return UUIDUsage.TO_FREEDOM;

			return UUIDUsage.INVALID;
		},
		outbounds,
		socketFactory: {
			newTcp: DuplexStreamOfTcp,
		}
	};
}
