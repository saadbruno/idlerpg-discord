export const ITEMS = [
  'ring', 'amulet', 'charm', 'weapon', 'helm', 'tunic', 'pair of gloves',
  'set of leggings', 'shield', 'pair of boots',
];

export const ITEM_COLUMNS = {
  ring: 'item_ring',
  amulet: 'item_amulet',
  charm: 'item_charm',
  weapon: 'item_weapon',
  helm: 'item_helm',
  tunic: 'item_tunic',
  'pair of gloves': 'item_gloves',
  'set of leggings': 'item_leggings',
  shield: 'item_shield',
  'pair of boots': 'item_boots',
};

export const now = () => Math.floor(Date.now() / 1000);
export const rand = (max) => Math.random() * max;
export const randInt = (max) => Math.floor(rand(max));
export const sample = (values) => values[randInt(values.length)];

export function shuffle(values) {
  for (let i = values.length - 1; i > 0; i -= 1) {
    const j = randInt(i + 1);
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}

export function numericItemLevel(value) {
  const match = String(value ?? 0).match(/^\d+/);
  return match ? Number(match[0]) : 0;
}

export function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return `NA (${seconds})`;
  const value = Math.floor(seconds);
  const days = Math.floor(value / 86400);
  const hours = String(Math.floor((value % 86400) / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((value % 3600) / 60)).padStart(2, '0');
  const secs = String(value % 60).padStart(2, '0');
  return `${days} day${days === 1 ? '' : 's'}, ${hours}:${minutes}:${secs}`;
}

export function joinNames(names) {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`;
}

export function splitDiscordMessage(text, max = 2000) {
  const chunks = [];
  let rest = String(text);
  while (rest.length > max) {
    let cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
