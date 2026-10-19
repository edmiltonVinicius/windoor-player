# Checklist de teste manual — Windoor Player 2.0.0

Pré-requisitos: `npm run mock` (servidor de desenvolvimento em
`http://localhost:4000/v1`, código de pareamento `123456`) ou o backend real,
e o player servido por HTTP (`npx serve .` ou qualquer servidor estático —
`file://` não permite service worker).

| # | Cenário | Como reproduzir | Esperado |
| --- | --- | --- | --- |
| 1 | Sem API configurada | abrir sem `?api=` e com `localStorage` limpo | tela "Player não configurado"; nenhuma requisição de rede |
| 2 | Pareamento feliz | `?api=http://localhost:4000/v1`, digitar `123456` | "Pareado! …" em verde por 1,5 s e o conteúdo começa a rodar |
| 3 | Código inválido | digitar `111111` | "Código inválido. Confira os números."; o código digitado não é apagado |
| 4 | Código expirado | digitar `000000` | "Código expirado. Gere um novo no painel." |
| 5 | 429 | backend real, 6 tentativas em 1 min | "Muitas tentativas. Aguarde um minuto." + contagem "Aguarde 0:xx" e teclado travado 60 s |
| 6 | Teclado físico / controle remoto | digitar com 0–9, Backspace e Enter | mesmo comportamento do teclado da tela |
| 7 | Queda de rede durante exibição | parar o mock com conteúdo no ar | status vira "offline (usando cache local)"; a rotação continua |
| 8 | Reabrir offline com cache | parar o mock e recarregar | exibe o cache filtrado por período + dayparting |
| 9 | Sem conteúdo e sem cache | mock devolvendo `[]`, cache limpo | tela "Estamos atualizando o conteúdo" |
| 10 | `content:updated` ao vivo | publicar/aprovar conteúdo no backend real | a tela atualiza em menos de 2 s, sem reload |
| 11 | `401` | revogar/excluir o player no painel | o player apaga o token e volta à tela de pareamento |
| 12 | `PLAYER_INACTIVE` | desativar o player no painel | tela "Player desativado"; ao reativar, volta sozinho em até 60 s |
| 13 | Comando `reload` | enviar pelo painel | a página recarrega e o painel recebe `command:ack` `acknowledged` |
| 14 | Comando `change_url` | enviar com uma URL `https` | navega; com `javascript:` responde `failed` e não navega |
| 15 | Watchdog | no console, travar o loop (ex.: `clearInterval` de todos os timers) | a página recarrega sozinha em até ~29 s |
| 16 | Watchdog não interfere no pareamento | ficar 2 min na tela de pareamento | nenhuma recarga |
| 17 | Repareamento por técnico | abrir com `?unpair=1` | volta à tela de pareamento |
| 18 | Offline total (service worker) | carregar uma vez, desligar a rede, recarregar | o shell sobe do cache e mostra conteúdo em cache ou o fallback |
| 19 | Proof of play / heartbeat | olhar o console do mock | `POST /v1/player/proof-of-play` a cada troca e `heartbeat` a cada 30 s |
| 20 | Telas de sistema em hardware | abrir `player-teste.html` no dispositivo | os 5 estados legíveis à distância, sem corte nem scroll |
