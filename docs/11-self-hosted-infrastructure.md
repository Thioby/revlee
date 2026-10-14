# 11 · Self-Hosted Infrastructure (GitHub Actions)

## 1. Reference topology

| Pool | Hardware | Runner | Isolation | Platforms |
|---|---|---|---|---|
| `mac` | Mac mini/Studio Apple Silicon, 32–64 GB RAM, macOS 26/27, Xcode 27 | Tart + Cilicon or runscaler; JIT runner in the VM | 1 macOS VM per job, max 2 in parallel | iOS Simulator (+ optionally Android arm64 emulator on Hypervisor.framework, web) |
| `linux` | x86_64 server with KVM (bare-metal or nested virt), 32+ cores, 128 GB | ARC (`gha-runner-scale-set`) ephemeral pods | pod per job, `/dev/kvm` via device plugin | Android Emulator x86_64, web (Playwright), Android build |
| `services` | any host/K8s | — | — | MinIO/S3, Postgres (App Map), Gradle build cache node, mitmproxy, vLLM (optional), `revlee-app` (GitHub App) |

Runner labels: `[self-hosted, macos, arm64, xcode-27, revlee]`, `[self-hosted, linux, kvm, android, revlee]`. Runner groups restrict which repositories can use the Mac pool.

## 2. macOS pool (ephemeral VMs)

### 2.1 Base image (Packer/Tart)

1. `tart clone ghcr.io/cirruslabs/macos-tahoe-xcode:27 revlee-ios-base` (or your own image).
2. Provisioning: Node 22, `agent-device`, `gh` ≥ 2.99, `ffmpeg`, `odiff`, CocoaPods, GitHub Actions runner (unregistered).
3. Pre-registration of the iOS 27.0 runtime and **pre-boot of the simulator** `iPhone 17` + `xcrun simctl shutdown`, so that the VM snapshot has warm caches (bypasses the "several minutes initial launch" of Xcode 27.1).
4. `tart push` to an OCI registry (Harbor/GHCR).

### 2.2 Job lifecycle

```
host: Cilicon (or runscaler) → tart clone base → tart run --net-softnet (isolation from the host)
      → JIT config injection (POST /repos/{o}/{r}/actions/runners/generate-jitconfig)
      → ./run.sh --jitconfig …  → job → VM deleted
```
- `--net-softnet` blocks access to the host; egress only through the host proxy with an allow-list (GitHub, LLM API, S3, registry).
- VM memory ≥ 12 GB (simulator ~4 GB + Xcode build).
- Host cache mounted read-only into the VM (SPM/CocoaPods/Node) and copied at start; build products from previous `main` SHAs in MinIO.

### 2.3 Throughput

2 VMs × ~8 min = ~15 iOS verifications/h/host. Scaling: additional Macs in the same runner group. The "bare host, N simulators" alternative gives more parallelism but no isolation: acceptable only for trusted PRs and disabled by default.

## 3. Linux pool (ARC + KVM)

### 3.1 Cluster

- Node pool on hosts with KVM; `kubevirt.io/kvm` device plugin (or privileged DinD as a fallback).
- Helm: `gha-runner-scale-set-controller` + `gha-runner-scale-set` (`containerMode: kubernetes` or DinD), `minRunners: 1` (warm), `maxRunners` according to RAM (≥ 6 GB per pod with an emulator).
- Runner image: Ubuntu 24.04, Android SDK (cmdline-tools, platform-tools, emulator 37.x pinned, system image `google_apis;x86_64` API 35), Java 17, Node 22, `agent-device`, Playwright with browsers (`npx playwright install --with-deps`), `gh`, `ffmpeg`, `odiff`, `mitmproxy`.
- **AVD with a Quick Boot snapshot baked into the image** (created during the image build: boot, animations off, `-no-snapshot-save` disabled once), launched with `-read-only` → N instances share the snapshot.

### 3.2 Pod manifest (fragment)

```yaml
resources:
  limits: { devices.kubevirt.io/kvm: 1, memory: 8Gi, cpu: "4" }
securityContext: { runAsUser: 1001, supplementalGroups: [kvm] }
env:
  - { name: ANDROID_EMULATOR_HOME, value: /opt/avd }
```

### 3.3 Gradle remote cache

`gradle/build-cache-node` as a Deployment with a PVC; in projects `org.gradle.caching=true` + `buildCache { remote(HttpBuildCache) { url = "http://gradle-cache:5071/cache/"; push = <main only> } }`. Expected effect (data from the literature): 15 → 6 min Android build.

## 4. Web

Playwright in Linux pods (the same image). The web app starts in the pod (`npm run start`), or Revlee receives the `--url` of a preview deployment (Vercel/Netlify) detected via the Deployments API (`deployments: read`), with a bypass header for preview protection (secret in the Orchestrator, sent only to the preview host).

## 5. Network and proxy

- Every job has a local `mitmproxy` with the `security.allowed_hosts` allow-list (test backend, CDN); emulator `-http-proxy`, simulator via the VM's system proxy, Playwright `proxy`.
- mitmproxy CA: iOS `xcrun simctl keychain add-root-cert` (+ trust in settings, automated in the image); Android: AOSP image (not Google Play) with the CA in the system store (Android 14: tmpfs mount on `/apex/com.android.conscrypt/cacerts`), or, preferred: in-app mocks (MSW) instead of MITM.
- Runner egress: GitHub, LLM providers, S3, package registries (via a local mirror).

## 6. Time: budget < 10 min

| Step | Target | How |
|---|---|---|
| Runner allocation | < 30 s | `minRunners: 1`; pre-warmed VM pool (Cilicon) |
| Checkout + cache | 30–60 s | local host caches, shallow clone |
| PR build | 2–4 min iOS / 1–3 min Android | remote cache, warm daemons, Debug build only, reuse of the native build for JS-only changes |
| Base build/download | 0–60 s | artifact from `main` in MinIO |
| Device ready | 10–60 s | snapshot/pre-boot in the image |
| Execution | 1–4 min | replay + a11y-first |
| Base compare | 0.5–2 min | replay |
| Judge + report | 30–60 s | parallel votes |
| **Total** | **6–12 min** | |

Boot time measurements on the target hardware are the first task of phase 1 (no reliable public numbers for Xcode 27 / emulator 37.x).

## 7. Operations

- **Monitoring:** run metrics (phase durations, cost, verdicts, cache hit rate, triage) to Prometheus/Grafana via `revlee stats --prom`; runner logs to Loki.
- **Updates:** VM/pod images built weekly (pin Xcode/emulator/system image; a version change invalidates snapshots and part of the step cache: the report shows "device profile changed").
- **Cleanup:** ephemeral VMs/pods; `tart prune` on hosts, image rotation; S3 lifecycle; `revlee cache gc`.
- **Device failure:** retry allocation once; then `unable_to_verify(infra)` with a neutral check run, never `failure`.

## 8. Alternative deployments

- **A single Mac to start (MVP):** runner directly on the host, 1 job at a time, Android arm64 emulator on the same Mac, web as well. Trusted PRs only. Sufficient to validate the product.
- **Hybrid:** iOS self-hosted, Android/web on GitHub-hosted `ubuntu-latest` with KVM (ReactiveCircus) — when there is no Linux server.
- **Without Actions:** `revlee-app` as a standalone server (GitHub App webhooks) queueing runs to its own workers (phase 3); the same CLI and configuration.
