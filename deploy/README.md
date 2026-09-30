# Deploy do player nos totens

O player (`index.html` + `app.js` + `service-worker.js`) é o mesmo em qualquer sistema
operacional. O que muda é só como cada SO abre e supervisiona o navegador em modo kiosk.

## Linux (mini-PC, NUC, Raspberry Pi)

1. Copie `linux-kiosk.service` para `/etc/systemd/system/totem-kiosk.service`
2. Ajuste a URL no `ExecStart` (troque `LOJA1234` pelo ID real do totem)
3. Ative o serviço:
   ```bash
   sudo systemctl enable totem-kiosk.service
   sudo systemctl start totem-kiosk.service
   ```
4. O `Restart=always` garante que, se o navegador cair, o systemd reabre sozinho.

## Windows (mini-PC reaproveitado)

1. Crie um atalho apontando para:
   ```
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --noerrdialogs --disable-infobars https://totem.seudominio.com/?totem=LOJA1234
   ```
2. Coloque esse atalho na pasta de inicialização do Windows
   (`shell:startup`), para abrir sozinho ao ligar.
3. Desative atualizações automáticas do Windows e notificações do sistema
   (Configurações > Notificações), para não "vazarem" por cima do totem.
4. Para o watchdog (reabrir se travar), use o Agendador de Tarefas do Windows
   com um gatilho "a cada 1 minuto" rodando um script que verifica se o
   processo do Chrome está de pé e o reabre se não estiver.

## Android (TV Box / Android TV)

1. Instale o **Fully Kiosk Browser** (disponível na Play Store ou APK direto).
2. Configure a "Start URL" para `https://totem.seudominio.com/?totem=LOJA1234`.
3. Ative:
   - "Start on boot" (abre sozinho ao ligar)
   - "Kiosk mode" (remove barra de navegador, bloqueia gestos)
   - "Auto reload on connection error" (watchdog embutido)
4. O Fully Kiosk também tem um painel remoto (opcional, pago) que permite ver o
   status de todos os totens e forçar reload à distância — vale avaliar se o
   volume de totens justificar.

## Parâmetro comum

Em todos os casos, a URL carrega o mesmo `index.html`, passando o ID do totem via
query string (`?totem=LOJA1234`), que é o que o `app.js` usa para saber quais ofertas
buscar e em qual "sala" do WebSocket entrar.
