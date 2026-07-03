# AGENTS.md

Contexto pra qualquer sessão do Codex (Code, Cowork, etc) trabalhando nesse projeto.

## O que é isso

Editor local que pega um trecho de vídeo (ex: skate) e aplica um efeito
"binary rain" estilo Matrix (0s e 1s verdes com scroll infinito) só na
silhueta de um sujeito (pessoa + skate), com fundo preto — mantendo o
resto do vídeo normal, com corte seco entre as partes.

Referência visual: `artkit.cc/asciikit`, mas sem pagar pela ferramenta.

## Stack

- `backend/`: FastAPI (Python) — upload, extração de frames, segmentação,
  renderização do efeito, export final. Usa OpenCV, rembg, ffmpeg (via
  subprocess, dependência de sistema — não é pacote pip).
- `frontend/`: Vite + React + TypeScript — upload/trim, editor com
  filmstrip, canvas de pintura de máscara, preview, export. Sem lib de
  desenho, canvas puro.

## Como rodar (Windows — é onde o Gabriel desenvolve, PowerShell + VS Code)

```powershell
# backend
cd backend
python -m venv venv          # NAO python3 - no Windows e so "python"
venv\Scripts\activate
pip install -r requirements.txt
python -m uvicorn main:app --reload --port 8000

# frontend (outro terminal)
cd frontend
npm install
npm run dev
```

Gotchas do Windows já resolvidos numa sessão anterior:
- `python3` não existe no Windows, é `python`
- ffmpeg precisa estar instalado via `winget install ffmpeg` (ou manual) e
  no PATH — é dependência de sistema, `pip install` não resolve
- depois de mexer no PATH (instalar ffmpeg, etc), precisa **fechar o VS
  Code inteiro** e abrir de novo, não só o terminal integrado
- o Vite pode subir em porta diferente de 5173 se ela estiver ocupada
  (ex: 5174) — o backend usa `allow_origin_regex` pra aceitar qualquer
  porta localhost, não mexer nisso pra fixo de novo

## Arquitetura

- `backend/main.py` — todos os endpoints da API
- `backend/segmentation.py` — geração de máscara: tenta `rembg`
  (u2net_human_seg, IA) e cai automaticamente pro fallback por diferença
  de movimento compensada por homografia (ORB + RANSAC) se o rembg falhar
  (sem internet pro download do modelo, etc)
- `backend/render.py` — classe `RainRenderer`: o efeito binário em si.
  A silhueta fica sempre densa (todo pixel da máscara mostra um
  caractere); o "scroll" muda QUAL caractere aparece em cada célula ao
  longo do tempo + uma onda de brilho, criando a sensação de fluxo sem
  nunca esvaziar a silhueta (isso foi um bug corrigido — a primeira
  versão usava "rastro" tipo chuva esparsa, ficou errado)
- `frontend/src/api.ts` — client HTTP pro backend
- `frontend/src/UploadTrim.tsx` — tela 1: upload + escolha do trecho (in/out)
- `frontend/src/Editor.tsx` — tela 2: filmstrip, pincel de máscara,
  preview do efeito, controles, export

## Decisões de projeto já fechadas com o Gabriel (não mudar sem confirmar)

- Máscara dinâmica seguindo o contorno exato do sujeito (não uma área
  fixa do frame)
- Efeito aplicado só num trecho curto do vídeo (~1s), não no vídeo inteiro
- Corte seco entre normal ↔ efeito (não crossfade)
- Scroll infinito estilo Matrix na densidade — não "rain" esparso
- Cor, tamanho de célula, velocidade de scroll configuráveis pelo usuário
- Edição manual da máscara com pincel (incluir/remover), por frame
- Rodando só local por enquanto — sem deploy/hospedagem ainda
- Zero custo, só ferramentas gratuitas

## Known issues / o que provavelmente precisa de atenção

O frontend foi escrito e validado só por build (`tsc` + `vite build`
passando limpo) — **nunca foi testado de fato num navegador** antes de
chegar nas mãos do Gabriel. Ou seja, é bem provável que existam bugs de
runtime na interação real (canvas, desenho do pincel, sincronização de
estado) que só aparecem usando de verdade. Comece testando o fluxo
completo ponta a ponta com um vídeo real antes de assumir qualquer coisa
sobre o que funciona.

Pontos específicos suspeitos:
- `Editor.tsx` → `saveMask()`: a lógica de extrair só os pixels pintados
  do canvas composto (frame + máscara desenhada) pra virar um PNG
  binário nunca foi validada rodando de verdade
- `drawMaskMode()` recarrega duas imagens (frame + máscara) toda vez que
  troca de frame — pode ter flicker ou race condition
- Preview ao vivo faz uma requisição HTTP por frame — não é otimizado
  pra scrubbing rápido na filmstrip, pode parecer lento/travado
- Render no backend é loop Python puro célula-por-célula — ~90s pra
  processar 1s de vídeo (30 frames) no sandbox de teste; pra trechos
  maiores vale vetorizar com numpy
- `main.py` upload_video: le metadados via ffprobe mas não corrige
  rotação de vídeos verticais (celular) explicitamente — funcionou no
  teste mas vale confirmar em outros vídeos

## Convenções do código

- Comentários e mensagens de status voltados ao usuário em português
- Cores no backend em BGR (convenção OpenCV); no frontend em hex,
  convertidas via `hexToBgrString()` antes de mandar pra API
- Numeração de frame: 1-based nos nomes de arquivo (`f_001.png`)

## Sobre o Gabriel (quem vai usar/revisar isso)

Dev frontend júnior buscando emprego, fullstack na prática. Prefere
respostas diretas, em português. Esse projeto é tanto um teste pessoal
quanto uma possível peça de portfólio futura (hoje só local, deploy é
conversa pra depois).

## Imported Claude Cowork project instructions

Sempre leia o CLAUDE.md na raiz do projeto antes de qualquer tarefa.
Respostas em português.
Antes de assumir que algo funciona ou foi corrigido, teste de verdade no
navegador — não valide só por leitura de código.
Ao corrigir bugs, um de cada vez: corrige, testa de novo, só então segue
pro próximo.
