# Device infrastructure for self-hosted AI-driven mobile/web PR verification (iOS Simulator + Android Emulator + web) via GitHub Actions self-hosted runners — state as of October 2026

Scope note: these notes cover the "device layer" of a Revyl-like self-hosted system: runner provisioning (macOS + Linux/KVM), simulator/emulator orchestration, per-PR build + install, evidence capture, isolation/cleanup, timings, evidence storage, and security of self-hosted runners for fork PRs. Several official doc hosts (docs.github.com, github.blog, tart.run, playwright.dev, docs.expo.dev, tessl.io, medium) were unreachable from the research sandbox; where possible the same content was read from the upstream GitHub source repos (github/docs, microsoft/playwright, expo/expo, cirruslabs/tart). Facts are cited inline; everything without a URL is in "Inferences" and should be treated as practitioner knowledge to verify against `xcrun simctl help` / `emulator -help` on the target machine.

Versions relevant in Oct 2026 (verified): Xcode 27 / iOS 27 / macOS 27 shipped mid-September 2026 (third-party report, see Q2); Android Emulator stable 37.2.12 (Oct 1, 2026), 37.1.11 (Jul 30, 2026) (official release notes, see Q3); `gh` CLI `--attach` for media in PR comments shipped in gh 2.99.0 (Sept 1, 2026) (see Q6).

---

## Key Question 1: GitHub Actions self-hosted runners (macOS + Linux/ARC): setup, groups/labels, ephemeral/JIT, autoscaling, fork-PR security, `pull_request_target`

### Takeaway
GitHub's own guidance is blunt: self-hosted runners should "almost never" serve public repositories, and even in private repos anyone who can fork and open a PR can compromise a persistent runner; the sanctioned mitigations are ephemeral/JIT one-job runners on freshly provisioned VMs (ARC on Kubernetes for Linux; Tart/Cilicon/Tartelet-style VM-per-job on Apple Silicon for macOS), runner groups to scope access, OIDC instead of long-lived cloud credentials, and never checking out fork code under `pull_request_target`. ARC is Linux/Kubernetes only; macOS autoscaling needs separate tooling.

### Cited Findings

**Self-hosted runner basics / support matrix**
- macOS support: "macOS 11.0 (Big Sur) or later"; architectures: x64 on Linux/macOS/Windows, ARM64 on Linux and macOS (Windows ARM64 in public preview), ARM32 Linux only. Docker container actions and service containers require a Linux machine with Docker. — [github/docs: actions/reference/runners/self-hosted-runners.md](https://github.com/github/docs/blob/main/content/actions/reference/runners/self-hosted-runners.md)
- Job routing: a job is sent to an online, idle runner matching its labels and groups; if the assigned runner doesn't pick up the job within 60 seconds "the job is re-queued so that a new runner can accept it"; "If the job remains queued for more than 24 hours, the job will fail." — [same](https://github.com/github/docs/blob/main/content/actions/reference/runners/self-hosted-runners.md)
- Ephemeral runners: add `--ephemeral` when registering with `config.sh`; the runner "processes one job" and is then de-registered. GitHub "recommends implementing autoscaling with ephemeral self-hosted runners". Forward runner logs to external storage before using ephemeral autoscaling in production. — [same](https://github.com/github/docs/blob/main/content/actions/reference/runners/self-hosted-runners.md)
- JIT runners: you can "create ephemeral, just-in-time runners using the REST API". — [same](https://github.com/github/docs/blob/main/content/actions/reference/runners/self-hosted-runners.md)
- Networking: runners need outbound HTTPS on port 443 to GitHub (no inbound). Auto-update is on by default; with `--disableupdate` you must still update within 30 days of a release. — [same](https://github.com/github/docs/blob/main/content/actions/reference/runners/self-hosted-runners.md)
- Autoscaling options GitHub lists: Actions Runner Controller (recommended for Kubernetes), the Runner Scale Set Client (Go module for custom autoscaling), webhook-based scaling (not recommended at higher volume); "Persistent runners are not recommended for autoscaling." — [same](https://github.com/github/docs/blob/main/content/actions/reference/runners/self-hosted-runners.md)
- Runner levels: repo-level runners are dedicated to one repo; org-level runners process jobs for multiple repos; enterprise-level runners can be assigned to multiple orgs; runner groups (Enterprise Cloud/Server) "restrict access to specific workflows, organizations, and repositories". Self-hosted runners "Don't need to have a clean instance for every job execution" (i.e., state persists by default). — [github/docs: actions/concepts/runners/self-hosted-runners.md](https://github.com/github/docs/blob/main/content/actions/concepts/runners/self-hosted-runners.md)

**Actions Runner Controller (ARC)**
- Architecture: "autoscaling runner scale set mode"; an `AutoScalingRunnerSet` resource calls the Actions API to fetch/create a runner scale set; a Runner ScaleSet Listener pod long-polls the service and "stays idle until it receives a `Job Available` message"; scaling patches the Ephemeral RunnerSet replica count; "the EphemeralRunner Controller requests a Just-in-Time (JIT) configuration token"; after a successful job "the Ephemeral RunnerSet deletes the runner"; failed runner pods are retried up to 5 times; jobs unassigned after 24h. Helm charts `gha-runner-scale-set-controller` and `gha-runner-scale-set` are "only published as Open Container Initiative (OCI) packages"; AutoscalingRunnerSet name "is limited to 45 characters". Container modes include `kubernetes` (needs runner container hooks under `/home/runner/k8s`) and Docker-in-Docker. The runner image is a Linux container (.NET runtime-deps base). — [github/docs: actions/concepts/runners/actions-runner-controller.md](https://github.com/github/docs/blob/main/content/actions/concepts/runners/actions-runner-controller.md)
- Community macOS alternatives (because ARC is Kubernetes/Linux-container based): `ysya/runscaler` autoscales GitHub runners as Docker containers or Tart macOS VMs without Kubernetes, one ephemeral VM per job, README notes Apple's 2-concurrent-macOS-VM limit so `max-runners` is typically 2, with a pre-warmed VM pool option — [pkg.go.dev/ysya/runscaler](https://pkg.go.dev/github.com/ysya/runscaler@v0.2.24); `tomtom-international/macos-actions-runner-controller` (Apache-2.0) states ARC "focuses on Linux runners deployed in Kubernetes" and specialises in macOS runners using AWS SQS + Tart VMs on registered Mac nodes — [pkg.go.dev listing](https://pkg.go.dev/github.com/tomtom-international/macos-actions-runner-controller).

**Security hardening for self-hosted runners and fork PRs**
- Self-hosted runners "do not have guarantees around running in ephemeral clean virtual machines" and can be compromised by untrusted workflow code; auto-destroying runners after each job is only partial mitigation because "there is no way to guarantee that a self-hosted runner only runs one job"; secrets passed as CLI args can be seen by other jobs on the same runner. — [github/docs: actions/reference/security/secure-use.md](https://github.com/github/docs/blob/main/content/actions/reference/security/secure-use.md)
- Public repos: self-hosted runners should almost never be used, because "any user can open pull requests against the repository and compromise the environment." Private/internal repos: anyone who can fork and open a PR can "compromise the self-hosted runner environment"; environment secrets/required reviews don't protect because "these workflows are not run in an isolated environment." — [same](https://github.com/github/docs/blob/main/content/actions/reference/security/secure-use.md)
- Org/enterprise runners run workflows from many repos so "a security compromise of these environments can result in a wide impact"; runner groups let you "create boundaries by organizing your self-hosted runners into separate groups." Review sensitive data on the runner (SSH keys, API tokens) and reachability of cloud metadata endpoints; keep sensitive data to a minimum. JIT runners "perform at most one job before being automatically removed"; reusing hardware for JIT runners can expose environment data, so automate a clean environment. Use OIDC for short-lived cloud credentials. — [same](https://github.com/github/docs/blob/main/content/actions/reference/security/secure-use.md)
- `pull_request_target`: privileged (write token + secrets); "these vulnerabilities can be exploited to take over a repository"; avoid unless needed; prefer `workflow_run` for privilege separation; such workflows must not check out untrusted (fork PR) code. Untrusted input: pass context values through an intermediate env var rather than inlining `${{ }}` into shell scripts. — [same](https://github.com/github/docs/blob/main/content/actions/reference/security/secure-use.md)
- Event semantics: `pull_request_target` "runs in the context of the default branch of the base repository", "This prevents execution of unsafe code from the head of the pull request", "Avoid using this event if you need to build or run code from the pull request", it "allows your workflow to do things like label or comment on pull requests from forks." For `pull_request`, `GITHUB_REF` is the merge branch so `actions/checkout` checks out the merged result by default; workflows don't run on `pull_request` if the PR has a merge conflict. — [github/docs: events-that-trigger-workflows.md](https://github.com/github/docs/blob/main/content/actions/reference/workflows-and-actions/events-that-trigger-workflows.md)
- Fork-run approval: "You can manually approve workflow runs triggered by a contributor's pull request"; approval policy is configurable at repo/org/enterprise level; "Workflow runs that have been awaiting approval for more than 30 days expire and are marked as failed." — [github/docs: approve-runs-from-forks.md](https://github.com/github/docs/blob/main/content/actions/how-tos/manage-workflow-runs/approve-runs-from-forks.md)
- Approval gate is not a full fix: a researcher describes an attacker landing one trivial merged PR to become a "contributor", after which later fork PRs run without approval on default-configured runners, plus persistence via background processes surviving the job. — [adnanthekhan.com (Dec 2023)](https://adnanthekhan.com/2023/12/20/one-supply-chain-attack-to-rule-them-all/)
- Equinor AppSec guideline: keep the public-repo fork-PR setting at "Require approval for all outside collaborators" and don't enable fork workflows for non-public repos unless risks are understood. — [appsec.equinor.com](https://appsec.equinor.com/guidelines/gh-actions-runners)
- Community mitigation pattern: guard jobs with an `if:` on repository name so forks don't run on the self-hosted runner. — [github.community thread](https://github.community/t/self-hosted-runner-security-with-public-repositories/17860)

### Inferences
- Practical topology for a Revyl-like system: (a) `pull_request` workflow (no secrets, read-only token on fork PRs) runs the build + agent verification on an ephemeral runner, uploads evidence as artifacts; (b) a separate `workflow_run`-triggered workflow (base-repo context, write token) downloads the artifacts and posts the PR comment. This matches GitHub's "prefer `workflow_run` for privilege separation" and "never checkout fork code under `pull_request_target`" guidance.
- Gate the self-hosted job: `if: github.event.pull_request.head.repo.full_name == github.repository` (same-repo PRs only) or run fork PRs only on GitHub-hosted runners / require manual approval. Use repository rulesets / branch protection to make the verification check required only for trusted branches.
- One job per VM is the only robust isolation for macOS (no container story for Simulator); on Linux use ARC with `kubernetes` or DinD container mode and ephemeral runner pods, plus KVM exposure (see Q3).
- Runner registration for macOS VM-per-job: issue a JIT config via REST (`POST /repos/{owner}/{repo}/actions/runners/generate-jitconfig` or the org equivalent) from the host orchestrator, pass it into the VM, run `./run.sh --jitconfig <base64>`; the runner self-deregisters after the job. (REST endpoint name from practitioner knowledge; the fetched docs only say "create ephemeral, just-in-time runners using the REST API".)
- Labels: tag macOS runners e.g. `[self-hosted, macOS, ARM64, xcode-27, simulators]` and Android runners `[self-hosted, linux, kvm, android-emulator]`; use runner groups to restrict which repos can target the Mac pool.

### Gaps
- Could not read the rendered docs.github.com pages (DNS blocked); some reusable snippets (e.g., the exact fork-approval policy options "Require approval for first-time contributors who are new to GitHub / first-time contributors / all outside collaborators", and the note that secrets other than `GITHUB_TOKEN` are not passed to fork-PR runs) were not visible in the raw Markdown. These are well-known GitHub behaviours but are unverified here.
- No official statement found on why ARC doesn't support macOS; only community tooling found.
- Could not verify the exact REST endpoint names for JIT config in this session.

---

## Key Question 2: iOS Simulator automation on Apple Silicon (simctl, parallel simulators, headless, idb, WebDriverAgent/accessibility, VM limits: Tart/Anka/Cilicon)

### Takeaway
`xcrun simctl` covers almost the entire evidence pipeline (boot, install, launch, screenshot, video, push, privacy, status bar, root CA); a simulator does not need Simulator.app for recording. The hard ceiling is Apple's licence-enforced 2 concurrent macOS VMs per host, so "one ephemeral VM per job" gives at most 2 parallel jobs per Mac; inside a VM/host you can boot many simulators, with memory (roughly 4 GB per stock simulator per one vendor measurement) as the practical limit.

### Cited Findings

**Xcode / macOS state (Oct 2026)**
- Xcode 27 (build 27A266a) and the 27.0 OSes were posted on Sept 14, 2026; Xcode 27 reportedly requires macOS Tahoe 26.6+ and runs only on Apple silicon (third-party blog, not confirmed against Apple). — [blakecrosley.com](https://blakecrosley.com/blog/xcode-27-release)
- Apple's Xcode 27.1 release notes list a known issue where the initial simulator launch can take several minutes. — [Apple: Xcode 27.1 release notes](https://developer.apple.com/documentation/xcode-release-notes/xcode-27_1-release-notes.md)
- Multiple developer-forum reports of iOS 27 simulator runtimes downloading but never registering/appearing after Xcode 27 install; one fix was reinstalling the runtime from Xcode Settings → Components. — [Apple Dev Forums 830152](https://developer.apple.com/forums/thread/830152), [849096](https://developer.apple.com/forums/thread/849096), [846004](https://developer.apple.com/forums/thread/846004)
- idb currently requires macOS 15+ with Xcode 26.0+ to build from source. — [facebook/idb](https://github.com/facebook/idb)

**simctl commands (from Apple's WWDC20 "Become a Simulator expert" transcript)**
- Privacy: `xcrun simctl privacy booted grant calendar com.example.MyApp` / `... revoke all com.example.MyApp` / `... reset all`; services named include calendar, contacts, location, photos; `all` applies to every service; `booted` works only when exactly one simulator is booted, otherwise use name/UDID. — [WWDC20 10647](https://developer.apple.com/videos/play/wwdc2020/10647/)
- Push: `xcrun simctl push booted com.example.MyApp payload.json` or `xcrun simctl push booted payload.json` with `"Simulator Target Bundle": "com.example.MyApp"` in the JSON; a CLI bundle id overrides the file. — [same](https://developer.apple.com/videos/play/wwdc2020/10647/)
- Video: `xcrun simctl io booted recordVideo video.mp4`; default is HEVC with black device mask; `--codec h264`; `--mask ignored` records the full rectangular framebuffer; `--display external`; recording runs until Ctrl-C; output must not exist unless `--force`; "Encoding uses the GPU, and Simulator.app does not need to be running." — [same](https://developer.apple.com/videos/play/wwdc2020/10647/)
- Status bar: `xcrun simctl status_bar booted override --time 12:01 --cellularBars 1 --dataNetwork 3g --wifiMode failed`; `xcrun simctl status_bar booted clear`; running `status_bar` with no args lists all options. — [same](https://developer.apple.com/videos/play/wwdc2020/10647/)
- Root CA: `xcrun simctl keychain booted add-root-cert myCA.pem`; the cert must still be trusted in Settings → General → About → Certificate Trust Settings (manual step). — [same](https://developer.apple.com/videos/play/wwdc2020/10647/)
- Third-party reference confirms syntax `simctl status_bar <UDID> <override|clear> [flags]`, `simctl privacy <UDID> <grant|revoke|reset> <service> <bundle-id>`, `simctl push <UDID> [<bundle-id>] <payload.json|->`, `xcrun simctl io booted recordVideo video.mp4` (community doc; check `xcrun simctl help`). — [tessl.io simctl reference (via search summary)](https://tessl.io/registry/dpearson2699/swift-ios-skills/3.9.0/files/skills/ios-simulator/references/simctl-commands.md)

**Headless / parallel simulators**
- Headless background: an old Apple forum thread (Xcode 7 era) warned that booting via `simctl boot` without Simulator.app would not load backboardd so install/launch failed; this is dated. — [Apple Dev Forums 17340](https://developer.apple.com/forums/thread/17340)
- HeadSpin: the simulator runs as a separate process from Simulator.app; "headless" just skips the window and "will save a little bit of system resources ... compared to the CPU and memory required to run the device, this is minimal." — [headspin.io](https://headspin.io/blog/how-to-test-on-headless-emulators-and-simulators-with-appium)
- Memory per simulator (vendor measurement): a freshly booted iOS simulator starts ~180 background services; `simslim` (MIT, MobAI-App) disables unneeded ones and reports one simulator dropping from 4.0 GB to 0.9 GB RSS and 258→70 processes on an M1 Pro 16 GB; claims 19 automated simulators on 16 GB vs stock "thrashing at around 5". Treat as vendor claim. — [pkg.go.dev simslim](https://pkg.go.dev/github.com/mobai-app/simslim)
- Parallel-simulator test runners: Bluepill (LinkedIn → MobileNativeFoundation) lists headless mode to reduce memory, test grouping, retries on simulator hang; last push Aug 2024 — [awesome.ecosyste.ms Bluepill](https://awesome.ecosyste.ms/projects/github.com%2Fmobilenativefoundation%2Fbluepill), [LinkedIn blog 2017](https://engineering.linkedin.com/blog/2017/01/open-sourcing-bluepill--run-ios-tests-in-multiple-simulators); Emcee distributes across machines and manages simulator lifecycles — [github.com/gopito/emcee](https://github.com/gopito/emcee); pxctest runs tests in parallel across simulators from `.xctestrun` — [github.com/davetobin/pxctest](https://github.com/davetobin/pxctest).
- Xcode 16 / iOS 18 simulator CI regression reports (test time roughly doubled on CircleCI, heavy CPU on first boot); workaround to wait for boot: `xcrun simctl bootstatus -b`. — [discuss.circleci.com 52129](https://discuss.circleci.com/t/xcode-16-performance-regression/52129), [discuss.circleci.com 49205](https://discuss.circleci.com/t/severe-performance-problems-with-xcode-15/49205)
- Simulator boot timeouts are a common cause of `xcodebuild` exit code 65 in CI; timeouts start right after the previous xcodebuild action finishes. — [CircleCI blog (Oct 2025)](https://circleci.com/blog/xcodebuild-exit-code-65-what-it-is-and-how-to-solve-for-ios-and-macos-builds/)
- A simulator-automation skill repo defaults to a 300 s readiness wait and notes GitHub-hosted macOS can need 4–6 min for a cold-start boot (config default, not a benchmark). — [conorluddy/ios-simulator-skill](https://github.com/conorluddy/ios-simulator-skill)

**idb / accessibility tree / WebDriverAgent**
- idb: CLI for automating iOS Simulators and Devices; macOS "companion" + Python client that can run anywhere, enabling "a 'Device Lab' within a Data Center"; install `brew install facebook/fb/idb` and `pip3 install fb-idb` (Python 3.10+); commands shown: `idb list-targets`, `idb list-apps --udid <UDID>`, `idb launch <bundle-id>`; designed to fan out shards "to a large pool of iOS Simulators"; 5.4k stars, 173 open issues; nearly pure Swift. — [facebook/idb](https://github.com/facebook/idb)
- Maestro drives apps through the Accessibility Tree; `maestro hierarchy` prints the current view hierarchy as text; Maestro "only supports the Simulator" on iOS (no real devices). — [docs.maestro.dev how it works](https://docs.maestro.dev/get-started/how-maestro-works), [devicelab.dev Maestro CLI reference](https://devicelab.dev/blog/maestro-cli-complete-reference), [docs.maestro.dev iOS](https://docs.maestro.dev/platform-support/ios-uikit)
- Appium XCUITest: WebDriverAgent is the XCTest-based server linking XCTest.framework to execute commands on the device; snapshot caching rewritten in Appium 1.20 for lookup performance; settings `customSnapshotTimeout` and `waitForIdleTimeout` exist; `useJSONSource: true` and `waitForQuiescence: false` are the usual levers when page source hangs. — [appium v1.20.0 release](https://github.com/appium/appium/releases/tag/v1.20.0), [discuss.appium.io thread](https://discuss.appium.io/t/appium-ios-testing-getpagesource-and-requesting-snapshot-of-accessibility-hierarchy-get-stuck-and-fail-to-retrieve-the-app-source/32487)

**Apple Silicon VM limits and ephemeral macOS VM tooling**
- The 2-VM cap: traced to the macOS license (Section 2B(iii)) capping macOS VMs running on a Mac at two; eclecticlight argues it is not a hardware limit; enforcement error is `VZErrorDomain Code 6` "The maximum supported number of active virtual machines has been reached." — [eclecticlight.co 2022](https://eclecticlight.co/2022/08/04/virtualisation-on-apple-silicon-macs-8-how-apple-limits-vms/), [khronokernel 2023](https://khronokernel.com/macos/2023/08/08/AS-VM.html), [eclecticlight.co Apr 2026](https://eclecticlight.co/2026/04/29/virtualisation-on-apple-silicon-macs-is-different/)
- Tart (Cirrus Labs): "macOS and Linux VMs on Apple Silicon to use in CI"; uses Apple's Virtualization.Framework "for near-native performance"; installed via Homebrew (README shows a one-line `brew install ...` from the cirruslabs tap; the exact tap path was garbled in the fetched summary, so verify — commonly `brew install cirruslabs/tart/tart`), `tart clone ghcr.io/cirruslabs/macos-tahoe-base:latest tahoe-base`, `tart run tahoe-base`; images ~25 GB; VMs pushed/pulled from any OCI registry; Packer plugin available. — [cirruslabs/tart](https://github.com/cirruslabs/tart)
- Tart FAQ: nested virtualization only on M3/M4 with macOS 15+ and only for Linux guests; `tart run --net-softnet` gives stricter isolation ("not possible to access the host"); `--net-bridged` + `tart ip --resolver=arp`; default NAT lets guests reach host services bound to 0.0.0.0; stacked disk clones require "macOS 27" + DiskImageKit build; running VMs on Sequoia+ may need an unlocked login keychain (headless hosts). — [tart docs/faq.md](https://github.com/cirruslabs/tart/blob/main/docs/faq.md)
- Cilicon (Trade Republic): macOS app using Virtualization Framework to "create, provision and run ephemeral CI VMs with near-native performance"; supports GitHub Actions, Buildkite, GitLab Runner, scripts; config `~/cilicon.yml` with `source: oci://ghcr.io/cirruslabs/macos-runner:sequoia` and a `github` provisioner (`appId`, `organization`, `privateKeyPath`); runs one VM at a time (2 parallel listed as future idea, "more are not possible due to a limitation of the Virtualization framework"); images pulled via OCI into `~/.tart`; SSH-based preRun/postRun; SSH issues on macOS 15.0–15.3.x (use 15.4+); don't use `latest` tag; host should be dedicated with auto-updates, screen lock and power saving disabled. — [traderepublic/Cilicon](https://github.com/traderepublic/Cilicon)
- Tartelet (framna-dk): manages ephemeral GitHub Actions runners through Tart, "up to two parallel, isolated runners on a single host machine". — [Tartelet docs listing](https://docsearch.algolia.com/mcp/docs/repo/framna-dk/tartelet)
- khoi/sand: self-hosted GH runners on Tart, needs macOS 15+ Apple silicon; warns macOS DHCP leases last 24 h so >~253 VMs/day exhausts IPs. — [khoi/sand](https://github.com/khoi/sand)
- Mirego ekiden: runner pool on ephemeral arm64 macOS VMs using Tart + Packer + Gitea (image store) + Grafana. — [mirego/ekiden](https://github.com/mirego/ekiden)
- Scaleway tutorial (updated July 2025) for Cilicon self-hosted CI on Apple silicon. — [scaleway.com](https://www.scaleway.com/en/docs/tutorials/cilicon-self-hosted-ci-on-apple-silicon.md)
- Anka (Veertu): type-2 hypervisor suite for macOS VMs with ephemeral provisioning from CI including GitHub Actions; a third-party post cites ~$600/core/year Basic tier (undated). — [AWS Marketplace listing](https://aws.amazon.com/marketplace/pp/prodview-tzmid5kfn2knw), [nutrient.io blog](https://www.nutrient.io/blog/managing-macos-hardware-virtualization-or-bare-metal/)
- Hosted ephemeral Mac alternative pricing data point: Tenki M4 Pro runners, ephemeral VM per job, listed at $0.025–$0.08 per vCPU-minute (conflicting pages). — [tenki.cloud macOS runners](https://tenki.cloud/docs/runners/macos-runners.md)

### Inferences
- Simulator lifecycle for a job (commands from practitioner knowledge; verify with `xcrun simctl help`):
  ```bash
  UDID=$(xcrun simctl create "pr-${PR}-iphone" "iPhone 17" "com.apple.CoreSimulator.SimRuntime.iOS-27-0")
  xcrun simctl boot "$UDID"
  xcrun simctl bootstatus "$UDID" -b                 # block until booted (cited above as CI fix)
  xcrun simctl install "$UDID" ./build/MyApp.app
  xcrun simctl launch --console-pty "$UDID" com.example.MyApp   # or: launch -w, then xcrun simctl openurl "$UDID" "myapp://screen/x"
  xcrun simctl io "$UDID" screenshot --type png shot.png
  xcrun simctl io "$UDID" recordVideo --codec h264 --force video.mp4 &   # kill -INT to stop
  xcrun simctl spawn "$UDID" log stream --style compact --predicate 'subsystem == "com.example.MyApp"' > app.log &
  xcrun simctl ui "$UDID" appearance dark
  xcrun simctl shutdown "$UDID" && xcrun simctl delete "$UDID"
  ```
  Only `privacy`, `push`, `io recordVideo`, `status_bar`, `keychain add-root-cert` were verified from Apple's WWDC transcript; `create/boot/install/launch/openurl/io screenshot/spawn log stream/ui appearance/bootstatus/delete` are standard subcommands not verified in this session.
- Headless: on modern Xcode, `xcrun simctl boot` without Simulator.app works for install/launch/screenshot/recordVideo in practice (and Apple confirmed recordVideo needs no Simulator.app); the 2015 backboardd forum thread is obsolete. If visual rendering issues appear, launching `open -a Simulator --args -CurrentDeviceUDID $UDID` is the fallback. Budget RAM at ~4 GB/stock simulator (vendor figure) until measured.
- Accessibility tree for an AI agent: fastest options are Maestro `hierarchy` (text), idb `ui describe-all` (JSON of AX elements, not verified on page), or WebDriverAgent `/source?format=json` via Appium XCUITest. An XCUITest-based helper can also dump `XCUIApplication().debugDescription`. Each snapshot can take 1–several seconds on complex screens; snapshot timeouts are tunable in Appium.
- Parallelism per Mac: with VM-per-job you get ≤2 jobs per host (licence cap). Alternative: run the runner on the bare host with N simulators and isolate per job via unique device names/UDIDs + separate `DEVELOPER_DIR`/derived data paths — faster but no security isolation between PRs (unacceptable for fork PRs per Q1). A hybrid: trusted same-repo PRs on bare host, fork PRs on VMs or GitHub-hosted.
- Fresh-VM cost: a ~25 GB base image clone via APFS copy-on-write is seconds; prewarming (Cilicon/runscaler pool) hides the macOS boot (~30–60 s typical, not measured here) and the Xcode 27.1 "initial simulator launch can take several minutes" issue — pre-boot a simulator and snapshot the VM image with it already booted, or at least with runtimes pre-registered.

### Gaps
- No authoritative benchmark found for simulator boot time on Xcode 26/27 on M-series; only forum reports and tool defaults (300 s waits, 4–6 min cold on GitHub-hosted). Needs on-hardware measurement.
- Apple's `simctl` has no web manual; command flags beyond those in the WWDC transcript are unverified here.
- No Tart "Fair Source" licence terms (free host count) captured — tart.run was unreachable. Verify before commercial deployment.
- idb's maintenance status unclear (no statement); check recent commit activity.

---

## Key Question 3: Android Emulator automation (headless flags, snapshots, KVM, Docker images, ARC/K8s KVM, evidence via adb, N emulators in parallel, ARM vs x86, Cuttlefish/Genymotion)

### Takeaway
On Linux the Android stack is the easy part: KVM + `emulator -no-window -gpu swiftshader_indirect -noaudio -no-boot-anim`, Quick Boot snapshots ("up to 10x faster" than cold boot), 64 instances addressable via `-port`, `-read-only` for N clones of one AVD, and ATD/`aosp-atd` images built for headless testing. Snapshots are invalidated by any emulator/system-image/AVD change and are unreliable with software rendering per Google, so CI must pin versions. Containerising requires `/dev/kvm` (device plugin or privileged pod), which is the main ARC friction point.

### Cited Findings

**Emulator versions (Oct 2026)**
- Stable releases: 37.2.12 (Oct 1, 2026; macOS Apple Silicon gRPC `streamScreenshot` MMAP fix), 37.1.11 (Jul 30, 2026; AEHD sunset announced for Dec 31, 2026; Pixel 10a; snapshot out-of-storage fix; `6G`/`32M` unit suffixes in config.ini), 36.6.11 (Jun 2, 2026; min RAM for API 37 phone AVDs raised to 4 GB; macOS 26.3 memory leak fix), 36.5.10 (Apr 2, 2026; new networking stack letting AVDs on one host discover each other), 36.4.9 (Feb 10, 2026; `-gpu software` CLI option; Lavapipe default software Vulkan), 36.2.11 (Oct 9, 2025; HAXM removed). — [Android Emulator release notes](https://developer.android.com/studio/releases/emulator)

**Command-line flags (official)**
- `-no-window`: "Disables graphical window display on the emulator. This option is useful when running the emulator on servers that have no display." `-gpu mode` e.g. `-gpu swiftshader_indirect`. `-no-snapshot`: full boot and lose state; `-no-snapshot-save`; `-no-snapshot-load`; `-snapshot name`; `-no-boot-anim`; `-noaudio`; `-port` (first instance 5554/5555, +2 each, range 5554–5682 = 64 instances; prefer even console port) and `-ports console,adb`; `-wipe-data`; `-accel auto|off|on` (`off` needs `ANDROID_I_WANT_MY_TCG=yes`, unsupported and very slow); `-accel-check`; `-memory 1536..8192`; `-netdelay`/`-netspeed` presets (gsm, edge, lte...); `-http-proxy http://user:pass@host:port` (set on first launch when running multiple emulators); `-writable-system` (temp system copy up to several hundred MB); `-verbose`; `-show-kernel`; `-qemu args` (must be last). The `emulator` tool is now documented as deprecated in favour of the `android emulator [create|start|stop|list]` CLI. — [Android emulator command-line reference](https://developer.android.com/studio/run/emulator-commandline)
- `-read-only`: Emulator 28.0 added running multiple instances of one AVD; instances after the first must pass `-read-only` and discard disk changes on exit; works by copying QCOW2 writable layers; bundled `qemu-img` can pre-commit QCOW2; read-only instances "will share the existing Quickboot snapshot as a common source of copy-on-write guest RAM". — [Android Studio blog 28.0.0 canary](https://androidstudio.googleblog.com/2018/07/emulator-2800-canary.html), [28.0.16 stable](https://androidstudio.googleblog.com/2018/11/emulator-28016-stable.html?m=1); Chromium's `avd.py` runs emulators read-only by default — [chromium docs](https://chromium.googlesource.com/chromium/src/+/refs/tags/111.0.5545.3/docs/android_emulator.md)

**Snapshots**
- Quick Boot snapshot can start an AVD "up to 10 times faster than a cold boot"; first start is always a cold boot; "Any update to the Android Emulator, system image, or AVD settings resets the AVD's saved state" forcing a cold boot; snapshots are not reliable with software rendering (Google advises Hardware/Automatic graphics). — [Android emulator snapshots doc](https://developer.android.com/studio/run/emulator-snapshots) (software-rendering warning seen on the [German page](https://developer.android.com/studio/run/emulator-snapshots?hl=de))
- A hosted-runner vendor notes the first cold boot of a new API level takes "a few minutes"; subsequent warm-AVD runs are much faster. — [tenki.cloud android-emulator doc](https://tenki.cloud/docs/runners/android-emulator.md)

**Boot detection and animations**
- Google's prebuilt-container blog waits for `sys.boot_completed` == 1 via `adb shell getprop` after `adb wait-for-device`. — [androidstudio.googleblog.com Aug 2020](https://androidstudio.googleblog.com/2020/08/)
- Don't use `init.svc.bootanim` as the ready signal with `-no-boot-anim` (device looks ready too early; on API 36 the property is missing). — [JENKINS-27702](https://issues.jenkins.io/browse/JENKINS-27702), [CircleCI API 36 thread](https://discuss.circleci.com/t/starting-android-emulator-with-api-36-hangs-while-waiting-for-boot-animation-with-workaround/54823)
- Detox sets `window_animation_scale`, `transition_animation_scale`, `animator_duration_scale` to 0 via `adb shell settings put global` on emulators; CircleCI also recommends disabling animations. — [Detox 16.6.0 notes](https://newreleases.io/project/github/wix/Detox/release/16.6.0), [CircleCI support](https://support.circleci.com/hc/en-us/articles/360000028928)

**ReactiveCircus/android-emulator-runner (GitHub Action; also usable as reference for raw commands)**
- Inputs: `api-level` (min 15; e.g. `35-ext15`), `target` (`default`, `google_apis`, ...), `arch` (`x86` default, `x86_64`, `arm64-v8a`), `emulator-options` default `-no-window -gpu swiftshader_indirect -no-snapshot -noaudio -no-boot-anim`, `emulator-boot-timeout` default 600 s, `disable-animations` default true, `force-avd-creation` default true, `ram-size`, `heap-size`, `emulator-build` (pin e.g. `6061023`), `channel`. KVM enablement step on Linux:
  ```yaml
  - name: Enable KVM
    run: |
      echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' | sudo tee /etc/udev/rules.d/99-kvm4all.rules
      sudo udevadm control --reload-rules
      sudo udevadm trigger --name-match=kvm
  ```
  Recommended AVD snapshot caching pattern: `actions/cache@v5` on `~/.android/avd/*` and `~/.android/adb*` keyed by API level; first run creates AVD + snapshot with `-no-window -gpu swiftshader_indirect -noaudio -no-boot-anim -camera-back none`, later runs use `-no-snapshot-save ...` and `disable-animations: true`. README says Ubuntu runners are ~2–3x faster than macOS runners for this. On macOS the emulator uses Hypervisor.Framework. — [ReactiveCircus/android-emulator-runner](https://github.com/ReactiveCircus/android-emulator-runner)

**Gradle Managed Devices / ATD**
- GMD: AGP creates/deploys/tears down virtual devices (API 27+), uses emulator snapshots, sharding via `android.experimental.androidTest.numManagedDeviceShards=<n>` (3 devices × 2 shards = 6 VMs), CI without hardware rendering needs `-Pandroid.testoptions.manageddevices.emulator.gpu=swiftshader_indirect`. ATD images (`aosp-atd` / `google-atd`, API 30 only) are "optimized for testing: headless mode, removed preinstalled apps, disabled background services, and disabled hardware rendering"; screenshot tests needing hardware rendering unsupported. — [Android: Gradle-managed devices](https://developer.android.com/studio/test/gradle-managed-devices)

**Containers / Kubernetes / KVM**
- google/android-emulator-container-scripts: experimental; Linux host, Python 3.10+, Docker + Compose, KVM required (nested virt on AWS/Azure/GCE possible with perf penalty; Docker Desktop on macOS/Windows unsupported); prebuilt images in Google Artifact Registry (e.g. `30-google-x64:30.1.2`); run with `-e ADBKEY`, `--device /dev/kvm`, ports 5555 (adb) and 8554 (gRPC); `adb connect localhost:5555`; `emu-docker create <emulator.zip> <sysimg.zip>`; WebRTC gateway on 8080; tmpfs `/data` suggested; `--gpu` for NVIDIA needs Xvfb when headless. — [google/android-emulator-container-scripts](https://github.com/google/android-emulator-container-scripts)
- budtmo/docker-android: `docker run -d -p 6080:6080 -e EMULATOR_DEVICE="Samsung Galaxy S10" -e WEB_VNC=true --device /dev/kvm --name android-container budtmo/docker-android:emulator_11.0`; status via `docker exec -it android-container cat device_status`; Ubuntu host + KVM required; free images cover Android 9–14; Android 15–17, headless variant, multiple emulators per container, proxy setup are Pro/sponsor-gated; includes an MCP server and AI agent (beta). — [budtmo/docker-android](https://github.com/budtmo/docker-android)
- KVM in Kubernetes: a KVM device plugin can expose `/dev/kvm` as a schedulable resource (`devices.kubevirt.io/kvm`) so pods don't need privileged mode; older guides use privileged pods. — [kubevirt.io 2018](https://kubevirt.io/2018/KVM-Using-Device-Plugins.html), [codemia write-up](https://codemia.io/knowledge-hub/path/how_to_mount_devkvm_in_a_non-privileged_pod), [android-farm-operator README](https://github.com/tinyzimmer/android-farm-operator/blob/master/README.md)
- Even with `/dev/kvm` present, default perms `crw-rw---- root:kvm` block the runner user, so a udev rule (as above) is needed or the emulator falls back to software emulation. — [warpbuild.com nested-virt docs](https://warpbuild.com/docs/ci/features/nested-virtualization)
- On AWS, KVM is only available on bare-metal instances. — [realz.medium.com Cuttlefish on EKS](https://realz.medium.com/running-android-on-kubernetes-be73b940833f)

**Cuttlefish / Genymotion / STF**
- Cuttlefish requires KVM; install host Debian packages, add user to `kvm` and `cvdnetwork` groups; launch `HOME=$PWD ./bin/launch_cvd --daemon`, check `./bin/adb devices`, WebRTC on 8443, stop `./bin/stop_cvd`; images from Android CI (`aosp_cf_x86_64_only_phone` userdebug); host package must match the build. Container images built from android-cuttlefish `docker/image-builder.sh`. — [source.android.com Cuttlefish get started](https://source.android.com/docs/devices/cuttlefish/get-started), [ghaf docs](https://ghaf.tii.ae/ghaf/scenarios/run_cuttlefish/), [realz.medium.com](https://realz.medium.com/running-android-on-kubernetes-be73b940833f)
- DeviceFarmer/stf: browser control of Android 2.3.3–15 devices; Node ≤20, RethinkDB 2.2+, adb; REST API (doc/API.md); docker image `devicefarmer/stf` + compose; security caveats (unencrypted internal comms, devices not fully reset between uses, "not suited to multiuser deployments without changes"); iOS only a long-term goal; emulators not mentioned. — [DeviceFarmer/stf](https://github.com/DeviceFarmer/stf)
- Genymotion integration is available via docker-android on Genymotion SaaS/AWS/GCP/Alibaba. — [budtmo/docker-android](https://github.com/budtmo/docker-android)

**Evidence capture via adb**
- `adb shell screenrecord` default limit is 180 s; `--time-limit` can raise it up to 86400 s on images honouring it; an AOSP patch allows `--time-limit 0` (no limit) on some versions; chaining multiple recordings leaves seams; scrcpy has no 3-minute limit. — [Genymotion KB](https://support.genymotion.com/hc/en-us/articles/4418018194449-How-to-screen-record-with-Genymotion-SaaS-Cloud), [Maestro blog](https://www.maestro.dev/blog/fixing-androids-3-minute-screen-recording-limitation), [AOSP-derived commit](https://gerrit.omnirom.org/plugins/gitiles/android_frameworks_av/+/b88917cc3dcdf1cb58862729e7f7096e6476a55e%5E%21), [Google issue 152628934](https://issuetracker.google.com/issues/152628934)

### Inferences
- Reference headless launch + readiness script (combining cited flags; `getprop` loop is the Google-blog pattern):
  ```bash
  export ANDROID_SERIAL=emulator-5554
  $ANDROID_HOME/emulator/emulator @ci_api35 -no-window -gpu swiftshader_indirect -noaudio -no-boot-anim \
     -no-snapshot-save -read-only -port 5554 -memory 4096 -cores 4 &
  adb -s $ANDROID_SERIAL wait-for-device
  until [ "$(adb -s $ANDROID_SERIAL shell getprop sys.boot_completed | tr -d '\r')" = "1" ]; do sleep 2; done
  adb shell settings put global window_animation_scale 0
  adb shell settings put global transition_animation_scale 0
  adb shell settings put global animator_duration_scale 0
  adb install -r -t app-debug.apk
  adb shell am start -W -a android.intent.action.VIEW -d "myapp://screen/x" com.example.app   # deep link
  adb exec-out screencap -p > shot.png
  adb shell screenrecord --time-limit 600 /sdcard/run.mp4 &   # pull later
  adb shell uiautomator dump /sdcard/ui.xml && adb pull /sdcard/ui.xml
  adb logcat -d -v threadtime > logcat.txt
  ```
  `-cores`, `screencap`, `uiautomator dump`, `logcat` were not verified in fetched docs this session (standard tooling).
- Parallel N emulators on one Linux box: bake one AVD with a Quick Boot snapshot, launch N instances with `-read-only` and distinct `-port` (even numbers 5554..5682); each gets its own `ANDROID_SERIAL`. Because snapshots + software rendering are flagged unreliable by Google, either test on your host that `swiftshader_indirect` + snapshot load is stable for your image, or use `-gpu host` with a real GPU/Xvfb, or accept `-no-snapshot` cold boots (~1–3 min) for determinism. Pin emulator build (`emulator-build`) and system image revision so snapshots never silently invalidate.
- ARC + Android: give runner pods `resources.limits: devices.kubevirt.io/kvm: 1` via a KVM device plugin (or privileged DinD mode), run as a user in the `kvm` group, request ≥4 GB RAM per emulator (API 37 images force 4 GB minimum) plus Gradle memory; use node pools on bare-metal/nested-virt-capable hosts.
- ARM vs x86: on Apple Silicon Macs use `arm64-v8a` images (Hypervisor.framework); on x86 Linux use `x86_64` images (KVM); do not try to run arm64 images on x86 hosts (TCG software emulation is "unsupported and very slow" per the CLI docs' `-accel off` note).
- ATD (`aosp-atd`, API 30 only) is attractive for AI-agent runs (fewer background services, headless) but cannot do GPU screenshot tests; for vision-model evidence you need rendering (swiftshader is fine for screenshots).

### Gaps
- No official Google "emulator on CI" page was reachable (developer.android.com/studio/test/continuous-integration returned 404); flag recommendations are taken from the ReactiveCircus action and Google's container blog.
- `-read-only` behaviour is documented only in 2018 release notes; current docs page omits it. Verify with `emulator -help`.
- No measured cold-boot/snapshot-boot seconds for emulator 37.x on current hardware found (only "up to 10x" and "a few minutes").
- No ARC-specific manifest for KVM found; the device-plugin approach is inferred from generic Kubernetes sources.

---

## Key Question 4: App build and distribution per PR (Expo EAS local, Fastlane, Gradle/Xcode caching, prebuilt debug builds, bundle id per PR, deep links/test hooks, network mocking)

### Takeaway
Keeping PR time low is mostly a caching story: remote Gradle build cache on self-hosted runners took one team from ~15 to ~6 min (cache hit rate 14%→50%), while on iOS persisting whole DerivedData (~8 GB) cost 10 min of transfer and was slower than saving only build products. `eas build --local` works on self-hosted runners but explicitly does not support caching, so for an EAS-based app prefer `xcodebuild`/Gradle directly (or `expo run:*`/prebuild) with warm caches. Determinism needs deep links/test hooks plus a MITM proxy whose CA is installed in the simulator keychain / emulator system store (root/writable-system required on Android 7+, and Android 14 moved system CAs to immutable APEX).

### Cited Findings
- Android self-hosted CI case: moving from hosted to self-hosted runners with a remote Gradle Build Cache node dropped builds from ~15 min to ~6 min; cache hit rate rose 14%→50%; P95 fell below 10 min; the setup also includes a Docker mirror and the Gradle Build Cache node. — [levelup.gitconnected.com (search summary; page not fetchable)](https://levelup.gitconnected.com/how-we-cut-android-ci-from-15-minutes-to-6-with-self-hosted-runners-and-remote-gradle-build-caches-ef9a539c5112)
- iOS caching case (Lightspeed on CircleCI, 2022): saving the whole project with derived data came to nearly 8 GB and "required 10 minutes to upload and download again"; better results from saving only build products and the Fastlane directory. — [circleci.com blog](https://circleci.com/blog/how-lightspeed-optimized-ios-testing)
- Expo claims most EAS cloud builds complete in 10–20 min for iOS (vendor claim, above a 10-min PR target). — [expo.dev](https://expo.dev/grow/mobile-cicd)
- `eas build --local`: `eas build --platform ios --local` / `--platform android --local`; authenticate via `eas login` or `EXPO_TOKEN`; prerequisites Node + package manager, fastlane and CocoaPods (iOS), Android SDK/NDK; limitations: one platform per run (`all` disabled), eas.json `node/yarn/fastlane/cocoapods/ndk/image` fields ignored, "Caching isn't supported", EAS Secret-visibility env vars unsupported, Windows unsupported; env vars `EAS_LOCAL_BUILD_SKIP_CLEANUP=1`, `EAS_LOCAL_BUILD_WORKINGDIR`, `EAS_LOCAL_BUILD_ARTIFACTS_DIR`; only contact with EAS servers is verifying `@account/slug` and downloading managed credentials. — [expo/expo docs local-builds.mdx](https://github.com/expo/expo/blob/main/docs/pages/build-reference/local-builds.mdx)
- Simulator builds: set `ios.simulator: true` in an `eas.json` profile; `eas build -p ios --profile preview`; requires a Mac with Xcode; `eas build:run -p ios` installs a finished build on a simulator. — [docs.expo.dev simulators (search summary)](https://docs.expo.dev/build-reference/simulators/)
- Self-hosted maintenance cost (Bitrise case study): team "owned everything: OS updates, Xcode version management, networking, hardware provisioning". — [bitrise.io blog](https://bitrise.io/blog/post/ship-ios-and-android-builds-twice-as-fast-on-github-actions)
- Android network mocking via MITM: since Android 7 apps ignore user-installed CAs unless configured; mitmproxy's how-to installs the CA into the system store (hash-named `<hash>.0` file in `/system/etc/security/cacerts` after `adb root` + remount), which works only on non-Google-Play (AOSP) images. — [docs.mitmproxy.org](https://docs.mitmproxy.org/stable/howto/install-system-trusted-ca-android/), [dev.to walkthrough](https://dev.to/ptisserand/mitmproxy-and-android-emulator-206b)
- Android 14: system CAs live in `/apex/com.android.conscrypt/cacerts` which is immutable; remounts fail; workaround is a tmpfs mount over the cacerts directory (root required). — [httptoolkit.com](https://httptoolkit.com/blog/android-14-install-system-ca-certificate/)
- iOS Simulator CA install: `xcrun simctl keychain booted add-root-cert myCA.pem` (then trust manually in Settings, or drag onto the Simulator window). — [WWDC20 10647](https://developer.apple.com/videos/play/wwdc2020/10647/)
- Emulator `-http-proxy http://server:port` routes TCP via a proxy (set on first launch when running multiple emulators); `-writable-system` makes `/system` writable after `adb remount`. — [emulator CLI docs](https://developer.android.com/studio/run/emulator-commandline)
- Simulator `openurl` is the standard deep-link entry (listed in community reference; not in WWDC transcript). — [tessl.io simctl reference](https://tessl.io/registry/dpearson2699/swift-ios-skills/3.9.0/files/skills/ios-simulator/references/simctl-commands.md)

### Inferences
- Build strategy for <10 min: (1) build once per PR commit in a dedicated build job (Debug, simulator arch `arm64` for iOS; `assembleDebug` for Android), (2) publish `.app`/`.apk` as a short-retention artifact, (3) fan out verification jobs that only install. Persistent self-hosted runners can keep warm Gradle daemons, Gradle remote build cache (`org.gradle.caching=true` + HTTP cache node), CocoaPods/SPM caches and DerivedData on local SSD; ephemeral VMs should mount a host-side cache volume or restore from a fast local object store (MinIO) rather than GitHub cache (10 GB/repo cap; slow for multi-GB DerivedData).
- iOS: `xcodebuild -scheme App -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath ./dd CODE_SIGNING_ALLOWED=NO build` (no signing needed for simulator builds); Fastlane's `build_app`/`gym` is optional sugar. Android: `./gradlew :app:assembleDebug --build-cache --configuration-cache`.
- Per-PR bundle id / applicationId suffix (`.pr123`) is useful on shared persistent devices to allow side-by-side installs, but is unnecessary with VM-per-job or fresh AVD/simulator per job; it also breaks deep link/universal link associations, so prefer isolation over suffixing.
- Deterministic agent runs: add a debug-only "test hooks" surface (deep links `myapp://debug/screen?...`, env/launch args read on startup such as `-UITestMode 1` passed via `simctl launch` or `am start --es`), seed state via `simctl openurl`/`am start`, and point the app at a mock (MSW in RN JS runtime, WireMock standalone on host, or mitmproxy with recorded flows). For RN/Expo apps MSW inside the JS bundle avoids CA headaches entirely.
- For EAS-managed apps, `eas build --local` in CI is viable but cache-less; faster is `npx expo prebuild` + native `xcodebuild`/Gradle with caches, or a prebuilt dev client reused across PRs when only JS changed (serve the JS bundle from the runner and load via dev-client deep link).

### Gaps
- Could not fetch the full Medium article for the Android 15→6 min case; only summary figures captured.
- No 2025–2026 primary-source engineering blog with end-to-end <10 min mobile PR verification timings was found.
- Expo docs on `--local` combined with simulator profiles were not directly verified (docs.expo.dev unreachable).
- Fastlane specifics not researched (time budget); treat as standard.

---

## Key Question 5: Web — Playwright on self-hosted runners, headed vs headless for vision agents, trace viewer

### Takeaway
Playwright traces (`retain-on-failure`/`on-first-retry`) already bundle screenshots, DOM snapshots, network, console and sources into one `trace.zip` viewable at trace.playwright.dev or `npx playwright show-trace` — the richest single evidence format for a web verification agent. Headed runs on Linux CI need a virtual display (xvfb), but for a vision agent, headless screenshots are equivalent.

### Cited Findings
- Trace values: `'off'`, `'on'` (performance-heavy), `'retain-on-failure'`, `'on-first-retry'`, `'on-all-retries'`. Trace contents: screenshots (film strip), DOM snapshots Before/Action/After, Sources, Network (headers + bodies), Console, plus Actions/Call/Log/Errors/Metadata/Attachments tabs. Open with `npx playwright show-trace path/to/trace.zip` or upload at trace.playwright.dev (loads fully in browser, no upload to a server); remote traces via `?trace=<url>` (CORS applies). JS traces are reached through `npx playwright show-report`. — [microsoft/playwright docs/src/trace-viewer.md](https://github.com/microsoft/playwright/blob/main/docs/src/trace-viewer.md)
- Config snippet: `trace: 'on-first-retry'` with `retries: process.env.CI ? 2 : 0`; `npx playwright test --trace on` forces traces; traces are normally recorded in CI, UI Mode recommended locally. — [trace-viewer-intro-js.md](https://github.com/microsoft/playwright/blob/main/docs/src/trace-viewer-intro-js.md)

### Inferences
- On a Linux self-hosted runner without a display, run headed only when necessary: `xvfb-run --auto-servernum -- npx playwright test --headed` (standard Playwright CI guidance; the ci.md page returned 503 in this session). For a vision agent, headless Chromium screenshots (`page.screenshot({fullPage:false})`) are pixel-identical for practical purposes; use `use: { video: 'retain-on-failure', screenshot: 'only-on-failure', trace: 'retain-on-failure' }`.
- Use the official `mcr.microsoft.com/playwright:v<version>-<ubuntu>` image in ARC runner pods (or `npx playwright install --with-deps` baked into the runner image) so browsers aren't downloaded per PR.
- Store `playwright-report/` + `test-results/**/trace.zip` as artifacts; link the trace in the PR comment with a `https://trace.playwright.dev/?trace=<artifact-url>` link only if the artifact URL is publicly fetchable (GitHub artifact downloads require login, so for inline linking host traces on S3/MinIO with CORS).

### Gaps
- playwright.dev and the ci.md source were unreachable; exact `xvfb-run` command and artifact-retention examples from Playwright docs not verified here.

---

## Key Question 6: Evidence storage for PR comments (artifacts, release assets, S3/MinIO, image upload API, video→GIF, retention)

### Takeaway
The long-standing blocker — no public API to upload images to PR comments — changed on Sept 1, 2026: `gh` 2.99.0 added `--attach` for `gh pr comment`/`gh pr create`/`gh pr edit` (and issue equivalents) supporting PNG/JPEG/GIF/WebP/SVG/MP4/MOV/WebM with push access. GitHub Actions artifacts remain the default bulk store (90-day max retention, immutable v4, login required to download, 500 per job), with S3/MinIO as the public/CORS-friendly tier for traces and videos.

### Cited Findings
- `gh --attach`: repeatable flag; `gh issue comment N --attach PATH/TO/IMAGE`; alt text via `'path#ALT-TEXT'` (not supported on video); supported on `gh issue create|edit|comment`, `gh pr create|edit|comment`; CLI "only supports uploading image and media files"; "You need push access to the repository to attach files"; local paths referenced in the body are rewritten to the uploaded URL; unreferenced attachments appended at end in flag order; a video must be alone in its paragraph to render as a player. Frontmatter lists only fpt/ghec (GHES not listed). — [github/docs: attaching-files-with-github-cli.md](https://github.com/github/docs/blob/main/content/github-cli/github-cli/attaching-files-with-github-cli.md)
- Changelog (Sept 1, 2026, gh v2.99.0): GA across plans; formats PNG, JPEG, GIF, WebP, SVG, MP4, MOV, WebM; uploads authenticate with the `gh auth login` OAuth token or a classic PAT. — [github.blog changelog (search summary; page unreachable)](https://github.blog/changelog/2026-09-01-github-cli-media-in-issues-pull-requests-and-comments)
- Pre-Sept-2026 state: GitHub REST API has no endpoint for binary image uploads; drag-and-drop uses internal endpoints requiring browser cookies; workarounds were browser automation, committing images to a dedicated branch, or release assets; the gh team had previously declined image support citing no public API. — [awesome-copilot pr-screenshots skill](https://git.cynarski.dev/Awesome/awesome-copilot/src/branch/main/skills/pr-screenshots/SKILL.md), [claudeissues feature request](https://claudeissues.com/issue/26831-feature-request-allow-posting-images-screenshots-to-github-pr-issue-comments), [braindetox gh-attach analysis](https://braindetox.kr/en/posts/gh_attach_cli_2026.html)
- Note: as of a July 2026 third-party write-up GitHub still had no official public API for attachments; the gh flag uses the same upload path as the web UI (third-party analysis). — [braindetox.kr](https://braindetox.kr/en/posts/gh_attach_cli_2026.html)
- Actions artifacts (`actions/upload-artifact@v4`): "Artifacts are retained for 90 days by default"; `retention-days` 1–90 unless repo settings lower the max; `compression-level` 0–9 (default 6; 0 recommended for already-compressed video/PNG); v4 artifacts are immutable, cannot be appended across jobs; `overwrite: true` deletes and recreates (new ID); up to 500 artifacts per job; `artifact-url` output requires login to download and expires with the artifact; `artifact-id` works with the Artifacts REST API. — [actions/upload-artifact](https://github.com/actions/upload-artifact)

### Inferences
- Recommended flow: verification job uploads `evidence/` (PNG, MP4, trace.zip, ui.xml/AX JSON, logcat/oslog) as an artifact with `retention-days: 14`, `compression-level: 0`; the privileged `workflow_run` job downloads it and posts `gh pr comment $PR --body-file summary.md --attach evidence/step1.png#'Login screen' --attach evidence/run.mp4` — this needs the `GITHUB_TOKEN` of the base repo (push access) and `gh` ≥ 2.99.0 on the runner image; confirm `GITHUB_TOKEN` (a GitHub App installation token) is accepted by `--attach` on your setup, since the docs mention OAuth/classic PAT (gap below).
- Video to GIF is now largely unnecessary because MP4/MOV/WebM upload is supported and renders as a player; keep an `ffmpeg -i run.mp4 -vf "fps=8,scale=360:-1" run.gif` fallback for GHES or if `--attach` is unavailable. Short H.264 (`simctl ... --codec h264`) is the most compatible format.
- For public links usable by a trace viewer or an external dashboard, mirror evidence to S3/MinIO with signed URLs and a lifecycle rule (e.g., 30 days); GitHub artifact URLs need login and are not embeddable.
- Release assets are a poor fit for per-PR evidence (pollute releases, no auto-expiry); committing images to an `evidence` branch works but grows repo size.

### Gaps
- Size limits for `--attach` uploads and GHES support not stated on the fetched doc; verify (web UI limit historically 10 MB images / 100 MB video — unverified here).
- Whether `--attach` works with `GITHUB_TOKEN` inside Actions (vs user OAuth/classic PAT) was not confirmed.

---

## Key Question 7: OSS device farms / orchestration (DeviceFarmer/STF, Appium Grid, Selenium-Grid-like emulator orchestration)

### Takeaway
No OSS project gives a turnkey "Selenium Grid for simulators + emulators" with per-job isolation: STF is Android-only, real-device-oriented and self-described as unsafe for multi-user without changes; Emcee/Bluepill distribute XCTest across simulators; idb was built for data-centre simulator pools; docker-android gates multi-emulator/headless behind Pro. A Revyl-like system most likely needs its own thin orchestrator (queue → ephemeral VM/pod → simctl/adb) rather than a farm product.

### Cited Findings
- STF: Android 2.3.3–15, Node ≤20, RethinkDB, REST API, Docker Compose; "not suited to multiuser deployments without changes"; devices not fully reset between uses; iOS only long-term goal; slow development funded by unpaid time. — [DeviceFarmer/stf](https://github.com/DeviceFarmer/stf)
- idb: companion + Python client, remote automation of simulator pools, shard fan-out. — [facebook/idb](https://github.com/facebook/idb)
- Emcee: distributes UI tests across multiple machines with automatic simulator lifecycle management and load balancing. — [gopito/emcee](https://github.com/gopito/emcee)
- docker-android: "multiple emulators per container" and headless are Pro-only; includes an MCP server and AI agent (beta) with Ollama/vLLM. — [budtmo/docker-android](https://github.com/budtmo/docker-android)
- android-farm-operator (Kubernetes operator for emulator farms) and agoda-com/android-farm exist as references. — [tinyzimmer/android-farm-operator](https://github.com/tinyzimmer/android-farm-operator/blob/master/README.md), [agoda-com/android-farm](https://github-redirect.dependabot.com/agoda-com/android-farm)
- Google's container scripts include a WebRTC gateway (port 8080) and React UI for streaming/controlling emulators via gRPC. — [google/android-emulator-container-scripts](https://github.com/google/android-emulator-container-scripts)

### Inferences
- Appium server per job (localhost) is a simpler "grid" than Selenium Grid: each ephemeral runner starts Appium bound to a unique port with XCUITest (WDA) / UiAutomator2 drivers; the agent speaks WebDriver for taps and `getPageSource` for the tree; no shared hub is needed when each job owns its device.
- Where a shared pool is required (bare-host Macs with many simulators), a lightweight allocator (Redis lock per UDID; `xcrun simctl list -j` to discover) is enough; STF adds little for simulators.

### Gaps
- No current (2025–2026) OSS "emulator grid" with isolation guarantees found; Selenium Grid itself not researched for mobile nodes.

---

## Key Question 8: Typical timings and how teams hit <10 min PR verification

### Takeaway
Hard numbers in public sources are sparse: Quick Boot "up to 10x faster than cold boot" and "a few minutes" for cold boot (Android), "initial simulator launch can take several minutes" on Xcode 27.1 and reported 2x slowdowns on Xcode 16 (iOS), 15→6 min Android CI via remote Gradle cache, 10 min lost to 8 GB DerivedData transfer. Sub-10-minute verification therefore hinges on pre-warmed VM images with simulators/AVDs pre-booted or snapshotted, remote build caches, and building once per commit then fanning out install-only jobs.

### Cited Findings
- Quick Boot snapshot start "up to 10 times faster than a cold boot"; first boot always cold; version changes reset the snapshot. — [Android emulator snapshots](https://developer.android.com/studio/run/emulator-snapshots)
- First cold boot of a new API level takes "a few minutes" (hosted-runner vendor). — [tenki.cloud](https://tenki.cloud/docs/runners/android-emulator.md)
- `android-emulator-runner` default boot timeout 600 s; example 300 s; Ubuntu ~2–3x faster than macOS for emulator jobs. — [ReactiveCircus/android-emulator-runner](https://github.com/ReactiveCircus/android-emulator-runner)
- Xcode 27.1 known issue: initial simulator launch can take several minutes. — [Apple Xcode 27.1 release notes](https://developer.apple.com/documentation/xcode-release-notes/xcode-27_1-release-notes.md)
- Xcode 16/iOS 18 simulator: test time roughly doubled for one team on CircleCI. — [discuss.circleci.com](https://discuss.circleci.com/t/xcode-16-performance-regression/52129)
- GitHub-hosted macOS cold-start simulator boot 4–6 min (tool-repo note, not a benchmark). — [conorluddy/ios-simulator-skill](https://github.com/conorluddy/ios-simulator-skill)
- Android CI 15→6 min (P95 <10 min) via self-hosted runners + remote Gradle build cache. — [levelup.gitconnected.com](https://levelup.gitconnected.com/how-we-cut-android-ci-from-15-minutes-to-6-with-self-hosted-runners-and-remote-gradle-build-caches-ef9a539c5112)
- iOS DerivedData ~8 GB cost 10 min transfer; save only build products instead. — [circleci.com Lightspeed](https://circleci.com/blog/how-lightspeed-optimized-ios-testing)
- EAS cloud iOS builds typically 10–20 min (vendor). — [expo.dev](https://expo.dev/grow/mobile-cicd)
- simslim vendor claim: stock simulator ~4 GB RAM; trimmed 0.9 GB; 19 simulators on 16 GB possible. — [simslim](https://pkg.go.dev/github.com/mobai-app/simslim)
- GitHub macOS hosted runners bill minutes at a 10x multiplier (competitor source). — [bitrise.io 2026 runner guide](https://bitrise.io/blog/post/best-github-actions-runners-in-2026-and-hidden-pricing-traps-to-avoid)
- Mac VM licence cap: 2 concurrent macOS VMs per host. — [eclecticlight.co](https://eclecticlight.co/2022/08/04/virtualisation-on-apple-silicon-macs-8-how-apple-limits-vms/)

### Inferences
- Budget for a <10 min PR gate (inferred, needs measurement): checkout+restore caches 0.5–1 min; incremental Debug build with warm caches 2–4 min (iOS) / 1–3 min (Android); simulator/emulator ready 0.2–1 min if pre-booted in the VM image or snapshot-loaded, else 1–5 min cold; install+launch 10–30 s; agent-driven flow 1–3 min depending on steps and model latency; evidence upload + comment 0.5 min. Cold emulator/simulator boots and cache misses are the two things that push past 10 min, so bake them into images.
- Capacity math: a Mac mini/Studio with the 2-VM cap gives 2 concurrent PR verifications; at ~8 min each that is ~15 PR runs/hour/host. Bare-host (no VM) with 4–8 simulators multiplies throughput but forfeits isolation. Android on a 32-core Linux box can run 8+ emulators (4 GB each for API 37) in parallel.
- Cost: Apple-hardware CapEx (~1 Mac per 2 concurrent jobs) vs hosted macOS minutes at 10x multiplier; Linux Android capacity is cheap on bare-metal/KVM-capable hosts.

### Gaps
- No primary-source 2025–2026 benchmark for simulator boot time (Xcode 26/27) or emulator 37.x snapshot-load time on specific hardware; all timing guidance above is either vendor claims, forum reports, or inference.
- No public engineering blog found describing a complete self-hosted AI-agent PR verification pipeline with timings.
