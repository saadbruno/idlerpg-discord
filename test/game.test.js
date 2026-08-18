import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { GameDatabase } from '../src/database.js';
import { IdleGame } from '../src/game.js';
import { buildHelpEmbed, buildStatusEmbed, commandData } from '../src/commands.js';
import { ensureEventsFile, formatConfigSummary } from '../src/config.js';
import { PresenceTracker } from '../src/presence.js';
import { I18n } from '../src/i18n.js';
import { now } from '../src/utils.js';

const config = {
  ownerIds: new Set(['owner']),
  rpBase: 600,
  rpStep: 1.16,
  rpPenStep: 1.14,
  selfClock: 3,
  limitPenalty: 604800,
  mapWidth: 500,
  mapHeight: 500,
  noScale: false,
  caseInsensitiveNames: true,
  questEligibilitySeconds: 14400,
};

const events = {
  calamities: ['stubbed calamity'],
  godsends: ['stubbed godsend'],
  quests: [{ type: 1, text: 'test the realm' }],
};

test('startup configuration summary lists settings without exposing the token', () => {
  const summary = formatConfigSummary({
    token: 'super-secret-token',
    channelIds: ['channel-1', 'channel-2'],
    ownerIds: new Set(['owner-1']),
    eventsPaths: { 'en-US': '/data/events.txt' },
    rpBase: 600,
    noScale: false,
  });

  assert.match(summary, /^\+-+\+-+\+$/m);
  assert.match(summary, /channelIds\[0\].*channel-1/);
  assert.match(summary, /channelIds\[1\].*channel-2/);
  assert.match(summary, /ownerIds\[0\].*owner-1/);
  assert.match(summary, /eventsPaths\.en-US.*\/data\/events\.txt/);
  assert.match(summary, /rpBase.*600/);
  assert.match(summary, /noScale.*false/);
  assert.doesNotMatch(summary, /super-secret-token/);
});

test('the same Discord user has completely separate characters per channel', () => {
  const database = new GameDatabase(':memory:');
  const first = new IdleGame('channel-a', database, config, events);
  const second = new IdleGame('channel-b', database, config, events);

  first.register('user-1', 'Hero', 'Knight');
  second.register('user-1', 'Hero', 'Mage');
  first.penalizeMessage('user-1', 12);

  assert.equal(first.playerForUser('user-1').class, 'Knight');
  assert.equal(second.playerForUser('user-1').class, 'Mage');
  assert.equal(first.playerForUser('user-1').next_level, 612);
  assert.equal(second.playerForUser('user-1').next_level, 600);
  assert.equal(database.getPlayers('channel-a').length, 1);
  assert.equal(database.getPlayers('channel-b').length, 1);
  database.close();
});

test('registration validation and message penalties match original formulas', () => {
  const database = new GameDatabase(':memory:');
  const game = new IdleGame('channel', database, config, events);
  const player = game.register('user-1', 'Hero', 'Knight');
  player.level = 10;
  player.next_level = 1000;

  const penalty = game.penalizeMessage('user-1', 25);
  assert.equal(penalty, Math.floor(25 * (1.14 ** 10)));
  assert.equal(player.next_level, 1000 + penalty);
  assert.throws(() => game.register('user-2', 'hero', 'Mage'), /already in use/);
  assert.throws(() => game.register('user-2', 'x'.repeat(17), 'Mage'), /between 1 and 16/);
  database.close();
});

test('level timer uses the original exponential curve', () => {
  const originalRandom = Math.random;
  Math.random = () => 0.5;
  const database = new GameDatabase(':memory:');
  const logs = [];
  try {
    const game = new IdleGame('channel', database, config, events, {
      logger: { info: (message, details) => logs.push({ message, details }) },
    });
    const player = game.register('user-1', 'Hero', 'Knight');
    player.next_level = 1;
    const timestamp = now();
    game.channel.last_tick = timestamp - 2;

    game.tick(timestamp);

    assert.equal(player.level, 1);
    assert.equal(player.next_level, Math.floor(600 * (1.16 ** 1)));
    assert.equal(player.idled, 2);
    assert.ok(game.messages.some((message) => message.includes('Hero, the Knight (<@user-1>), has attained level 1!')));
    assert.deepEqual(logs, [{
      message: 'Player leveled up; battle check completed.',
      details: {
        channelId: 'channel',
        userId: 'user-1',
        character: 'Hero',
        level: 1,
        battleStarted: false,
        battleSkippedReason: 'random-chance',
        battleChance: '1-in-4',
        battleChanceRoll: 3,
        battleChanceRequiredRoll: 1,
        opponentType: undefined,
        opponentUserId: undefined,
        opponentCharacter: undefined,
        battleWon: undefined,
      },
    }]);
  } finally {
    Math.random = originalRandom;
    database.close();
  }
});

test('level-up events only mention the leveling player in the initial announcement', () => {
  const originalRandom = Math.random;
  Math.random = () => 0.75;
  const database = new GameDatabase(':memory:');
  try {
    const game = new IdleGame('channel', database, config, events);
    const player = game.register('user-1', 'Hero', 'Knight');
    game.lastRegistration = 0;
    game.register('user-2', 'Rival', 'Mage');
    game.drainMessages();
    player.level = 24;

    game.levelUp(player);

    assert.match(game.messages[0], /Hero, the Knight \(<@user-1>\), has attained level 25/);
    assert.doesNotMatch(game.messages.slice(1).join('\n'), /<@user-1>/);
    assert.match(game.messages.slice(1).join('\n'), /Rival \(<@user-2>\)/);
    assert.equal(game.messages.join('\n').match(/<@user-1>/g)?.length, 1);
  } finally {
    Math.random = originalRandom;
    database.close();
  }
});

test('the virtual IdleRPG opponent can be disabled', () => {
  const originalRandom = Math.random;
  Math.random = () => 0;
  const database = new GameDatabase(':memory:');
  try {
    const game = new IdleGame('channel', database, {
      ...config,
      enableBotOpponent: false,
    }, events);
    const player = game.register('user-1', 'Hero', 'Knight');
    game.lastRegistration = 0;
    game.register('user-2', 'Rival', 'Mage');
    game.drainMessages();
    player.level = 25;

    const result = game.challengeOpponent(player);

    assert.equal(result.started, true);
    assert.equal(result.opponentType, 'player');
    assert.equal(result.opponentUserId, 'user-2');
    assert.doesNotMatch(game.messages.join('\n'), /IdleRPG/);
    assert.match(game.messages[0], /Rival \(<@user-2>\)/);
  } finally {
    Math.random = originalRandom;
    database.close();
  }
});

test('leaving and rejoining requires no login command', () => {
  const database = new GameDatabase(':memory:');
  const game = new IdleGame('channel', database, config, events);
  const player = game.register('user-1', 'Hero', 'Knight');

  game.setActive('user-1', false, 'quit');
  assert.equal(player.active, 0);
  assert.equal(player.pen_quit, 20);
  game.drainMessages();
  game.setActive('user-1', true);
  assert.equal(player.active, 1);
  assert.deepEqual(game.messages, [
    'Hero, the level 0 Knight (<@user-1>), is now online. Next level in 0 days, 00:10:20.',
  ]);
  database.close();
});

test('login announcements can be disabled without preventing reactivation', () => {
  const database = new GameDatabase(':memory:');
  const game = new IdleGame('channel', database, {
    ...config,
    announceLoginMessages: false,
  }, events);
  const player = game.register('user-1', 'Hero', 'Knight');

  game.setActive('user-1', false, 'quit');
  game.drainMessages();
  game.setActive('user-1', true);

  assert.equal(player.active, 1);
  assert.equal(game.messages.length, 0);
  assert.equal(database.getPlayer('channel', 'user-1').active, 1);
  database.close();
});

test('online presence changes do not deactivate an already-active character', () => {
  const database = new GameDatabase(':memory:');
  const game = new IdleGame('channel', database, config, events);
  const player = game.register('user-1', 'Hero', 'Knight');
  game.drainMessages();
  const tracker = new PresenceTracker({
    games: new Map([['channel', game]]),
    channels: new Map([['channel', { guild: { id: 'guild' } }]]),
    enabled: true,
    graceSeconds: 60,
  });

  tracker.update('guild', 'user-1', 'online');
  tracker.update('guild', 'user-1', 'idle');
  tracker.update('guild', 'user-1', 'dnd');

  assert.equal(player.active, 1);
  assert.equal(player.pen_quit, 0);
  assert.equal(player.next_level, config.rpBase);
  assert.deepEqual(game.messages, []);
  tracker.clear();
  database.close();
});

test('quest eligibility uses the configured continuous-online duration', () => {
  const database = new GameDatabase(':memory:');
  const game = new IdleGame('channel', database, config, events);
  const timestamp = now();

  for (let index = 1; index <= 4; index += 1) {
    game.lastRegistration = 0;
    const player = game.register(`user-${index}`, `Hero${index}`, 'Knight');
    player.level = 40;
    player.last_login = timestamp - 18000;
  }
  game.drainMessages();

  game.startQuest(timestamp);

  assert.equal(JSON.parse(game.channel.questers).length, 4);
  assert.match(game.messages[0], /have been chosen by the gods/);
  database.close();
});

test('offline grace period cancels on reconnect and penalizes only once', async () => {
  const player = { active: 1 };
  const transitions = [];
  const logs = [];
  const game = {
    playerForUser: () => player,
    setActive: (_userId, active, penalty) => {
      transitions.push({ active, penalty });
      player.active = active ? 1 : 0;
    },
  };
  const tracker = new PresenceTracker({
    games: new Map([['channel', game]]),
    channels: new Map([['channel', { guild: { id: 'guild' } }]]),
    enabled: true,
    graceSeconds: 0.01,
    logger: { info: (message) => logs.push(message), warn() {}, error() {} },
  });

  tracker.update('guild', 'user', 'offline');
  tracker.update('guild', 'user', 'online');
  await delay(20);
  assert.deepEqual(transitions, [{ active: true, penalty: undefined }]);
  assert.ok(logs.includes('Player went offline; grace period started.'));
  assert.ok(logs.includes('Player came back online during the grace period; offline penalty cancelled.'));

  transitions.length = 0;
  tracker.update('guild', 'user', 'offline');
  await delay(20);
  tracker.update('guild', 'user', 'offline');
  await delay(20);
  assert.deepEqual(transitions, [{ active: false, penalty: 'quit' }]);
  assert.ok(logs.includes('Offline grace period ended; applying the quit penalty.'));
  tracker.clear();
});

test('server-leave penalties remain when presence intent is unavailable', () => {
  const player = { active: 1 };
  const transitions = [];
  const game = {
    playerForUser: () => player,
    setActive: (_userId, active, penalty) => {
      transitions.push({ active, penalty });
      player.active = active ? 1 : 0;
    },
  };
  const tracker = new PresenceTracker({
    games: new Map([['channel', game]]),
    channels: new Map([['channel', { guild: { id: 'guild' } }]]),
    enabled: false,
    graceSeconds: 60,
  });

  tracker.update('guild', 'user', 'offline');
  assert.deepEqual(transitions, []);
  tracker.memberRemove('guild', 'user');
  assert.deepEqual(transitions, [{ active: false, penalty: 'quit' }]);
});

test('startup presence fetch reactivates players even when the initial cache is empty', async () => {
  const player = { user_id: 'user', name: 'Hero', active: 0 };
  const transitions = [];
  const logs = [];
  const game = {
    channelId: 'channel',
    players: new Map([['user', player]]),
    get activePlayers() { return [...this.players.values()].filter((candidate) => candidate.active); },
    playerForUser: (userId) => userId === 'user' ? player : undefined,
    setActive: (_userId, active, penalty) => {
      transitions.push({ active, penalty });
      player.active = active ? 1 : 0;
    },
  };
  const tracker = new PresenceTracker({
    games: new Map([['channel', game]]),
    channels: new Map([['channel', { guild: { id: 'guild' } }]]),
    enabled: true,
    graceSeconds: 60,
    logger: { info: (message) => logs.push(message), warn() {}, error() {} },
  });
  const guild = {
    id: 'guild',
    presences: { cache: new Map() },
    members: {
      fetch: async (options) => {
        assert.deepEqual(options.user, ['user']);
        assert.equal(options.withPresences, true);
        return new Map([['user', { id: 'user', presence: { status: 'online' } }]]);
      },
    },
  };

  await tracker.initializeGuild(guild);

  assert.equal(player.active, 1);
  assert.deepEqual(transitions, [{ active: true, penalty: undefined }]);
  assert.ok(logs.includes('Initial player presence reconciliation completed.'));
  tracker.clear();
});

test('startup presence fetch failures leave player state unchanged instead of assuming offline', async () => {
  const player = { user_id: 'user', name: 'Hero', active: 1 };
  const transitions = [];
  const warnings = [];
  const game = {
    channelId: 'channel',
    players: new Map([['user', player]]),
    playerForUser: (userId) => userId === 'user' ? player : undefined,
    setActive: (_userId, active, penalty) => transitions.push({ active, penalty }),
  };
  const tracker = new PresenceTracker({
    games: new Map([['channel', game]]),
    channels: new Map([['channel', { guild: { id: 'guild' } }]]),
    enabled: true,
    graceSeconds: 0,
    startupRetries: 0,
    logger: { info() {}, warn: (message) => warnings.push(message), error() {} },
  });
  const guild = {
    id: 'guild',
    presences: { cache: new Map() },
    members: { fetch: async () => { throw new Error('temporary gateway failure'); } },
  };

  const result = await tracker.initializeGuild(guild);

  assert.equal(player.active, 1);
  assert.deepEqual(transitions, []);
  assert.equal(result.unknownUsers, 1);
  assert.ok(warnings.includes('Could not fetch player presences during startup reconciliation.'));
  tracker.clear();
});

test('status command embed contains character and equipment details', () => {
  const database = new GameDatabase(':memory:');
  const game = new IdleGame('channel', database, config, events);
  const player = game.register('user-1', 'Hero', 'Knight');
  player.level = 12;
  player.alignment = 'g';
  player.items.weapon = '42d';
  const interaction = { client: { users: { cache: new Map() } } };

  const embed = buildStatusEmbed(game, player, interaction).toJSON();

  assert.equal(embed.title, 'Hero, the Knight');
  assert.equal(embed.color, 0x57F287);
  assert.equal(embed.fields.find((field) => field.name === 'Level').value, '12');
  assert.match(embed.fields.find((field) => field.name === 'Equipment').value, /weapon.*42/s);
  assert.match(embed.footer.text, /unique artifact/);
  database.close();
});

test('public game messages label characters with their Discord mention', () => {
  const database = new GameDatabase(':memory:');
  const game = new IdleGame('channel', database, config, events);
  const player = game.register('123456789012345678', 'Hero', 'Knight');
  game.drainMessages();

  game.setAlignment(player.user_id, 'good');

  assert.equal(game.playerLabel(player), 'Hero (<@123456789012345678>)');
  assert.ok(game.messages.some((message) => message.includes('Hero (<@123456789012345678>) has changed alignment')));
  database.close();
});

test('neutral status embeds use grey and omit the artifact legend when unnecessary', () => {
  const database = new GameDatabase(':memory:');
  const game = new IdleGame('channel', database, config, events);
  const player = game.register('user-1', 'Hero', 'Knight');
  const interaction = { client: { users: { cache: new Map() } } };

  const embed = buildStatusEmbed(game, player, interaction).toJSON();

  assert.equal(embed.color, 0x95A5A6);
  assert.doesNotMatch(embed.footer.text, /unique artifact/);
  database.close();
});

test('missing runtime events are seeded once without overwriting custom events', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'idlerpg-events-'));
  try {
    const template = path.join(directory, 'events.example.txt');
    const runtime = path.join(directory, 'events.txt');
    fs.writeFileSync(template, 'default events\n');

    assert.equal(ensureEventsFile(runtime), true);
    assert.equal(fs.readFileSync(runtime, 'utf8'), 'default events\n');
    fs.writeFileSync(runtime, 'custom events\n');
    assert.equal(ensureEventsFile(runtime), false);
    assert.equal(fs.readFileSync(runtime, 'utf8'), 'custom events\n');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Brazilian Portuguese localizes game announcements, durations, items, and embeds', () => {
  const database = new GameDatabase(':memory:');
  const i18n = new I18n({ defaultLocale: 'pt-BR' });
  const game = new IdleGame('channel', database, { ...config, defaultLocale: 'pt-BR' }, events, { i18n });
  const player = game.register('user-1', 'Herói', 'Cavaleiro');
  player.items.weapon = '42d';
  const interaction = { client: { users: { cache: new Map() } } };

  assert.match(game.messages[0], /Boas-vindas/);
  assert.equal(game.duration(86400), '1 dia, 00:00:00');
  assert.equal(game.duration(172800), '2 dias, 00:00:00');
  const embed = buildStatusEmbed(game, player, interaction).toJSON();
  assert.equal(embed.title, 'Herói, o Cavaleiro');
  assert.equal(embed.fields[0].name, 'Nível');
  assert.match(embed.fields.find((field) => field.name === 'Equipamento').value, /arma.*42/s);
  assert.match(embed.footer.text, /artefato único/);
  game.setActive('user-1', false, 'quit');
  game.drainMessages();
  game.setActive('user-1', true);
  assert.match(game.messages[0], /Herói, Cavaleiro de nível 0 \(<@user-1>\), agora está online/);
  database.close();
});

test('guild language settings persist independently', () => {
  const database = new GameDatabase(':memory:');
  assert.equal(database.getGuildLocale('guild-a'), undefined);
  database.setGuildLocale('guild-a', 'pt-BR');
  database.setGuildLocale('guild-b', 'en-US');
  assert.equal(database.getGuildLocale('guild-a'), 'pt-BR');
  assert.equal(database.getGuildLocale('guild-b'), 'en-US');
  database.close();
});

test('slash commands include Brazilian Portuguese names and the guild language command', () => {
  const game = commandData.find((command) => command.name === 'idlerpg');
  const admin = commandData.find((command) => command.name === 'idlerpg-admin');
  assert.equal(game.options.find((option) => option.name === 'register').name_localizations['pt-BR'], 'registrar');
  assert.equal(game.options.find((option) => option.name === 'quest').name_localizations['pt-BR'], 'missão');
  assert.ok(admin.options.some((option) => option.name === 'language'));
  assert.equal(admin.options.find((option) => option.name === 'language').name_localizations['pt-BR'], 'idioma');
});

test('help embed explains core game mechanics in both supported languages', () => {
  const database = new GameDatabase(':memory:');
  const i18n = new I18n();
  const game = new IdleGame('channel', database, { ...config, offlineGraceSeconds: 60 }, events, { i18n });

  const english = buildHelpEmbed(game).toJSON();
  assert.equal(english.title, 'How to play IdleRPG');
  assert.equal(english.fields.length, 8);
  assert.match(english.fields.find((field) => field.name === 'Battles and random events').value, /Critical strikes/);
  assert.match(english.fields.find((field) => field.name === 'Activity and offline penalties').value, /60 seconds/);
  assert.doesNotMatch(english.description, /Discord port/i);

  game.setLocale('pt-BR', events);
  const portuguese = buildHelpEmbed(game).toJSON();
  assert.equal(portuguese.title, 'Como jogar IdleRPG');
  assert.equal(portuguese.fields.length, 8);
  assert.match(portuguese.fields.find((field) => field.name === 'Batalhas e eventos aleatórios').value, /Golpes críticos/);
  assert.match(portuguese.fields.find((field) => field.name === 'Atividade e penalidades offline').value, /60 segundos/);

  for (const embed of [english, portuguese]) {
    const length = (embed.title?.length ?? 0) + (embed.description?.length ?? 0)
      + embed.fields.reduce((total, field) => total + field.name.length + field.value.length, 0)
      + (embed.footer?.text.length ?? 0);
    assert.ok(length <= 6000);
    assert.ok(embed.fields.every((field) => field.value.length <= 1024));
  }
  database.close();
});
