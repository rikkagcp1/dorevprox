import { DuplexStream } from "./stream";
import { connect } from "cloudflare:sockets";

export async function DuplexStreamOfTcp(hostname: string, port: number) : Promise<DuplexStream> {
	let downStreamRequestClose = false;
	let upStreamRequestClose = false;

	const socket = connect({hostname, port}, {allowHalfOpen: true});
	await socket.opened;

	const writer = socket.writable.getWriter();
	writer.closed.catch((reason)=>{
		console.log("socket.writable.getWriter().closed.catch", reason);
	}).finally(async () => {
		writer.releaseLock();
		if (downStreamRequestClose) {
			socket.close();
		} else {
			upStreamRequestClose = true;
		}
	});

	const writable = new WritableStream<Uint8Array>({
		write: async (chunk, controller) => {
			await writer.ready;
			writer.write(chunk);
		},

		// When the remote pair starts the close handshake,
		// Make sure we explicitly call `tcpSocket.close()` after `tcpSocket.writable` closes(unlocked).
		close: async () => {
			await writer.close();
		},
		abort: async (reason) => {
			await writer.abort(reason);
		},
	});

	const downStream = new TransformStream<Uint8Array, Uint8Array>();
	socket.readable.pipeTo(downStream.writable).then(() => {
		if (upStreamRequestClose) {
			socket.close();
		} else {
			downStreamRequestClose = true;
		}
	}, (reason) => {
		console.log("tcp.readable cancle or downStream.writable abort");
		socket.close();
	});

	return {
		readable: downStream.readable,
		writable: writable,
		closed: socket.closed,
		close: () => {
			console.log("tcp.close()");
		},
	};
}
