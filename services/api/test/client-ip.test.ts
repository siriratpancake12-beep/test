import { describe, expect, it } from "vitest";
import { clientIp, isInternal } from "../src/auth/client-ip";

describe("客户端 IP", () => {
  it("公网直连:只认连接地址,X-Forwarded-For 是客户端自己填的,不信", () => {
    expect(clientIp("198.51.100.7", undefined)).toBe("198.51.100.7");
    expect(clientIp("198.51.100.7", "1.2.3.4")).toBe("198.51.100.7");
    expect(clientIp("::ffff:198.51.100.7", undefined)).toBe("198.51.100.7");
  });

  it("负载均衡(内网地址)转发:取 X-Forwarded-For 里最右边的公网地址", () => {
    // 阿里云 SLB 用 100.64.0.0/10 转发到后端
    expect(clientIp("100.64.3.2", "198.51.100.7")).toBe("198.51.100.7");
    // 负载均衡 → nginx → 服务器:两层代理
    expect(clientIp("127.0.0.1", "198.51.100.7, 100.64.3.2")).toBe("198.51.100.7");
    // 客户端自己在前面加了假的,代理在后面追加了真实地址:取真实的
    expect(clientIp("10.0.0.5", "6.6.6.6, 198.51.100.7")).toBe("198.51.100.7");
    // 多个请求头
    expect(clientIp("10.0.0.5", ["6.6.6.6", "198.51.100.7"])).toBe("198.51.100.7");
  });

  it("全是内网地址、没有 X-Forwarded-For、或者里面有乱写的:不出错,用最后一个可信的地址", () => {
    expect(clientIp("127.0.0.1", undefined)).toBe("127.0.0.1");
    expect(clientIp("10.0.0.5", "192.168.1.9")).toBe("192.168.1.9");
    expect(clientIp("10.0.0.5", "garbage, 192.168.1.9")).toBe("192.168.1.9");
    expect(clientIp("10.0.0.5", "198.51.100.7:51234")).toBe("198.51.100.7");
    expect(clientIp("10.0.0.5", "[2001:db8::1]:443")).toBe("2001:db8::1");
    expect(clientIp(undefined, undefined)).toBe("unknown");
  });

  it("内网地址的判断", () => {
    for (const ip of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.1", "127.0.0.1", "100.64.0.1", "100.127.255.255", "169.254.1.1", "::1", "fd00::1", "fe80::1"]) {
      expect(isInternal(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "198.51.100.7", "2001:db8::1", "not-an-ip"]) {
      expect(isInternal(ip), ip).toBe(false);
    }
  });
});
