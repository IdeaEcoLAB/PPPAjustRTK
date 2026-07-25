# Ajuste PPP

App web para correção de levantamentos GNSS RTK a partir de uma base ajustada pelo serviço **IBGE-PPP**.

O usuário envia dois arquivos:

1. **PDF do relatório IBGE-PPP** da base — o app extrai automaticamente UTM E/N, altitude ortométrica e geométrica (também é possível digitar manualmente);
2. **TXT/CSV bruto do levantamento RTK** exportado do coletor (Nome, Código, E, N, Z, RMS, Solução, PDOP, altura da antena…).

O app detecta a linha da base, reduz o Z ao marco (Z − ARP − APC da antena), calcula os parâmetros ΔE/ΔN/ΔZ e aplica a todos os pontos, gerando:

- **CSV/TXT ajustado** com todos os pontos corrigidos (sigmas, solução fixed/float e PDOP preservados);
- **Arquivo de metadados** com todo o processo (arquivos de entrada, base, antena/APC e fonte do parâmetro, deltas, método e estatísticas).

Antenas pré-cadastradas: ComNav CNTT300, KQ M10T e CHC i73+ — com alerta pedindo confirmação do modelo, edição de parâmetros e cadastro de novas antenas (h0 + h1).

Todo o processamento roda **100% no navegador** — nenhum dado é enviado a servidores.

## Método

```
Z_marco = Z_base_bruto − ARP − APC
ΔE = E_PPP − E_base_campo
ΔN = N_PPP − N_base_campo
ΔZ = Z_PPP − Z_marco
Ponto ajustado: E' = E + ΔE | N' = N + ΔN | Z' = Z + ΔZ
```

Validado contra planilha de referência (base CNTT300, PPP-IBGE): reproduz os resultados ponto a ponto.

---

## Rodando localmente

Pré-requisito: [Node.js 18+](https://nodejs.org).

```bash
npm install
npm run dev
```

Abra http://localhost:5173. Um arquivo de teste está em `exemplos/exemplo_bruto_28-06-2025.txt`
(coordenadas PPP da base para teste: E 396932.599 · N 7412396.747 · Z 548.180 ortométrica,
ARP 1.748 m, antena CNTT300).

## Passo a passo: subir para o GitHub

1. Crie um repositório novo em https://github.com/new (ex.: `ajuste-ppp`), **sem** README/gitignore iniciais.
2. Na pasta do projeto, rode:

```bash
git init
git add .
git commit -m "Ajuste PPP: app de correção GNSS RTK por base IBGE-PPP"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/ajuste-ppp.git
git push -u origin main
```

## Passo a passo: deploy no Vercel

1. Acesse https://vercel.com e entre com a conta do GitHub.
2. Clique em **Add New → Project** e importe o repositório `ajuste-ppp`.
3. O Vercel detecta **Vite** automaticamente. Confirme:
   - Build Command: `npm run build`
   - Output Directory: `dist`
4. Clique em **Deploy**. Em ~1 minuto o app estará no ar em `https://ajuste-ppp-….vercel.app`.
5. Cada `git push` na branch `main` gera um novo deploy automaticamente.

## Estrutura

```
ajuste-ppp/
├── index.html          # entrada (Tailwind via CDN)
├── package.json
├── vite.config.js
├── exemplos/           # TXT bruto de exemplo para testes
└── src/
    ├── main.jsx        # bootstrap React
    ├── App.jsx         # interface e cálculo do ajuste
    └── ppp-pdf.js      # extração do relatório IBGE-PPP (pdf.js)
```

## Avisos importantes

- O offset **APC** deve corresponder à antena realmente usada na base. Valores pré-cadastrados
  vêm do manual do fabricante ou da calibração NGS (https://www.ngs.noaa.gov/ANTCAL/); confirme
  sempre no seu equipamento.
- Se o software de campo já reduzir o Z da base ao ARP, edite a antena e zere o APC para não
  aplicar a correção em dobro (teste com um ponto conhecido na primeira utilização).
- O layout do relatório IBGE-PPP pode variar entre versões; se a extração automática falhar,
  o app avisa e permite digitar as coordenadas manualmente.
