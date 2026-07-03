export type EffectType = "rain" | "blink" | "tracking" | "mesh" | "reveal" | "glitch";

export type EffectPreset = {
  id: string;
  name: string;
  hint: string;
  effectType: EffectType;
  charMap: string;
  color: string;
  colorMode: "solid" | "source" | "grayscale";
  backgroundMode: "color" | "video" | "image";
  cellSize: number;
  trailLen: number;
  intensity: number;
};

export const EFFECT_PRESETS: EffectPreset[] = [
  {
    id: "binary",
    name: "binary rain",
    hint: "0/1 verde classico",
    effectType: "rain",
    charMap: "01",
    color: "#46ff00",
    colorMode: "solid",
    backgroundMode: "color",
    cellSize: 14,
    trailLen: 14,
    intensity: 1,
  },
  {
    id: "tracking",
    name: "tracking box",
    hint: "caixa + label",
    effectType: "tracking",
    charMap: "01",
    color: "#46ff00",
    colorMode: "solid",
    backgroundMode: "video",
    cellSize: 14,
    trailLen: 14,
    intensity: 1,
  },
  {
    id: "mesh",
    name: "mesh lines",
    hint: "pontos conectados",
    effectType: "mesh",
    charMap: "01",
    color: "#64ff8a",
    colorMode: "solid",
    backgroundMode: "video",
    cellSize: 16,
    trailLen: 12,
    intensity: 1,
  },
  {
    id: "blink",
    name: "blink pulse",
    hint: "pisca e pulsa",
    effectType: "blink",
    charMap: "01",
    color: "#46ff00",
    colorMode: "solid",
    backgroundMode: "video",
    cellSize: 12,
    trailLen: 18,
    intensity: 1,
  },
  {
    id: "reveal",
    name: "scan reveal",
    hint: "varredura digital",
    effectType: "reveal",
    charMap: "01",
    color: "#46ff00",
    colorMode: "solid",
    backgroundMode: "video",
    cellSize: 12,
    trailLen: 18,
    intensity: 1,
  },
  {
    id: "glitch",
    name: "glitch panel",
    hint: "recortes deslocados",
    effectType: "glitch",
    charMap: "01#$%",
    color: "#46ff00",
    colorMode: "solid",
    backgroundMode: "video",
    cellSize: 10,
    trailLen: 18,
    intensity: 1,
  },
  {
    id: "blocks",
    name: "block shade",
    hint: "blocos densos",
    effectType: "rain",
    charMap: " .:-=+*#%@",
    color: "#46ff00",
    colorMode: "solid",
    backgroundMode: "video",
    cellSize: 10,
    trailLen: 18,
    intensity: 1,
  },
  {
    id: "source",
    name: "source color",
    hint: "usa a cor do video",
    effectType: "rain",
    charMap: "01",
    color: "#46ff00",
    colorMode: "source",
    backgroundMode: "video",
    cellSize: 12,
    trailLen: 14,
    intensity: 1,
  },
  {
    id: "gray",
    name: "gray ascii",
    hint: "luminosidade ASCII",
    effectType: "rain",
    charMap: " .,:;irsXA253hMHGS#9B&@",
    color: "#ffffff",
    colorMode: "grayscale",
    backgroundMode: "color",
    cellSize: 9,
    trailLen: 22,
    intensity: 1,
  },
];

export function presetById(id: string) {
  return EFFECT_PRESETS.find((preset) => preset.id === id) ?? EFFECT_PRESETS[0];
}
