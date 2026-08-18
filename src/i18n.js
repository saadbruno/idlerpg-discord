import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';

export const DEFAULT_LOCALE = 'en-US';
export const DISCORD_LOCALES = { 'en-US': 'en-US', 'pt-BR': 'pt-BR' };

const localeDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../locales');

function render(template, variables) {
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, key) => (
    Object.hasOwn(variables, key) ? String(variables[key]) : match
  ));
}

function placeholders(value) {
  const templates = typeof value === 'string' ? [value] : Object.values(value);
  return [...new Set(templates.flatMap((template) => (
    [...template.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1])
  )))].sort();
}

export class I18n {
  constructor({ directory = localeDirectory, defaultLocale = DEFAULT_LOCALE, log = logger } = {}) {
    this.log = log;
    this.catalogs = new Map();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name, 'messages.json');
      if (entry.isDirectory() && fs.existsSync(filename)) {
        this.catalogs.set(entry.name, JSON.parse(fs.readFileSync(filename, 'utf8')));
      }
    }
    if (!this.catalogs.has(DEFAULT_LOCALE)) throw new Error(`Missing required ${DEFAULT_LOCALE} locale catalog.`);
    this.defaultLocale = this.resolve(defaultLocale);
    this.validateCatalogs();
  }

  get locales() {
    return [...this.catalogs.keys()];
  }

  supports(locale) {
    return Boolean(locale && this.catalogs.has(locale));
  }

  resolve(locale) {
    if (this.supports(locale)) return locale;
    const base = String(locale ?? '').split('-')[0].toLowerCase();
    const regional = this.locales.find((candidate) => candidate.toLowerCase().split('-')[0] === base);
    return regional ?? (this.catalogs.has(this.defaultLocale) ? this.defaultLocale : DEFAULT_LOCALE);
  }

  t(locale, key, variables = {}) {
    const resolved = this.resolve(locale);
    const catalog = this.catalogs.get(resolved);
    let template = catalog[key];
    if (template === undefined && resolved !== DEFAULT_LOCALE) {
      template = this.catalogs.get(DEFAULT_LOCALE)[key];
      this.log.warn('Translation key missing; using English fallback.', { locale: resolved, key });
    }
    if (template === undefined) {
      this.log.warn('Translation key is missing from every catalog.', { locale: resolved, key });
      return key;
    }
    if (typeof template === 'object') {
      const category = new Intl.PluralRules(resolved).select(Number(variables.count));
      template = template[category] ?? template.other;
    }
    return render(template, variables);
  }

  duration(seconds, locale = this.defaultLocale) {
    if (!Number.isFinite(seconds) || seconds < 0) return this.t(locale, 'time.invalid', { seconds });
    const value = Math.floor(seconds);
    const days = Math.floor(value / 86400);
    const hours = String(Math.floor((value % 86400) / 3600)).padStart(2, '0');
    const minutes = String(Math.floor((value % 3600) / 60)).padStart(2, '0');
    const secs = String(value % 60).padStart(2, '0');
    return this.t(locale, 'time.duration', {
      days: this.t(locale, 'time.days', { count: days }), hours, minutes, seconds: secs,
    });
  }

  list(values, locale = this.defaultLocale) {
    return new Intl.ListFormat(this.resolve(locale), { style: 'long', type: 'conjunction' }).format(values);
  }

  validateCatalogs() {
    const englishKeys = Object.keys(this.catalogs.get(DEFAULT_LOCALE)).sort();
    for (const [locale, catalog] of this.catalogs) {
      const missing = englishKeys.filter((key) => !Object.hasOwn(catalog, key));
      const extra = Object.keys(catalog).filter((key) => !englishKeys.includes(key));
      if (missing.length || extra.length) {
        throw new Error(`Locale ${locale} does not match ${DEFAULT_LOCALE}: missing [${missing.join(', ')}], extra [${extra.join(', ')}].`);
      }
      for (const key of englishKeys) {
        const expected = placeholders(this.catalogs.get(DEFAULT_LOCALE)[key]);
        const actual = placeholders(catalog[key]);
        if (expected.join('\0') !== actual.join('\0')) {
          throw new Error(`Locale ${locale} uses different placeholders for ${key}: expected [${expected.join(', ')}], found [${actual.join(', ')}].`);
        }
      }
    }
  }
}
