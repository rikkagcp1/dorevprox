import * as codec from "./codec";

// Must match the binary field value
export const enum AddrType {
	IPv4 = 1,
	DomainName = 2,
	IPv6 = 3,
}

interface BaseAddress {
	addrType: AddrType;
	addr: string | Uint8Array;
}

export interface IPv4Address extends BaseAddress {
	addrType: AddrType.IPv4;
	addr: Uint8Array;
}

export interface IPv6Address extends BaseAddress {
	addrType: AddrType.IPv6;
	addr: Uint8Array;
}

export interface DomainAddress extends BaseAddress {
	addrType: AddrType.DomainName;
	addr: string;
}

export type Address = IPv4Address | IPv6Address | DomainAddress;

export const codec_address: codec.Codec<Address> = {
	byteLength: (address) => {
		switch (address.addrType) {
			case AddrType.IPv4:
				return 4 + 1;
			case AddrType.DomainName: {
				const addressEncoded = new TextEncoder().encode(address.addr);
				return 2 + addressEncoded.byteLength;
			}
			case AddrType.IPv6:
				return 16 + 1;
			default:
				return 0;
		}
	},
	write: (address, context) => {
		context.push(address.addrType);
		switch (address.addrType) {
			case AddrType.IPv4: {
				context.push(address.addr);
				break;
			}
			case AddrType.DomainName: {
				const addressEncoded = new TextEncoder().encode(address.addr);
				context.push(addressEncoded.byteLength);	// 1-byte of length
				context.push(addressEncoded);
				break;
			}
			case AddrType.IPv6: {
				context.push(address.addr);
				break;
			}
			default:
				throw new Error(`Unknown AddrType: ${String((address as any)?.addrType)}`);
		}
	},
	read: (context) => {
		const addrType: AddrType = context.shift();
		switch (addrType) {
			case AddrType.IPv4:
				return { addrType, addr: context.shiftBy(4) } as IPv4Address;
			case AddrType.DomainName: {
				const length = context.shift();
				const bytes = context.shiftBy(length);
				const domainName = new TextDecoder().decode(bytes);
				return { addrType, addr: domainName };
			}
			case AddrType.IPv6:
				return { addrType, addr: context.shiftBy(16) } as IPv6Address;
			default:
				throw new Error(`Unknown AddrType: ${String(addrType)}`);
		}
	},
};

export function string2IPv4(addrStr: string): IPv4Address {
	const parts = addrStr.split('.').map((p) => {
		const n = Number(p);
		if (!Number.isInteger(n) || n < 0 || n > 255) {
			throw new Error(`Invalid IPv4 address segment: ${p}`);
		}
		return n;
	});

	if (parts.length !== 4) {
		throw new Error(`Invalid IPv4 address: ${addrStr}`);
	}

	const addr = new Uint8Array(parts) as Uint8Array & { readonly length: 4 };

	return {
		addrType: AddrType.IPv4,
		addr,
	};
}

export function ipv4ToString(addr: IPv4Address): string {
	const parts = Array.from(addr.addr);
	return parts.join('.');
}

export function ipv6ToString(addr: IPv6Address): string {
	const parts: string[] = [];
	for (let i = 0; i < 16; i += 2) {
		const segment = (addr.addr[i] << 8) | addr.addr[i + 1];
		parts.push(segment.toString(16));
	}
	// 压缩连续的0段
	let ipv6 = parts.join(':').replace(/(:0)+:/, '::');
	return "[" + ipv6 + "]";
}

export function domainToString(addr: DomainAddress): string {
	return addr.addr;
}

export function addressToString(address: Address): string {
	switch (address.addrType) {
		case AddrType.IPv4:
			return ipv4ToString(address);
		case AddrType.IPv6:
			return ipv6ToString(address);
		case AddrType.DomainName:
			return domainToString(address);
		default:
			throw new Error(`Unknown AddrType: ${(address as any)?.addrType}`);
	}
}
