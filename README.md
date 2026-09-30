# totem-player

Player web do totem do Atacadão. Roda em hardware modesto (Android TV Box,
Raspberry Pi, mini-PC) via Chromium/navegador em modo `--kiosk`. É **vanilla
JS puro, sem framework e sem build step** — de propósito, para não pesar em
hardware fraco e para não depender de um pipeline de build no totem.

Este repositório é independente dos repos irmãos `totem-backend` (API) e
`totem-cms` (painel administrativo), que são desenvolvidos em paralelo.

## Arquitetura de módulos

Cada arquivo é um módulo com uma única responsabilidade, que se registra em
`window.TotemPlayer.<nome>` como uma IIFE. `index.html` carrega os scripts em
ordem (via `<script>` tags simples, sem bundler) e `app.js` é sempre o
último: ele orquestra os outros módulos, mas não tem lógica de domínio
própria.

```
config.js         → TotemPlayer.config     — lê TOTEM_ID da query string, URL da API, versão do player
cache.js           → TotemPlayer.cache      — persiste/lê ofertas no IndexedDB; filtro de dayparting client-side
render.js          → TotemPlayer.render     — desenha a oferta atual, loop de rotação, tela de fallback
logger.js          → TotemPlayer.logger     — loga local (console) e remoto (POST /logs)
heartbeat.js        → TotemPlayer.heartbeat  — POST /totems/:id/heartbeat a cada 30s
commands.js         → TotemPlayer.commands   — reage a comandos remotos recebidos via WebSocket
proof-of-play.js    → TotemPlayer.proofOfPlay — POST /totems/:id/proof-of-play ao trocar de oferta
wakelock.js          → TotemPlayer.wakelock   — Wake Lock API, evita a tela apagar/suspender
watchdog.js          → TotemPlayer.watchdog   — recarrega a página se o loop de exibição travar
app.js               → orquestrador final: carrega estado inicial, conecta WebSocket, liga os outros módulos
service-worker.js    → cache do "shell" da aplicação (os próprios arquivos .js/.html), estratégia network-first
```

`player-teste.html` é uma página standalone (sem backend, sem os módulos
acima) só para validar visualmente em hardware físico como cada estado do
player real se parece, antes do backend estar pronto — ver seção abaixo.

## Contrato de API consumido

> O backend (`totem-backend`) traduziu todas as rotas, payloads e eventos
> WebSocket de português para inglês (breaking change). O player foi
> atualizado para o novo contrato; os nomes abaixo já refletem isso.

- `GET /totems/:totemId/offers` — lista de ofertas já filtrada por
  dayparting no servidor. Campos: `id`, `title`, `imageUrl`, `price`,
  `category`, `periodStart`, `periodEnd`, `daypartingStart`,
  `daypartingEnd`, `createdAt`, `updatedAt`.
- `POST /totems/:totemId/heartbeat` — `{ playerVersion, lastOfferId, memoryUsageMb }`, a cada 30s.
- `POST /totems/:totemId/proof-of-play` — `{ offerId, durationMs }`, disparado
  toda vez que uma oferta sai de cena (troca automática do loop de 8s ou
  nova lista chegando via WebSocket).
- `POST /logs` — logs estruturados (`level`, `message`, `context`, `totemId`, `timestamp`).
- WebSocket (`socket.io`), conectado com `io(API_URL, { query: { totemId } })`:
  - evento recebido `offer:updated` — `{ totemId, offers }`, nova lista de ofertas.
  - evento recebido `command` — `{ type, payload }`, tipos `reload`,
    `restart`, `change_url`, `update_version`. `reload` e `change_url` são
    executados pelo próprio player; `restart` e `update_version` são só
    logados e repassados — quem executa de fato é o agente de kiosk nativo
    do SO (ver seção "Fora do escopo" abaixo).

## Gaps fechados nesta rodada

O player já existia com o fluxo básico (buscar ofertas, cachear, exibir em
loop, heartbeat, comandos remotos). Esta rodada fechou os gaps abaixo:

1. **Fallback visual de erro.** Antes, sem ofertas na API nem no cache
   (IndexedDB vazio, primeira execução sem internet), o player renderizava
   uma lista vazia — tela preta. Agora `render.js` expõe
   `mostrarFallback()`/`ocultarFallback()`, chamadas automaticamente quando
   `definirOfertas([])` é chamado com lista vazia. O `#fallback` em
   `index.html` é um placeholder simples com a paleta do Atacadão (azul
   `#003DA5` de fundo, círculo vermelho `#E30613` no lugar de um logo real —
   não há assets de marca disponíveis ainda, então isso é só um placeholder
   de identidade visual, fácil de trocar por um logo/imagem real depois) e
   uma mensagem explicando que o totem vai continuar tentando se reconectar.

2. **Wake Lock (`wakelock.js`).** Usa `navigator.wakeLock.request('screen')`
   para impedir a tela de suspender. Se a API não existir no navegador
   embarcado, falha em silêncio (só loga um `info`) — nesse caso a
   supervisão de tela fica por conta da configuração do SO/agente de kiosk.
   Como o wake lock é liberado automaticamente pelo navegador quando a aba
   perde visibilidade, o módulo escuta `visibilitychange` e pede o lock de
   novo assim que `document.visibilityState` volta a `'visible'`.

3. **Proof of play (`proof-of-play.js`).** `render.js` agora guarda qual
   oferta está no ar e desde quando (`exibicaoIniciadaEm`). Toda vez que
   `mostrarOferta()` é chamada de novo — seja pelo loop automático de 8s,
   seja por uma nova lista chegando via `offer:updated` — a duração real
   da oferta anterior é calculada e reportada via
   `TotemPlayer.proofOfPlay.reportar(oferta, duracaoMs)`, que faz o `POST
   /totems/:totemId/proof-of-play` com `keepalive: true` (pra não perder o
   request se coincidir com um reload). Falha de rede aqui não é tratada
   como erro — só um log informativo, mesmo padrão do heartbeat.

4. **Watchdog de travamento (`watchdog.js`).** `render.js` marca um
   timestamp (`ultimoTickMs`) toda vez que o loop de rotação "bate" — mesmo
   quando a oferta visível não muda (ex: lista com uma oferta só), para
   distinguir "só tem uma oferta pra mostrar" de "o JS travou". O watchdog
   verifica a cada 5s se faz mais de `3 × TEMPO_POR_OFERTA_MS` (24s) que o
   loop não bate e, se sim, força `location.reload()`. Isso cobre o caso de
   o processo do navegador continuar vivo mas o JS da página ter travado
   (loop infinito, exceção não tratada em algum callback) — complementa,
   não substitui, o watchdog do agente de kiosk nativo (que cobre o
   navegador/processo/SO travando por completo, ver `deploy/README.md`).

5. **Dayparting client-side (`cache.js`).** O filtro de horário
   (`daypartingStart`/`daypartingEnd`, formato `HH:MM` ou `HH:MM:SS`) já é
   responsabilidade do backend na resposta de `GET /offers`, mas como o
   totem pode ficar horas offline exibindo a lista salva em cache local, a
   lista cacheada pode conter ofertas cujo dayparting já não vale mais para
   o horário atual do dispositivo. `cache.filtrarPorDayparting(lista, agora)`
   refaz esse filtro no cliente, comparando a hora atual com a janela de
   cada oferta (inclusive janelas que cruzam a meia-noite, ex:
   `22:00:00`–`06:00:00`). Ofertas sem os dois campos são sempre
   consideradas válidas. `app.js` só aplica esse filtro no caminho em que a
   lista vem do cache (fallback de API indisponível) — a lista fresca da API
   já vem filtrada pelo servidor.

6. **`player-teste.html` atualizado.** Agora demonstra os três estados
   visuais do player (carregando → oferta normal em rotação → fallback de
   erro) em autoplay, e também expõe `window.TotemTeste` com
   `mostrarCarregando()` / `mostrarOfertaDemo()` / `mostrarErro()` para
   troca manual pelos botões no canto superior esquerdo da página — útil
   para validar em hardware físico antes do backend estar disponível. É uma
   página standalone, não usa os módulos de `TotemPlayer`.

## Testes

Não há framework de teste configurado (de propósito, para manter o projeto
sem dependências de build). A lógica DOM-heavy (render, wakelock, watchdog)
foi validada lendo o código com cuidado e via `node --check` em todos os
`.js`. A única peça de lógica pura e fácil de isolar — o filtro de
dayparting — tem testes leves com o test runner nativo do Node:

```bash
node --test test/dayparting.test.js
```

## O que fica fora do escopo do player web

- **Screenshot remoto da tela.** A página web não tem acesso à tela cheia
  do dispositivo (só ao próprio viewport/DOM) — quem expõe isso é o agente
  de kiosk nativo (ex: painel remoto do Fully Kiosk Browser no Android, ou
  uma ferramenta equivalente no Windows/Linux). Não há código relacionado a
  isso neste repositório, de propósito.
- **Reinício do dispositivo / atualização de versão do player** (comandos
  `restart` e `update_version` recebidos via WebSocket) — o player só
  loga e confirma o recebimento; quem executa de fato é a camada nativa
  (systemd no Linux, Agendador de Tarefas no Windows, Fully Kiosk no
  Android). Ver `deploy/README.md`.
- **Watchdog de processo/SO** (reabrir o navegador se ele cair, ou reiniciar
  o dispositivo se travar por completo) — coberto por `Restart=always` do
  systemd (Linux), Agendador de Tarefas (Windows) ou "Auto reload on
  connection error" do Fully Kiosk (Android). O `watchdog.js` deste
  repositório só cobre o caso mais restrito de JS travado com o navegador
  ainda de pé.
- **Deploy/instalação em cada SO** — ver `deploy/README.md` e
  `deploy/linux-kiosk.service`.
