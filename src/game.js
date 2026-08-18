import fs from 'node:fs';
import {
  ITEMS, now, numericItemLevel, rand, randInt, sample, shuffle,
} from './utils.js';
import { I18n } from './i18n.js';

const ALIGNMENTS = { good: 'g', neutral: 'n', evil: 'e' };
const BOT_OPPONENT = 'IdleRPG';
const defaultI18n = new I18n();

export function loadEvents(filename) {
  const events = { calamities: [], godsends: [], quests: [] };
  for (const line of fs.readFileSync(filename, 'utf8').split(/\r?\n/)) {
    if (line.startsWith('C ')) events.calamities.push(line.slice(2));
    else if (line.startsWith('G ')) events.godsends.push(line.slice(2));
    else if (line.startsWith('Q1 ')) events.quests.push({ type: 1, text: line.slice(3) });
    else {
      const match = line.match(/^Q2 (\d+) (\d+) (\d+) (\d+) (.*)$/);
      if (match) events.quests.push({
        type: 2,
        p1: [Number(match[1]), Number(match[2])],
        p2: [Number(match[3]), Number(match[4])],
        text: match[5],
      });
    }
  }
  if (!events.calamities.length || !events.godsends.length || !events.quests.length) {
    throw new Error(`Events file ${filename} is missing C, G, or Q entries.`);
  }
  return events;
}

export class IdleGame {
  constructor(channelId, database, config, events, {
    i18n = defaultI18n,
    locale = config.defaultLocale,
    logger = { info() {} },
  } = {}) {
    this.channelId = channelId;
    this.database = database;
    this.config = config;
    this.events = events;
    this.i18n = i18n;
    this.locale = this.i18n.resolve(locale);
    this.logger = logger;
    this.channel = database.ensureChannel(channelId);
    this.players = new Map(database.getPlayers(channelId).map((player) => [player.user_id, player]));
    this.messages = [];
    this.lastRegistration = 0;

    // The IRC bot did not count time while it was disconnected. A process restart
    // is the Discord equivalent, so resume the clock from startup rather than the
    // persisted wall-clock timestamp.
    this.channel.last_tick = now();
    this.save();
  }

  get activePlayers() {
    return [...this.players.values()].filter((player) => player.active);
  }

  playerForUser(userId) {
    return this.players.get(String(userId));
  }

  playerByName(name) {
    if (!name) return undefined;
    if (this.config.caseInsensitiveNames) {
      const wanted = name.toLocaleLowerCase();
      return [...this.players.values()].find((player) => player.name.toLocaleLowerCase() === wanted);
    }
    return [...this.players.values()].find((player) => player.name === name);
  }

  isAdmin(userId) {
    return this.config.ownerIds.has(String(userId)) || Boolean(this.playerForUser(userId)?.is_admin);
  }

  playerLabel(player, mention = true) {
    return mention ? `${player.name} (<@${player.user_id}>)` : player.name;
  }

  playerLabels(players) {
    return this.i18n.list(players.map((player) => this.playerLabel(player)), this.locale);
  }

  setLocale(locale, events = this.events) {
    this.locale = this.i18n.resolve(locale);
    this.events = events;
  }

  t(key, variables = {}) {
    return this.i18n.t(this.locale, key, variables);
  }

  duration(seconds) {
    return this.i18n.duration(seconds, this.locale);
  }

  itemName(item) {
    return this.t(`item.${item}`);
  }

  announce(message) {
    if (message && !(this.channel.silent_mode & 1)) this.messages.push(message);
  }

  drainMessages(maxMessages = 5, maxCharacters = 7000) {
    const outgoing = [];
    let characters = 0;
    while (this.messages.length && outgoing.length < maxMessages) {
      const next = this.messages[0];
      if (outgoing.length && characters + next.length > maxCharacters) break;
      outgoing.push(this.messages.shift());
      characters += next.length;
    }
    return outgoing;
  }

  save() {
    this.database.saveGame(this.channel, this.players.values());
  }

  register(userId, name, characterClass, isOwner = false) {
    userId = String(userId);
    name = name.trim();
    characterClass = characterClass.trim();
    if (this.playerForUser(userId)) throw new Error(this.t('game.error.alreadyOwn', { name: this.playerForUser(userId).name }));
    if (name.length < 1 || name.length > 16) throw new Error(this.t('game.error.nameLength'));
    if (name.startsWith('#')) throw new Error(this.t('game.error.nameHash'));
    if (/\p{Cc}/u.test(name) || /\p{Cc}/u.test(characterClass)) throw new Error(this.t('game.error.controlCharacters'));
    if (characterClass.length < 1 || characterClass.length > 30) throw new Error(this.t('game.error.classLength'));
    if (this.playerByName(name)) throw new Error(this.t('game.error.nameUsed'));

    const timestamp = now();
    if (timestamp === this.lastRegistration) throw new Error(this.t('game.error.registrationRate'));
    const player = {
      channel_id: this.channelId,
      user_id: userId,
      name,
      class: characterClass,
      level: 0,
      next_level: this.config.rpBase,
      idled: 0,
      created: timestamp,
      last_login: timestamp,
      x: randInt(this.config.mapWidth),
      y: randInt(this.config.mapHeight),
      alignment: 'n',
      active: 1,
      is_admin: isOwner ? 1 : 0,
      pen_message: 0,
      pen_nick: 0,
      pen_part: 0,
      pen_kick: 0,
      pen_quit: 0,
      pen_quest: 0,
      pen_logout: 0,
      items: Object.fromEntries(ITEMS.map((item) => [item, '0'])),
    };
    this.database.insertPlayer(player);
    this.players.set(userId, player);
    this.lastRegistration = timestamp;
    this.announce(this.t('game.welcome', {
      name, className: characterClass, mention: `<@${userId}>`, time: this.duration(this.config.rpBase),
    }));
    return player;
  }

  removeOwnPlayer(userId) {
    const player = this.playerForUser(userId);
    if (!player) throw new Error(this.t('game.error.noCharacter'));
    this.players.delete(player.user_id);
    this.database.deletePlayer(this.channelId, player.user_id);
    this.announce(this.t('game.ownerRemoved', { player: this.playerLabel(player), className: player.class }));
    return player;
  }

  setAlignment(userId, alignment) {
    const player = this.requirePlayer(userId);
    player.alignment = ALIGNMENTS[alignment];
    this.database.savePlayer(player);
    this.announce(this.t('game.alignmentChanged', {
      player: this.playerLabel(player), alignment: this.t(`alignment.${alignment}`),
    }));
    return player;
  }

  requirePlayer(userId) {
    const player = this.playerForUser(userId);
    if (!player) throw new Error(this.t('game.error.noCharacterRegister'));
    return player;
  }

  itemSum(player, battle = false) {
    if (player === BOT_OPPONENT) {
      return Math.max(0, ...[...this.players.values()].map((candidate) => this.itemSum(candidate))) + 1;
    }
    const sum = ITEMS.reduce((total, item) => total + numericItemLevel(player.items[item]), 0);
    if (!battle) return sum;
    if (player.alignment === 'e') return Math.floor(sum * 0.9);
    if (player.alignment === 'g') return Math.floor(sum * 1.1);
    return sum;
  }

  status(player) {
    return this.t('game.status.text', {
      name: player.name,
      level: player.level,
      className: player.class,
      status: this.t(player.active ? 'status.online' : 'status.offline'),
      nextLevel: this.duration(player.next_level),
      idled: this.duration(player.idled),
      itemSum: this.itemSum(player),
      x: player.x,
      y: player.y,
      alignment: this.t(`alignment.${{ g: 'good', n: 'neutral', e: 'evil' }[player.alignment]}`),
    });
  }

  leaderboard() {
    return [...this.players.values()].sort((a, b) => b.level - a.level || a.next_level - b.next_level);
  }

  questStatus() {
    const questers = JSON.parse(this.channel.questers);
    if (!questers.length) return this.t('game.quest.none');
    const names = questers.map((id) => this.players.get(id)?.name).filter(Boolean);
    if (this.channel.quest_type === 1) {
      return this.t('game.quest.statusTimed', {
        players: this.i18n.list(names, this.locale),
        quest: this.channel.quest_text,
        time: this.duration(Math.max(0, this.channel.quest_time - now())),
      });
    }
    return this.t('game.quest.statusJourney', {
      players: this.i18n.list(names, this.locale), quest: this.channel.quest_text,
      p1x: this.channel.quest_p1_x, p1y: this.channel.quest_p1_y,
      p2x: this.channel.quest_p2_x, p2y: this.channel.quest_p2_y,
    });
  }

  setActive(userId, active, penaltyType) {
    const player = this.playerForUser(userId);
    if (!player) return;
    if (active && !player.active) {
      player.active = 1;
      player.last_login = now();
      this.database.savePlayer(player);
      if (this.config.announceLoginMessages !== false) {
        this.announce(this.t('game.online', {
          name: player.name,
          level: player.level,
          className: player.class,
          mention: `<@${player.user_id}>`,
          time: this.duration(player.next_level),
        }));
      }
    } else if (!active && player.active) {
      this.penalize(player, penaltyType ?? 'quit');
    }
  }

  penalizeMessage(userId, length) {
    const player = this.playerForUser(userId);
    if (!player || !player.active) return 0;
    return this.penalize(player, 'message', length);
  }

  penalize(player, type, messageLength = 0) {
    if (!player) return 0;
    this.questPenaltyCheck(player);
    const bases = { quit: 20, nick: 30, part: 200, kick: 250, logout: 20 };
    const base = type === 'message' ? messageLength : bases[type];
    if (base === undefined) return 0;
    let penalty = Math.floor(base * (this.config.rpPenStep ** player.level));
    if (this.config.limitPenalty && penalty > this.config.limitPenalty) penalty = this.config.limitPenalty;
    const columns = {
      message: 'pen_message', nick: 'pen_nick', part: 'pen_part', kick: 'pen_kick',
      quit: 'pen_quit', logout: 'pen_logout',
    };
    player[columns[type]] += penalty;
    player.next_level += penalty;
    if (['quit', 'part', 'kick', 'logout'].includes(type)) player.active = 0;
    this.database.savePlayer(player);
    if (type === 'message') {
      this.announce(this.t('game.penalty.message', {
        player: this.playerLabel(player), time: this.duration(penalty), name: player.name,
      }));
    } else if (type === 'nick') {
      this.announce(this.t('game.penalty.nick', {
        player: this.playerLabel(player), time: this.duration(penalty), name: player.name,
      }));
    }
    return penalty;
  }

  questPenaltyCheck(player) {
    const questers = JSON.parse(this.channel.questers);
    if (!questers.includes(player.user_id)) return;
    this.announce(this.t('game.quest.failed', { player: this.playerLabel(player) }));
    for (const target of this.activePlayers) {
      const gain = Math.floor(15 * (this.config.rpPenStep ** target.level));
      target.pen_quest += gain;
      target.next_level += gain;
    }
    this.channel.questers = '[]';
    this.channel.quest_time = now() + 43200;
    this.save();
  }

  tick(timestamp = now()) {
    const elapsed = Math.max(0, timestamp - this.channel.last_tick);
    const active = this.activePlayers;
    if (!active.length) {
      this.channel.last_tick = timestamp;
      this.save();
      return;
    }

    const evilCount = active.filter((player) => player.alignment === 'e').length;
    const goodCount = active.filter((player) => player.alignment === 'g').length;
    if (!this.config.noScale) {
      if (rand((20 * 86400) / this.config.selfClock) < active.length) this.handOfGod();
      if (rand((24 * 86400) / this.config.selfClock) < active.length) this.teamBattle();
      if (rand((8 * 86400) / this.config.selfClock) < active.length) this.calamity();
      if (rand((4 * 86400) / this.config.selfClock) < active.length) this.godsend();
    } else {
      if (rand(4000) < 1) this.handOfGod();
      if (rand(4000) < 1) this.teamBattle();
      if (rand(4000) < 1) this.calamity();
      if (rand(2000) < 1) this.godsend();
    }
    if (rand((8 * 86400) / this.config.selfClock) < evilCount) this.evilness();
    if (rand((12 * 86400) / this.config.selfClock) < goodCount) this.goodness();

    this.movePlayers();
    this.checkQuest(timestamp);

    if (this.channel.report_seconds && this.channel.report_seconds % 36000 === 0) {
      const leaders = this.leaderboard();
      if (leaders.length) this.announce(this.t('game.leaderboard.title'));
      leaders.slice(0, 3).forEach((player, index) => {
        this.announce(this.t('game.leaderboard.line', {
          player: this.playerLabel(player), level: player.level, className: player.class,
          rank: index + 1, time: this.duration(player.next_level),
        }));
      });
    }
    if (this.channel.report_seconds && this.channel.report_seconds % 3600 === 0) {
      const veterans = this.activePlayers.filter((player) => player.level > 44);
      if (veterans.length / this.activePlayers.length > 0.15) this.challengeOpponent(sample(veterans));
    }
    if (this.channel.paused && this.channel.report_seconds % 600 === 0) {
      this.announce(this.t('game.pausedWarning'));
    }

    for (const player of this.activePlayers) {
      player.next_level -= elapsed;
      player.idled += elapsed;
      if (player.next_level < 1) this.levelUp(player);
    }

    this.channel.report_seconds += this.config.selfClock;
    this.channel.last_tick = timestamp;
    if (!this.channel.paused) this.save();
  }

  levelUp(player) {
    player.level += 1;
    player.next_level = player.level > 60
      ? Math.floor((this.config.rpBase * (this.config.rpStep ** 60)) + (86400 * (player.level - 60)))
      : Math.floor(this.config.rpBase * (this.config.rpStep ** player.level));
    this.announce(this.t('game.levelUp', {
      name: player.name, className: player.class, mention: `<@${player.user_id}>`,
      level: player.level, time: this.duration(player.next_level),
    }));
    this.findItem(player, { mentionPlayer: false });
    const battle = this.challengeOpponent(player, { mentionPlayer: false });
    this.logger.info('Player leveled up; battle check completed.', {
      channelId: this.channelId,
      userId: player.user_id,
      character: player.name,
      level: player.level,
      battleStarted: battle.started,
      battleSkippedReason: battle.reason,
      battleChance: battle.chance,
      battleChanceRoll: battle.chanceRoll,
      battleChanceRequiredRoll: battle.chanceRequiredRoll,
      opponentType: battle.opponentType,
      opponentUserId: battle.opponentUserId,
      opponentCharacter: battle.opponentCharacter,
      battleWon: battle.won,
    });
  }

  handOfGod() {
    const player = sample(this.activePlayers);
    if (!player) return;
    const label = this.playerLabel(player);
    const amount = Math.floor(((5 + randInt(71)) / 100) * player.next_level);
    if (randInt(5)) {
      this.announce(this.t('game.handOfGod.good', {
        player: label, time: this.duration(amount), level: player.level + 1,
      }));
      player.next_level -= amount;
    } else {
      this.announce(this.t('game.handOfGod.bad', {
        player: label, time: this.duration(amount), level: player.level + 1,
      }));
      player.next_level += amount;
    }
    this.announce(this.t('game.nextLevel', { player: label, time: this.duration(player.next_level) }));
  }

  challengeOpponent(player, { mentionPlayer = true } = {}) {
    const chance = player.level < 25 ? '1-in-4' : 'guaranteed';
    const chanceRoll = player.level < 25 ? randInt(4) + 1 : undefined;
    const chanceRequiredRoll = player.level < 25 ? 1 : undefined;
    if (chanceRoll !== undefined && chanceRoll !== chanceRequiredRoll) {
      return {
        started: false,
        reason: 'random-chance',
        chance,
        chanceRoll,
        chanceRequiredRoll,
      };
    }
    const opponents = this.activePlayers.filter((candidate) => candidate.user_id !== player.user_id);
    if (!opponents.length) {
      return {
        started: false,
        reason: 'no-active-opponents',
        chance,
        chanceRoll,
        chanceRequiredRoll,
      };
    }
    let opponent = sample(opponents);
    if (rand(opponents.length + 1) < 1) opponent = BOT_OPPONENT;
    const mySum = this.itemSum(player, true);
    const opponentSum = this.itemSum(opponent, true);
    const myRoll = randInt(mySum);
    const opponentRoll = randInt(opponentSum);
    const playerLabel = this.playerLabel(player, mentionPlayer);
    const opponentLabel = opponent === BOT_OPPONENT ? BOT_OPPONENT : this.playerLabel(opponent);

    const won = myRoll >= opponentRoll;
    if (won) {
      let percent = opponent === BOT_OPPONENT ? 20 : Math.floor(opponent.level / 4);
      if (percent < 7) percent = 7;
      let gain = Math.floor((percent / 100) * player.next_level);
      this.announce(this.t('game.battle.win', {
        player: playerLabel, playerRoll: myRoll, playerSum: mySum, opponent: opponentLabel,
        opponentRoll, opponentSum, time: this.duration(gain), name: player.name,
      }));
      player.next_level -= gain;
      this.announce(this.t('game.nextLevel', { player: playerLabel, time: this.duration(player.next_level) }));
      const criticalFactor = player.alignment === 'g' ? 50 : player.alignment === 'e' ? 20 : 35;
      if (rand(criticalFactor) < 1 && opponent !== BOT_OPPONENT) {
        gain = Math.floor(((5 + randInt(20)) / 100) * opponent.next_level);
        this.announce(this.t('game.battle.critical', {
          player: playerLabel, opponent: opponentLabel, time: this.duration(gain), opponentName: opponent.name,
        }));
        opponent.next_level += gain;
        this.announce(this.t('game.nextLevel', { player: opponentLabel, time: this.duration(opponent.next_level) }));
      } else if (rand(25) < 1 && opponent !== BOT_OPPONENT && player.level > 19) {
        this.swapBattleItem(player, opponent, { mentionWinner: mentionPlayer });
      }
    } else {
      let percent = opponent === BOT_OPPONENT ? 10 : Math.floor(opponent.level / 7);
      if (percent < 7) percent = 7;
      const gain = Math.floor((percent / 100) * player.next_level);
      this.announce(this.t('game.battle.lose', {
        player: playerLabel, playerRoll: myRoll, playerSum: mySum, opponent: opponentLabel,
        opponentRoll, opponentSum, time: this.duration(gain), name: player.name,
      }));
      player.next_level += gain;
      this.announce(this.t('game.nextLevel', { player: playerLabel, time: this.duration(player.next_level) }));
    }
    return {
      started: true,
      chance,
      chanceRoll,
      chanceRequiredRoll,
      opponentType: opponent === BOT_OPPONENT ? 'bot' : 'player',
      opponentUserId: opponent === BOT_OPPONENT ? undefined : opponent.user_id,
      opponentCharacter: opponent === BOT_OPPONENT ? BOT_OPPONENT : opponent.name,
      won,
    };
  }

  swapBattleItem(winner, loser, { mentionWinner = true, mentionLoser = true } = {}) {
    const item = sample(ITEMS);
    if (numericItemLevel(loser.items[item]) <= numericItemLevel(winner.items[item])) return;
    this.announce(this.t('game.battle.swap', {
      loser: this.playerLabel(loser, mentionLoser), loserLevel: numericItemLevel(loser.items[item]),
      item: this.itemName(item), winner: this.playerLabel(winner, mentionWinner),
      winnerLevel: numericItemLevel(winner.items[item]), loserName: loser.name,
    }));
    [winner.items[item], loser.items[item]] = [loser.items[item], winner.items[item]];
  }

  teamBattle() {
    if (this.activePlayers.length < 6) return;
    const players = shuffle([...this.activePlayers]).slice(0, 6);
    const mySum = players.slice(0, 3).reduce((sum, player) => sum + this.itemSum(player, true), 0);
    const opponentSum = players.slice(3).reduce((sum, player) => sum + this.itemSum(player, true), 0);
    const gain = Math.floor(Math.min(...players.slice(0, 3).map((player) => player.next_level)) * 0.2);
    const myRoll = randInt(mySum);
    const opponentRoll = randInt(opponentSum);
    const first = players.slice(0, 3);
    const second = players.slice(3);
    const won = myRoll >= opponentRoll;
    this.announce(this.t(won ? 'game.teamBattle.win' : 'game.teamBattle.lose', {
      team: this.playerLabels(first), teamRoll: myRoll, teamSum: mySum,
      opponents: this.playerLabels(second), opponentRoll, opponentSum, time: this.duration(gain),
    }));
    for (const player of players.slice(0, 3)) player.next_level += won ? -gain : gain;
  }

  collisionFight(player, opponent) {
    const mySum = this.itemSum(player, true);
    const opponentSum = this.itemSum(opponent, true);
    const myRoll = randInt(mySum);
    const opponentRoll = randInt(opponentSum);
    const playerLabel = this.playerLabel(player);
    const opponentLabel = this.playerLabel(opponent);
    if (myRoll >= opponentRoll) {
      let percent = Math.floor(opponent.level / 4);
      if (percent < 7) percent = 7;
      let gain = Math.floor((percent / 100) * player.next_level);
      this.announce(this.t('game.collision.win', {
        player: playerLabel, playerRoll: myRoll, playerSum: mySum, opponent: opponentLabel,
        opponentRoll, opponentSum, time: this.duration(gain), name: player.name,
      }));
      player.next_level -= gain;
      this.announce(this.t('game.nextLevel', { player: playerLabel, time: this.duration(player.next_level) }));
      if (rand(35) < 1) {
        gain = Math.floor(((5 + randInt(20)) / 100) * opponent.next_level);
        this.announce(this.t('game.battle.critical', {
          player: playerLabel, opponent: opponentLabel, time: this.duration(gain), opponentName: opponent.name,
        }));
        opponent.next_level += gain;
        this.announce(this.t('game.nextLevel', { player: opponentLabel, time: this.duration(opponent.next_level) }));
      } else if (rand(25) < 1 && player.level > 19) {
        this.swapBattleItem(player, opponent);
      }
    } else {
      let percent = Math.floor(opponent.level / 7);
      if (percent < 7) percent = 7;
      const gain = Math.floor((percent / 100) * player.next_level);
      this.announce(this.t('game.collision.lose', {
        player: playerLabel, playerRoll: myRoll, playerSum: mySum, opponent: opponentLabel,
        opponentRoll, opponentSum, time: this.duration(gain), name: player.name,
      }));
      player.next_level += gain;
      this.announce(this.t('game.nextLevel', { player: playerLabel, time: this.duration(player.next_level) }));
    }
  }

  findItem(player, { mentionPlayer = true } = {}) {
    const playerLabel = this.playerLabel(player, mentionPlayer);
    const item = sample(ITEMS);
    let foundLevel = 1;
    for (let level = 1; level <= Math.floor(player.level * 1.5); level += 1) {
      if (rand(1.4 ** (level / 4)) < 1) foundLevel = level;
    }

    const artifacts = [
      { min: 25, base: 50, range: 25, item: 'helm', suffix: 'a', key: 'crown' },
      { min: 25, base: 50, range: 25, item: 'ring', suffix: 'h', key: 'ring' },
      { min: 30, base: 75, range: 25, item: 'tunic', suffix: 'b', key: 'plate' },
      { min: 35, base: 100, range: 25, item: 'amulet', suffix: 'c', key: 'amulet' },
      { min: 40, base: 150, range: 25, item: 'weapon', suffix: 'd', key: 'sword' },
      { min: 45, base: 175, range: 26, item: 'weapon', suffix: 'e', key: 'cane' },
      { min: 48, base: 250, range: 51, item: 'pair of boots', suffix: 'f', key: 'boots' },
      { min: 52, base: 300, range: 51, item: 'weapon', suffix: 'g', key: 'hammer' },
    ];
    for (const artifact of artifacts) {
      // These checks were an elsif chain in the original: once an eligible
      // 1-in-40 roll succeeds, later artifacts are not considered.
      if (player.level >= artifact.min && rand(40) < 1) {
        const level = artifact.base + randInt(artifact.range);
        if (level >= foundLevel && level > numericItemLevel(player.items[artifact.item])) {
          this.announce(this.t('game.artifactFound', {
            player: playerLabel, level,
            artifact: this.t(`artifact.${artifact.key}.name`),
            description: this.t(`artifact.${artifact.key}.description`),
          }));
          player.items[artifact.item] = `${level}${artifact.suffix}`;
          return;
        }
        break;
      }
    }

    const current = numericItemLevel(player.items[item]);
    if (foundLevel > current) {
      this.announce(this.t('game.itemFound.better', {
        player: playerLabel, foundLevel, item: this.itemName(item), currentLevel: current,
      }));
      player.items[item] = String(foundLevel);
    } else {
      this.announce(this.t('game.itemFound.worse', {
        player: playerLabel, foundLevel, item: this.itemName(item), currentLevel: current,
      }));
    }
  }

  calamity() {
    const player = sample(this.activePlayers);
    if (!player) return;
    const label = this.playerLabel(player);
    if (rand(10) < 1) {
      const item = sample(['amulet', 'charm', 'weapon', 'tunic', 'set of leggings', 'shield']);
      const event = this.t(`game.calamity.item.${item}`, { player: label });
      this.announce(this.t('game.calamity.itemResult', {
        event, name: player.name, item: this.itemName(item),
      }));
      const suffix = String(player.items[item]).match(/\D$/)?.[0] ?? '';
      player.items[item] = `${Math.floor(numericItemLevel(player.items[item]) * 0.9)}${suffix}`;
    } else {
      const amount = Math.floor((Math.floor(5 + rand(8)) / 100) * player.next_level);
      this.announce(this.t('game.calamity.event', {
        player: label, event: sample(this.events.calamities),
        time: this.duration(amount), level: player.level + 1,
      }));
      player.next_level += amount;
      this.announce(this.t('game.nextLevel', { player: label, time: this.duration(player.next_level) }));
    }
  }

  godsend() {
    const player = sample(this.activePlayers);
    if (!player) return;
    const label = this.playerLabel(player);
    if (rand(10) < 1) {
      const item = sample(['amulet', 'charm', 'weapon', 'tunic', 'set of leggings', 'shield']);
      const event = this.t(`game.godsend.item.${item}`, { player: label });
      this.announce(this.t('game.godsend.itemResult', {
        event, name: player.name, item: this.itemName(item),
      }));
      const suffix = String(player.items[item]).match(/\D$/)?.[0] ?? '';
      player.items[item] = `${Math.floor(numericItemLevel(player.items[item]) * 1.1)}${suffix}`;
    } else {
      const amount = Math.floor((Math.floor(5 + rand(8)) / 100) * player.next_level);
      this.announce(this.t('game.godsend.event', {
        player: label, event: sample(this.events.godsends),
        time: this.duration(amount), level: player.level + 1,
      }));
      player.next_level -= amount;
      this.announce(this.t('game.nextLevel', { player: label, time: this.duration(player.next_level) }));
    }
  }

  goodness() {
    const good = shuffle(this.activePlayers.filter((player) => player.alignment === 'g')).slice(0, 2);
    if (good.length < 2) return;
    const percent = 5 + randInt(8);
    this.announce(this.t('game.goodness', {
      player1: this.playerLabel(good[0]), player2: this.playerLabel(good[1]), percent,
    }));
    for (const player of good) {
      player.next_level = Math.floor(player.next_level * (1 - (percent / 100)));
      this.announce(this.t('game.nextLevel', {
        player: this.playerLabel(player), time: this.duration(player.next_level),
      }));
    }
  }

  evilness() {
    const evil = sample(this.activePlayers.filter((player) => player.alignment === 'e'));
    if (!evil) return;
    if (randInt(2) < 1) {
      const good = sample(this.activePlayers.filter((player) => player.alignment === 'g'));
      if (!good) return;
      const item = sample(ITEMS);
      if (numericItemLevel(good.items[item]) > numericItemLevel(evil.items[item])) {
        [evil.items[item], good.items[item]] = [good.items[item], evil.items[item]];
        this.announce(this.t('game.evilness.steal', {
          evil: this.playerLabel(evil), good: this.playerLabel(good),
          newLevel: numericItemLevel(evil.items[item]), oldLevel: numericItemLevel(good.items[item]),
          item: this.itemName(item), evilName: evil.name, goodName: good.name,
        }));
      } else {
        this.announce(this.t('game.evilness.failedSteal', {
          evil: this.playerLabel(evil), good: this.playerLabel(good), item: this.itemName(item),
        }));
      }
    } else {
      const percent = 1 + randInt(5);
      const gain = Math.floor(evil.next_level * (percent / 100));
      this.announce(this.t('game.evilness.forsaken', {
        player: this.playerLabel(evil), time: this.duration(gain),
      }));
      evil.next_level = Math.floor(evil.next_level * (1 + (percent / 100)));
      this.announce(this.t('game.nextLevel', {
        player: this.playerLabel(evil), time: this.duration(evil.next_level),
      }));
    }
  }

  movePlayers() {
    const onlineCount = this.activePlayers.length;
    if (!onlineCount) return;
    for (let second = 0; second < this.config.selfClock; second += 1) {
      const positions = new Map();
      const questerIds = JSON.parse(this.channel.questers);
      if (this.channel.quest_type === 2 && questerIds.length) {
        const questers = questerIds.map((id) => this.players.get(id)).filter(Boolean);
        const target = this.channel.quest_stage === 1
          ? [this.channel.quest_p1_x, this.channel.quest_p1_y]
          : [this.channel.quest_p2_x, this.channel.quest_p2_y];
        const allArrived = questers.every((player) => player.x === target[0] && player.y === target[1]);
        if (this.channel.quest_stage === 1 && allArrived) {
          this.channel.quest_stage = 2;
        } else if (this.channel.quest_stage === 2 && allArrived) {
          this.announce(this.t('game.quest.journeyComplete', { players: this.playerLabels(questers) }));
          for (const player of questers) player.next_level = Math.floor(player.next_level * 0.75);
          this.channel.questers = '[]';
          this.channel.quest_time = now() + 21600;
          this.channel.quest_type = 1;
        } else {
          const ordinary = this.activePlayers.filter((player) => !questerIds.includes(player.user_id));
          for (const player of ordinary) this.randomMove(player, positions, onlineCount);
          const stageTarget = this.channel.quest_stage === 1
            ? [this.channel.quest_p1_x, this.channel.quest_p1_y]
            : [this.channel.quest_p2_x, this.channel.quest_p2_y];
          for (const player of questers) {
            if (rand(100) < 1) {
              if (player.x !== stageTarget[0]) player.x += player.x < stageTarget[0] ? 1 : -1;
              if (player.y !== stageTarget[1]) player.y += player.y < stageTarget[1] ? 1 : -1;
            }
          }
        }
      } else {
        for (const player of this.activePlayers) this.randomMove(player, positions, onlineCount);
      }
    }
  }

  randomMove(player, positions, onlineCount) {
    player.x += randInt(3) - 1;
    player.y += randInt(3) - 1;
    if (player.x > this.config.mapWidth) player.x = 0;
    if (player.y > this.config.mapHeight) player.y = 0;
    if (player.x < 0) player.x = this.config.mapWidth;
    if (player.y < 0) player.y = this.config.mapHeight;
    const key = `${player.x},${player.y}`;
    const occupied = positions.get(key);
    if (occupied && !occupied.battled) {
      if (occupied.player.is_admin && !player.is_admin && rand(100) < 1) {
        this.announce(this.t('game.adminEncounter', {
          player: this.playerLabel(player), admin: this.playerLabel(occupied.player),
        }));
      }
      if (rand(onlineCount) < 1) {
        occupied.battled = true;
        this.collisionFight(player, occupied.player);
      }
    } else {
      positions.set(key, { battled: false, player });
    }
  }

  checkQuest(timestamp) {
    if (timestamp <= this.channel.quest_time) return;
    const questers = JSON.parse(this.channel.questers);
    if (!questers.length) {
      this.startQuest(timestamp);
    } else if (this.channel.quest_type === 1) {
      const players = questers.map((id) => this.players.get(id)).filter(Boolean);
      this.announce(this.t('game.quest.complete', { players: this.playerLabels(players) }));
      for (const player of players) player.next_level = Math.floor(player.next_level * 0.75);
      this.channel.questers = '[]';
      this.channel.quest_time = timestamp + 21600;
    }
  }

  startQuest(timestamp = now()) {
    const eligible = this.activePlayers.filter((player) => (
      player.level > 39 && timestamp - player.last_login > this.config.questEligibilitySeconds
    ));
    if (eligible.length < 4) return;
    const questers = shuffle(eligible).slice(0, 4);
    const quest = sample(this.events.quests);
    this.channel.questers = JSON.stringify(questers.map((player) => player.user_id));
    this.channel.quest_text = quest.text;
    this.channel.quest_type = quest.type;
    if (quest.type === 1) {
      this.channel.quest_time = timestamp + 43200 + randInt(43201);
      this.announce(this.t('game.quest.startTimed', {
        players: this.playerLabels(questers), quest: quest.text,
        time: this.duration(this.channel.quest_time - timestamp),
      }));
    } else {
      this.channel.quest_stage = 1;
      [this.channel.quest_p1_x, this.channel.quest_p1_y] = quest.p1;
      [this.channel.quest_p2_x, this.channel.quest_p2_y] = quest.p2;
      this.announce(this.t('game.quest.startJourney', {
        players: this.playerLabels(questers), quest: quest.text,
        p1x: quest.p1[0], p1y: quest.p1[1], p2x: quest.p2[0], p2y: quest.p2[1],
      }));
    }
  }

  adminDelete(name) {
    const player = this.playerByName(name);
    if (!player) throw new Error(this.t('game.error.noSuchCharacter', { name }));
    this.players.delete(player.user_id);
    this.database.deletePlayer(this.channelId, player.user_id);
    this.announce(this.t('game.admin.deleted', { player: this.playerLabel(player) }));
    return player;
  }

  adminSetAdmin(name, enabled) {
    const player = this.playerByName(name);
    if (!player) throw new Error(this.t('game.error.noSuchCharacter', { name }));
    player.is_admin = enabled ? 1 : 0;
    this.database.savePlayer(player);
    return player;
  }

  adminRename(name, newName) {
    const player = this.playerByName(name);
    if (!player) throw new Error(this.t('game.error.noSuchCharacter', { name }));
    if (this.playerByName(newName)) throw new Error(this.t('game.error.nameTaken', { name: newName }));
    if (newName.length < 1 || newName.length > 16 || /^#|\p{Cc}/u.test(newName)) throw new Error(this.t('game.error.invalidNewName'));
    player.name = newName;
    this.database.savePlayer(player);
    return player;
  }

  adminSetClass(name, characterClass) {
    const player = this.playerByName(name);
    if (!player) throw new Error(this.t('game.error.noSuchCharacter', { name }));
    if (characterClass.length < 1 || characterClass.length > 30 || /\p{Cc}/u.test(characterClass)) throw new Error(this.t('game.error.invalidNewClass'));
    player.class = characterClass;
    this.database.savePlayer(player);
    return player;
  }

  adminPush(name, seconds) {
    const player = this.playerByName(name);
    if (!player) throw new Error(this.t('game.error.noSuchCharacter', { name }));
    const pushed = seconds > player.next_level ? player.next_level : seconds;
    player.next_level -= pushed;
    this.database.savePlayer(player);
    this.announce(this.t('game.admin.pushed', {
      player: this.playerLabel(player), seconds: pushed, level: player.level + 1,
      name: player.name, time: this.duration(player.next_level),
    }));
    return { player, pushed };
  }

  adminDeleteOld(days) {
    const threshold = now() - (days * 86400);
    const old = [...this.players.values()].filter((player) => !player.active && player.last_login < threshold);
    for (const player of old) {
      this.players.delete(player.user_id);
      this.database.deletePlayer(this.channelId, player.user_id);
    }
    this.announce(this.t('game.admin.deletedOld', { count: old.length, days }));
    return old.length;
  }
}
