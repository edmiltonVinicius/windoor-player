# Deploy do Windoor Player

O player (`index.html` + módulos + `service-worker.js`) é o mesmo em qualquer sistema
operacional: HTML/JS estático, sem build. O que muda é só como cada SO abre e
supervisiona o navegador em modo kiosk.

## Como o player se identifica

1. Cadastre o player no painel Windoor (Cliente → Unidade → Players).
2. Abra o player no dispositivo (URL abaixo). Ele mostra a **tela de pareamento**.
3. No painel, em **Unidades → Ver código**, gere o código de 6 dígitos
   (válido por 10 min, uso único).
4. Digite o código no dispositivo (teclado físico, controle remoto ou teclado da tela).
   O player guarda o `deviceToken` e passa a se autenticar sozinho.

Não existe mais `?totem=`: a identidade vem do pareamento.

## Endereço da API

Ordem de resolução: `?api=` na URL (persistido no dispositivo) → `localStorage`
→ `<meta name="windoor-api-url">` do `index.html` publicado. Sem nenhum deles, o
player mostra a tela **"Player não configurado"** e não faz nada (nunca redireciona).

```
https://player.windoor.com/?api=https://api.windoor.com/v1
```

O `?api=` só precisa estar na **primeira** abertura. `API_URL` inclui o prefixo de
versão (`/v1`); o socket.io conecta na origem (`https://api.windoor.com`).

Como o player roda em um domínio diferente da API, o backend precisa liberar essa
origem em `PLAYER_ORIGINS` (CORS e socket).

## Linux (mini-PC, NUC, Raspberry Pi)

1. Copie `linux-kiosk.service` para `/etc/systemd/system/windoor-kiosk.service`
2. Ajuste as URLs do `ExecStart` (player e API).
3. Ative o serviço:
   ```bash
   sudo systemctl enable windoor-kiosk.service
   sudo systemctl start windoor-kiosk.service
   ```
4. `Restart=always` garante que, se o navegador cair, o systemd reabre sozinho.

## Windows (mini-PC reaproveitado)

1. Crie um atalho apontando para:
   ```
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --noerrdialogs --disable-infobars "https://player.windoor.com/?api=https://api.windoor.com/v1"
   ```
2. Coloque o atalho em `shell:startup` para abrir sozinho ao ligar.
3. Desative atualizações automáticas e notificações do sistema, para não
   aparecerem por cima do player.
4. Para watchdog de processo, use o Agendador de Tarefas com gatilho "a cada 1
   minuto" rodando um script que reabre o Chrome se ele não estiver de pé.

## Android (TV Box / Android TV)

Este é o alvo de produção, e o único em que a **captura de tela real** funciona.

1. Instale o **Fully Kiosk Browser** e ative a licença **PLUS** (paga, por dispositivo).
   Sem PLUS não existe `getScreenshotPngBase64()`: o histórico passa a mostrar só
   capturas *Recompostas*.
2. *Start URL* = `https://player.windoor.com/?api=https://api.windoor.com/v1`.
3. *Advanced Web Settings → Enable JavaScript Interface* = **ON**.
   É o que injeta `window.fully` na página; sem isso não há print nem `restartApp`.
4. *Advanced Web Settings → URL Whitelist* = **só o domínio do player**.
   A interface JS dá acesso ao dispositivo — ela não pode valer para outras páginas.
5. *Remote Administration*: ligado, com a senha que o painel mostra na tela do player
   (card "Fully Kiosk Browser"). Detalhes em [`../fully.md`](../fully.md).
6. Ative "Start on boot", "Kiosk mode" e "Auto reload on connection error", e desligue
   suspensão/economia de energia da tela.

### Checklist de bancada (fazer em cada modelo novo de TV box)

O print do Fully é feito pelo sistema, e alguns aparelhos desenham vídeo em **overlay de
hardware** — a imagem sai preta justamente no quadro do vídeo. O player detecta isso
(amostra os pixels e, com vídeo no ar, trata >98% quase preto como falha) e cai para a
recomposição, mas é melhor saber antes de instalar no cliente.

| Teste | O que verificar no painel (Histórico → Ver captura) |
| --- | --- |
| Playlist só com imagem | captura chega com badge **Tela real** |
| Playlist com vídeo | **Tela real** também. Se vier **Recomposta** com motivo `black_frame`, este modelo tem overlay de hardware |
| Barra de informações ligada | a barra aparece na captura (horário/data e o item do centro) |
| 2 h desconectado da rede | ao religar, as capturas acumuladas sobem e aparecem com **Recebida X depois** |

Para exercitar o caminho "tela real" num navegador comum, sem TV box, abra o player com
`?fakeFully=1` (só desenvolvimento): um PNG sintético entra no lugar do print do Fully.
Sem esse parâmetro, o navegador cai na recomposição — que é justamente o fallback que
precisa ser testado.

## Operação e manutenção

| Situação | O que fazer |
| --- | --- |
| Reparear o dispositivo (trocou de player no painel, token revogado) | abrir com `?unpair=1` — apaga o token e volta à tela de pareamento |
| Trocar a API | abrir com `?api=https://outra-api/v1` (fica salvo) |
| Limpar cache (imagens/conteúdos/identidade) | `chrome://settings/siteData` → remover os dados do domínio do player |
| Player aparece "Player desativado" | reative-o no painel; o player tenta sozinho a cada 60 s |
| Player voltou à tela de pareamento sozinho | o token foi revogado (player excluído/desativado ou cliente desativado): gere um novo código |

## Comandos remotos: o que fazem e o que não fazem

| Comando | Efeito real |
| --- | --- |
| `reload` | recarrega a página do player (funciona sempre) |
| `change_url` | navega para outra URL `http(s)` (outros esquemas são recusados) |
| `restart` | o navegador **não** reinicia o dispositivo. O player só confirma o recebimento e repassa a `window.WindoorKiosk.restart()` se o agente de kiosk nativo expuser essa função |
| `update_version` | idem: quem baixa/instala nova versão é o agente nativo ou o cache do service worker na próxima publicação |
| `screenshot` | captura a tela na hora e envia como evidência. Diferente dos outros, a confirmação só sai **depois** do upload, levando o `screenshotId` — é com ele que o painel exibe a imagem. Player offline nem recebe o comando (o painel recusa com "player offline") |

## Watchdog: JS vs. nativo

O `watchdog.js` cobre o caso de o navegador continuar vivo mas o JS da página
travar: se o loop de exibição não "bater" por mais de 3× a duração de um conteúdo,
ele recarrega a página. Ele **só é armado depois que o loop de conteúdo começou** —
nas telas de pareamento, configuração e "player desativado" não há recarga automática.

Ele **não** cobre o navegador inteiro travar, o processo morrer ou o SO congelar;
para isso é preciso o watchdog nativo (systemd `Restart=always`, Agendador de
Tarefas no Windows, "Auto reload" do Fully Kiosk).
