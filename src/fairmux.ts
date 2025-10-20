/* eslint-disable no-constant-condition */
import * as muxcool from "./muxcool"
import * as utils from "./utils"

export interface Datagram {
	info: muxcool.MuxcoolConnectionInfo | null;
	data: Uint8Array;
}

interface InputState {
	// Info
	id: number;

	// Reading
	reader: ReadableStreamDefaultReader<Datagram>;
	chunkPending: Datagram | null;
	promisePending: Promise<void> | null;
	readerCanceled: boolean;

	// Writing
	writer: WritableStreamDefaultWriter<Datagram>;
	writerClosed: boolean;

	// States
	/**
	 * SUB_LINK_NEW sent?
	 */
	sentSubLinkNew: boolean;
	/**
	 * sublink closed, but SUB_LINK_END ACK may be pending
	 */
	done: boolean;
	/**
	 * We actively close this sublink, await ACK
	 */
	awaitingAck: boolean;
	/**
	 * Pair send SUB_LINK_END, we need to ACK
	 */
	endAckQueued: boolean;
}

const NOP = () => { };

/**
 * Fairness guaranteed by round-robin
 */
export class FairMux {
	private inputs = new Map<number, InputState>();
	private rrOrder: number[] = [];
	private nextId = 1; // 16-bit, 0 and 1 reserved from auto alloc.
	private available: () => void = NOP;

	private terminated = false;
	private closeOut!: (wasClean: boolean, resaon?: any) => void;

	/**
	 * Muxed Traffic
	 */
	readonly out: ReadableStream<muxcool.MuxcoolFrame> = new ReadableStream<muxcool.MuxcoolFrame>({
		start: (controller) => {
			this.closeOut = (wasClean, reason) => {
				if (wasClean)
					controller.close();
				else
					controller.error(reason);
			}
		},
		pull: (controller) => this.tryEmitOne(controller),
		cancel: async () => {
			for (const st of this.inputs.values()) {
				await this.safeCloseWriter(st);
				await this.safeCancelReader(st);
			}
			this.inputs.clear();
			this.rrOrder = [];
		},
	});

	/**
	 * Traffic to be demuxed
	 */
	readonly in: WritableStream<muxcool.MuxcoolFrame> = new WritableStream<muxcool.MuxcoolFrame>({
		write: async (chunk, controller) => {
			const st = this.inputs.get(chunk.header.id);
			if (!st) {
				console.debug(`[FairMux.demux] unknown sublink ${chunk.header.id}, opcode=${chunk.header.opcode}`);
				return;
			}

			if (chunk.header.opcode == muxcool.MuxcoolOpCode.SUB_LINK_END) {
				if (st.awaitingAck) { // We send SUB_LINK_END and await ACK
					console.debug(`[FairMux] END ack received for sublink ${st.id}`);
					this.inputs.delete(st.id);
					this.rrOrder = this.rrOrder.filter(x => x !== st.id);
					await this.safeCloseWriter(st);
					await this.safeCancelReader(st);
				} else { // Pair send SUB_LINK_END and we need to replay ACK
					console.debug(`[FairMux] Peer requested END for sublink ${st.id}, sending ack`);
					await this.safeCloseWriter(st);
					await this.safeCancelReader(st);
					st.done = true;
					st.endAckQueued = true;
					this.rrOrder = this.rrOrder.filter(x => x !== st.id);
					this.available(); // Needed so that tryEmitOne can send ACK
				}
				return;
			}

			if (st.awaitingAck) {
				console.debug(`[FairMux] drop data for sublink ${st.id} while awaiting END ACK`);
				return;
			}

			if (chunk.header.opcode === muxcool.MuxcoolOpCode.KEEP_ALIVE) {
				console.debug(`[FairMux] KEEP_ALIVE on sublink ${st.id}`);
				return;
			}

			if (!(chunk.header.options & muxcool.MuxcoolOptions.HAS_DATA)) {
				return;
			}

			try {
				await st.writer.ready;
				await st.writer.write({
					info: chunk.header.connectionInfo,
					data: chunk.payload!,
				});
			} catch (e) {
				console.debug(`[FairMux] write failed on sublink ${st.id}; initiating END`, e);
				st.done = true;
				await this.safeCloseWriter(st);
				await this.safeCancelReader(st);
				this.available();
			}
		},
	} as UnderlyingSink<muxcool.MuxcoolFrame>)

	async terminate(wasClean: boolean, reason?: any) {
		if (this.terminated)
			return;

		this.terminated = true;
		const jobs: Promise<any>[] = [];
		for (const st of this.inputs.values()) {
			jobs.push(this.safeCloseWriter(st));
			jobs.push(this.safeCancelReader(st));
		}
		await Promise.allSettled(jobs);
		this.inputs.clear();
		this.rrOrder = [];

		try {
			this.closeOut(wasClean, reason);
		} catch { }

		try { this.available(); } catch { }
		this.available = NOP;

		console.debug("[FairMux] terminated");
	}

	/**
	 * 
	 * @param readable sink
	 * @param writable source
	 * @returns assigned sublink id
	 */
	addInput(readable: ReadableStream<Datagram>, writable: WritableStream<Datagram>): number {
		if (this.terminated)
			throw new Error("FairMux terminated");

		const id = this.allocId();
		const reader = readable.getReader();
		const writer = writable.getWriter();

		const st: InputState = {
			id,

			reader,
			chunkPending: null,
			promisePending: null,
			readerCanceled: false,

			writer,
			writerClosed: false,

			done: false,
			sentSubLinkNew: false,
			awaitingAck: false,
			endAckQueued: false,
		};

		this.inputs.set(id, st);
		this.rrOrder.push(id);
		this.ensurePending(st);
		return id;
	}

	/**
	 * Number of registered sublinks
	 */
	get count() {
		return this.inputs.size;
	}

	private allocId(): number {
		let id = this.nextId;
		while (this.inputs.has(id)) {
			id++;
			if (id > 0xFFFF)
				id = 2;	// We reserve id=0 and id=1
		}
		this.nextId = id + 1;
		if (this.nextId > 0xFFFF)
			this.nextId = 2;	// We reserve id=0 and id=1
		return id;
	}

	private allIdle(): boolean {
		// 全部输入 done 且无 residue / 无待发 END
		for (const st of this.inputs.values()) {
			if (!st.done)
				return false;
		}
		return true;
	}

	private ensurePending(st: InputState) {
		if (st.done || st.promisePending || st.chunkPending)
			return;

		st.promisePending = st.reader.read().then(({done, value}) => {
			st.promisePending = null;
			// console.log(`[Fairmux]: sublink ${st.id} read, done: ${done}`);

			if (done) {
				// End of sublink ReadableStream
				st.done = true;
			} else {
				// We should allow 0-lengthed packets here
				st.chunkPending = value;
			}
		}).catch(() => {
			st.chunkPending = null;
			st.done = true;
		}).finally(() => this.available());
	}

	private tryEmitOne(controller: ReadableStreamDefaultController<muxcool.MuxcoolFrame>): Promise<void> {
		// Send ACKs for SUB_LINK_END first
		for (const st of this.inputs.values()) {
			if (st.endAckQueued) {
				st.endAckQueued = false; // 只发一次
				controller.enqueue({
					header: {
						id: st.id,
						opcode: muxcool.MuxcoolOpCode.SUB_LINK_END,
						options: 0,
						connectionInfo: null,
					},
				});
				this.inputs.delete(st.id);
				this.rrOrder = this.rrOrder.filter(x => x !== st.id);
				console.debug(`[FairMux.out] Sent END-ACK for sublink ${st.id}, removed`);
				return Promise.resolve();
			}
		}

		if (this.terminated) {
			try { controller.close(); } catch { }
			return Promise.resolve();
		}

		for (let i = 0; i < this.rrOrder.length; i++) {
			// Round robin
			const id = this.rrOrder.shift()!;
			this.rrOrder.push(id);

			const st = this.inputs.get(id);
			if (!st)
				throw new Error(`[FairMux] Unknown sublink id: ${id}`);

			if (st.chunkPending) {
				const chunk = st.chunkPending;
				st.chunkPending = null;

				// console.debug(`[FairMux] Enqueue chunk for sublink ${st.id}`);

				if (st.sentSubLinkNew) {
					controller.enqueue({
						header: {
							id: st.id,
							opcode: muxcool.MuxcoolOpCode.SUB_LINK_KEEP,
							options: muxcool.MuxcoolOptions.HAS_DATA,
							connectionInfo: chunk.info
						},
						payload: chunk.data,
					});
				} else {
					st.sentSubLinkNew = true;
					controller.enqueue({
						header: {
							id: st.id,
							opcode: muxcool.MuxcoolOpCode.SUB_LINK_NEW,
							options: muxcool.MuxcoolOptions.HAS_DATA,
							connectionInfo: chunk.info
						},
						payload: chunk.data,
					});
				}

				return Promise.resolve();
			}

			if (st.done && !st.awaitingAck) {
				controller.enqueue({
					header: {
						id: st.id,
						opcode: muxcool.MuxcoolOpCode.SUB_LINK_END,
						options: 0,
						connectionInfo: null,
					},
				});

				st.awaitingAck = true;
				// Remove this sublink from round-robin
				this.rrOrder = this.rrOrder.filter(x => x !== st.id);
				console.debug(`[FairMux] Issue END to sublink ${st.id}`);
				return Promise.resolve();
			}

			// This sublink does not have any pending chunk
			this.ensurePending(st);
		}

		const { resolve, promise } = utils.newPromiseWithHandle<void>();
		this.available = () => {
			this.available = NOP;
			// Avoid sync re-entry
			// Make sure tryEmitOne exit before entering another tryEmitOne
			queueMicrotask(() => {
				this.tryEmitOne(controller).then(() => {
					resolve();
				})
			})
		};
		return promise;
	}

	private async safeCloseWriter(st: InputState) {
		if (st.writerClosed)
			return;

		st.writerClosed = true;
		try { await st.writer.ready; } catch { }
		try { await st.writer.close(); } catch { }
	}

	private async safeCancelReader(st: InputState) {
		if (st.readerCanceled)
			return;

		st.readerCanceled = true;
		try { await st.reader.cancel(); } catch { }
	}
}
