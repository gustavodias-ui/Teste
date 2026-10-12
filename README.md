# Monitor de preço de ingresso → WhatsApp + painel ao vivo

**📈 Painel ao vivo:** https://gustavodias-ui.github.io/Teste/

Abre a página do ingresso de tempos em tempos, lê todos os preços em R$ e,
quando algum entra na faixa que você definiu, manda uma mensagem no seu
WhatsApp com o preço, o setor e o link para comprar.

Exemplo de mensagem:

```
🎫 Ingresso na faixa de R$ 300,00 a R$ 900,00!

• R$ 645,50 — Pista | Meia-entrada | R$ 645,50

Comprar: https://buyticketbrasil.com/event/bts-2026worldtourarirang/session/...
```

Cada oferta é avisada uma vez só. Se ela sumir e voltar depois, você recebe o aviso de novo.

## 1. Configurar o WhatsApp (CallMeBot, grátis)

1. Salve o contato **+34 694 29 84 96** no celular (confira o número atual em <https://www.callmebot.com/blog/free-api-whatsapp-messages/>).
2. Mande para ele no WhatsApp a mensagem: `I allow callmebot to send me messages`
3. Você recebe de volta uma **apikey**. Ela vai em `CALLMEBOT_APIKEY`.

> Outra opção é a Twilio (`WHATSAPP_PROVIDER=twilio`), mais estável, mas exige uma conta e entrar no sandbox de WhatsApp dela.

## 2. Rodar no seu computador (recomendado: avisa mais rápido)

```bash
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python -m playwright install chromium

cp .env.example .env        # e preencha MIN_PRICE, MAX_PRICE, WHATSAPP_PHONE, CALLMEBOT_APIKEY

python monitor.py --test-whatsapp   # confere se a mensagem chega
python monitor.py --dry-run         # mostra os preços que ele achou na página (✅ = dentro da faixa)
python monitor.py                   # começa a monitorar (padrão: a cada ~2 min)
```

Deixe o terminal aberto e o computador sem hibernar enquanto quiser monitorar.

## 3. Rodar 24h no GitHub (sem deixar o PC ligado)

O workflow `.github/workflows/monitor.yml` já está ativo neste repositório.
Cada execução fica ~5h40 verificando a página a cada ~2 min, e a próxima
começa logo em seguida. Na prática, o monitor fica ligado direto.

Só falta configurar, em **Settings → Secrets and variables → Actions**:

1. Aba **Secrets** → *New repository secret*:
   - `WHATSAPP_PHONE`: seu número, ex.: `+5511999998888`
   - `CALLMEBOT_APIKEY`: a chave que o CallMeBot mandou
2. Aba **Variables** → *New repository variable*:
   - `MIN_PRICE`: ex.: `300`
   - `MAX_PRICE`: ex.: `900`
   - (opcional) `SECTOR_KEYWORD`: ex.: `Pista`
   - (opcional) `TICKET_URL`: só se quiser trocar o link (o padrão já é o do BTS)
3. **Settings → Pages**: em *Build and deployment*, escolha *Source: Deploy from a branch*,
   branch `ccr-3566d014-iwtg5b` e pasta `/docs`, e clique em **Save**. Isso publica o painel ao vivo.
4. Aba **Actions** → *Monitor de preço de ingresso* → **Run workflow**.
   Isso manda uma mensagem de teste no WhatsApp e já liga o monitor.

### Painel ao vivo

Abra **https://gustavodias-ui.github.io/Teste/** no celular ou no computador
(dá para salvar na tela inicial). O painel mostra:

- se o monitor está **🟢 ao vivo**, com falha para ler o site ou parado, e há quanto tempo foi a última verificação
- o menor preço agora e quantas ofertas estão na sua faixa
- um botão **Comprar agora** que abre a página do evento
- o gráfico do menor preço nas últimas 6h, 24h ou 7 dias
- a lista de todas as ofertas lidas, com as da sua faixa marcadas

O monitor verifica o site a cada ~1 min e o painel se atualiza sozinho.
Os dados ficam na branch `live-data`, que o monitor sobrescreve a cada verificação.

### O que você recebe no WhatsApp

- 🎫 **Ingresso na faixa**: preço, setor e link para comprar, assim que aparecer
- 📊 **Resumo diário** (às 10h): confirma que o monitor está ativo e mostra os menores preços do momento
- ⚠️ **Aviso de problema**: se o monitor não conseguir ler a página por ~10 min seguidos (site fora do ar, bloqueio etc.), e ✅ quando voltar ao normal

Para ver o que ele está lendo, abra a aba **Actions** e clique na execução em andamento.
Para pausar, vá em **Actions → Monitor de preço de ingresso → ⋯ → Disable workflow**.

Observações:
- O repositório é público, então os logs também são. Eles mostram só os preços encontrados.
  Número e chave ficam em *Secrets* e não aparecem.
- O GitHub desliga agendamentos de repositórios sem nenhum commit por 60 dias. Se isso
  acontecer, você recebe um e-mail; é só reativar em Actions.
- Alguns sites bloqueiam acessos vindos de servidores. Se isso acontecer, você recebe o
  aviso ⚠️ e pode rodar no seu computador (seção 2).

## Ajustes finos

| Variável | Para que serve |
|---|---|
| `MIN_PRICE` / `MAX_PRICE` | Faixa de preço em reais (ex.: `300` e `900`) |
| `SECTOR_KEYWORD` | Só avisa ofertas cujo texto contenha a palavra (ex.: `Pista`, `Meia`) |
| `PRICE_SELECTOR` | Seletor CSS do preço, se a detecção automática pegar valores errados, como taxas |
| `INTERVAL_SECONDS` | Intervalo entre verificações (padrão `60` no GitHub, `120` no computador) |
| `SUMMARY_HOUR` | Hora do resumo diário, horário de Brasília (padrão `10`; `off` desliga) |
| `FAIL_ALERT_AFTER` | Quantas falhas seguidas antes do aviso ⚠️ (padrão `5`) |

**Achando o `PRICE_SELECTOR`:** no Chrome, clique com o botão direito no preço → *Inspecionar*,
veja a classe do elemento (ex.: `<span class="ticket-price">`) e use `PRICE_SELECTOR=.ticket-price`.

Se `--dry-run` não achar nenhum preço, rode `python monitor.py --dry-run --dump`
para ver o texto que o navegador capturou. Pode ser que a página peça login ou
mostre um captcha.

## Cuidados

- Não diminua muito o intervalo. Verificar a cada 1 ou 2 minutos já basta, e intervalos menores podem fazer o site te bloquear.
- Antes de pagar, confira se o site é um revendedor confiável e se o ingresso é válido. Em shows grandes é comum aparecer site falso de revenda.
