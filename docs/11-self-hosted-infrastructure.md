# 11 · Infrastruktura self-hosted (GitHub Actions)

## 1. Topologia referencyjna

| Pula | Sprzęt | Runner | Izolacja | Platformy |
|---|---|---|---|---|
| `mac` | Mac mini/Studio Apple Silicon, 32–64 GB RAM, macOS 26/27, Xcode 27 | Tart + Cilicon lub runscaler; JIT runner w VM | 1 VM macOS per job, max 2 równoległe | iOS Simulator (+ opcjonalnie Android arm64 emulator na Hypervisor.framework, web) |
| `linux` | serwer x86_64 z KVM (bare-metal lub nested-virt), 32+ rdzeni, 128 GB | ARC (`gha-runner-scale-set`) ephemeral pody | pod per job, `/dev/kvm` przez device plugin | Android Emulator x86_64, web (Playwright), build Android |
| `services` | dowolny host/K8s | — | — | MinIO/S3, Postgres (App Map), Gradle build cache node, mitmproxy, vLLM (opcjonalnie), `revlee-app` (GitHub App) |

Etykiety runnerów: `[self-hosted, macos, arm64, xcode-27, revlee]`, `[self-hosted, linux, kvm, android, revlee]`. Runner groups ograniczają, które repozytoria mogą używać puli Mac.

## 2. Pula macOS (ephemeral VM)

### 2.1 Obraz bazowy (Packer/Tart)

1. `tart clone ghcr.io/cirruslabs/macos-tahoe-xcode:27 revlee-ios-base` (lub własny obraz).
2. Provisioning: Node 22, `agent-device`, `gh` ≥ 2.99, `ffmpeg`, `odiff`, CocoaPods, runner GitHub Actions (bez rejestracji).
3. Pre-rejestracja runtime iOS 27.0 i **pre-boot symulatora** `iPhone 17` + `xcrun simctl shutdown` tak, aby snapshot VM miał ciepłe cache (omija „several minutes initial launch” Xcode 27.1).
4. `tart push` do rejestru OCI (Harbor/GHCR).

### 2.2 Cykl joba

```
host: Cilicon (lub runscaler) → tart clone base → tart run --net-softnet (izolacja od hosta)
      → wstrzyknięcie JIT config (POST /repos/{o}/{r}/actions/runners/generate-jitconfig)
      → ./run.sh --jitconfig …  → job → VM usunięta
```
- `--net-softnet` blokuje dostęp do hosta; egress tylko przez proxy hosta z allow-listą (GitHub, LLM API, S3, rejestr).
- Pamięć VM ≥ 12 GB (symulator ~4 GB + Xcode build).
- Cache hosta montowany read-only do VM (SPM/CocoaPods/Node) i kopiowany na start; produkty buildu z poprzednich SHA `main` w MinIO.

### 2.3 Przepustowość

2 VM × ~8 min = ~15 weryfikacji iOS/h/host. Skalowanie: kolejne Maci w tej samej runner group. Alternatywa „bare host, N symulatorów” daje więcej równoległości, ale bez izolacji: dopuszczalna tylko dla zaufanych PR-ów i wyłączona domyślnie.

## 3. Pula Linux (ARC + KVM)

### 3.1 Klaster

- Node pool na hostach z KVM; `kubevirt.io/kvm` device plugin (lub privileged DinD jako fallback).
- Helm: `gha-runner-scale-set-controller` + `gha-runner-scale-set` (`containerMode: kubernetes` lub DinD), `minRunners: 1` (ciepły), `maxRunners` wg RAM (≥ 6 GB per pod z emulatorem).
- Obraz runnera: Ubuntu 24.04, Android SDK (cmdline-tools, platform-tools, emulator 37.x pinned, system image `google_apis;x86_64` API 35), Java 17, Node 22, `agent-device`, Playwright z przeglądarkami (`npx playwright install --with-deps`), `gh`, `ffmpeg`, `odiff`, `mitmproxy`.
- **AVD z Quick Boot snapshotem wbudowany w obraz** (utworzony przy budowie obrazu: boot, animacje off, `-no-snapshot-save` wyłączone raz), uruchamiany `-read-only` → N instancji współdzieli snapshot.

### 3.2 Pod manifest (fragment)

```yaml
resources:
  limits: { devices.kubevirt.io/kvm: 1, memory: 8Gi, cpu: "4" }
securityContext: { runAsUser: 1001, supplementalGroups: [kvm] }
env:
  - { name: ANDROID_EMULATOR_HOME, value: /opt/avd }
```

### 3.3 Gradle remote cache

`gradle/build-cache-node` jako Deployment z PVC; w projektach `org.gradle.caching=true` + `buildCache { remote(HttpBuildCache) { url = "http://gradle-cache:5071/cache/"; push = <tylko main> } }`. Oczekiwany efekt (dane z literatury): 15 → 6 min buildu Android.

## 4. Web

Playwright w podach Linux (ten sam obraz). Aplikacja web startuje w podzie (`npm run start`) albo Revlee dostaje `--url` preview deploymentu (Vercel/Netlify) wykrytego przez Deployments API (`deployments: read`), z nagłówkiem bypass dla ochrony preview (sekret w Orchestratorze, wysyłany tylko do hosta preview).

## 5. Sieć i proxy

- Każdy job ma lokalny `mitmproxy` z allow-listą `security.allowed_hosts` (backend testowy, CDN); emulator `-http-proxy`, symulator przez proxy systemowe VM, Playwright `proxy`.
- CA mitmproxy: iOS `xcrun simctl keychain add-root-cert` (+ zaufanie w ustawieniach, zautomatyzowane w obrazie); Android: obraz AOSP (nie Google Play) z CA w systemowym magazynie (Android 14: tmpfs mount na `/apex/com.android.conscrypt/cacerts`), albo preferowane: mock w aplikacji (MSW) zamiast MITM.
- Egress runnera: GitHub, dostawcy LLM, S3, rejestry pakietów (przez lokalny mirror).

## 6. Czas: budżet < 10 min

| Krok | Cel | Jak |
|---|---|---|
| Przydział runnera | < 30 s | `minRunners: 1`; pre-warm VM pool (Cilicon) |
| Checkout + cache | 30–60 s | lokalne cache hosta, shallow clone |
| Build PR | 2–4 min iOS / 1–3 min Android | remote cache, ciepłe daemony, build tylko Debug, reużycie natywnego buildu przy zmianach JS |
| Build/pobranie base | 0–60 s | artefakt z `main` w MinIO |
| Urządzenie gotowe | 10–60 s | snapshot/pre-boot w obrazie |
| Wykonanie | 1–4 min | replay + a11y-first |
| Base compare | 0,5–2 min | replay |
| Sędzia + raport | 30–60 s | równoległe głosy |
| **Razem** | **6–12 min** | |

Pomiary czasu bootu na docelowym sprzęcie to pierwsze zadanie fazy 1 (brak wiarygodnych publicznych liczb dla Xcode 27 / emulatora 37.x).

## 7. Operacje

- **Monitoring:** metryki runów (czas faz, koszt, werdykty, cache hit-rate, triage) do Prometheus/Grafana przez `revlee stats --prom`; logi runnerów do Loki.
- **Aktualizacje:** obrazy VM/podów budowane co tydzień (pin Xcode/emulator/system image; zmiana wersji unieważnia snapshoty i część cache kroków: raport pokazuje „profil urządzenia zmieniony”).
- **Sprzątanie:** VM/pody ephemeral; na hostach `tart prune`, rotacja obrazów; S3 lifecycle; `revlee cache gc`.
- **Awaria urządzenia:** retry przydziału raz; potem `unable_to_verify(infra)` z neutralnym check runem, nigdy `failure`.

## 8. Alternatywne wdrożenia

- **Jeden Mac na start (MVP):** runner bezpośrednio na hoście, 1 job na raz, Android emulator arm64 na tym samym Macu, web też. Tylko zaufane PR-y. Wystarcza do walidacji produktu.
- **Hybryda:** iOS self-hosted, Android/web na GitHub-hosted `ubuntu-latest` z KVM (ReactiveCircus) — gdy nie ma serwera Linux.
- **Bez Actions:** `revlee-app` jako samodzielny serwer (webhooki GitHub App) kolejkujący runy do własnych workerów (faza 3); ten sam CLI i konfiguracja.
