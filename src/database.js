import Database from 'better-sqlite3';
import { ITEM_COLUMNS, ITEMS, now } from './utils.js';

export class GameDatabase {
  constructor(filename) {
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    this.prepare();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        channel_id TEXT PRIMARY KEY,
        last_tick INTEGER NOT NULL,
        report_seconds INTEGER NOT NULL DEFAULT 0,
        paused INTEGER NOT NULL DEFAULT 0,
        silent_mode INTEGER NOT NULL DEFAULT 0,
        quest_time INTEGER NOT NULL,
        quest_type INTEGER NOT NULL DEFAULT 1,
        quest_stage INTEGER NOT NULL DEFAULT 1,
        quest_text TEXT NOT NULL DEFAULT '',
        quest_p1_x INTEGER,
        quest_p1_y INTEGER,
        quest_p2_x INTEGER,
        quest_p2_y INTEGER,
        questers TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS guild_settings (
        guild_id TEXT PRIMARY KEY,
        locale TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS players (
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        class TEXT NOT NULL,
        level INTEGER NOT NULL DEFAULT 0,
        next_level INTEGER NOT NULL,
        idled INTEGER NOT NULL DEFAULT 0,
        created INTEGER NOT NULL,
        last_login INTEGER NOT NULL,
        x INTEGER NOT NULL,
        y INTEGER NOT NULL,
        alignment TEXT NOT NULL DEFAULT 'n',
        active INTEGER NOT NULL DEFAULT 1,
        is_admin INTEGER NOT NULL DEFAULT 0,
        pen_message INTEGER NOT NULL DEFAULT 0,
        pen_nick INTEGER NOT NULL DEFAULT 0,
        pen_part INTEGER NOT NULL DEFAULT 0,
        pen_kick INTEGER NOT NULL DEFAULT 0,
        pen_quit INTEGER NOT NULL DEFAULT 0,
        pen_quest INTEGER NOT NULL DEFAULT 0,
        pen_logout INTEGER NOT NULL DEFAULT 0,
        item_ring TEXT NOT NULL DEFAULT '0',
        item_amulet TEXT NOT NULL DEFAULT '0',
        item_charm TEXT NOT NULL DEFAULT '0',
        item_weapon TEXT NOT NULL DEFAULT '0',
        item_helm TEXT NOT NULL DEFAULT '0',
        item_tunic TEXT NOT NULL DEFAULT '0',
        item_gloves TEXT NOT NULL DEFAULT '0',
        item_leggings TEXT NOT NULL DEFAULT '0',
        item_shield TEXT NOT NULL DEFAULT '0',
        item_boots TEXT NOT NULL DEFAULT '0',
        PRIMARY KEY (channel_id, user_id),
        UNIQUE (channel_id, name),
        FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS players_channel_level ON players(channel_id, level DESC, next_level ASC);
    `);
    const columns = new Set(this.db.prepare('PRAGMA table_info(players)').all().map((column) => column.name));
    if (!columns.has('active')) this.db.exec('ALTER TABLE players ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
  }

  prepare() {
    this.getChannelStmt = this.db.prepare('SELECT * FROM channels WHERE channel_id = ?');
    this.insertChannelStmt = this.db.prepare(`
      INSERT OR IGNORE INTO channels (channel_id, last_tick, quest_time) VALUES (?, ?, ?)
    `);
    this.saveChannelStmt = this.db.prepare(`
      UPDATE channels SET last_tick=@last_tick, report_seconds=@report_seconds,
        paused=@paused, silent_mode=@silent_mode, quest_time=@quest_time,
        quest_type=@quest_type, quest_stage=@quest_stage, quest_text=@quest_text,
        quest_p1_x=@quest_p1_x, quest_p1_y=@quest_p1_y,
        quest_p2_x=@quest_p2_x, quest_p2_y=@quest_p2_y, questers=@questers
      WHERE channel_id=@channel_id
    `);
    this.getPlayersStmt = this.db.prepare('SELECT * FROM players WHERE channel_id = ?');
    this.getPlayerByUserStmt = this.db.prepare('SELECT * FROM players WHERE channel_id = ? AND user_id = ?');
    this.insertPlayerStmt = this.db.prepare(`
      INSERT INTO players (channel_id, user_id, name, class, next_level, created,
        last_login, x, y, is_admin) VALUES
        (@channel_id, @user_id, @name, @class, @next_level, @created,
         @last_login, @x, @y, @is_admin)
    `);
    const mutable = [
      'name', 'class', 'level', 'next_level', 'idled', 'last_login', 'x', 'y',
      'alignment', 'active', 'is_admin', 'pen_message', 'pen_nick', 'pen_part', 'pen_kick',
      'pen_quit', 'pen_quest', 'pen_logout', ...Object.values(ITEM_COLUMNS),
    ];
    this.savePlayerStmt = this.db.prepare(`UPDATE players SET ${mutable.map((key) => `${key}=@${key}`).join(', ')} WHERE channel_id=@channel_id AND user_id=@user_id`);
    this.deletePlayerStmt = this.db.prepare('DELETE FROM players WHERE channel_id = ? AND user_id = ?');
    this.getGuildLocaleStmt = this.db.prepare('SELECT locale FROM guild_settings WHERE guild_id = ?');
    this.setGuildLocaleStmt = this.db.prepare(`
      INSERT INTO guild_settings (guild_id, locale) VALUES (?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET locale=excluded.locale
    `);
  }

  ensureChannel(channelId) {
    const timestamp = now();
    this.insertChannelStmt.run(channelId, timestamp, timestamp + Math.floor(Math.random() * 21600));
    return this.getChannelStmt.get(channelId);
  }

  getPlayers(channelId) {
    return this.getPlayersStmt.all(channelId).map((row) => {
      row.items = Object.fromEntries(ITEMS.map((item) => [item, row[ITEM_COLUMNS[item]]]));
      return row;
    });
  }

  getPlayer(channelId, userId) {
    const row = this.getPlayerByUserStmt.get(channelId, userId);
    if (!row) return undefined;
    row.items = Object.fromEntries(ITEMS.map((item) => [item, row[ITEM_COLUMNS[item]]]));
    return row;
  }

  insertPlayer(player) {
    this.insertPlayerStmt.run(player);
  }

  savePlayer(player) {
    const row = { ...player };
    for (const item of ITEMS) row[ITEM_COLUMNS[item]] = String(player.items[item]);
    this.savePlayerStmt.run(row);
  }

  deletePlayer(channelId, userId) {
    this.deletePlayerStmt.run(channelId, userId);
  }

  getGuildLocale(guildId) {
    return this.getGuildLocaleStmt.get(String(guildId))?.locale;
  }

  setGuildLocale(guildId, locale) {
    this.setGuildLocaleStmt.run(String(guildId), locale);
  }

  saveGame(channel, players) {
    const transaction = this.db.transaction(() => {
      this.saveChannelStmt.run(channel);
      for (const player of players) this.savePlayer(player);
    });
    transaction();
  }

  close() {
    this.db.close();
  }
}
