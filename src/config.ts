import { OutboundHandler, SocketFactory } from "./outbound";

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
