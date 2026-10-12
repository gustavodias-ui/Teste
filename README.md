# Monitor de preço de ingresso → WhatsApp

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

## 3. Ou rodar 24h no GitHub Actions (sem deixar o PC ligado)

O workflow `.github/workflows/monitor.yml` verifica a cada ~10 minutos.

Em **Settings → Secrets and variables → Actions** do repositório:

- **Secrets:** `WHATSAPP_PHONE` (ex.: `+5511999998888`) e `CALLMEBOT_APIKEY`
- **Variables:** `TICKET_URL`, `MIN_PRICE`, `MAX_PRICE` e, se quiser, `SECTOR_KEYWORD` e `PRICE_SELECTOR`

Depois, em **Actions → Monitor de preço de ingresso → Run workflow**, rode uma vez para testar.

Limitações: o agendamento do GitHub pode atrasar de 5 a 15 minutos, e alguns
sites bloqueiam acessos vindos de servidores. Se o log mostrar
"Nenhum preço em R$ encontrado", rode no seu computador.

## Ajustes finos

| Variável | Para que serve |
|---|---|
| `MIN_PRICE` / `MAX_PRICE` | Faixa de preço em reais (ex.: `300` e `900`) |
| `SECTOR_KEYWORD` | Só avisa ofertas cujo texto contenha a palavra (ex.: `Pista`, `Meia`) |
| `PRICE_SELECTOR` | Seletor CSS do preço, se a detecção automática pegar valores errados, como taxas |
| `INTERVAL_SECONDS` | Intervalo entre verificações no modo loop |

**Achando o `PRICE_SELECTOR`:** no Chrome, clique com o botão direito no preço → *Inspecionar*,
veja a classe do elemento (ex.: `<span class="ticket-price">`) e use `PRICE_SELECTOR=.ticket-price`.

Se `--dry-run` não achar nenhum preço, rode `python monitor.py --dry-run --dump`
para ver o texto que o navegador capturou. Pode ser que a página peça login ou
mostre um captcha.

## Cuidados

- Não diminua muito o intervalo. Verificar a cada 1 ou 2 minutos já basta, e intervalos menores podem fazer o site te bloquear.
- Antes de pagar, confira se o site é um revendedor confiável e se o ingresso é válido. Em shows grandes é comum aparecer site falso de revenda.
