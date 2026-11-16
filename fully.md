# Fully Kiosk Browser — Integração Windoor

## Como funciona

O CMS envia o comando `restart` ao player via WebSocket. O player executa `window.WindoorKiosk.restart()` (definido em `kiosk.js`), que chama `window.fully.restartApp()` — interface JavaScript nativa do Fully, sem HTTP, sem CORS.

## Setup no dispositivo

1. Abra o Fully Kiosk Browser
2. **Settings → Advanced Web Settings**
   - Enable JavaScript Interface → **ON**
   - É isto que injeta `window.fully` na página. Sem isso não há `restartApp` **nem
     captura de tela real** — o histórico passa a mostrar só capturas *Recompostas*.
   - URL Whitelist → **só o domínio do player**. A interface JS dá acesso ao
     dispositivo; ela não pode valer para outras páginas.
3. **Settings → Remote Administration**
   - Enable Remote Administration → **ON**
   - Remote Admin Password → cole a senha exibida no CMS (tela do player, card "Fully Kiosk Browser")

A licença **PLUS** é obrigatória: `getScreenshotPngBase64()` (usado pelas evidências de
exibição) só existe nela. Setup completo de produção, incluindo o checklist de bancada
por modelo de TV box, em [`deploy/README.md`](deploy/README.md).

## Testar a conexão

De qualquer dispositivo na mesma rede:
```
http://IP-DO-DEVICE:2323
```
Login com a senha do player → confirma que o Remote Admin está ativo.

## Testar o comando de restart

```
http://IP-DO-DEVICE:2323/?cmd=restartApp&password=SENHA&type=json
```
Resposta esperada: `{"status":"OK"}`

## Comandos disponíveis (sem Device Owner)

| Comando | Efeito |
|---|---|
| `restartApp` | Reinicia o app Fully Kiosk (usado pelo Windoor) |
| `reloadPage` | Recarrega a página atual |
| `loadURL&url=...` | Navega para uma URL |

## Interface JavaScript: o que o player usa

Estas são chamadas de dentro da página, não pelo Remote Admin — é o caminho que o
Windoor usa em produção, porque não exige o servidor na mesma rede da TV box.

| Chamada | Para quê | Módulo |
|---|---|---|
| `window.fully.restartApp()` | comando "Reiniciar dispositivo" do CMS | `kiosk.js` |
| `window.fully.getScreenshotPngBase64()` | captura de tela real das evidências | `capture.js` |

Sem `window.fully` (navegador comum, ou JavaScript Interface desligada) o player
**recompõe** a tela num canvas e marca a captura como *Recomposta*. Para exercitar o
caminho "tela real" num navegador comum, abra o player com `?fakeFully=1`.

## Por que não `rebootDevice`?

Exige Device Owner configurado via ADB — impraticável em totens instalados em campo. O `restartApp` reinicia o Fully (e o player junto) sem essa permissão.

## Senha do player

- Gerada automaticamente na criação do player (8 chars hex)
- Visível no CMS em **Players → [nome do player] → card "Fully Kiosk Browser"**
- Nunca exposta em URL ou logs

## IP padrão desta instalação

TV Box do elevador: `192.168.0.45`
