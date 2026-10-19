# Decisões tomadas durante a implementação

Pontos que a spec (`WINDOOR-player.md`) não cobria explicitamente. Em todos eles
foi escolhido o caminho mais simples, sem mudar contrato de API.

1. **`node --test test/` não funciona no Node 22** (ele tenta resolver `test` como
   módulo). Os testes rodam com `node --test test/*.test.js`, exposto como
   `npm test` em um `package.json` mínimo (sem dependências, sem build).
   `test/mock-server.js` não casa com o padrão `*.test.js`, então não é executado
   como teste.
2. **`assets/logo.png`** é um placeholder gerado (quadrado 256×256 com o degradê
   da marca) até o cliente fornecer o logo definitivo — a spec já lista isso como
   pendência. O `player-teste.html` desenha o degradê em CSS para continuar
   standalone (sem depender de arquivo externo).
3. **`pairing.messageForError`** foi extraída como função pura (e testada) para o
   mapa de erros da seção 3.2, em vez de ficar embutida no handler.
4. **Logs remotos antes do pareamento** são apenas de console: sem `deviceToken`
   não há rota autenticada, então `logger` não tenta `POST /player/logs`.
   Mesma regra em `heartbeat` e `proof-of-play`.
5. **`loadInitial` com `403`** não escreve a tela de fallback por cima da tela
   `#inactive` (o evento `windoor:inactive` já assumiu a tela); apenas retorna.
6. **`connect_error` que não seja `unauthorized`** só muda o status para
   "offline (usando cache local)"; o socket.io reconecta sozinho.
7. **`refresh()` devolve `true`/`false`** para o retry de 60 s da tela
   `#inactive` saber quando voltar ao conteúdo.
8. **`render.hideFallback()`** mostra a view `content` (as views são mutuamente
   exclusivas via `showView`), em vez de mexer em `display` de dois elementos.
9. **`setContents` com lista idêntica** compara ids e ordem; listas vazias
   sempre caem no fallback.
10. **Token não é espelhado em IndexedDB** (pendência aberta na spec): fica só em
    `localStorage`, e a recuperação é reparear com um código novo.
11. **`?unpair=1` não limpa `windoor.apiUrl`**, só a identidade — o técnico não
    precisa redigitar a URL da API.
12. **Diretório do repositório** continua `totem-player/`; só o conteúdo foi
    renomeado para Windoor (renomear a pasta está fora do escopo pedido).


## Zonas, layout e barra de informações (2026-10-19)

O backend passou a servir `GET /player/contents` como um documento, não mais uma lista plana:
`{ playerId, layout, zones[{ position, playlist, items[] }], infoBar, skippedItems }`.
O player foi reescrito para esse modelo.

1. **`feed.js` substitui `schedule.js`.** Período e dayparting saíram do modelo de conteúdo;
   o que resta validar no cliente é a validade (`validUntil`), necessária porque o player pode
   passar dias offline com o cache. `normalizeFeed` devolve sempre a forma canônica: as zonas
   exatamente do layout, na ordem de exibição, com os itens exibíveis. Payload em array (versão
   anterior do player, ainda no IndexedDB de algum dispositivo) é tolerado e vira feed vazio.
2. **Uma sequência por zona.** Cada zona tem seu próprio `setTimeout` com a duração do item
   corrente, em vez do `setInterval` global de 8 s. Durações agora vêm por item.
3. **Vídeo não é pré-carregado.** Imagens continuam indo para o Cache Storage (cache-first);
   vídeo toca direto da rede — até 200 MB por arquivo encheria a cota do dispositivo.
4. **`contentId` x `id`.** O item da playlist tem os dois. Proof of play e heartbeat reportam
   `contentId`; usar `id` gravaria o id do item e quebraria o relatório.
5. **Cache guarda o feed inteiro** sob uma chave fixa (`feed`), não mais um registro por conteúdo.
6. **Barra de informações** vem da unidade: relógio à esquerda (fuso do dispositivo), mensagens
   do centro em rodízio pelo `rotationSeconds`, logo à direita. Desligada, a barra some e as zonas
   ocupam a tela toda.
7. **Zona vazia tem duas mensagens distintas**: "Sem playlist nesta zona" (nenhuma atribuída) e
   "Playlist sem conteúdo disponível" (atribuída, mas sem item exibível — conteúdo em rascunho,
   vencido ou sem arquivo). A diferença importa para o diagnóstico em campo.
