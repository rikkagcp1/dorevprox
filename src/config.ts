export const enum UUIDUsage {
	INVALID = -1,
	PORTAL_JOIN = 0,
	TO_PORTAL = 1,
	TO_FREEDOM = 2,
};

export interface GlobalConfig {
	portalDomainName: string;
	bridgeInternalDomain: string;
	checkUuid: (uuid: Uint8Array) => UUIDUsage;
}
