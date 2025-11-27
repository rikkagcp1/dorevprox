import { DurableObject } from "cloudflare:workers";
import * as less from "./less"
import * as http from "./http";
import * as utils from "./utils"
import { DuplexStreamFromWs } from "./stream"
import { GlobalConfig, parseEnv } from "./config"

const durableObjEndpoint = "/do";
const httpEndpoint = "/http";

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

function handleWs(request: Request, bridgeContext: less.BridgeContext | null, configProvider: () => GlobalConfig) {
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
	less.handlelessRequest(lessStream, bridgeContext, logger, globalConfig);

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
			case "GET": {
				const upgradeHeader = request.headers.get('Upgrade');
				if (upgradeHeader && upgradeHeader === 'websocket') {
					const globalConfig = parseEnv(env);
					return handleWs(request, null, () => globalConfig);
				} else {
					switch (url.pathname) {
						case "/ip":
							return fetch("https://ifconfig.co");
					}
				}
			} break;

			case "POST": {
				const httpInbound = http.parseInboundPath(url.pathname, httpEndpoint);
				if (httpInbound) {
					const globalConfig = parseEnv(env);
					return http.handleHttp(httpInbound, request, null, globalConfig);
				}
			} break;
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
}

// Durable Object
export class WebSocketHibernationServer extends DurableObject {
	// In-memory states
	globalConfig: GlobalConfig;
	bridgeContext = new less.BridgeContext(); // Tracks the reverse proxy states
	httpContext = new http.StatefulContext();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);

		this.globalConfig = parseEnv(env);
	}

	async fetch(request: Request): Promise<Response> {
		const pathname = (new URL(request.url)).pathname.substring(durableObjEndpoint.length);

		switch (request.method) {
			case "GET": {
				const upgradeHeader = request.headers.get('Upgrade');
				if (upgradeHeader && upgradeHeader === 'websocket') {
					return handleWs(request, this.bridgeContext, () => this.globalConfig);
				} else {
					const httpInbound = http.parseInboundPath(pathname, httpEndpoint);
					if (httpInbound) {
						return await http.handleHttp(httpInbound, request, this.httpContext, this.globalConfig);
					}

					switch (pathname) {
						case "/stats":
							const portalLoad = this.bridgeContext.getPortalLoad();
							return new Response(populateStatPage(portalLoad));
						case "/ip":
							return fetch("https://ifconfig.co");
						case "/conn":
							return new Response(this.httpContext.summary());
					}
				}
			} break;

			case "POST": {
				const httpInbound = http.parseInboundPath(pathname, httpEndpoint);
				if (httpInbound) {
					return await http.handleHttp(httpInbound, request, this.httpContext, this.globalConfig);
				}
			} break;
		}

		return new Response(null, {
			status: 404,
		});
	}
}
