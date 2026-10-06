"use strict";
(() => {
  // packages/engine/src/sandbox-runtime/index.ts
  var guest = globalThis;
  var snapshot = null;
  var pending = [];
  var apiCalls = 0;
  guest["__setSnapshot"] = (next) => {
    snapshot = next;
    pending = [];
    apiCalls = 0;
  };
  guest["__drainIntents"] = () => {
    const drained = pending;
    pending = [];
    return { intents: drained, apiCalls };
  };
  guest.getTick = () => {
    apiCalls += 1;
    return snapshot === null ? -1 : snapshot.tick;
  };
  guest.getObjectsByType = (kind, filter) => {
    apiCalls += 1;
    if (snapshot === null) {
      return [];
    }
    if (kind === "unit") {
      return snapshot.units.filter(
        (unit) => (filter?.owner === void 0 || unit.owner === filter.owner) && (filter?.type === void 0 || unit.type === filter.type)
      );
    }
    if (kind === "site") {
      return snapshot.sites.filter(
        (site) => (filter?.owner === void 0 || site.owner === filter.owner) && (filter?.kind === void 0 || site.kind === filter.kind)
      );
    }
    if (kind === "player") {
      return snapshot.players.filter(
        (player) => filter?.owner === void 0 || player.index === filter.owner
      );
    }
    return [];
  };
  guest.move = (unitId, dx, dy) => {
    apiCalls += 1;
    pending = [...pending, { kind: "move", unitId, dx, dy }];
  };
})();
