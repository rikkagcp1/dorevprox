import * as codec from "./codec";
import * as address from "./address";

export const enum NetworkType {
	TCP = 1,
	UDP = 2,
};

export const enum MuxcoolOpCode {
	SUB_LINK_NEW = 1,
	SUB_LINK_KEEP = 2,
	SUB_LINK_END = 3,
	KEEP_ALIVE = 4,
}

export interface MuxcoolHeaderBase {
	id: number;
	opcode: MuxcoolOpCode;
	options: number;
}

export interface MuxcoolConnectionInfo {
	networkType: NetworkType;
	port: number;
	address: address.Address;
}

export interface MuxcoolHeaderSubLinkNew extends MuxcoolHeaderBase, MuxcoolConnectionInfo {
	readonly opcode: MuxcoolOpCode.SUB_LINK_NEW;
}

export interface MuxcoolSubLinkKeep extends MuxcoolHeaderBase {
	readonly opcode: MuxcoolOpCode.SUB_LINK_KEEP;
}

export interface MuxcoolSubLinkEnd extends MuxcoolHeaderBase {
	readonly opcode: MuxcoolOpCode.SUB_LINK_END;
}

export interface MuxcoolKeepAlive extends MuxcoolHeaderBase {
	readonly opcode: MuxcoolOpCode.KEEP_ALIVE;
}

export type MuxcoolHeader = MuxcoolHeaderSubLinkNew | MuxcoolSubLinkKeep | MuxcoolSubLinkEnd | MuxcoolKeepAlive;

export const codecMuxcoolHeaderBase = codec.codecOf<MuxcoolHeaderBase>(
	{ key: "id", codec: codec.codecU16BE },
	{ key: "opcode", codec: codec.codecU8 },
	{ key: "options", codec: codec.codecU8 },
);

export const codecMuxcoolSublinkNew = codec.codecOf<MuxcoolHeaderSubLinkNew>(
	{ key: "networkType", codec: codec.codecU8 },
	{ key: "port", codec: codec.codecU16BE },
	{ key: "address", codec: address.codec_address },
);

export const codecMuxcoolHeaders: codec.Codec<MuxcoolHeader> =
	codec.codecOfTaggedUnion<MuxcoolOpCode, MuxcoolHeaderBase, MuxcoolHeader>(
		codecMuxcoolHeaderBase,
		header => header.opcode,
		{
			[MuxcoolOpCode.SUB_LINK_NEW]: codecMuxcoolSublinkNew,
			[MuxcoolOpCode.SUB_LINK_KEEP]: codec.codecEmpty,
			[MuxcoolOpCode.SUB_LINK_END]: codec.codecEmpty,
			[MuxcoolOpCode.KEEP_ALIVE]: codec.codecEmpty,
		}
	);

export const codecU16BESizedMuxcoolHeaders: codec.Codec<MuxcoolHeader> =
	codec.codecOfLengthed(codec.codecU16BE, codecMuxcoolHeaders);

export interface MuxcoolFrame {
	header: MuxcoolHeader
	payload?: Uint8Array
}
