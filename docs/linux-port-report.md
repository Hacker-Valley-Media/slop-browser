# Relatório — Port do Interceptor para Linux x64

**Versão base:** `0.23.20` (commit `679645d`) · **Data:** 2026-08-18/19
**Alvos:** `linux-x64`, `linux-arm64`, `linux-x64-musl`, `linux-arm64-musl` · **Ambiente de teste:** `ubuntu:24.04` + `alpine:3.20` (linux/amd64)
**Browsers:** Chrome · Chromium · Brave · Firefox

> Seções 1–6: o port inicial. Seções 7–10: os passos de follow-up aplicados depois (CI, empacotamento, Chromium, Firefox, musl).

---

## 1. Resumo executivo

O Interceptor já era estruturalmente portável — a camada `shared/platform.ts` separava Windows de "unix", `daemon/os-input.ts` já protegia o `dlopen` de CoreGraphics (PR #83) e `scripts/install.sh` já tinha ramos `Linux:` para Chrome e Brave. **O que faltava era o alvo de build e um conjunto de correções pontuais** onde o código assumia macOS silenciosamente.

Resultado final, validado dentro de `ubuntu:24.04`:

| | Antes | Depois |
|---|---|---|
| Alvo de build Linux | não existia | `--target=linux-x64` / `linux-arm64` (musl na fase 2) |
| Suíte de testes no Linux | 1052 pass / **19 fail** | **1062 pass / 0 fail** (1074 após a fase 2) |
| `typecheck` (3 projetos) | ok | ok |
| Fluxo `install.sh` fim-a-fim | falhava | `Extension loaded into Brave and reachable` |
| `interceptor daemon stop` | falso negativo (timeout) | `stopped: true` |
| `diagnose` (mismatch de binário) | cego no Linux | detecta Chrome e Brave |
| `capabilities.os_input` | `true` (mentira) | `false` (correto) |

Nenhuma alteração muda o comportamento em macOS: todos os caminhos novos são condicionais em `process.platform` / `uname -s`, com o ramo Darwin idêntico ao anterior.

---

## 2. Arquitetura: o que precisava existir no Linux

O produto tem três superfícies. Só a primeira é portável:

| Superfície | Implementação | Linux |
|---|---|---|
| **Browser** (`interceptor open/read/act/net/...`) | CLI Bun + daemon Bun + WebExtension MV3 | ✅ portada |
| **macOS** (`interceptor macos *`) | bridge Swift (AX, ScreenCaptureKit, Apple Events) | ❌ impossível — já bloqueada pelo *surface gate* |
| **iOS** (`interceptor ios *`) | usbmux/lockdown + `codesign`/`plutil` do macOS | ❌ impossível — mesma porta |

O `detectSurfaces()` (`cli/lib/surfaces.ts`) já exigia `process.platform === "darwin"` para habilitar macOS/iOS, então no Linux essas superfícies retornam a dica de upgrade em vez de erro de bridge. **Nada precisou mudar ali.**

O transporte também já estava correto: `listenOptions()`/`connectOptions()` usam Unix socket em tudo que não é Windows, e `/tmp/interceptor.sock` funciona igual no Linux.

---

## 3. Alterações realizadas

17 arquivos modificados, 2 criados (+369 / −68 linhas).

### 3.1 Build — `scripts/build.sh`

**Problema:** não havia alvo Linux. `--all` produzia macOS + Windows apenas.

**Alterações:**

1. **Nova função `build_linux_arch()`** espelhando `build_windows_arch()`, com os alvos `--target=linux-x64` e `--target=linux-arm64` (e o erro explícito para `--target=linux`, igual ao que já existia para `windows`).

2. **`bun-linux-x64-baseline`, não `bun-linux-x64`.** O alvo não-baseline exige AVX2. Sob emulação x86-64 (Rosetta/qemu — ou seja, *qualquer* container amd64 num host Apple Silicon) e em CPUs pré-Haswell o binário morre com SIGILL na primeira instrução, sem diagnóstico. É a mesma escolha que o projeto já fazia em `bun-windows-x64-baseline`.

3. **Guarda no bloco de `codesign`.** A condição era `uname -s == Darwin && TARGET != windows-*`. Com um alvo `linux-*`, o script tentaria assinar um ELF com `codesign` e depois executar `./dist/interceptor --version` (um binário Linux) no host macOS — falhando o build sobre um artefato correto. A condição passou a excluir `linux-*` também.

4. **Layout do pacote** em `dist/linux/<arch>/`, escolhido para ser *diretamente instalável* após a extração:

```
interceptor                        CLI  (95 MB, self-contained)
daemon/interceptor-daemon          daemon (94 MB)
daemon/com.interceptor.host.json   template do native-messaging host
extension/dist/                    extensão MV3 desempacotada
skills/{interceptor,-browser,-research}
scripts/{install.sh,uninstall.sh}
```

Duas restrições ditaram esse layout:
- `scripts/install.sh` calcula `ROOT="$(dirname $0)/.."` e procura `$ROOT/daemon/interceptor-daemon` e `$ROOT/extension/dist` — por isso o `extension/dist` aninhado.
- `resolvePackDir()` em `cli/commands/skills.ts` procura `<dir do binário>/skills` — por isso o CLI fica na raiz do pacote, com `skills/` ao lado. Confirmado em teste: `interceptor skills adopt` criou os 3 symlinks corretamente.

### 3.2 Manifestos de native messaging — `cli/lib/status-renderer.ts`

**Problema (bug real):** `installedNmhManifests()` montava caminhos macOS incondicionalmente:

```ts
`${home}/Library/Application Support/${dir}/NativeMessagingHosts/com.interceptor.host.json`
```

No Linux esses caminhos nunca existem, então a função **sempre retornava `[]`**. Consequência: `interceptor diagnose` ficava cego para a detecção de *binary mismatch* — exatamente o diagnóstico que explica "extensão não conecta" depois que o pacote é movido de lugar.

**Correção:** tabela por plataforma + raiz por plataforma.

| Plataforma | Raiz | Browsers |
|---|---|---|
| darwin | `~/Library/Application Support` | chrome, brave, chrome-beta/canary/dev/for-testing, edge, vivaldi |
| linux | `$XDG_CONFIG_HOME` ou `~/.config` | `google-chrome`, `BraveSoftware/Brave-Browser` |
| win32 | — (registro do Windows, nada em disco) | — |

O conjunto Linux é deliberadamente igual ao que `nm_dir_for()` em `install.sh` sabe escrever — listar um browser que o instalador nunca configura seria código morto.

**Validado:** com o manifesto adulterado, `interceptor diagnose` passou a reportar `⚠ binary mismatch (chrome)` e `(brave)` com os dois caminhos.

### 3.3 Navegador padrão do sistema — `cli/lib/status-renderer.ts`, `cli/commands/meta.ts`, `cli/commands/init.ts`

**Problema:** o bloco `browser:` de `status --verbose` / `init --verbose` era explicitamente `macOS-only` (`if (verbose && process.platform === "darwin")`), e a única detecção existente lia o plist do LaunchServices.

**Correção:** novo `detectSystemDefaultBrowser()` que delega para `detectMacOSDefaultBrowser()` no macOS e para `xdg-settings get default-web-browser` no Linux (retorna um id `.desktop` como `brave-browser.desktop`). O gate passou a `darwin || linux`. Windows continua fora — lá os hosts vivem no registro, não em disco.

**Validado:** no container o bloco passou a renderizar `configured: chrome, brave` / `system default: brave` / `✓ matches`.

### 3.4 Dica enganosa de upgrade — `cli/lib/status-renderer.ts`

`formatStatus()` imprimia `To enable native macOS control: interceptor upgrade --full` em **tudo que não fosse Windows** (`else if (!IS_WIN)`), inclusive Linux — onde `upgrade --full` aborta com `error: 'interceptor upgrade --full' is macOS only`. A condição passou a `process.platform === "darwin"`.

### 3.5 Liveness de processo: zumbis — `shared/platform.ts` (+ 3 call sites)

**Problema (bug real, específico de Linux):** todo o código usava `process.kill(pid, 0)` como prova de vida. Um **zumbi** — processo que já saiu mas cujo pai não fez `wait()` — continua respondendo ao sinal 0.

Isso importa no Linux porque o daemon é lançado *detached* e é reparentado ao PID 1. Em container, PID 1 costuma **não** ser um init que faz reaping (`docker run` sem `--init`, a maioria das imagens de CI, muitos pods Kubernetes). Sintoma observado no teste:

```
$ interceptor daemon stop
error: daemon did not exit and release ports 19221/19222 within 10000ms
$ ps -eo pid,ppid,stat,comm
 7920     1 Zs   interceptor-dae      ← zumbi, mas kill(pid,0) diz "vivo"
```

As portas eram liberadas em menos de 1 s; o que travava era só o `processAlive()`. O daemon **tinha** parado — o comando mentia e saía com código ≠ 0.

**Correção:** `isProcessAlive(pid)` em `shared/platform.ts` — faz o `kill(pid, 0)` e, **só no Linux**, confirma lendo o campo *state* de `/proc/<pid>/stat`, tratando `Z` como morto. O parsing corta após o **último** `)` porque o `comm` é parentetizado mas não escapado (um processo chamado `weird ) name (x)` deslocaria os campos). Se `/proc` não existir, cai de volta no sinal.

Aplicado em três lugares: `cli/commands/daemon.ts` (a falha observada), `cli/daemon-spawn.ts` (auto-start — um pid file velho + zumbi faria o CLI achar que há daemon e travar num socket morto) e `cli/lib/status-renderer.ts` (`status` reportando um daemon inalcançável como "running").

**Novo teste:** `test/process-liveness.test.ts`, 6 casos, com o leitor de `/proc` injetável.
**Validado:** `daemon stop` passou a responder `{"success":true,"stopped":true,...}` no mesmo container.

### 3.6 `capabilities.os_input` mentia no Linux — `shared/platform.ts`, `cli/index.ts`

**Problema:** `extension/src/background/capabilities/meta.ts` responde `os_input: daemonConnected` — um service worker não consegue ver o SO do host. No Linux (e no Windows) isso anuncia uma camada cuja *toda* chamada retorna "not supported": `daemon/os-input.ts` só carrega CoreGraphics no Darwin e devolve o sentinel `act --os not supported on this platform (macOS only)`.

Um agente lendo `capabilities` no Linux planejaria em cima de uma capacidade inexistente.

**Correção:** `osInputSupported()` em `shared/platform.ts` (true só no darwin) e pós-processamento no CLI — que roda no mesmo host do daemon e portanto *sabe* a resposta — corrigindo `layers.os_input` antes de imprimir.

**Validado:** `interceptor capabilities` no Linux passou a reportar `"os_input": false`.

Confirmei também o contrato do lado do daemon rodando a fixture já existente `test/fixtures/linux-os-input-check.ts` dentro do container:
```
import-ok
osClick:{"success":false,"error":"act --os not supported on this platform (macOS only)"}
```

### 3.7 `scripts/install.sh`

1. **`--dry-run` não pode exigir o browser instalado.** No ramo Linux, `browser_bin_for()` falhava com `ERROR: Chrome binary not found in PATH` *antes* do early-return de dry-run. O ramo Darwin nunca toca no disco (só monta o caminho do `.app`), então o dry-run se comportava diferente entre plataformas sem motivo. Agora o dry-run usa um placeholder. — *Isso destravou 1 dos testes que falhavam.*

2. **`probe_extension_reachable()` só conhecia o layout do repo.** Procurava `$ROOT/dist/interceptor`; no pacote Linux o CLI está em `$ROOT/interceptor`. O probe caía no `return 0` silencioso e o instalador imprimia o aviso "extension is NOT reachable" mesmo quando estava. Novo `resolve_interceptor_bin()` tenta, nessa ordem: `$ROOT/dist/interceptor` (repo) → `$ROOT/interceptor` (pacote) → `$PATH`.

### 3.8 `scripts/uninstall.sh`

Era 100% macOS. Três correções:

1. **Caminhos de manifesto por plataforma.** Array `NM_MANIFESTS` selecionado por `uname -s`: no Linux, `$XDG_CONFIG_HOME/{google-chrome,BraveSoftware/Brave-Browser,chromium}/NativeMessagingHosts/`.

2. **`$USER` não vinculada** (`set -u`). `id -u "${SUDO_USER:-$USER}"` abortava o uninstall no meio com `line 153: USER: unbound variable` — `$USER` não é exportada por shells não-login, que é o caso normal de um `docker exec`, uma unit systemd ou um runner de CI. Trocado por `${SUDO_USER:-$(id -un)}` com fallback `id -u`.

3. **`pkgutil` inexistente no Linux + `pipefail`.** `pkgutil --pkgs | grep ... | while ...` retorna ≠ 0 quando `pkgutil` não existe, e com `set -euo pipefail` isso **abortava o resto do uninstall**. Bloco envolvido em `command -v pkgutil`.

4. Home do usuário sob `sudo`: antes assumia `/Users/$SUDO_USER`. Agora consulta `getent passwd` (Linux) com fallback para a convenção macOS.

**Validado:** `uninstall.sh` roda até o fim no Linux e os dois diretórios `NativeMessagingHosts/` ficam vazios.

### 3.9 Testes

Nenhum código de produto foi ajustado para "passar no teste"; os testes é que estavam presos ao macOS.

| Arquivo | Mudança |
|---|---|
| `test/helpers/macos-tools.ts` *(novo)* | Sondas `HAS_PLUTIL` / `HAS_SECURITY` |
| `ios-nskeyed`, `ios-instruments` | `describe.skipIf(!HAS_PLUTIL)` — toda a suíte depende de `nskeyedArchive`, que faz `plutil -convert binary1` |
| `ios-lockdown`, `ios-installer`, `ios-webinspector-plist` | `test.skipIf(!HAS_PLUTIL)` só nos casos que tocam `plutil` |
| `ios-keychain` | `describe.skipIf(!HAS_SECURITY)` — usa o keychain real via `/usr/bin/security` |
| `test/diagnose-lockfile.test.ts` | Fixtures NMH por plataforma (`~/.config` vs `~/Library/Application Support`, conjuntos de browsers distintos) |
| `test/process-liveness.test.ts` *(novo)* | Cobertura do parsing de zumbi |

> **Detalhe que custou uma iteração:** a primeira versão de `macos-tools.ts` detectava a ferramenta via `spawnSync(...).error === undefined`. O `spawnSync` do Bun **não** preenche `.error` para um executável ausente — devolve `status: 127` com `error: undefined`. A sonda reportava *todas* as ferramentas como presentes. Trocado por `existsSync()` no caminho absoluto, com o motivo documentado no arquivo.

Os 2 testes de `install-modes` que ainda falhavam no container de build (sem browser) passam no container que tem Chrome e Brave — a exigência é ambiental, não da plataforma:

```
12 pass · 5 skip · 0 fail   (test/install-modes.test.ts, Ubuntu 24.04 com Chrome 151 + Brave 151)
```

---

## 4. Como foi testado

**Cadeia de build:** container `oven/bun:1.3.14` em `linux/amd64` → `bun install` → `bash scripts/build.sh --target=linux-x64` → artefatos copiados para um container `ubuntu:24.04` limpo (`/opt/interceptor`), rodando como usuário não-root.

O container de teste não tinha Bun nem Node — os binários são self-contained, então isso comprova que o pacote não depende de runtime instalado.

**Ambiente:** Ubuntu 24.04.4 LTS · Xvfb `:99` + openbox · Google Chrome 151.0.7922.169 · Brave 151.1.93.136 · servidor de fixtures em Python (estático + `/sse` + `/ws` + `/api/*.json`) em `127.0.0.1:8899`.

### 4.1 Instalação fim-a-fim

```
$ bash scripts/install.sh --browser-only --brave
==> [browser] Installing native messaging symlink(s)...
    Brave: /home/tester/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.interceptor.host.json
==> [browser] Launching Brave with --load-extension...
==> Verifying extension reachability (waits up to 8s)...
==> Extension loaded into Brave and reachable.
    Extension ID: hkjbaciefhhgekldhncknbjkofbpenng
```

```
$ interceptor status --verbose
mode: browser-only
daemon: running   pid: 3240   transport: unix:/tmp/interceptor.sock
browser:  configured: brave · system default: brave · ✓ matches
extension: reachable (a content-script ping succeeded against an interceptor-group tab)
skills: ✓ claude: 3/3 linked
```

O daemon foi lançado **pelo próprio Brave** via native messaging (`mode:native-messaging` → `spawning detached standalone daemon` → `ws extension registered`), que é o caminho real de produção, não um `--standalone` manual.

### 4.2 Matriz de verbos exercitados

| Grupo | Verbos | Resultado |
|---|---|---|
| Compostos | `open` `read` `act` `inspect` | ✅ |
| Leitura | `text` `text --markdown` `html` `tree` `state` `find` `diff` | ✅ |
| Extração | `table` `links` `images` `forms` `query` `exists` `count` `attr` `style` | ✅ |
| Ações | `click` `click --selector` `click text:` `type` `select` `check` `focus` `hover` `dblclick` `rightclick` `keys` `drag` `scroll` `what-at` `regions` `upload` | ✅ |
| Navegação | `navigate` `back` `forward` `wait` `wait-stable` | ✅ |
| Abas/janelas | `tabs` `tab new/switch` `window` `frames` `contexts` `group` `brand` | ✅ |
| Rede | `net log` `net log --format har/pcapng` `net monitor` `net page-comm log` `headers add/clear` `override` `sse log` `sse streams` | ✅ |
| Captura | `screenshot` `screenshot --save` `canvas status/list` `ocr` `save` | ✅ |
| Dados | `storage` `history` `bookmarks` `downloads` `cookies` `clear` | ✅ |
| Batch/monitor | `batch` `monitor start/status/stop/list` | ✅ |
| Locais | `status` `init` `diagnose` `capabilities` `manifest` `skills list/status/adopt` `mcp status/install/uninstall` `research` `extensions` `keepawake` `idle` `delegate` `events` `daemon stop` | ✅ |
| Gates de superfície | `macos *` `ios *` `upgrade --full` | ✅ erram com a mensagem correta |

Evidências pontuais:

- **Captura passiva de rede** — `fetch` e `XHR` gravados com corpo, headers e content-type; export HAR válido (2 entries, JSON parseável) e pcapng com magic `0a 0d 0d 0a` correto.
- **SSE** — `sse streams` mostrou o stream vivo (`chunkCount: 3`, texto acumulado) e `sse log` o stream concluído (`totalChunks: 5`, `duration: 4717`).
- **WebSocket / BroadcastChannel** — `net monitor on --reload` + `net page-comm log` capturou `ws_opening`, `ws_open`, `broadcast_open` e `broadcast_send` com payload.
- **OCR** — roda inteiramente na extensão (tesseract.js no offscreen document, WASM empacotado). `source: "tesseract"`, `confidence: 81`, leu o texto do canvas.
- **Screenshot** — PNG de página inteira, 1019×3194, 237 KB, verificado byte a byte (magic PNG + dimensões no IHDR) e inspecionado visualmente: renderização completa e correta.
- **`skills adopt`** — 3 symlinks criados em `~/.claude/skills/` apontando para `/opt/interceptor/skills/*`.
- **`mcp install`** — escreveu `~/.claude.json` com `"command": "/opt/interceptor/interceptor"`.

### 4.3 Suíte automatizada

```
$ bun test        # dentro do Ubuntu 24.04
1062 pass · 37 skip · 0 fail · 3091 expect() · 138 arquivos · 25.35s

$ bun run typecheck
tsconfig.host.json ✓  tsconfig.extension.json ✓  tsconfig.json ✓
```

### 4.4 Limpeza

Os containers `interceptor-build`, `interceptor-linux-test`, `interceptor-linux-test2`, a imagem-snapshot e as imagens base baixadas para o teste (`ubuntu:24.04`, `oven/bun:1.3.14`, `alpine:latest`) foram removidos ao final.

---

## 5. Limitações conhecidas no Linux

### 5.1 Por design (paridade com Windows)

| Item | Situação |
|---|---|
| `interceptor macos *` / `ios *` | Exigem host macOS. O surface gate já bloqueia. |
| `upgrade --full` / `update` (Sparkle) | macOS apenas. No Linux, rebuild/reinstale o pacote. |
| `act --os` / `click --trusted` (input de SO) | Sem backend. O daemon devolve o sentinel explícito; `capabilities` agora reporta `os_input: false`. Implementar via XTEST/uinput seria uma feature nova, não parte do port. |

### 5.2 Do navegador, não da plataforma

- **Google Chrome ignora `--load-extension`.** Confirmei no Chrome 151 Linux: a flag é descartada silenciosamente (o perfil não registra a extensão) e `--disable-features=DisableLoadExtensionCommandLineSwitch` já não funciona. É o mesmo comportamento que o `install.sh` documenta para macOS/Windows — em builds *branded* o caminho é "Load unpacked" manual. Brave, Vivaldi e Chrome for Testing continuam honrando a flag, e por isso o fluxo automático do `install.sh --brave` funciona ponta a ponta.
- **`interceptor eval` exige o toggle "Allow User Scripts".** Sem a API `chrome.userScripts` habilitada por extensão, o eval cai num caminho limitado pela CSP da *extensão* e falha com "page CSP blocks eval" mesmo em páginas sem CSP. `interceptor capabilities` já expõe isso (`userScripts.api_present: false`). Não é específico do Linux — é um pré-requisito de instalação.

### 5.3 Não verificável em container headless

Duas funcionalidades dependem de o Chromium reportar a janela como **focada pelo SO** (`chrome.windows.get().focused`). Sob Xvfb + openbox isso nunca fica `true`, mesmo com `xdotool windowactivate`:

- `clipboard read/write` → `Document is not focused` (restrição da Clipboard API).
- Escalada automática de `click` para input de SO, que exige aba ativa em janela focada.

Nenhuma das duas tem código específico de plataforma; ambas precisam de uma sessão de desktop real para validação.

### 5.4 Observações registradas (sem alteração de código)

Duas coisas que encontrei durante a investigação **não são regressões do port** e afetam macOS igualmente — deixo registradas em vez de mudá-las às cegas:

1. **`waitForMutation()` instala o `MutationObserver` depois do dispatch do clique** (`extension/src/content/input-simulation.ts:108`), então uma mutação *síncrona* do handler nunca é vista e o clique é marcado como "no DOM change". Isso é conhecido e assumido pelo projeto — `extension/src/content/actions/click-selector.test.ts:28` comenta exatamente esse comportamento e as fixtures mutam de forma assíncrona por causa dele. Não mexi.

2. **A escalada automática para `os_click` não chega a postar um evento de SO.** O router da extensão devolve `type: "click"` com um payload `method: "os_event"`, mas o daemon só posta o evento quando `actionType` começa com `os_` (`daemon/index.ts:768` e `:1467`). Ou seja, a escalada produz metadados (`escalated: {...}`) sem input de SO real, em qualquer plataforma. Quando ela "falha", o motivo observado foi sempre o guard de foreground (`tab is not the active tab` / `window is not the OS-focused window`), idêntico no macOS.

O efeito prático no Linux: um clique que realmente aconteceu pode ser reportado como `click failed at all layers` quando o `waitForMutation` erra. O caminho correto de correção é o item (1), que é uma decisão do projeto — não uma questão de porta.

---

## 6. Arquivos alterados

| Arquivo | Natureza |
|---|---|
| `scripts/build.sh` | alvo `linux-x64` / `linux-arm64`, staging do pacote, guarda do codesign |
| `scripts/install.sh` | dry-run sem browser; resolução do CLI no layout de pacote |
| `scripts/uninstall.sh` | manifestos por plataforma, `$USER` não vinculada, `pkgutil` guardado, home sob sudo |
| `shared/platform.ts` | `isProcessAlive()` (zumbis), `osInputSupported()` |
| `cli/lib/status-renderer.ts` | NMH por plataforma, `detectSystemDefaultBrowser()`, dica macOS-only, liveness |
| `cli/commands/daemon.ts` | liveness zumbi-aware |
| `cli/daemon-spawn.ts` | liveness zumbi-aware |
| `cli/commands/meta.ts`, `cli/commands/init.ts` | bloco `browser:` habilitado no Linux |
| `cli/index.ts` | correção de `capabilities.os_input` |
| `test/helpers/macos-tools.ts` *(novo)* | sondas de `plutil` / `security` |
| `test/process-liveness.test.ts` *(novo)* | cobertura de zumbis |
| `test/ios-*.test.ts` (5), `test/diagnose-lockfile.test.ts` | gates por ferramenta / fixtures por plataforma |
| `docs/linux-install.md` *(novo)* | guia de instalação Linux |

---

## 7. Fase 2 — passos de follow-up aplicados

Os itens 1, 2, 3 e 5 da lista original de próximos passos foram implementados e validados; o item 4 (input de SO via XTEST/uinput) foi explicitamente descartado.

**Resultado da fase 2, validado em `ubuntu:24.04`:**

| | Antes da fase 2 | Depois |
|---|---|---|
| Suíte de testes no Linux | 1062 pass / 0 fail | **1074 pass / 0 fail** / 37 skip |
| CI | só `macos-15` | job `ubuntu-24.04` (typecheck + testes + build + smoke + pacote) |
| Distribuição | só a árvore `dist/linux/<arch>/` | `.tar.gz` + `.deb` + `.rpm`, CLI no `PATH` |
| Browsers no Linux | Chrome, Brave | **+ Chromium, + Firefox (build Gecko)** |
| libc | só glibc | **+ musl** (Alpine) |
| Clique que "pousa" mas não muta o DOM | `click failed at all layers` | `success` + aviso honesto |

### 7.1 CI Linux — `.github/workflows/ci.yml`

Job `ubuntu-24.04` rodando em paralelo com o `macos-15` (renomeado para `macos — …`):

`bash -n` em `scripts/*.sh` → `bun install --frozen-lockfile` → `typecheck` → `bun test` → `build.sh --target=linux-x64` → smoke do CLI/daemon (`--version`, `status`, `daemon stop`) → `install.sh --dry-run` para os **quatro** targets Linux → `package-linux.sh --arch x64 --format tar.gz,deb`.

O runner `ubuntu-24.04` já traz Chrome e Firefox instalados, então a detecção de browser do `install.sh` e os testes `install-modes` rodam de verdade em vez de pular.

### 7.2 Empacotamento — `scripts/package-linux.sh` *(novo)*

```
bash scripts/package-linux.sh --arch x64                  # tar.gz + deb + rpm
bash scripts/package-linux.sh --arch x64 --format tar.gz  # só o tarball
bash scripts/package-linux.sh --arch x64-musl             # tar.gz apenas
```

Prefixo `/opt/interceptor`, com `/usr/bin/interceptor` → binário e `/usr/bin/interceptor-install` → wrapper do `install.sh`.

Decisões que valem registrar:

- **O pacote de sistema NÃO registra o native-messaging host.** Isso escreve em `~/.config` / `~/.mozilla` — estado por usuário que uma instalação como root não pode criar para um usuário arbitrário. O `postinst` imprime o comando (`interceptor-install --browser-only --chrome`).
- **`deb`/`rpm` são recusados para alvos musl.** Um binário musl instala limpo num Debian e não executa; produzir o pacote seria um erro silencioso.
- **`AutoReqProv: no` no spec do RPM** — os binários são Bun self-contained; o autodetector geraria dependências que não existem.
- **Alpine precisa de `apk add libstdc++ libgcc`.** Os builds musl do Bun linkam essas libs dinamicamente e o Alpine base não as traz — sem elas o binário morre com `Error loading shared library libstdc++.so.6` antes de imprimir nada. O `README-INSTALL.txt` do tarball musl traz esse passo como item 0.

**CLI no `PATH`:** `install.sh` ganhou `link_cli_onto_path()` (Linux apenas — macOS usa o pkg, Windows o Setup). Symlink, nunca cópia; recusa-se a sobrescrever um arquivo real; avisa quando o diretório não está no `PATH`; flags `--no-link-cli` e `--link-cli-dir <dir>`. O caminho criado é **gravado** em `<generated>/cli-link` para que o `uninstall.sh` remova exatamente aquele link — sem o registro, um `--link-cli-dir` customizado ficaria órfão.

> **Bug encontrado no caminho:** a leitura desse registro estava *depois* do bloco que apaga `daemon/.generated`, ou seja, o arquivo era removido antes de ser lido. Corrigido hoistando a leitura para antes da limpeza.

**Bug real de empacotamento:** `install.sh` gravava o manifesto resolvido em `$ROOT/daemon/.generated`. Num prefixo root-owned (`/opt` vindo do deb) o usuário não pode criar esse diretório — `mkdir: cannot create directory '/opt/interceptor/daemon/.generated': Permission denied`. Agora, quando `$ROOT/daemon` não é gravável, o manifesto vai para `${XDG_STATE_HOME:-~/.local/state}/interceptor` — a mesma raiz que `shared/monitor-tasks.ts` já usa no Linux.

### 7.3 Chromium — suporte completo

Chromium usa a **mesma** extensão MV3 de Chrome/Brave, então foi só tabela de instalação:

- `install.sh`: `--chromium` em `profile_root_for` / `nm_dir_for` / `browser_installed` / `browser_bin_for`, na auto-detecção e no dispatch de `load_extension`. Detecta `chromium` ou `chromium-browser` no `PATH`; NM dir em `~/.config/chromium/NativeMessagingHosts`.
- `status-renderer.ts`: entrada `chromium` em `NMH_BROWSER_DIRS_LINUX`.
- `uninstall.sh`: já cobria `~/.config/chromium`.
- `detectLinuxDefaultBrowser()` passou a distinguir `chromium` de `chrome` — antes o `.desktop` do Chromium era mapeado para `"chrome"`, o que produziria um "✓ matches" falso agora que são alvos de instalação distintos.

Chromium é *unbranded*, então honra `--load-extension`: `install.sh --chromium` carrega e lança em um passo.

**Validado:** Chromium 154 (snapshot oficial), extensão carregada, daemon spawnado pelo próprio browser via native messaging, e a matriz de verbos verde (tree/text/table/click/type/select/check/hover/dblclick/rightclick/keys/scroll/navigate/exists/count/storage/net log/screenshot/**ocr**/capabilities).

### 7.4 Firefox — build Gecko novo

Firefox não é Chromium: exigiu um terceiro alvo de extensão, ao lado dos existentes MV2-Electron e Safari.

**`extension/src/background-firefox.ts` *(novo)*** — mesmo padrão do `background-safari.ts`: compõe os mesmos módulos `background/*`, mas com o transporte normal (native messaging + WebSocket loopback; Gecko não tem o sandbox do Safari) e cada passo opcional embrulhado, para que uma API ausente perca **uma** capacidade e nunca o contexto inteiro. Não registra `background/cdp.ts` (`chrome.debugger`) nem `keepawake` (`chrome.power`) — omitidos em vez de embrulhados, para que a ausência fique visível no arquivo.

**`build_extension_firefox()` em `scripts/build.sh`** — reusa `content.js` / `inject-net.js` / `inject-canvas.js` / `popup.js` verbatim do build Chromium e gera um manifesto Gecko. Quatro diferenças, todas obrigatórias:

| | Chromium | Gecko |
|---|---|---|
| background | `service_worker` | `scripts` (event page) — um `service_worker` faz a extensão não carregar |
| identidade | `key` (id determinístico) | `browser_specific_settings.gecko.id` |
| autorização do host nativo | `allowed_origins: ["chrome-extension://…"]` | `allowed_extensions: ["interceptor@hackervalley.media"]` |
| permissões | 27 | 19 (removidas: `tabGroups`, `debugger`, `power`, `offscreen`, `tabCapture`, `pageCapture`, `userScripts`, `search`) |

`strict_min_version: "129.0"` — `world: "MAIN"` em content scripts chegou no 128 e `match_origin_as_fallback` no 129, e ambos são usados.

**`daemon/com.interceptor.host.firefox.json` *(novo)*** — template Gecko do host nativo. `install.sh` seleciona template + diretório de extensão + NM dir via um único `IS_GECKO`.

**Diferenças operacionais tratadas no `install.sh`:**
- NM dir do Firefox é `~/.mozilla/native-messaging-hosts` — **um por usuário**, fora da árvore XDG e fora da árvore de perfis. Por isso ele é resolvido separadamente também no `installedNmhManifests()`.
- `--profiles` não se aplica (perfis Gecko são indexados por `profiles.ini`, não são diretórios "Default"/"Profile 2"); o comando explica isso e sai.
- Firefox não tem `--load-extension`. O `load_extension` imprime o caminho do `about:debugging` e para, em vez de lançar um browser que ignoraria a flag.

**Contexto fixo `firefox`** (Chromium usa UUID aleatório), então os dois coexistem no mesmo daemon e o Firefox é endereçável com `--context firefox`.

**Validado:** Firefox 154, add-on instalado via RDP (`installTemporaryAddon` — a mesma chamada do `about:debugging` e do `web-ext`), registrado como contexto `firefox` simultaneamente com o Chromium. Verde: árvore a11y, text/html/find, table/links/images/forms/query/exists/count/attr, click (selector, ref, `text:`), type/select/check/focus/hover/dblclick/rightclick/keys/scroll, navigate/back, tabs/frames/window/group, **captura passiva de fetch+XHR**, **SSE**, **WebSocket + BroadcastChannel**, screenshot de página inteira, canvas list, storage/history/downloads/cookies, batch, monitor.

### 7.5 O bug do clique — resolvido

O primeiro relatório registrou, sem corrigir: um clique sintético que **pousa** mas cuja mutação de DOM não é observada em 200 ms escala para `os_click`, e essa escalada falha, produzindo `click failed at all layers` para uma ação que funcionou.

Com o Firefox entrando em cena isso deixou de ser aceitável: no Gecko a escalada é *estruturalmente* impossível. A correção tem três partes:

1. **`ExtensionTransportConfig.osInputAvailable`** — um entrypoint pode declarar que aquele build não tem lane de input de SO. O `background-firefox.ts` declara `false`.
2. **O daemon informa o host.** O ack de registro (`context_registered`) passou a carregar `osInput: boolean`, vindo de `osInputSupported()` — que só é `true` no macOS. Campo opcional: um daemon antigo simplesmente não o envia e a extensão mantém o default. Isso conserta o build **Chromium rodando em Linux/Windows**, que não tem como enxergar o SO do host de dentro de um service worker.
3. **O router só escala se houver para onde.** `isOsInputAvailable()` virou assíncrona e é aguardada antes de decidir. Quando não há lane, o resultado sintético é devolvido como **sucesso** com o aviso `no DOM change after click — …`, que é a informação que o usuário realmente precisa.

Como MV3 destrói o service worker por ociosidade e leva o estado de módulo junto, a resposta do daemon é **persistida** em `chrome.storage.local` e reidratada sob demanda — sem isso, o primeiro clique após cada acordar voltaria a escalar.

`interceptor capabilities` passou a reportar exatamente o valor que o router consulta, em vez de "há um daemon conectado".

**Antes → depois**, mesmo botão sem handler, Chromium/Linux:

```
{"success": false, "error": "click failed at all layers", ...}
{"success": true,  "data": "clicked [e1]",
 "warning": "no DOM change after click — if the site requires trusted events, try: interceptor click --trusted e1"}
```

> **Nota de diagnóstico:** a primeira verificação desta correção falhou por um motivo que não era o código — um perfil Chromium reaproveitado mantinha o **service worker antigo** da extensão. Com `--user-data-dir` novo, o comportamento correto apareceu imediatamente. Isso está registrado no troubleshooting do `docs/linux-install.md`.

### 7.6 Degradação honesta de APIs ausentes no Gecko

Três erros crus viraram mensagens acionáveis:

| Verbo | Antes (Firefox) | Depois |
|---|---|---|
| `ocr` | `Type error for parameter filter (Error processing contextTypes.0: Invalid enumeration value "OFFSCREEN_DOCUMENT")` | `this browser has no offscreen-document API (Chromium-only) … use a Chromium-based browser for ocr` |
| `keepawake` | `can't access property "requestKeepAwake", chrome.power is undefined` | `keepawake is unavailable — this browser has no power API (Chromium-only)` |
| `bookmarks` | `An unexpected error occurred` | `bookmarks call failed: An unexpected error occurred` (com checagem de presença da API) |

Sobre `bookmarks`: só a forma-árvore falha no Gecko; `bookmarks --query` funciona. A API existe e o erro vem do próprio Firefox, então o handler agora distingue "API ausente" de "chamada falhou" e repassa o texto original em vez de engolir.

### 7.7 musl / Alpine

`--target=linux-x64-musl` e `--target=linux-arm64-musl` (`bun-linux-x64-musl-baseline` / `bun-linux-arm64-musl`), staging idêntico ao glibc em `dist/linux/<arch>-musl/`.

**Validado em `alpine:3.20`:** após `apk add libstdc++ libgcc`, `interceptor --version`, `status`, `daemon stop`, `manifest --json` e `skills list` rodam. O `ldd` confirma o linker musl (`/lib/ld-musl-x86_64.so.1`).

### 7.8 Cobertura de teste adicionada

| Arquivo | O que trava |
|---|---|
| `test/nmh-locations.test.ts` *(novo)* | As três formas de diretório NMH (macOS / XDG / `~/.mozilla`), o conjunto de browsers por plataforma, `XDG_CONFIG_HOME` respeitado só pela família Chromium, e Windows/sem-HOME retornando vazio |
| `test/context-uniqueness.test.ts` | O ack de registro carregando (ou omitindo) `osInput`, e `claimContextId` repassando o flag |

---

## 8. Arquivos alterados na fase 2

| Arquivo | Natureza |
|---|---|
| `.github/workflows/ci.yml` | job `ubuntu-24.04` |
| `scripts/package-linux.sh` *(novo)* | tar.gz / deb / rpm |
| `scripts/build.sh` | `build_extension_firefox`, alvos musl, staging da extensão Gecko + template |
| `scripts/install.sh` | `--chromium`, `--firefox`, `--no-link-cli`, `--link-cli-dir`, seleção Gecko, `GENERATED_DIR` gravável, link do CLI no PATH |
| `scripts/uninstall.sh` | NM do Firefox, registro do link do CLI (lido antes da limpeza) |
| `extension/src/background-firefox.ts` *(novo)* | entrypoint Gecko |
| `daemon/com.interceptor.host.firefox.json` *(novo)* | template do host nativo Gecko |
| `daemon/context-registration.ts`, `daemon/index.ts` | `osInput` no ack de registro |
| `extension/src/background/transport.ts` | `osInputAvailable` + persistência + consumo do ack |
| `extension/src/background/router.ts` | escalada condicionada à existência da lane |
| `extension/src/background/capabilities/meta.ts` | `os_input` reporta a visão do router |
| `extension/src/background/offscreen.ts` | guarda de API ausente |
| `extension/src/background/keepawake.ts` | guarda de `chrome.power` |
| `extension/src/background/capabilities/bookmarks.ts` | erro atribuído |
| `cli/lib/status-renderer.ts` | `chromium` + `firefox` na tabela NMH, `defaultBrowserMatchesConfigured()` |
| `cli/commands/meta.ts`, `cli/commands/init.ts` | uso do matcher compartilhado |
| `cli/commands/diagnose.ts` | dica de mismatch neutra quanto ao browser |
| `test/nmh-locations.test.ts` *(novo)*, `test/context-uniqueness.test.ts` | cobertura |
| `docs/linux-install.md` | Chromium, Firefox, pacotes, musl, troubleshooting |

---

## 9. Ambiente de validação da fase 2

Container `ubuntu:24.04` (linux/amd64, `--security-opt seccomp=unconfined`), Xvfb `:99` + openbox, servidor de fixtures Python (estático + `/sse` + `/ws` + `/api/*.json`), instalado a partir do **`.deb`** como usuário não-root.

Browsers: Google Chrome 151.0.7922.169 · Brave 151.1.93.136 · Chromium 154.0.8011.0 (snapshot oficial) · Firefox 154.0 (tarball Mozilla). Alpine 3.20 para o binário musl.

Testes finais: `1074 pass / 37 skip / 0 fail` em 139 arquivos; `typecheck` limpo nos 3 projetos; `.deb`, `.rpm` e `.tar.gz` construídos e o `.deb` instalado/desinstalado de verdade.

Containers e imagens removidos ao final.

---

## 10. O que continua fora de escopo

- **Input de SO no Linux (XTEST/uinput)** — descartado explicitamente. Continua sendo uma feature nova, com implicações de permissão, e não parte do port. `act --os` / `--trusted` seguem devolvendo o sentinel honesto, agora também refletido em `capabilities` e na decisão de escalada.
- **Edge e Vivaldi no Linux** — fora do pedido; os diretórios seriam `~/.config/microsoft-edge` e `~/.config/vivaldi`, e adicioná-los exige tocar `nm_dir_for()`/`browser_installed()` no `install.sh` **e** `NMH_BROWSER_DIRS_LINUX` no `status-renderer.ts`, mantidos em espelho de propósito.
- **XPI assinado do Firefox** — o add-on hoje carrega como temporário (`about:debugging`), que some ao fechar o browser. Assinar exige conta e submissão na AMO.
- **`waitForMutation` instalando o observer depois do dispatch** — o projeto documenta esse comportamento num teste próprio (`click-selector.test.ts:28`); permanece intocado. A correção da fase 2 remove a *consequência* no Linux (o falso "failed"), não a causa.
