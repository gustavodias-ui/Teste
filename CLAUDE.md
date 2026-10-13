# Monitor de ingressos BTS → WhatsApp

Avisa no WhatsApp quando um ingresso do show do BTS (dia **31/10/2026**, MorumBIS)
aparece numa faixa de preço escolhida pelo usuário. O usuário fala português.

Página monitorada (revenda de fãs):
https://buyticketbrasil.com/event/bts-2026worldtourarirang/session/7dbb3a2b-985d-4bf2-9d36-df893169e098?returnTo=%2Fsearch

## Partes do projeto

- `extension/`: **caminho principal.** Extensão MV3 para Chrome e Zen/Firefox (≥128).
  - `background.js`: alarme a cada N min; recarrega uma aba fixada; abre a lista
    "Selecione o tipo de ingresso" (`openTicketList`); lê os preços (`extractFromPage`); filtra
    pelo dia do show; manda WhatsApp (CallMeBot) e notificação; grava `status` em `chrome.storage`.
  - `dashboard.*`: painel ao vivo (popup). `options.*`: configurações (faixa, dia, setor,
    telefone, apikey, intervalo).
- `monitor.py`: versão Python/Playwright, para rodar no terminal ou no GitHub Actions.
  **Ainda não abre a lista de ingressos nem ignora "R$ 0"**: se for usar, portar essa lógica
  da extensão.
- `.github/workflows/monitor.yml` + `docs/index.html`: monitor 24h no GitHub Actions + painel no
  GitHub Pages. Só roda se a variável `MAX_PRICE` estiver configurada. Não usar junto com a
  extensão (mensagens em dobro).

## O que se sabe da página real (por print do usuário)

- Os preços só aparecem com o dropdown "Selecione o tipo de ingresso" aberto.
- Itens vistos: Arquibancada R$ 3.100, Cadeira Inferior R$ 2.800, Cadeira Superior R$ 2.700,
  Camarote Clássico R$ 0 (indisponível → ignorar), Camarote Enter Exp… R$ 6.700, Camarote Ídolos R$ 4.400.
- Formato do preço: `R$ 3.100` (sem centavos).
- A descrição do evento cita "dias 28, 30 e 31 de outubro". Não confundir com a data da sessão:
  só linhas curtas (≤ 60 caracteres) contam como data.
- **Nunca foi lida automaticamente.** Ainda falta confirmar a estrutura do DOM (role="option"?
  portal?), se a data da sessão aparece na página e se há captcha ou bloqueio.

## Próximo passo sugerido

1. Abrir a página real com Playwright (não headless se houver bloqueio) e conferir se `openTicketList`
   e `extractFromPage` de `extension/background.js` pegam exatamente os preços do dropdown e a data
   da sessão. Ajustar se necessário.
2. Ajudar o usuário a instalar a extensão:
   - Chrome: `chrome://extensions` → Carregar sem compactação.
   - Zen: `about:debugging#/runtime/this-firefox` → Carregar extensão temporária → `manifest.json`.
     A extensão some ao fechar o navegador.
3. Configurar a faixa, o dia `31`, o número e a apikey do CallMeBot. Depois usar **Testar WhatsApp**
   e **Salvar e verificar agora**.

## Testes

Não há suíte de testes. A validação foi feita com páginas falsas, que imitam o dropdown, mais um
CallMeBot falso local, carregando a extensão no Chromium via Playwright
(`launch_persistent_context` com `--load-extension`). Para o Firefox: `npx web-ext lint --source-dir extension`.

Nunca inventar preços: só mostrar o que foi lido da página.
