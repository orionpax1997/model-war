var myIndex = -1;
var initialized = false;
var mainBaseId = -1;
var closestResourceId = -1;

function loop() {
  if (!initialized) {
    myIndex = getMyIndex();
    initialized = true;
    
    const myBases = getObjectsByType("site", { owner: myIndex, kind: "base" });
    if (myBases.length > 0 && myBases[0] !== undefined) {
      mainBaseId = myBases[0].id;
    }
    
    const myResources = getObjectsByType("site", { owner: myIndex, kind: "resource" });
    if (myResources.length > 0 && myResources[0] !== undefined) {
      closestResourceId = myResources[0].id;
    }
  }

  const tick = getTick();
  const players = getObjectsByType("player");
  const myPlayer = players[myIndex];
  
  if (myPlayer === undefined || !myPlayer.alive) {
    return;
  }

  manageBases(myPlayer);
  manageUnits();
}

function manageBases(myPlayer: { resources: number; alive: boolean; exceptionTicks: number }) {
  const myBases = getObjectsByType("site", { owner: myIndex, kind: "base" });
  
  for (let i = 0; i < myBases.length; i += 1) {
    const base = myBases[i];
    if (base === undefined || base.producing !== null) {
      continue;
    }
    
    const workers = getObjectsByType("unit", { owner: myIndex, type: "worker" });
    const melees = getObjectsByType("unit", { owner: myIndex, type: "melee" });
    
    if (workers.length < 3 && myPlayer.resources >= 4) {
      spawnUnit(base.id, "worker");
    } else if (myPlayer.resources >= 8) {
      spawnUnit(base.id, "melee");
    }
  }
}

function manageUnits() {
  const myUnits = getObjectsByType("unit", { owner: myIndex });
  
  for (let i = 0; i < myUnits.length; i += 1) {
    const unit = myUnits[i];
    if (unit === undefined) {
      continue;
    }
    
    if (unit.type === "worker") {
      manageWorker(unit);
    } else {
      manageCombatUnit(unit);
    }
  }
}

function manageWorker(worker: { id: number; x: number; y: number; carrying: number }) {
  if (worker.carrying >= 20) {
    const myBases = getObjectsByType("site", { owner: myIndex, kind: "base" });
    let nearestBase = null;
    let nearestDist = 0;
    
    for (let i = 0; i < myBases.length; i += 1) {
      const base = myBases[i];
      if (base === undefined) {
        continue;
      }
      const dist = getRange(worker.x, worker.y, base.x, base.y);
      if (nearestBase === null || dist < nearestDist) {
        nearestBase = base;
        nearestDist = dist;
      }
    }
    
    if (nearestBase !== null) {
      if (nearestDist <= 1) {
        transfer(worker.id);
      } else {
        moveTo(worker.id, nearestBase.x, nearestBase.y);
      }
    }
    return;
  }
  
  const myResources = getObjectsByType("site", { owner: myIndex, kind: "resource" });
  let targetResource = null;
  let minDist = 0;
  
  for (let i = 0; i < myResources.length; i += 1) {
    const res = myResources[i];
    if (res === undefined || res.remaining === undefined || res.remaining <= 0) {
      continue;
    }
    const dist = getRange(worker.x, worker.y, res.x, res.y);
    if (targetResource === null || dist < minDist) {
      targetResource = res;
      minDist = dist;
    }
  }
  
  if (targetResource === null) {
    const neutralResources = getObjectsByType("site", { owner: -1, kind: "resource" });
    for (let i = 0; i < neutralResources.length; i += 1) {
      const res = neutralResources[i];
      if (res === undefined) {
        continue;
      }
      const dist = getRange(worker.x, worker.y, res.x, res.y);
      if (targetResource === null || dist < minDist) {
        targetResource = res;
        minDist = dist;
      }
    }
  }
  
  if (targetResource !== null) {
    if (minDist <= 1 && targetResource.owner === myIndex) {
      harvest(worker.id, targetResource.id);
    } else {
      moveTo(worker.id, targetResource.x, targetResource.y);
    }
  }
}

function manageCombatUnit(unit: { id: number; x: number; y: number; type: string }) {
  const enemies = getObjectsByType("unit");
  let nearestEnemy = null;
  let nearestDist = 0;
  
  for (let i = 0; i < enemies.length; i += 1) {
    const enemy = enemies[i];
    if (enemy === undefined || enemy.owner === myIndex) {
      continue;
    }
    const dist = getRange(unit.x, unit.y, enemy.x, enemy.y);
    if (nearestEnemy === null || dist < nearestDist) {
      nearestEnemy = enemy;
      nearestDist = dist;
    }
  }
  
  if (nearestEnemy !== null) {
    const attackRange = 1;
    if (nearestDist <= attackRange) {
      attack(unit.id, nearestEnemy.id);
    } else {
      moveTo(unit.id, nearestEnemy.x, nearestEnemy.y);
    }
    return;
  }
  
  const neutralSites = getObjectsByType("site", { owner: -1 });
  let targetSite = null;
  let targetDist = 0;
  
  for (let i = 0; i < neutralSites.length; i += 1) {
    const site = neutralSites[i];
    if (site === undefined) {
      continue;
    }
    const dist = getRange(unit.x, unit.y, site.x, site.y);
    if (targetSite === null || dist < targetDist) {
      targetSite = site;
      targetDist = dist;
    }
  }
  
  if (targetSite !== null) {
    moveTo(unit.id, targetSite.x, targetSite.y);
    return;
  }
  
  const enemySites = getObjectsByType("site");
  for (let i = 0; i < enemySites.length; i += 1) {
    const site = enemySites[i];
    if (site === undefined || site.owner === myIndex || site.owner === -1) {
      continue;
    }
    if (targetSite === null) {
      targetSite = site;
      targetDist = getRange(unit.x, unit.y, site.x, site.y);
    } else {
      const dist = getRange(unit.x, unit.y, site.x, site.y);
      if (dist < targetDist) {
        targetSite = site;
        targetDist = dist;
      }
    }
  }
  
  if (targetSite !== null) {
    moveTo(unit.id, targetSite.x, targetSite.y);
  }
}
