import {
  ApplicationFlagsBitField, Client, Events, GatewayIntentBits, REST, Routes,
} from 'discord.js';
import { commandData, handleCommand } from './commands.js';
import { bundledEventsPath, formatConfigSummary, loadConfig } from './config.js';
import { GameDatabase } from './database.js';
import { IdleGame, loadEvents } from './game.js';
import { I18n } from './i18n.js';
import { logger } from './logger.js';
import { PresenceTracker } from './presence.js';
import { splitDiscordMessage } from './utils.js';

const config = loadConfig();
const database = new GameDatabase(config.databasePath);
const i18n = new I18n({ defaultLocale: config.defaultLocale });
config.defaultLocale = i18n.resolve(config.defaultLocale);
const eventPacks = new Map(i18n.locales.map((locale) => {
  const filename = config.eventsPaths[locale] ?? bundledEventsPath(locale);
  return [locale, loadEvents(filename)];
}));
const games = new Map(config.channelIds.map((channelId) => [
  channelId,
  new IdleGame(channelId, database, config, eventPacks.get(config.defaultLocale), { i18n, logger }),
]));
const channels = new Map();
const guildLocales = new Map();

function localeForGuild(guildId, preferredLocale) {
  if (!guildId) return config.defaultLocale;
  if (guildLocales.has(guildId)) return guildLocales.get(guildId);
  const stored = database.getGuildLocale(guildId);
  const locale = i18n.resolve(stored ?? preferredLocale ?? config.defaultLocale);
  database.setGuildLocale(guildId, locale);
  guildLocales.set(guildId, locale);
  logger.info(stored ? 'Stored guild language loaded.' : 'Guild language initialized.', {
    guildId, locale, preferredLocale: preferredLocale ?? undefined,
  });
  return locale;
}

function setGuildLocale(guildId, requestedLocale) {
  const locale = i18n.resolve(requestedLocale);
  database.setGuildLocale(guildId, locale);
  guildLocales.set(guildId, locale);
  for (const [channelId, game] of games) {
    if (channels.get(channelId)?.guild.id === guildId) game.setLocale(locale, eventPacks.get(locale));
  }
  return locale;
}

const commandRuntime = { games, i18n, localeForGuild, setGuildLocale };

logger.info(`Configuration loaded (Discord token omitted).\n${formatConfigSummary(config)}`);
logger.info('Configuration and game state loaded.', {
  configuredChannels: config.channelIds.length,
  databasePath: config.databasePath,
  eventLocales: [...eventPacks.keys()],
  defaultLocale: config.defaultLocale,
  selfClockSeconds: config.selfClock,
  playersByChannel: Object.fromEntries([...games].map(([channelId, game]) => [channelId, game.players.size])),
});

async function canUsePresenceIntent(token) {
  try {
    const application = await new REST({ version: '10' })
      .setToken(token)
      .get(Routes.oauth2CurrentApplication());
    const flags = new ApplicationFlagsBitField(application.flags ?? 0);
    return flags.has(ApplicationFlagsBitField.Flags.GatewayPresence)
      || flags.has(ApplicationFlagsBitField.Flags.GatewayPresenceLimited);
  } catch (error) {
    logger.warn('Could not inspect Discord application flags; continuing without presence tracking.', { error });
    return false;
  }
}

const presenceIntentAvailable = await canUsePresenceIntent(config.token);
if (presenceIntentAvailable) {
  logger.info('GUILD_PRESENCES intent is available; offline penalties are enabled.', {
    graceSeconds: config.offlineGraceSeconds,
  });
} else {
  logger.warn('GUILD_PRESENCES privileged intent is not available. Offline status penalties are disabled; falling back to penalties when users leave the server.');
}

const intents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
];
if (presenceIntentAvailable) intents.push(GatewayIntentBits.GuildPresences);

const client = new Client({
  intents,
});
const presenceTracker = new PresenceTracker({
  games,
  channels,
  enabled: presenceIntentAvailable,
  graceSeconds: config.offlineGraceSeconds,
  logger,
});

async function sendGameMessages(game) {
  const channel = channels.get(game.channelId);
  if (!channel) return;
  for (const message of game.drainMessages()) {
    for (const chunk of splitDiscordMessage(message)) {
      await channel.send({ content: chunk, allowedMentions: { users: [...message.matchAll(/<@(\d+)>/g)].map((match) => match[1]) } });
    }
  }
}

client.once(Events.ClientReady, async (readyClient) => {
  const guilds = new Map();
  for (const channelId of config.channelIds) {
    try {
      const channel = await readyClient.channels.fetch(channelId);
      if (!channel?.isTextBased() || !channel.isSendable() || !channel.guild) {
        throw new Error('not a sendable guild text channel');
      }
      channels.set(channelId, channel);
      guilds.set(channel.guild.id, channel.guild);
      const locale = localeForGuild(channel.guild.id, channel.guild.preferredLocale);
      games.get(channelId)?.setLocale(locale, eventPacks.get(locale));
      logger.info('Configured game channel connected.', {
        channelId,
        channelName: channel.name,
        guildId: channel.guild.id,
        guildName: channel.guild.name,
        registeredPlayers: games.get(channelId)?.players.size ?? 0,
        locale,
      });
    } catch (error) {
      logger.error('Cannot use configured game channel.', { channelId, error });
    }
  }
  if (!channels.size) throw new Error('None of the configured game channels could be accessed.');

  for (const guild of guilds.values()) {
    try {
      await guild.commands.set(commandData);
      logger.info('Slash commands registered for guild.', {
        guildId: guild.id,
        guildName: guild.name,
        commandCount: commandData.length,
      });
    } catch (error) {
      logger.error('Failed to register slash commands for guild.', {
        guildId: guild.id,
        guildName: guild.name,
        error,
      });
    }
    await presenceTracker.initializeGuild(guild);
  }
  logger.info('Bot ready.', {
    botUser: readyClient.user.tag,
    botUserId: readyClient.user.id,
    activeGameChannels: channels.size,
    presenceTracking: presenceIntentAvailable,
  });

  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    for (const game of games.values()) {
      if (!channels.has(game.channelId)) continue;
      try {
        game.tick();
        await sendGameMessages(game);
      } catch (error) {
        logger.error('Game tick failed.', { channelId: game.channelId, error });
      }
    }
    running = false;
  }, config.selfClock * 1000).unref();
});

client.on(Events.InteractionCreate, (interaction) => {
  const game = games.get(interaction.channelId);
  const wasRegistered = interaction.user ? Boolean(game?.playerForUser(interaction.user.id)) : false;
  handleCommand(interaction, commandRuntime)
    .then(() => {
      // PresenceUpdate events are authoritative after registration. Re-reading
      // the cache after every command can race with Discord cache updates and
      // make a character appear to alternate between active and inactive.
      // A one-time observation is still needed when a character is first made.
      if (interaction.isChatInputCommand() && interaction.guild && game
          && !wasRegistered && game.playerForUser(interaction.user.id)) {
        const status = interaction.guild.presences.cache.get(interaction.user.id)?.status ?? 'offline';
        presenceTracker.update(interaction.guild.id, interaction.user.id, status);
      }
    })
    .catch((error) => logger.error('Unhandled slash command failure.', {
      commandName: interaction.commandName,
      channelId: interaction.channelId,
      userId: interaction.user?.id,
      error,
    }));
});

client.on(Events.MessageCreate, (message) => {
  if (message.author.bot || !games.has(message.channelId)) return;
  games.get(message.channelId).penalizeMessage(message.author.id, message.content.length);
});

client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
  if (oldMember.displayName === newMember.displayName) return;
  const penalties = [];
  for (const [channelId, game] of games) {
    if (channels.get(channelId)?.guild.id === newMember.guild.id) {
      const player = game.playerForUser(newMember.id);
      if (player?.active) penalties.push({
        channelId,
        character: player.name,
        seconds: game.penalize(player, 'nick'),
      });
    }
  }
  if (penalties.length) {
    logger.info('Player changed their server display name; nickname penalty applied.', {
      guildId: newMember.guild.id,
      userId: newMember.id,
      oldDisplayName: oldMember.displayName,
      newDisplayName: newMember.displayName,
      penalties,
    });
  }
});

client.on(Events.GuildMemberRemove, (member) => {
  presenceTracker.memberRemove(member.guild.id, member.id);
});

client.on(Events.GuildMemberAdd, (member) => {
  presenceTracker.memberAdd(member.guild.id, member.id);
});

client.on(Events.PresenceUpdate, (_oldPresence, newPresence) => {
  presenceTracker.update(newPresence.guild.id, newPresence.userId, newPresence.status);
});

async function shutdown(signal) {
  logger.info('Shutdown requested; saving games.', { signal, gameChannels: games.size });
  presenceTracker.clear();
  for (const game of games.values()) game.save();
  database.close();
  client.destroy();
  logger.info('Shutdown complete.', { signal });
  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

client.login(config.token).catch((error) => {
  logger.error('Discord login failed.', { error });
  database.close();
  process.exitCode = 1;
});
