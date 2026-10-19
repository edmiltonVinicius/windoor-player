# windoor-player

Player de sinalização digital da Windoor: HTML + JavaScript puro, **sem framework
e sem etapa de build**, para rodar 24/7 em hardware modesto (Android TV Box,
Raspberry Pi, mini-PC) com Chromium em modo `--kiosk`.

Versão `2.0.0` (quebra de contrato em relação ao MVP single-tenant: identidade por
pareamento, rotas `/player/*`, envelope de resposta, nomes em inglês, marca Windoor).

## Como rodar

Requisitos: Node.js 18+ (testado no 22) e um navegador baseado em Chromium.
Não há dependências para instalar (`package.json` não tem `dependencies`) nem
etapa de build — `npm install` é dispensável.

### 1. Suba o mock da API (terminal 1)

```bash
cd totem-player
npm run mock      # node test/mock-server.js → http://localhost:4000/v1
```

O mock implementa as rotas `/v1/player/*` com o envelope da spec (sem socket.io).
Ele imprime no console cada `pair`, `heartbeat`, `proof-of-play` e `logs` recebido.
Para usar outra porta: `PORT=5000 npm run mock`.

Para apontar para o backend real em vez do mock, pule este passo e troque a URL
do `?api=` no passo 3 (ex.: `?api=http://localhost:3000/v1`); a origem do player
precisa estar liberada em `PLAYER_ORIGINS` no backend.

### 2. Sirva os arquivos estáticos (terminal 2)

`file://` **não** funciona: service worker, IndexedDB e Cache Storage exigem
`http://`. Qualquer servidor estático serve:

```bash
cd totem-player
npx serve . -l 3000          # ou
python3 -m http.server 3000
```

### 3. Abra e pareie

```
http://localhost:3000/?api=http://localhost:4000/v1
```

Na tela de pareamento, digite **123456** (teclado físico, numérico na tela ou
controle remoto). O mock aceita:

| Código | Resultado |
| --- | --- |
| `123456` | pareia e devolve `deviceToken` |
| `000000` | `410 PAIRING_CODE_EXPIRED` → "Código expirado" |
| qualquer outro | `404 PAIRING_CODE_INVALID` → "Código inválido" |

O `?api=` só é necessário na **primeira** abertura: ele fica persistido em
`localStorage` (`windoor.apiUrl`), junto do token (`windoor.deviceToken`).

### 4. Parâmetros úteis durante o desenvolvimento

| URL | Efeito |
| --- | --- |
| `?api=<url>` | define e persiste a URL da API (inclui o `/v1`) |
| `?unpair=1` | apaga token e identidade, volta ao pareamento |
| `?layout=split` | o mock devolve o feed de duas zonas (`split_top_bottom`) |
| `player-teste.html` | os 5 estados visuais sem API, para validar em hardware |

Depois de mudar um arquivo `.js`, recarregue com **Ctrl+Shift+R**: o
`service-worker.js` faz cache do shell e serve a versão antiga num reload comum.

### 5. Testes

```bash
npm test          # node --test test/*.test.js
```

O glob `test/*.test.js` é obrigatório; `node --test test/` falha no Node 22
porque tenta executar `mock-server.js` como suíte.

### Modo kiosk (como roda em produção)

```bash
chromium --kiosk --noerrdialogs --disable-infobars \
  --autoplay-policy=no-user-gesture-required \
  "http://localhost:3000/?api=http://localhost:4000/v1"
```

Supervisão, boot e reinício ficam fora do player web — veja `deploy/README.md`.

## Identidade do dispositivo

O dispositivo nasce sem identidade. Na primeira abertura mostra a tela de
pareamento; a pessoa digita o código de 6 dígitos gerado no painel
(CMS → Unidade → "Ver código", válido 10 min, uso único) e o backend devolve um
`deviceToken`, guardado em `localStorage` (`windoor.deviceToken`) e enviado como
`Authorization: Bearer` em todas as chamadas. `401` → apaga o token e volta ao
pareamento; `403 PLAYER_INACTIVE` → tela "Player desativado", com nova tentativa a
cada 60 s. `?unpair=1` na URL apaga a identidade (uso por técnico).

## Arquitetura de módulos

Cada arquivo registra um objeto em `window.WindoorPlayer`; `app.js` é o
orquestrador e entra por último.

| Arquivo | Responsabilidade |
| --- | --- |
| `config.js` | resolve `API_URL`/`SOCKET_URL` (`?api=` → `localStorage` → `<meta>`), constantes e acesso ao token/identidade. Nunca redireciona |
| `api.js` | único ponto de rede: `Authorization`, `EXTRA_HEADERS`, desembrulha o envelope, lança `ApiError`, dispara `windoor:unauthorized` / `windoor:inactive` |
| `schedule.js` | período e dayparting (funções puras, UMD, testadas em Node) |
| `pairing.js` | tela e fluxo de pareamento (visor, teclado físico e na tela, erros, trava de 60 s) |
| `cache.js` | IndexedDB `windoor-player`/`contents` + Cache Storage `windoor-images-v1` (cache-first, pré-carregamento, poda) |
| `render.js` | loop de exibição, cross-fade entre duas camadas `<img>`, `showView`, fallback, proof of play ao sair de cena |
| `logger.js` | console sempre; remoto só com token, limitado a 20 logs/min, `context` truncado em 8 KB |
| `heartbeat.js` | `POST /player/heartbeat` a cada 30 s |
| `proof-of-play.js` | `POST /player/proof-of-play` com a duração real de exibição |
| `commands.js` | `command` do socket + `command:ack`; `change_url` só aceita `http(s)` |
| `wakelock.js` | Wake Lock API (falha em silêncio onde não existe) |
| `watchdog.js` | recarrega a página se o loop travar; só é armado depois que o loop começou |
| `service-worker.js` | shell offline (`windoor-shell-v1`), network-first só para GET da mesma origem |
| `player-teste.html` | página standalone com os 5 estados visuais, para validar em hardware |

`vendor/socket.io.min.js` (4.7.5) é servido localmente: o kiosk precisa subir sem
acesso a CDN.

## Contrato de API consumido

`API_URL` inclui o prefixo de versão (ex.: `https://api.windoor.com/v1`); o socket
conecta na **origem**. Todas as respostas (exceto `204`) vêm no envelope
`{ success, data, errors, meta }`, e `api.js` devolve só `data`.

| Método e rota | Auth | Corpo | `data` |
| --- | --- | --- | --- |
| `POST /player/pair` | — | `{ code }` | `{ playerId, deviceToken, playerName, unitName, clientName }` |
| `GET /player/contents` | Bearer | — | `Content[]` (já filtrada no servidor) |
| `POST /player/heartbeat` | Bearer | `{ playerVersion, lastContentId, memoryUsageMb }` | 204 |
| `POST /player/proof-of-play` | Bearer | `{ contentId, durationMs }` | 204 |
| `POST /player/logs` | Bearer | `{ level, message, context, timestamp }` | 204 |

`Content`: `{ id, title, imageUrl, price, category, periodStart, periodEnd,
daypartingStart, daypartingEnd, createdAt, updatedAt }`. Cada upload gera um UUID
novo, então uma `imageUrl` nunca muda de conteúdo — por isso o cache por URL é seguro.

Socket.io: `io(SOCKET_URL, { auth: { token } })`; recebe `content:updated`
`{ playerId, contents }` e `command` `{ id, type, payload }`; emite `command:ack`
`{ id, status }`. Sem socket o player continua funcionando só com HTTP (re-busca de
segurança a cada 5 min e a cada reconexão).

## Comportamento offline

1. Conteúdos salvos em IndexedDB e imagens no Cache Storage (cache-first).
2. Sem API, exibe o cache refiltrado no cliente por período **e** dayparting
   (`schedule.filterActive`) — o player pode ficar dias offline.
3. Sem conteúdo nenhum, mostra a tela de fallback da marca.
4. O status no canto inferior direito mostra `conectando...`, `online` ou
   `offline (usando cache local)`.

Premissa: o relógio e o fuso do dispositivo estão corretos (o servidor filtra por
`APP_TIMEZONE`, padrão `America/Sao_Paulo`).

## Layout e zonas

O player desenha o layout definido no painel: `fullscreen` (uma zona) ou `split_top_bottom`
(duas empilhadas). Cada zona percorre a playlist atribuída a ela, com a duração de cada item,
independentemente da outra. A barra inferior (relógio, mensagens em rodízio, logo) é configurada
por unidade e vale para todos os players dela.

## Testes

```bash
npm test          # equivale a node --test test/*.test.js
```

- `test/schedule.test.js` — período, dayparting (inclusive cruzando a meia-noite),
  bordas inclusivas, `HH:MM` e `HH:MM:SS`, `filterActive` com relógio injetado.
- `test/pairing.test.js` — `normalizeCode`, `formatCode`, mapa de mensagens de erro.
- `test/api.test.js` — envelope, `204`, `ApiError`, `401`/`403`, cabeçalho de token.
- `test/mock-server.js` — servidor de desenvolvimento (REST, sem socket).
- `docs/manual-test.md` — checklist manual (pareamento, erros, offline, comandos,
  watchdog).

## O que fica fora do escopo do player web

Reiniciar o dispositivo, atualizar o sistema, supervisionar o processo do navegador
e garantir que ele abra no boot são responsabilidade do agente de kiosk nativo
(systemd, Agendador de Tarefas, Fully Kiosk). Os comandos `restart` e
`update_version` são apenas repassados a `window.WindoorKiosk`, quando existir.
Veja `deploy/README.md`.
