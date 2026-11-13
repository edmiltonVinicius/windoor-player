# Fully Kiosk Browser — Integração Windoor

## Como funciona

O CMS envia o comando `restart` ao player via WebSocket. O player executa `window.WindoorKiosk.restart()` (definido em `kiosk.js`), que chama `window.fully.restartApp()` — interface JavaScript nativa do Fully, sem HTTP, sem CORS.

## Setup no dispositivo (único passo)

1. Abra o Fully Kiosk Browser
2. **Settings → Remote Administration**
   - Enable Remote Administration → **ON**
   - Remote Admin Password → cole a senha exibida no CMS (tela do player, card "Fully Kiosk Browser")

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

## Por que não `rebootDevice`?

Exige Device Owner configurado via ADB — impraticável em totens instalados em campo. O `restartApp` reinicia o Fully (e o player junto) sem essa permissão.

## Senha do player

- Gerada automaticamente na criação do player (8 chars hex)
- Visível no CMS em **Players → [nome do player] → card "Fully Kiosk Browser"**
- Nunca exposta em URL ou logs

## IP padrão desta instalação

TV Box do elevador: `192.168.0.45`
