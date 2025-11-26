import { DurableObject } from "cloudflare:workers";
import * as less from "./less"
import * as utils from "./utils"
import { DuplexStreamFromWs } from "./stream"
import { GlobalConfig, UUIDUsage } from "./config"

const durableObjEndpoint = "/do";

export function populateStatPage(portalLoad: number[]): string {
	const now = new Date().toISOString();

	const loads = (portalLoad ?? []).map(n =>
		Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0
	);

	const portalCount = loads.length;
	const totalConnections = loads.reduce((s, n) => s + n, 0);

	const lines: string[] = [];
	lines.push("Portal Status");
	lines.push("==============");
	lines.push(`Portals: ${portalCount}`);
	lines.push(`Total connections: ${totalConnections}`);
	lines.push(`Generated at: ${now}`);
	lines.push("");

	if (portalCount === 0) {
		lines.push("No portals found.");
	} else {
		lines.push("Per-portal load:");
		loads.forEach((cnt, idx) => {
			lines.push(`- Portal #${idx + 1}: ${cnt} connection${cnt === 1 ? "" : "s"}`);
		});
	}

	return lines.join("\n");
}

function parseEnv(env: Env) : GlobalConfig {
	const uuid_portal = utils.uuidToUint8Array(env.UUID_PORTAL, "3bcd5018-a42f-4584-a1db-bc7a3592037a");
	const uuid_client = utils.uuidToUint8Array(env.UUID_CLIENT, "f4e37f87-9156-4698-bba8-87847d23c83e");
	const uuid_user = utils.uuidToUint8Array(env.UUID, "f1f8dc41-64d4-4c21-898c-035fe9c55763");

	return {
		portalDomainName: "cyka.blayt.su",
		bridgeInternalDomain: "reverse",
		checkUuid: (uuid) => {
			if (utils.equalUint8Array(uuid, uuid_portal))
				return UUIDUsage.PORTAL_JOIN;

			if (utils.equalUint8Array(uuid, uuid_client))
				return UUIDUsage.TO_PORTAL;

			if (utils.equalUint8Array(uuid, uuid_user))
				return UUIDUsage.TO_FREEDOM;

			return UUIDUsage.INVALID;
		},
	};
}

function handleWs(request: Request, configProvider: () => GlobalConfig) {
	const webSocketPair = new WebSocketPair();
	const [client, server] = Object.values(webSocketPair);

	const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
	const earlyDataParseResult = utils.base64ToUint8Array(earlyDataHeader);
	if (!earlyDataParseResult.success) {
		return new Response(null, { status: 500 });
	}

	server.accept();

	const uuid = crypto.randomUUID();
	const logPrefix = uuid.substring(0, 6);
	const logger = utils.createLogger(logPrefix);
	const globalConfig = configProvider();

	const lessStream = DuplexStreamFromWs(server, earlyDataParseResult.data, logger);
	less.handlelessRequest(lessStream, null, logger, globalConfig);

	return new Response(null, {
		status: 101,
		webSocket: client,
	});
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname.startsWith(durableObjEndpoint)) {
			// Let durable object handle the request
			return env.WEBSOCKET_HIBERNATION_SERVER.getByName("foo").fetch(request);
		}

		switch (request.method) {
			case "GET":
				const upgradeHeader = request.headers.get('Upgrade');
				if (upgradeHeader && upgradeHeader === 'websocket') {
					const globalConfig = parseEnv(env);
					return handleWs(request, () => globalConfig);
				} else {
					switch (url.pathname) {
						case "/ip":
							return fetch("https://ifconfig.co");
					}
				}
		}

		return new Response(
			"Expects a WebSocket upgrade request",
			{
				status: 200,
				headers: {
					'Content-Type': 'text/plain',
				},
			}
		);
	},
};

// Durable Object
export class WebSocketHibernationServer extends DurableObject {
	// In-memory states
	globalConfig: GlobalConfig;
	bridgeContext = new less.BridgeContext(); // Tracks the reverse proxy states

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);

		this.globalConfig = parseEnv(env);
	}

	async fetch(request: Request): Promise<Response> {
		const pathname = (new URL(request.url)).pathname.substring(durableObjEndpoint.length);

		switch (request.method) {
			case "GET":
				const upgradeHeader = request.headers.get('Upgrade');
				if (upgradeHeader && upgradeHeader === 'websocket') {
					return handleWs(request, () => this.globalConfig);
				} else {
					switch (pathname) {
						case "/stats":
							const portalLoad = this.bridgeContext.getPortalLoad();
							return new Response(populateStatPage(portalLoad));
						case "/ip":
							return fetch("https://ifconfig.co");
					}
				}
		}

		return new Response(null, {
			status: 404,
		});
	}
}
