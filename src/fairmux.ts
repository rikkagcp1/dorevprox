/* eslint-disable no-constant-condition */
import * as muxcool from "./muxcool"
import * as utils from "./utils"

// 仅实现：多输入 ReadableStream<Uint8Array> -> 单输出 ReadableStream<MuxcoolFrame>
// 要点：addInput(rs, connectionInfo) 分配 16-bit 子链接 id；
// - UDP: 第一个 chunk 作为 SUB_LINK_NEW.payload，后续 chunk 逐个 SUB_LINK_KEEP；结束发 SUB_LINK_END
// - TCP: 第一个 chunk 的前 1024B 放在 SUB_LINK_NEW.payload，其余残余放入 residue，后续以 SUB_LINK_KEEP 按 1024B 继续；结束发 SUB_LINK_END
// - 公平性：round-robin，每次 pull 只从一个输入发“一份单位”数据（residue<=1KiB 或 1 帧）
// - 使用 Web Streams 的 ReadableStream（非 Node streams），并在 out 的 constructor 中使用 pull

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

	// Writing
	writer: WritableStreamDefaultWriter<Datagram>;

	// States
	sentSubLinkNew: boolean;
	done: boolean;
}


const NOP = () => { };

export class FairMux {
	private inputs = new Map<number, InputState>();
	private rrOrder: number[] = [];
	private nextId = 1; // 16-bit 回绕
	private available: () => void = NOP;

	/**
	 * Muxed Traffic
	 */
	readonly out: ReadableStream<muxcool.MuxcoolFrame> = new ReadableStream<muxcool.MuxcoolFrame>({
		pull: (controller) => {
			console.log("FairMux: pull");

			// 一次 pull 只尝试发出“一份单位”（公平分时）
			return this.tryEmitOne(controller);
		},
		cancel: () => {
			for (const st of this.inputs.values()) {
				try { st.reader.cancel(); } catch { }
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
			if (!st)
				throw new Error(`Unknown sublink id: ${chunk.header.id}`);

			if (chunk.header.opcode == muxcool.MuxcoolOpCode.SUB_LINK_END || 
				chunk.header.opcode == muxcool.MuxcoolOpCode.KEEP_ALIVE) {
				// Control frames
				return;
			}

			if (!(chunk.header.options & muxcool.MuxcoolOptions.HAS_DATA)) {
				return;
			}
			const data = chunk.payload!;
			await st.writer.ready;
			await st.writer.write({
				info: chunk.header.connectionInfo,
				data,
			});

			console.log(JSON.stringify(chunk))
		},
	} as UnderlyingSink<muxcool.MuxcoolFrame>)

	addInput(rs: ReadableStream<Datagram>, writable: WritableStream<Datagram>): number {
		const id = this.allocId();
		const reader = rs.getReader();
		const writer = writable.getWriter();

		const st: InputState = {
			id,
			reader,
			writer,
			chunkPending: null,
			promisePending: null,
			sentSubLinkNew: false,
			done: false,
		};

		this.inputs.set(id, st);
		this.rrOrder.push(id);
		this.ensurePending(st);
		return id;
	}

	// ===== 内部实现 =====

	private allocId(): number {
		// 16-bit，避免冲突（线性探测）
		for (let i = 0; i < 65536; i++) {
			const candidate = this.nextId & 0xFFFF;
			this.nextId = (this.nextId + 1) & 0xFFFF;
			if (!this.inputs.has(candidate))
				return candidate;
		}

		// 极端：满载（65536 路），简单退回 0（实际上不应出现）
		return 0;
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

		st.promisePending = st.reader.read().then((outcome) => {
			st.promisePending = null;
			console.log(`Read: ${st.id}`)

			if (outcome.done) {
				// End of sublink ReadableStream
				st.done = true;
			} else {
				// We should allow 0-lengthed packets here
				st.chunkPending = outcome.value;
			}
		}).catch(() => {
			st.chunkPending = null;
			st.done = true;
		}).finally(() => this.available());
	}

	private tryEmitOne(controller: ReadableStreamDefaultController<muxcool.MuxcoolFrame>): Promise<void> {
		for (let i = 0; i < this.rrOrder.length; i++) {
			// Round robin
			const id = this.rrOrder.shift()!;
			this.rrOrder.push(id);

			const st = this.inputs.get(id);
			if (!st)
				throw new Error(`Unknown sublink id: ${id}`);

			if (st.chunkPending) {
				const chunk = st.chunkPending;
				st.chunkPending = null;

				console.log(`FairMux enqueue chunk for ${st.id}`);

				if (st.sentSubLinkNew) {
					controller.enqueue({
						header: {
							id: st.id,
							opcode: muxcool.MuxcoolOpCode.SUB_LINK_KEEP,
							options: 1,
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
							options: 1,
							connectionInfo: chunk.info
						},
						payload: chunk.data,
					});
				}

				return Promise.resolve();
			}

			if (st.done) {
				controller.enqueue({
					header: {
						id: st.id,
						opcode: muxcool.MuxcoolOpCode.SUB_LINK_END,
						options: 0,
						connectionInfo: null,
					},
				});

				// Remove this sublink from internal state
				this.inputs.delete(st.id);
				this.rrOrder = this.rrOrder.filter(x => x !== st.id);
				console.log(`FairMux: sublink ${st.id} removed`);
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
}
