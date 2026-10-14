import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import type { Observation, UiNode } from "../types.js";
import { fingerprintOf, renderSnapshot, type Action, type DeviceAdapter, type DeviceOptions } from "./types.js";

/**
 * Adapter over the agent-device CLI (callstack/agent-device, MIT).
 * Works for --platform ios | android | web (web needs Node 24+ and `agent-device web setup`).
 * The CLI prints snapshot lines like:  @e12 [button] label="Add to cart" enabled hittable
 * which we normalise into UiNode[]; --json output is preferred when available.
 */
export class AgentDeviceAdapter implements DeviceAdapter {
  readonly platform: string;
  private session: string;
  private shotCounter = 0;
  private bin: string;
  constructor(private opts: DeviceOptions) {
    this.platform = opts.platform;
    this.session = opts.session ?? `revlee-${Date.now().toString(36)}`;
    this.bin = process.env.AGENT_DEVICE_BIN || "agent-device";
  }

  private async run(args: string[], { json = true, allowFail = false } = {}): Promise<{ code: number; stdout: string; stderr: string; data?: any }> {
    const full = [...args, "--session", this.session, "--platform", this.platform];
    if (this.opts.device) full.push("--device", this.opts.device);
    if (json) full.push("--json");
    const res = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const p = spawn(this.bin, full, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      p.stdout.on("data", (d) => (stdout += d));
      p.stderr.on("data", (d) => (stderr += d));
      p.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
    fs.appendFileSync(path.join(this.opts.evidenceDir, "agent-device.log"), `$ ${this.bin} ${full.join(" ")}\n${res.stdout}\n${res.stderr}\n`);
    let data: any;
    if (json) {
      try { data = JSON.parse(res.stdout); } catch { /* text output */ }
    }
    if (res.code !== 0 && !allowFail) throw new Error(`agent-device ${args[0]} failed (${res.code}): ${(data?.error?.message) ?? res.stderr ?? res.stdout}`.slice(0, 500));
    return { ...res, data };
  }

  /** Parse agent-device snapshot output (JSON `data.nodes`/`data.snapshot` or text lines) into UiNodes. */
  private parseSnapshot(out: { stdout: string; data?: any }): { title: string; nodes: UiNode[] } {
    const nodes: UiNode[] = [];
    let title = "";
    const fromJson = out.data?.data?.nodes ?? out.data?.data?.snapshot?.nodes ?? out.data?.nodes;
    if (Array.isArray(fromJson)) {
      for (const n of fromJson) {
        const ref = String(n.ref ?? n.id ?? "").replace(/^@/, "");
        if (!ref) continue;
        nodes.push({ ref, role: String(n.role ?? n.type ?? "generic"), name: String(n.label ?? n.name ?? n.text ?? ""), testId: n.identifier ?? n.testID ?? n.id_attr ?? undefined, value: n.value, interactive: n.interactive ?? true });
      }
      title = String(out.data?.data?.title ?? out.data?.data?.screen ?? "");
    }
    if (nodes.length === 0) {
      const text: string = out.data?.data?.text ?? out.data?.text ?? out.stdout;
      const re = /@(e\d+(?:~s\d+)?)\s+\[([^\]]+)\]\s*(.*)$/;
      for (const line of text.split("\n")) {
        const m = line.trim().replace(/^#\s*/, "").match(re);
        if (!m) continue;
        const rest = m[3];
        const label = rest.match(/label="((?:[^"\\]|\\.)*)"/)?.[1] ?? rest.match(/text="((?:[^"\\]|\\.)*)"/)?.[1] ?? rest.match(/^"((?:[^"\\]|\\.)*)"/)?.[1] ?? "";
        const id = rest.match(/\bid="((?:[^"\\]|\\.)*)"/)?.[1];
        const value = rest.match(/value="((?:[^"\\]|\\.)*)"/)?.[1];
        nodes.push({ ref: m[1], role: m[2], name: label, testId: id, value, interactive: !/static/.test(rest) });
      }
    }
    if (!title) title = nodes.find((n) => n.role === "heading")?.name ?? "";
    return { title, nodes };
  }

  private toObs(parsed: { title: string; nodes: UiNode[] }, screenshotPath?: string): Observation {
    return { title: parsed.title, nodes: parsed.nodes, snapshotText: renderSnapshot(parsed.title, parsed.nodes), fingerprint: fingerprintOf(parsed.title, parsed.nodes), screenshotPath };
  }

  async open(target: string): Promise<Observation> {
    await this.run(["open", target, "--relaunch", "--foreground"]);
    return this.observe({ screenshot: true, label: "open" });
  }

  async observe(opts: { screenshot?: boolean; label?: string } = {}): Promise<Observation> {
    const out = await this.run(["snapshot", "-i", "--force-full"]);
    const parsed = this.parseSnapshot(out);
    const shot = opts.screenshot ? await this.screenshot(opts.label ?? "observe") : undefined;
    return this.toObs(parsed, shot);
  }

  async act(action: Action, opts: { screenshot?: boolean; label?: string } = {}): Promise<Observation> {
    const tgt = (a: { ref?: string; selector?: string }) => (a.ref ? (a.ref.startsWith("@") ? a.ref : `@${a.ref}`) : a.selector!);
    switch (action.kind) {
      case "tap": await this.run(["press", tgt(action), "--settle"]); break;
      case "type": await this.run(["fill", tgt(action), action.text, "--settle"]); break;
      case "scroll": await this.run(["scroll", action.direction, "--settle"]); break;
      case "open_link": await this.run(["open", action.url]); break;
      case "wait": await this.run(["wait", String(action.ms)]); break;
      case "back": await this.run(["back", "--settle"]); break;
    }
    return this.observe(opts);
  }

  async waitFor(q: { text?: string; selector?: string; absent?: boolean; timeoutMs?: number }): Promise<boolean> {
    const t = String(q.timeoutMs ?? 5000);
    const args = q.absent ? ["wait", "absent", q.selector ?? `text="${q.text}"`, t] : q.text ? ["wait", "text", q.text, t] : ["wait", q.selector!, t];
    const out = await this.run(args, { allowFail: true });
    return out.code === 0;
  }

  async screenshot(label: string): Promise<string> {
    const dir = path.join(this.opts.evidenceDir, "screenshots");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${String(++this.shotCounter).padStart(3, "0")}-${label.replace(/[^a-z0-9_-]+/gi, "_").slice(0, 40)}.png`);
    await this.run(["screenshot", file], { json: false });
    return file;
  }

  async close(): Promise<void> {
    await this.run(["close"], { allowFail: true });
  }
}
