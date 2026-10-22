import { isIP } from "node:net";

/**
 * 客户端的真实 IP(短信按 IP 限流用)。
 *
 * 线上服务器在负载均衡(阿里云 SLB/ALB、腾讯云 CLB)或 nginx 后面,TCP 连接来自代理的内网地址,
 * 真实 IP 在 X-Forwarded-For 里;如果直接用连接地址,所有用户都是同一个 IP,"每 IP 每小时 20 次"就成了全站限流。
 * 但 X-Forwarded-For 是请求头,公网客户端可以随便填,所以只在"连接来自内网(我们自己的代理)"时才看它:
 * 从右往左跳过内网地址(一层层代理),第一个公网地址就是客户端。公网直连时只认连接地址,伪造无效。
 */
export function clientIp(remoteAddress: string | undefined, forwardedFor: string | string[] | undefined): string {
  const remote = bare(remoteAddress ?? "");
  if (!isInternal(remote)) return remote || "unknown";
  const chain = (Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor ?? "")
    .split(",")
    .map((s) => bare(s.trim()))
    .filter(Boolean);
  let ip = remote;
  for (let i = chain.length - 1; i >= 0; i--) {
    const hop = chain[i]!;
    // 不是合法 IP:再往左都是客户端自己填的,不可信,停在上一跳
    if (!isIP(hop)) break;
    ip = hop;
    if (!isInternal(hop)) break;
  }
  return ip || "unknown";
}

/** 去掉 IPv4 映射的 IPv6 前缀(::ffff:1.2.3.4)和端口 */
function bare(ip: string): string {
  let s = ip.trim();
  if (s.toLowerCase().startsWith("::ffff:") && isIP(s.slice(7)) === 4) s = s.slice(7);
  // "1.2.3.4:5678"(有的代理会带端口)
  const m = /^(\d+\.\d+\.\d+\.\d+):\d+$/.exec(s);
  if (m) s = m[1]!;
  // "[2001:db8::1]:443"
  const v6 = /^\[([0-9a-fA-F:]+)\](?::\d+)?$/.exec(s);
  if (v6) s = v6[1]!;
  return s;
}

/** 内网、本机、运营商级 NAT(阿里云 SLB 转发到后端用 100.64.0.0/10)和链路本地地址 */
export function isInternal(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    return s === "::1" || s.startsWith("fc") || s.startsWith("fd") || /^fe[89ab]/.test(s);
  }
  return false;
}
