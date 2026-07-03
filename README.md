# ascii-binary-tool

Editor local para aplicar um efeito ASCII/binary rain em trechos de video,
focado em silhueta de pessoa + skate. O app roda localmente com FastAPI,
OpenCV/ffmpeg e Vite/React.

## Inspiracao

Os presets de ASCII, mapas de caracteres, modo grayscale/cor do video,
atalhos de playback e ideia de frame skip foram inspirados pelo projeto
[`maxcurzi/tplay`](https://github.com/maxcurzi/tplay), um terminal media
player que renderiza imagens e videos como caracteres no terminal.

Este projeto nao depende do `tplay`: a integracao aqui e conceitual/visual,
adaptada para um editor web com mascara, pincel e export de video.

## Stack

- `backend/`: FastAPI, OpenCV, rembg, ffmpeg via subprocess.
- `frontend/`: Vite, React, TypeScript, canvas puro.

## Rodar localmente no Windows

Backend:

```powershell
cd backend
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
python -m uvicorn main:app --reload --port 8000
```

Frontend:

```powershell
cd frontend
npm install
npm run dev
```

Abra o Vite em `http://127.0.0.1:5173/` ou na porta que ele informar.

## Fluxo

1. Escolha um exemplo no lobby ou suba um video.
2. Selecione um ou mais intervalos.
3. O backend extrai frames e gera mascaras.
4. Ajuste mascaras com pincel/borracha.
5. Teste o preview do efeito.
6. Gere o preview completo/export final.

## Features atuais

- Multiplos intervalos no mesmo video.
- Mascara automatica hibrida: pessoa por IA + movimento proximo para pegar skate.
- Edicao manual da mascara por frame.
- Presets ASCII: binary, blocks, braille, source color, grayscale.
- Fundo solido, fundo do video original ou imagem enviada.
- Preview leve com frame skip.
- Export final em MP4.
- Export ASCII de frame como `.txt`.
