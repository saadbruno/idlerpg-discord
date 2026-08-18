import {
  EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder,
} from 'discord.js';
import { logger } from './logger.js';
import { numericItemLevel } from './utils.js';

const localize = (builder, name, description, ptName, ptDescription) => builder
  .setName(name)
  .setNameLocalization('pt-BR', ptName)
  .setDescription(description)
  .setDescriptionLocalization('pt-BR', ptDescription);

const gameCommand = localize(
  new SlashCommandBuilder(), 'idlerpg', 'Play IdleRPG in this channel',
  'idlerpg', 'Jogue IdleRPG neste canal',
)
  .addSubcommand((command) => localize(command, 'register', 'Create your character in this channel', 'registrar', 'Crie seu personagem neste canal')
    .addStringOption((option) => localize(option, 'name', 'Character name (1-16 characters)', 'nome', 'Nome do personagem (1-16 caracteres)').setRequired(true).setMaxLength(16))
    .addStringOption((option) => localize(option, 'class', 'Character class (1-30 characters)', 'classe', 'Classe do personagem (1-30 caracteres)').setRequired(true).setMaxLength(30)))
  .addSubcommand((command) => localize(command, 'status', 'Show character status', 'status', 'Mostre o status de um personagem')
    .addStringOption((option) => localize(option, 'character', 'Another character; omit for yourself', 'personagem', 'Outro personagem; deixe vazio para ver o seu').setMaxLength(16)))
  .addSubcommand((command) => localize(command, 'whoami', 'Show your character and time to level', 'quemsou', 'Mostre seu personagem e o tempo até o próximo nível'))
  .addSubcommand((command) => localize(command, 'quest', 'Show the active quest', 'missão', 'Mostre a missão ativa'))
  .addSubcommand((command) => localize(command, 'align', 'Change your alignment', 'alinhar', 'Altere seu alinhamento')
    .addStringOption((option) => localize(option, 'alignment', 'New alignment', 'alinhamento', 'Novo alinhamento').setRequired(true)
      .addChoices(
        { name: 'Good', name_localizations: { 'pt-BR': 'Bom' }, value: 'good' },
        { name: 'Neutral', name_localizations: { 'pt-BR': 'Neutro' }, value: 'neutral' },
        { name: 'Evil', name_localizations: { 'pt-BR': 'Mau' }, value: 'evil' },
      )))
  .addSubcommand((command) => localize(command, 'items', 'Show your equipment', 'itens', 'Mostre seu equipamento'))
  .addSubcommand((command) => localize(command, 'leaderboard', 'Show the top IdleRPG characters', 'ranking', 'Mostre os melhores personagens do IdleRPG'))
  .addSubcommand((command) => localize(command, 'removeme', 'Permanently remove your character from this channel', 'remover', 'Remova permanentemente seu personagem deste canal')
    .addBooleanOption((option) => localize(option, 'confirm', 'Confirm permanent removal', 'confirmar', 'Confirme a remoção permanente').setRequired(true)))
  .addSubcommand((command) => localize(command, 'help', 'Explain how to play IdleRPG', 'ajuda', 'Explique como jogar IdleRPG'));

const characterOption = (option) => localize(option, 'character', 'Character name', 'personagem', 'Nome do personagem').setRequired(true);

const adminCommand = localize(
  new SlashCommandBuilder(), 'idlerpg-admin', "Administer this channel's IdleRPG game",
  'idlerpg-admin', 'Administre o IdleRPG deste canal',
)
  .addSubcommand((command) => localize(command, 'delete', 'Delete a character', 'excluir', 'Exclua um personagem')
    .addStringOption(characterOption))
  .addSubcommand((command) => localize(command, 'delete-old', 'Delete inactive characters older than a number of days', 'excluir-antigos', 'Exclua personagens inativos mais antigos que certo número de dias')
    .addNumberOption((option) => localize(option, 'days', 'Days since last access', 'dias', 'Dias desde o último acesso').setRequired(true).setMinValue(0)))
  .addSubcommand((command) => localize(command, 'make-admin', 'Grant game admin access', 'tornar-admin', 'Conceda acesso administrativo ao jogo')
    .addStringOption(characterOption))
  .addSubcommand((command) => localize(command, 'remove-admin', 'Remove game admin access', 'remover-admin', 'Remova o acesso administrativo ao jogo')
    .addStringOption(characterOption))
  .addSubcommand((command) => localize(command, 'rename', 'Rename a character', 'renomear', 'Renomeie um personagem')
    .addStringOption((option) => localize(option, 'character', 'Current character name', 'personagem', 'Nome atual do personagem').setRequired(true))
    .addStringOption((option) => localize(option, 'new-name', 'New character name', 'novo-nome', 'Novo nome do personagem').setRequired(true).setMaxLength(16)))
  .addSubcommand((command) => localize(command, 'change-class', 'Change a character class', 'mudar-classe', 'Altere a classe de um personagem')
    .addStringOption(characterOption)
    .addStringOption((option) => localize(option, 'new-class', 'New class', 'nova-classe', 'Nova classe').setRequired(true).setMaxLength(30)))
  .addSubcommand((command) => localize(command, 'push', 'Push a character toward or away from the next level', 'adiantar', 'Aproxime ou afaste um personagem do próximo nível')
    .addStringOption(characterOption)
    .addIntegerOption((option) => localize(option, 'seconds', 'Positive moves forward; negative moves backward', 'segundos', 'Positivo adianta; negativo atrasa').setRequired(true)))
  .addSubcommand((command) => localize(command, 'hand-of-god', 'Summon the Hand of God', 'mão-de-deus', 'Invoque a Mão de Deus'))
  .addSubcommand((command) => localize(command, 'pause', 'Toggle pause mode', 'pausar', 'Ative ou desative o modo de pausa'))
  .addSubcommand((command) => localize(command, 'silent', 'Set the classic silent mode (0-3)', 'silêncio', 'Defina o modo silencioso clássico (0-3)')
    .addIntegerOption((option) => localize(option, 'mode', '0 all, 1 no channel output, 2 no private output, 3 neither', 'modo', '0 tudo; 1 sem canal; 2 sem privado; 3 nenhum').setRequired(true).setMinValue(0).setMaxValue(3)))
  .addSubcommand((command) => localize(command, 'language', 'Set the IdleRPG language for this server', 'idioma', 'Defina o idioma do IdleRPG neste servidor')
    .addStringOption((option) => localize(option, 'locale', 'Language', 'idioma', 'Idioma').setRequired(true)
      .addChoices(
        { name: 'English (United States)', name_localizations: { 'pt-BR': 'Inglês (Estados Unidos)' }, value: 'en-US' },
        { name: 'Portuguese (Brazil)', name_localizations: { 'pt-BR': 'Português (Brasil)' }, value: 'pt-BR' },
      )));

export const commandData = [gameCommand.toJSON(), adminCommand.toJSON()];

const privateReply = (interaction, response) => interaction.reply({
  ...(typeof response === 'string' ? { content: response } : response),
  flags: MessageFlags.Ephemeral,
  allowedMentions: { parse: [] },
});

export function buildStatusEmbed(game, player, interaction) {
  const alignments = {
    g: { label: game.t('alignment.good'), color: 0x57F287 },
    n: { label: game.t('alignment.neutral'), color: 0x95A5A6 },
    e: { label: game.t('alignment.evil'), color: 0xED4245 },
  };
  const alignment = alignments[player.alignment] ?? alignments.n;
  const owner = interaction.client.users.cache.get(player.user_id);
  const equipment = Object.entries(player.items).map(([item, value]) => {
    const unique = /\D$/.test(String(value)) ? ' ★' : '';
    return `**${game.itemName(item)}**: ${numericItemLevel(value)}${unique}`;
  });
  const hasUniqueItem = Object.values(player.items).some((value) => /\D$/.test(String(value)));
  const midpoint = Math.ceil(equipment.length / 2);

  const embed = new EmbedBuilder()
    .setColor(alignment.color)
    .setTitle(game.t('status.title', { name: player.name, className: player.class }))
    .setDescription(game.t('status.description', { mention: `<@${player.user_id}>` }))
    .addFields(
      { name: game.t('status.level'), value: String(player.level), inline: true },
      { name: game.t('status.status'), value: game.t(player.active ? 'status.online' : 'status.offline'), inline: true },
      { name: game.t('status.alignment'), value: alignment.label, inline: true },
      { name: game.t('status.nextLevel'), value: game.duration(player.next_level), inline: true },
      { name: game.t('status.totalIdled'), value: game.duration(player.idled), inline: true },
      { name: game.t('status.itemScore'), value: String(game.itemSum(player)), inline: true },
      { name: game.t('status.mapPosition'), value: `[${player.x}, ${player.y}]`, inline: true },
      { name: game.t('status.created'), value: `<t:${player.created}:D>`, inline: true },
      { name: '\u200B', value: '\u200B', inline: true },
      { name: game.t('status.equipment'), value: equipment.slice(0, midpoint).join('\n'), inline: true },
      { name: '\u200B', value: equipment.slice(midpoint).join('\n'), inline: true },
    )
    .setFooter({
      text: `${game.t('status.footer', { channelId: game.channelId })}${hasUniqueItem ? ` • ${game.t('status.uniqueArtifact')}` : ''}`,
    });

  if (owner) embed.setThumbnail(owner.displayAvatarURL({ size: 128 }));
  return embed;
}

export function buildHelpEmbed(game) {
  return new EmbedBuilder()
    .setColor(0x95A5A6)
    .setTitle(game.t('help.title'))
    .setDescription(game.t('help.intro'))
    .addFields(
      { name: game.t('help.register.name'), value: game.t('help.register.value') },
      { name: game.t('help.progression.name'), value: game.t('help.progression.value') },
      { name: game.t('help.combat.name'), value: game.t('help.combat.value') },
      { name: game.t('help.items.name'), value: game.t('help.items.value') },
      { name: game.t('help.alignment.name'), value: game.t('help.alignment.value') },
      { name: game.t('help.quests.name'), value: game.t('help.quests.value') },
      {
        name: game.t('help.penalties.name'),
        value: game.t('help.penalties.value', { graceSeconds: game.config.offlineGraceSeconds ?? 60 }),
      },
      { name: game.t('help.commands.name'), value: game.t('help.commands.value') },
    )
    .setFooter({ text: game.t('help.footer') });
}

export async function handleCommand(interaction, runtime) {
  if (!interaction.isChatInputCommand()) return;
  const { games, i18n, localeForGuild } = runtime;
  const game = games.get(interaction.channelId);
  if (!game) {
    const locale = localeForGuild(interaction.guildId, interaction.guildLocale);
    await privateReply(interaction, i18n.t(locale, 'error.channelNotConfigured'));
    return;
  }

  try {
    if (interaction.commandName === 'idlerpg') await handleGameCommand(interaction, game);
    else if (interaction.commandName === 'idlerpg-admin') await handleAdminCommand(interaction, game, runtime);
  } catch (error) {
    const content = error instanceof Error ? error.message : game.t('error.commandFailed');
    logger.warn('Slash command rejected.', {
      commandName: interaction.commandName,
      subcommand: interaction.options.getSubcommand(false),
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      userId: interaction.user.id,
      reason: content,
    });
    if (interaction.replied || interaction.deferred) await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    else await privateReply(interaction, content);
  }
}

async function handleGameCommand(interaction, game) {
  const subcommand = interaction.options.getSubcommand();
  const userId = interaction.user.id;
  if (subcommand === 'register') {
    const player = game.register(
      userId,
      interaction.options.getString('name', true),
      interaction.options.getString('class', true),
      game.config.ownerIds.has(userId),
    );
    logger.info('Character registered.', {
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      userId,
      character: player.name,
      class: player.class,
      ownerAdmin: Boolean(player.is_admin),
    });
    await privateReply(interaction, game.t('command.register.success', {
      name: player.name, className: player.class, time: game.duration(player.next_level),
    }));
  } else if (subcommand === 'status') {
    const name = interaction.options.getString('character');
    const player = name ? game.playerByName(name) : game.requirePlayer(userId);
    if (!player) throw new Error(game.t('error.noCharacterNamed'));
    await privateReply(interaction, { embeds: [buildStatusEmbed(game, player, interaction)] });
  } else if (subcommand === 'whoami') {
    const player = game.requirePlayer(userId);
    await privateReply(interaction, game.t('command.whoami', {
      name: player.name, level: player.level, className: player.class, time: game.duration(player.next_level),
    }));
  } else if (subcommand === 'quest') {
    await privateReply(interaction, game.questStatus());
  } else if (subcommand === 'align') {
    const alignment = interaction.options.getString('alignment', true);
    game.setAlignment(userId, alignment);
    await privateReply(interaction, game.t('command.align', { alignment: game.t(`alignment.${alignment}`) }));
  } else if (subcommand === 'items') {
    const player = game.requirePlayer(userId);
    const items = Object.entries(player.items).map(([item, level]) => game.t('command.items.line', {
      item: game.itemName(item), level: numericItemLevel(level),
      unique: /\D$/.test(level) ? game.t('command.items.unique') : '',
    })).join('\n');
    await privateReply(interaction, `${game.t('command.items.title', { name: player.name })}\n${items}`);
  } else if (subcommand === 'leaderboard') {
    const lines = game.leaderboard().slice(0, 10).map((player, index) => game.t('command.leaderboard.line', {
      rank: index + 1, name: player.name, level: player.level,
      className: player.class, time: game.duration(player.next_level),
    }));
    await privateReply(interaction, lines.length ? lines.join('\n') : game.t('command.leaderboard.empty'));
  } else if (subcommand === 'removeme') {
    if (!interaction.options.getBoolean('confirm', true)) throw new Error(game.t('error.removeNotConfirmed'));
    const player = game.removeOwnPlayer(userId);
    logger.info('Player removed their character.', {
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      userId,
      character: player.name,
    });
    await privateReply(interaction, game.t('command.remove.success', { name: player.name }));
  } else if (subcommand === 'help') {
    await privateReply(interaction, { embeds: [buildHelpEmbed(game)] });
  }
}

async function handleAdminCommand(interaction, game, runtime) {
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'language') {
    const canManageGuild = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
    if (!canManageGuild && !game.config.ownerIds.has(interaction.user.id)) {
      throw new Error(game.t('error.noGuildLanguagePermission'));
    }
    const locale = interaction.options.getString('locale', true);
    runtime.setGuildLocale(interaction.guildId, locale);
    logger.info('Guild language changed.', {
      guildId: interaction.guildId, adminUserId: interaction.user.id, locale,
    });
    await privateReply(interaction, game.t('admin.language'));
    return;
  }
  if (!game.isAdmin(interaction.user.id)) throw new Error(game.t('error.noAdmin'));
  const name = interaction.options.getString('character');
  let response;
  if (subcommand === 'delete') {
    response = game.t('admin.delete', { name: game.adminDelete(name).name });
  } else if (subcommand === 'delete-old') {
    const days = interaction.options.getNumber('days', true);
    response = game.t('admin.deleteOld', { count: game.adminDeleteOld(days) });
  } else if (subcommand === 'make-admin') {
    const player = game.adminSetAdmin(name, true);
    response = game.t('admin.makeAdmin', { name: player.name });
  } else if (subcommand === 'remove-admin') {
    const player = game.adminSetAdmin(name, false);
    response = game.t('admin.removeAdmin', { name: player.name });
  } else if (subcommand === 'rename') {
    const oldName = name;
    const player = game.adminRename(name, interaction.options.getString('new-name', true));
    response = game.t('admin.rename', { oldName, name: player.name });
  } else if (subcommand === 'change-class') {
    const player = game.adminSetClass(name, interaction.options.getString('new-class', true));
    response = game.t('admin.changeClass', { name: player.name, className: player.class });
  } else if (subcommand === 'push') {
    const result = game.adminPush(name, interaction.options.getInteger('seconds', true));
    response = game.t('admin.push', {
      name: result.player.name, seconds: result.pushed, time: game.duration(result.player.next_level),
    });
  } else if (subcommand === 'hand-of-god') {
    game.handOfGod();
    game.save();
    response = game.t('admin.handOfGod');
  } else if (subcommand === 'pause') {
    game.channel.paused = game.channel.paused ? 0 : 1;
    game.save();
    response = game.t('admin.pause', { mode: game.channel.paused });
  } else if (subcommand === 'silent') {
    game.channel.silent_mode = interaction.options.getInteger('mode', true);
    game.save();
    response = game.t('admin.silent', { mode: game.channel.silent_mode });
  }
  logger.info('Administrative command completed.', {
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    adminUserId: interaction.user.id,
    subcommand,
    targetCharacter: name ?? undefined,
    result: response,
  });
  await privateReply(interaction, response);
}
