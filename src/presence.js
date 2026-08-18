export class PresenceTracker {
  constructor({
    games, channels, enabled, graceSeconds, logger,
    startupRetries = 2, startupRetryMilliseconds = 5000,
  }) {
    this.games = games;
    this.channels = channels;
    this.enabled = enabled;
    this.graceMilliseconds = graceSeconds * 1000;
    this.logger = logger ?? { info() {}, warn() {}, error() {} };
    this.pendingOffline = new Map();
    this.startupRetryTimers = new Map();
    this.statuses = new Map();
    this.startupRetries = startupRetries;
    this.startupRetryMilliseconds = startupRetryMilliseconds;
  }

  key(guildId, userId) {
    return `${guildId}:${userId}`;
  }

  gamesForGuild(guildId) {
    return [...this.games.entries()]
      .filter(([channelId]) => this.channels.get(channelId)?.guild.id === guildId)
      .map(([, game]) => game);
  }

  hasActivePlayer(guildId, userId) {
    return this.gamesForGuild(guildId).some((game) => game.playerForUser(userId)?.active);
  }

  playerSummary(guildId, userId) {
    const players = this.gamesForGuild(guildId)
      .map((game) => ({ channelId: game.channelId, player: game.playerForUser(userId) }))
      .filter(({ player }) => player)
      .map(({ channelId, player }) => ({ channelId, character: player.name, active: Boolean(player.active) }));
    return { gameCount: players.length, players };
  }

  async initializeGuild(guild, retriesRemaining = this.startupRetries) {
    if (!this.enabled) return { registeredUsers: 0, unknownUsers: 0 };
    const userIds = new Set();
    for (const game of this.gamesForGuild(guild.id)) {
      // Reconcile every persisted character, including characters that were
      // saved as inactive before the bot restarted. Otherwise an already-online
      // Discord user would remain inactive until their next presence change.
      for (const player of game.players.values()) userIds.add(player.user_id);
    }
    const members = new Map();
    const unknownUsers = new Set();
    const ids = [...userIds];
    for (let offset = 0; offset < ids.length; offset += 100) {
      const batch = ids.slice(offset, offset + 100);
      try {
        // A Guild Create presence cache can be incomplete at ClientReady.
        // Requesting the registered members with presences gives startup
        // reconciliation an authoritative snapshot instead of treating a
        // cache miss as offline.
        const fetched = await guild.members.fetch({
          user: batch,
          withPresences: true,
          time: 30_000,
        });
        if (fetched?.id) members.set(fetched.id, fetched);
        else for (const [userId, member] of fetched) members.set(userId, member);
      } catch (error) {
        for (const userId of batch) unknownUsers.add(userId);
        this.logger.warn('Could not fetch player presences during startup reconciliation.', {
          guildId: guild.id,
          requestedUsers: batch.length,
          retriesRemaining,
          error,
        });
      }
    }

    let onlineUsers = 0;
    let offlineUsers = 0;
    let missingMembers = 0;
    for (const userId of userIds) {
      if (unknownUsers.has(userId)) continue;
      const member = members.get(userId);
      if (!member) {
        missingMembers += 1;
        this.memberRemove(guild.id, userId);
        continue;
      }
      const status = member.presence?.status
        ?? guild.presences.cache.get(userId)?.status
        ?? 'offline';
      if (status === 'offline') offlineUsers += 1;
      else onlineUsers += 1;
      this.update(guild.id, userId, status);
    }
    this.logger.info('Initial player presence reconciliation completed.', {
      guildId: guild.id,
      registeredUsers: userIds.size,
      onlineUsers,
      offlineUsers,
      missingMembers,
      unknownUsers: unknownUsers.size,
    });

    if (unknownUsers.size && retriesRemaining > 0 && !this.startupRetryTimers.has(guild.id)) {
      this.logger.info('Startup presence reconciliation retry scheduled.', {
        guildId: guild.id,
        unknownUsers: unknownUsers.size,
        retryInSeconds: this.startupRetryMilliseconds / 1000,
        retriesRemaining,
      });
      const timer = setTimeout(() => {
        this.startupRetryTimers.delete(guild.id);
        this.initializeGuild(guild, retriesRemaining - 1).catch((error) => {
          this.logger.error('Startup presence reconciliation retry failed.', { guildId: guild.id, error });
        });
      }, this.startupRetryMilliseconds);
      timer.unref();
      this.startupRetryTimers.set(guild.id, timer);
    }
    return { registeredUsers: userIds.size, unknownUsers: unknownUsers.size };
  }

  update(guildId, userId, status) {
    if (!this.enabled) return;
    const key = this.key(guildId, userId);
    const previousStatus = this.statuses.get(key);
    this.statuses.set(key, status);
    if (status === 'offline') {
      this.scheduleOffline(guildId, userId);
    } else {
      const graceCancelled = this.cancelOffline(guildId, userId);
      const inactiveBefore = this.gamesForGuild(guildId)
        .filter((game) => {
          const player = game.playerForUser(userId);
          return player && !player.active;
        }).length;
      for (const game of this.gamesForGuild(guildId)) game.setActive(userId, true);
      if (previousStatus !== status && this.playerSummary(guildId, userId).gameCount) {
        const message = graceCancelled
          ? 'Player came back online during the grace period; offline penalty cancelled.'
          : inactiveBefore
            ? 'Player came online; character reactivated automatically.'
            : 'Player presence is online.';
        this.logger.info(
          message,
          { guildId, userId, status, reactivatedGames: inactiveBefore, ...this.playerSummary(guildId, userId) },
        );
      }
    }
  }

  scheduleOffline(guildId, userId) {
    const key = this.key(guildId, userId);
    if (this.pendingOffline.has(key) || !this.hasActivePlayer(guildId, userId)) return;
    this.logger.info('Player went offline; grace period started.', {
      guildId,
      userId,
      graceSeconds: this.graceMilliseconds / 1000,
      ...this.playerSummary(guildId, userId),
    });
    const timer = setTimeout(() => {
      this.pendingOffline.delete(key);
      if (this.statuses.get(key) !== 'offline') return;
      const affected = this.gamesForGuild(guildId).filter((game) => game.playerForUser(userId)?.active).length;
      this.logger.info('Offline grace period ended; applying the quit penalty.', {
        guildId,
        userId,
        affectedGames: affected,
        ...this.playerSummary(guildId, userId),
      });
      for (const game of this.gamesForGuild(guildId)) game.setActive(userId, false, 'quit');
    }, this.graceMilliseconds);
    timer.unref();
    this.pendingOffline.set(key, timer);
  }

  cancelOffline(guildId, userId) {
    const key = this.key(guildId, userId);
    const timer = this.pendingOffline.get(key);
    if (timer) clearTimeout(timer);
    this.pendingOffline.delete(key);
    return Boolean(timer);
  }

  memberRemove(guildId, userId) {
    const summary = this.playerSummary(guildId, userId);
    const affectedGames = summary.players.filter((player) => player.active).length;
    this.cancelOffline(guildId, userId);
    this.statuses.delete(this.key(guildId, userId));
    if (summary.gameCount) {
      this.logger.info(
        affectedGames
          ? 'Player left the server; applying the quit penalty immediately.'
          : 'Player left the server while already inactive; no additional quit penalty applied.', {
        guildId,
        userId,
        affectedGames,
        ...summary,
        },
      );
    }
    for (const game of this.gamesForGuild(guildId)) game.setActive(userId, false, 'quit');
  }

  memberAdd(guildId, userId) {
    const inactiveBefore = this.gamesForGuild(guildId)
      .filter((game) => {
        const player = game.playerForUser(userId);
        return player && !player.active;
      }).length;
    for (const game of this.gamesForGuild(guildId)) game.setActive(userId, true);
    const summary = this.playerSummary(guildId, userId);
    if (summary.gameCount) {
      this.logger.info('Player rejoined the server; character reactivated automatically.', {
        guildId,
        userId,
        reactivatedGames: inactiveBefore,
        ...summary,
      });
    }
  }

  clear() {
    for (const timer of this.pendingOffline.values()) clearTimeout(timer);
    for (const timer of this.startupRetryTimers.values()) clearTimeout(timer);
    this.pendingOffline.clear();
    this.startupRetryTimers.clear();
    this.statuses.clear();
  }
}
