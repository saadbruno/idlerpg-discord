import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';

const defaults = {
  databasePath: './idlerpg.sqlite',
  eventsPath: './events.txt',
  eventsPaths: {
    'en-US': './events.txt',
    'pt-BR': './events.pt-BR.txt',
  },
  defaultLocale: 'en-US',
  ownerIds: [],
  rpBase: 600,
  rpStep: 1.16,
  rpPenStep: 1.14,
  selfClock: 3,
  limitPenalty: 604800,
  mapWidth: 500,
  mapHeight: 500,
  noScale: false,
  caseInsensitiveNames: true,
  offlineGraceSeconds: 60,
  questEligibilitySeconds: 14400,
  announceLoginMessages: true,
  enableBotOpponent: true,
};

function flattenConfigValue(entries, key, value) {
  if (key.split('.').at(-1).toLowerCase() === 'token') return;
  if (value instanceof Set) value = [...value];
  if (Array.isArray(value)) {
    if (!value.length) entries.push([key, '[]']);
    else value.forEach((item, index) => flattenConfigValue(entries, `${key}[${index}]`, item));
    return;
  }
  if (value && typeof value === 'object') {
    const children = Object.entries(value);
    if (!children.length) entries.push([key, '{}']);
    else children.forEach(([childKey, childValue]) => {
      flattenConfigValue(entries, `${key}.${childKey}`, childValue);
    });
    return;
  }
  entries.push([key, value === undefined ? 'undefined' : String(value)]);
}

export function formatConfigSummary(config) {
  const entries = [];
  for (const [key, value] of Object.entries(config)) flattenConfigValue(entries, key, value);
  const settingWidth = Math.max('Setting'.length, ...entries.map(([key]) => key.length));
  const valueWidth = Math.max('Loaded value'.length, ...entries.map(([, value]) => value.length));
  const border = `+${'-'.repeat(settingWidth + 2)}+${'-'.repeat(valueWidth + 2)}+`;
  const row = (setting, value) => `| ${setting.padEnd(settingWidth)} | ${value.padEnd(valueWidth)} |`;
  return [
    border,
    row('Setting', 'Loaded value'),
    border,
    ...entries.map(([key, value]) => row(key, value)),
    border,
  ].join('\n');
}

export function bundledEventsPath(locale) {
  const filename = locale === 'pt-BR' ? 'events.pt-BR.example.txt' : 'events.example.txt';
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), `../data/${filename}`);
}

export function ensureEventsFile(eventsPath, locale = 'en-US') {
  if (fs.existsSync(eventsPath)) return false;
  const extension = path.extname(eventsPath);
  const templateName = `${path.basename(eventsPath, extension)}.example${extension}`;
  const bundledTemplate = bundledEventsPath(locale);
  const templatePath = [
    path.join(path.dirname(eventsPath), templateName),
    bundledTemplate,
  ].find((candidate) => fs.existsSync(candidate));
  if (!templatePath) return false;

  fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
  fs.copyFileSync(templatePath, eventsPath, fs.constants.COPYFILE_EXCL);
  logger.info('Created runtime events file from the bundled template.', {
    eventsPath,
    templatePath,
  });
  return true;
}

export function loadConfig() {
  const dataDirectory = path.resolve(process.env.IDLERPG_DATA_DIR ?? './data');
  const configFile = path.resolve(process.env.IDLERPG_CONFIG ?? path.join(dataDirectory, 'config.json'));
  let fileConfig = {};
  if (fs.existsSync(configFile)) {
    fileConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  }

  const config = { ...defaults, ...fileConfig };
  if (Object.hasOwn(fileConfig, 'eventsPath') && !Object.hasOwn(fileConfig, 'eventsPaths')) {
    config.eventsPaths = { [config.defaultLocale]: fileConfig.eventsPath };
    logger.warn('The legacy eventsPath setting is in use. Configure eventsPaths to customize events per language.', {
      locale: config.defaultLocale,
    });
  }
  config.token = process.env.DISCORD_TOKEN || config.token;
  if (process.env.IDLERPG_CHANNEL_IDS) {
    config.channelIds = process.env.IDLERPG_CHANNEL_IDS.split(',').map((id) => id.trim()).filter(Boolean);
  }
  if (process.env.IDLERPG_OWNER_IDS) {
    config.ownerIds = process.env.IDLERPG_OWNER_IDS.split(',').map((id) => id.trim()).filter(Boolean);
  }

  if (!config.token || config.token.startsWith('set DISCORD_TOKEN')) {
    throw new Error('Set DISCORD_TOKEN or provide token in config.json.');
  }
  if (!Array.isArray(config.channelIds) || config.channelIds.length === 0) {
    throw new Error('channelIds must be a non-empty array of Discord channel IDs.');
  }
  if (new Set(config.channelIds).size !== config.channelIds.length) {
    throw new Error('channelIds contains duplicates.');
  }
  for (const key of ['rpBase', 'rpStep', 'rpPenStep', 'selfClock', 'mapWidth', 'mapHeight']) {
    if (!Number.isFinite(config[key]) || config[key] <= 0) throw new Error(`${key} must be a positive number.`);
  }
  if (!Number.isInteger(config.selfClock) || 60 % config.selfClock !== 0) {
    throw new Error('selfClock must be an integer factor of 60, matching the original scheduler.');
  }
  if (!Number.isInteger(config.offlineGraceSeconds) || config.offlineGraceSeconds < 0) {
    throw new Error('offlineGraceSeconds must be a non-negative integer.');
  }
  if (!Number.isInteger(config.questEligibilitySeconds) || config.questEligibilitySeconds < 0) {
    throw new Error('questEligibilitySeconds must be a non-negative integer.');
  }
  if (typeof config.announceLoginMessages !== 'boolean') {
    throw new Error('announceLoginMessages must be a boolean.');
  }
  if (typeof config.enableBotOpponent !== 'boolean') {
    throw new Error('enableBotOpponent must be a boolean.');
  }
  if (typeof config.defaultLocale !== 'string' || !config.defaultLocale) {
    throw new Error('defaultLocale must be a locale string.');
  }
  if (!config.eventsPaths || typeof config.eventsPaths !== 'object' || Array.isArray(config.eventsPaths)) {
    throw new Error('eventsPaths must be an object keyed by locale.');
  }

  const baseDir = path.dirname(configFile);
  config.databasePath = path.resolve(baseDir, config.databasePath);
  config.eventsPaths = Object.fromEntries(Object.entries(config.eventsPaths).map(([locale, filename]) => {
    if (typeof filename !== 'string' || !filename) throw new Error(`eventsPaths.${locale} must be a file path.`);
    const resolved = path.resolve(baseDir, filename);
    ensureEventsFile(resolved, locale);
    return [locale, resolved];
  }));
  config.eventsPath = config.eventsPaths[config.defaultLocale] ?? Object.values(config.eventsPaths)[0];
  config.channelIds = config.channelIds.map(String);
  config.ownerIds = new Set(config.ownerIds.map(String));
  return config;
}
