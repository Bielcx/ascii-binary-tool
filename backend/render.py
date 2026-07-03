"""
render.py

Renderiza o efeito "binary rain" dentro da mascara: colunas de 0/1 que
descem continuamente (scroll infinito), com um rastro esmaecendo atras
da "cabeca" de cada coluna - o efeito classico do Matrix.
"""

import cv2
import numpy as np
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


class RainRenderer:
    def __init__(self, width, height, cell_size=14, seed=42, char_map="01"):
        self.cell_size = cell_size
        self.cols = width // cell_size
        self.rows = height // cell_size
        self.width = width
        self.height = height
        self.char_map = list(char_map or "01")

        rng = np.random.default_rng(seed)
        # buffer de caracteres bem mais alto que a tela, pra poder "rolar"
        # sem repetir padrao perceptivelmente
        self.buffer_rows = self.rows * 6
        self.chars = rng.integers(0, len(self.char_map), size=(self.buffer_rows, self.cols))
        # fase aleatoria por coluna, pra as colunas nao descerem todas
        # sincronizadas (mais organico)
        self.col_phase = rng.integers(0, self.buffer_rows, size=self.cols)

        self._glyph_cache = {}
        self._font_cache = {}

    def _font(self):
        if self.cell_size in self._font_cache:
            return self._font_cache[self.cell_size]
        size = max(8, int(self.cell_size * 0.9))
        candidates = [
            Path("C:/Windows/Fonts/seguisym.ttf"),
            Path("C:/Windows/Fonts/consola.ttf"),
            Path("C:/Windows/Fonts/arial.ttf"),
        ]
        for path in candidates:
            if path.exists():
                self._font_cache[self.cell_size] = ImageFont.truetype(str(path), size=size)
                return self._font_cache[self.cell_size]
        self._font_cache[self.cell_size] = ImageFont.load_default()
        return self._font_cache[self.cell_size]

    def _glyph(self, ch, brightness):
        # brightness de 0.0 a 1.0, cacheia por nivel arredondado
        key = (ch, round(brightness, 2))
        if key in self._glyph_cache:
            return self._glyph_cache[key]
        img = Image.new("L", (self.cell_size, self.cell_size), 0)
        draw = ImageDraw.Draw(img)
        text = str(ch)
        font = self._font()
        bbox = draw.textbbox((0, 0), text, font=font)
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]
        x = (self.cell_size - tw) // 2 - bbox[0]
        y = (self.cell_size - th) // 2 - bbox[1]
        draw.text((x, y), text, font=font, fill=int(255 * brightness))
        canvas = np.array(img, dtype=np.uint8)
        self._glyph_cache[key] = canvas
        return canvas

    def render(self, mask: np.ndarray, frame_index: int, scroll_speed=1,
               trail_len=10, color_bgr=(70, 255, 0), background_bgr=(0, 0, 0),
               color_mode="solid", source_frame=None):
        """
        mask: array (H,W) uint8, >0 onde deve aparecer o efeito
        frame_index: indice do frame (controla o offset do scroll)
        scroll_speed: celulas por frame que o rain desce
        trail_len: comprimento do rastro esmaecendo, em celulas
        color_bgr: cor dos digitos
        background_bgr: cor do fundo do trecho renderizado
        color_mode: solid | source | grayscale
        source_frame: frame BGR usado nos modos source/grayscale
        """
        out = np.zeros((self.height, self.width, 3), dtype=np.uint8)
        out[:, :] = background_bgr
        offset = (frame_index * scroll_speed)

        # reduz a mascara pra resolucao da grade (1 valor por celula)
        mask_small = cv2.resize(mask, (self.cols, self.rows), interpolation=cv2.INTER_AREA)

        for c in range(self.cols):
            phase = self.col_phase[c]
            for r in range(self.rows):
                if mask_small[r, c] < 60:
                    continue
                # a silhueta fica sempre preenchida (denso, como no protótipo);
                # o "scroll" muda QUAL digito aparece em cada celula ao longo do
                # tempo, e um brilho ondulante da a sensacao de fluxo descendo,
                # sem nunca esvaziar a silhueta.
                source_row = (r + offset) % self.buffer_rows
                ch = self.char_map[self.chars[source_row, c] % len(self.char_map)]
                wave = (r + offset + phase) % trail_len
                brightness = 0.55 + 0.45 * (wave / trail_len)
                glyph = self._glyph(ch, brightness)

                y0, x0 = r * self.cell_size, c * self.cell_size
                roi = out[y0:y0 + self.cell_size, x0:x0 + self.cell_size]
                cell_color = color_bgr
                if source_frame is not None and color_mode in {"source", "grayscale"}:
                    src_roi = source_frame[y0:y0 + self.cell_size, x0:x0 + self.cell_size]
                    if src_roi.size:
                        avg = src_roi.reshape(-1, 3).mean(axis=0)
                        if color_mode == "grayscale":
                            lum = int(0.114 * avg[0] + 0.587 * avg[1] + 0.299 * avg[2])
                            cell_color = (lum, lum, lum)
                        else:
                            cell_color = tuple(int(v) for v in avg)
                colored = np.zeros_like(roi)
                colored[:, :] = cell_color
                m3 = cv2.merge([glyph, glyph, glyph]).astype(np.float32) / 255.0
                out[y0:y0 + self.cell_size, x0:x0 + self.cell_size] = (
                    roi * (1 - m3) + colored * m3
                ).astype(np.uint8)

        return out
