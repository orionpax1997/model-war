"use strict";
var MY = -1;
function myAbs(n) {
    if (n < 0) {
        return 0 - n;
    }
    return n;
}
function myCheb(ax, ay, bx, by) {
    var dx = ax - bx;
    if (dx < 0) {
        dx = 0 - dx;
    }
    var dy = ay - by;
    if (dy < 0) {
        dy = 0 - dy;
    }
    if (dx > dy) {
        return dx;
    }
    return dy;
}
function isPlainAt(x, y) {
    var t = getTerrainAt(x, y);
    if (t === "plain") {
        return true;
    }
    return false;
}
function loop() {
    var me = MY;
    if (me === -1) {
        me = getMyIndex();
        MY = me;
    }
    var tick = getTick();
    var players = getObjectsByType("player");
    var myRes = 0;
    var pi = 0;
    for (pi = 0; pi < players.length; pi += 1) {
        var pl = players[pi];
        if (pl === undefined) {
            continue;
        }
        if (pl.index === me) {
            myRes = pl.resources;
            break;
        }
    }
    var units = getObjectsByType("unit");
    var sites = getObjectsByType("site");
    var workerN = 0;
    var meleeN = 0;
    var rangedN = 0;
    var myBaseN = 0;
    var ui = 0;
    for (ui = 0; ui < units.length; ui += 1) {
        var cu = units[ui];
        if (cu === undefined) {
            continue;
        }
        if (cu.owner !== me) {
            continue;
        }
        if (cu.type === "worker") {
            workerN += 1;
        }
        else {
            if (cu.type === "melee") {
                meleeN += 1;
            }
            else {
                if (cu.type === "ranged") {
                    rangedN += 1;
                }
            }
        }
    }
    var sj = 0;
    for (sj = 0; sj < sites.length; sj += 1) {
        var cs = sites[sj];
        if (cs === undefined) {
            continue;
        }
        if (cs.owner === me) {
            if (cs.kind === "base") {
                myBaseN += 1;
            }
        }
    }
    var wantW = 3 + myBaseN * 2;
    if (wantW > 10) {
        wantW = 10;
    }
    if (tick < 40) {
        if (wantW > 3) {
            wantW = 3;
        }
    }
    var pW = workerN;
    var pM = meleeN;
    var pR = rangedN;
    var bi = 0;
    for (bi = 0; bi < sites.length; bi += 1) {
        var b = sites[bi];
        if (b === undefined) {
            continue;
        }
        if (b.kind !== "base") {
            continue;
        }
        if (b.owner !== me) {
            continue;
        }
        if (b.producing !== null) {
            continue;
        }
        var pick = 1;
        if (pW < 2) {
            pick = 0;
        }
        else {
            if (tick < 50) {
                if (pM < 2) {
                    pick = 1;
                }
                else {
                    if (pW < wantW) {
                        pick = 0;
                    }
                    else {
                        pick = 1;
                    }
                }
            }
            else {
                if (pW < wantW) {
                    pick = 0;
                }
                else {
                    if ((pM + pR) % 4 === 3) {
                        pick = 2;
                    }
                    else {
                        pick = 1;
                    }
                }
            }
        }
        var cost = 8;
        if (pick === 0) {
            cost = 4;
        }
        else {
            if (pick === 2) {
                cost = 12;
            }
            else {
                cost = 8;
            }
        }
        if (myRes < cost) {
            if (pick !== 0) {
                if (myRes >= 4) {
                    if (pW < 10) {
                        pick = 0;
                        cost = 4;
                    }
                    else {
                        continue;
                    }
                }
                else {
                    continue;
                }
            }
            else {
                continue;
            }
        }
        if (pick === 0) {
            var r0 = spawnUnit(b.id, "worker");
            if (isError(r0)) {
                continue;
            }
            else {
                myRes = myRes - cost;
                pW += 1;
            }
        }
        else {
            if (pick === 2) {
                if (myRes < 12) {
                    var rf = spawnUnit(b.id, "melee");
                    if (isError(rf)) {
                        continue;
                    }
                    else {
                        myRes = myRes - 8;
                        pM += 1;
                    }
                }
                else {
                    var r2 = spawnUnit(b.id, "ranged");
                    if (isError(r2)) {
                        continue;
                    }
                    else {
                        myRes = myRes - cost;
                        pR += 1;
                    }
                }
            }
            else {
                var r1 = spawnUnit(b.id, "melee");
                if (isError(r1)) {
                    continue;
                }
                else {
                    myRes = myRes - cost;
                    pM += 1;
                }
            }
        }
    }
    var wi = 0;
    for (wi = 0; wi < units.length; wi += 1) {
        var w = units[wi];
        if (w === undefined) {
            continue;
        }
        if (w.owner !== me) {
            continue;
        }
        if (w.type !== "worker") {
            continue;
        }
        var onBase = false;
        var ob = 0;
        for (ob = 0; ob < sites.length; ob += 1) {
            var os = sites[ob];
            if (os === undefined) {
                continue;
            }
            if (os.kind !== "base") {
                continue;
            }
            if (os.owner !== me) {
                continue;
            }
            if (w.x === os.x) {
                if (w.y === os.y) {
                    onBase = true;
                    break;
                }
            }
        }
        if (onBase) {
            if (isPlainAt(w.x - 1, w.y - 1)) {
                move(w.id, -1, -1);
                continue;
            }
            if (isPlainAt(w.x, w.y - 1)) {
                move(w.id, 0, -1);
                continue;
            }
            if (isPlainAt(w.x + 1, w.y - 1)) {
                move(w.id, 1, -1);
                continue;
            }
            if (isPlainAt(w.x - 1, w.y)) {
                move(w.id, -1, 0);
                continue;
            }
            if (isPlainAt(w.x + 1, w.y)) {
                move(w.id, 1, 0);
                continue;
            }
            if (isPlainAt(w.x - 1, w.y + 1)) {
                move(w.id, -1, 1);
                continue;
            }
            if (isPlainAt(w.x, w.y + 1)) {
                move(w.id, 0, 1);
                continue;
            }
            if (isPlainAt(w.x + 1, w.y + 1)) {
                move(w.id, 1, 1);
                continue;
            }
        }
        var nbid = -1;
        var nbx = 0;
        var nby = 0;
        var nbd = 1000000;
        var nb2 = 0;
        for (nb2 = 0; nb2 < sites.length; nb2 += 1) {
            var ns = sites[nb2];
            if (ns === undefined) {
                continue;
            }
            if (ns.owner !== me) {
                continue;
            }
            if (ns.kind !== "base") {
                continue;
            }
            var db0 = myCheb(w.x, w.y, ns.x, ns.y);
            if (db0 < nbd) {
                nbd = db0;
                nbid = ns.id;
                nbx = ns.x;
                nby = ns.y;
            }
        }
        var foeD = 1000000;
        var fi = 0;
        for (fi = 0; fi < units.length; fi += 1) {
            var fu = units[fi];
            if (fu === undefined) {
                continue;
            }
            if (fu.owner === me) {
                continue;
            }
            var df0 = myCheb(w.x, w.y, fu.x, fu.y);
            if (df0 < foeD) {
                foeD = df0;
            }
        }
        if (w.carrying >= 20) {
            if (nbid === -1) {
                continue;
            }
            if (nbd <= 1) {
                transfer(w.id);
            }
            else {
                var sx = nbx;
                var syy = nby;
                var best = 1000000;
                var found = false;
                var ox = -1;
                for (ox = -1; ox <= 1; ox += 1) {
                    var oy = -1;
                    for (oy = -1; oy <= 1; oy += 1) {
                        if (ox === 0) {
                            if (oy === 0) {
                                continue;
                            }
                        }
                        var tx0 = nbx + ox;
                        var ty0 = nby + oy;
                        if (!isPlainAt(tx0, ty0)) {
                            continue;
                        }
                        var dd0 = myCheb(w.x, w.y, tx0, ty0);
                        if (dd0 < best) {
                            best = dd0;
                            sx = tx0;
                            syy = ty0;
                            found = true;
                        }
                    }
                }
                if (found) {
                    if (w.x === sx) {
                        if (w.y === syy) {
                            transfer(w.id);
                        }
                        else {
                            moveTo(w.id, sx, syy);
                        }
                    }
                    else {
                        moveTo(w.id, sx, syy);
                    }
                }
                else {
                    moveTo(w.id, nbx, nby);
                }
            }
            continue;
        }
        if (foeD <= 2) {
            if (nbid !== -1) {
                if (nbd <= 1) {
                    if (w.carrying > 0) {
                        transfer(w.id);
                    }
                    else {
                        continue;
                    }
                }
                else {
                    var fx = nbx;
                    var fy = nby;
                    var fb = 1000000;
                    var ff = false;
                    var fxo = -1;
                    for (fxo = -1; fxo <= 1; fxo += 1) {
                        var fyo = -1;
                        for (fyo = -1; fyo <= 1; fyo += 1) {
                            if (fxo === 0) {
                                if (fyo === 0) {
                                    continue;
                                }
                            }
                            var ftx = nbx + fxo;
                            var fty = nby + fyo;
                            if (!isPlainAt(ftx, fty)) {
                                continue;
                            }
                            var fdd = myCheb(w.x, w.y, ftx, fty);
                            if (fdd < fb) {
                                fb = fdd;
                                fx = ftx;
                                fy = fty;
                                ff = true;
                            }
                        }
                    }
                    if (ff) {
                        moveTo(w.id, fx, fy);
                    }
                    else {
                        moveTo(w.id, nbx, nby);
                    }
                }
            }
            else {
                var esc = -1;
                var escx = 0;
                var escy = 0;
                var escd = 1000000;
                var eq = 0;
                for (eq = 0; eq < sites.length; eq += 1) {
                    var qs = sites[eq];
                    if (qs === undefined) {
                        continue;
                    }
                    if (qs.owner === me) {
                        continue;
                    }
                    var dq = myCheb(w.x, w.y, qs.x, qs.y);
                    if (dq < escd) {
                        escd = dq;
                        esc = qs.id;
                        escx = qs.x;
                        escy = qs.y;
                    }
                }
                if (esc !== -1) {
                    if (w.x === escx) {
                        if (w.y === escy) {
                            continue;
                        }
                    }
                    moveTo(w.id, escx, escy);
                }
            }
            continue;
        }
        var adjId = -1;
        var adjD = 1000000;
        var ak = 0;
        for (ak = 0; ak < sites.length; ak += 1) {
            var aset = sites[ak];
            if (aset === undefined) {
                continue;
            }
            if (aset.kind !== "resource") {
                continue;
            }
            if (aset.owner !== me) {
                continue;
            }
            if (aset.remaining !== undefined) {
                if (aset.remaining <= 0) {
                    continue;
                }
            }
            var da = myCheb(w.x, w.y, aset.x, aset.y);
            if (da <= 1) {
                if (da < adjD) {
                    adjD = da;
                    adjId = aset.id;
                }
            }
        }
        if (adjId !== -1) {
            harvest(w.id, adjId);
            continue;
        }
        var tgtId = -1;
        var tgtX = 0;
        var tgtY = 0;
        var tgtD = 1000000;
        var tk = 0;
        for (tk = 0; tk < sites.length; tk += 1) {
            var tset = sites[tk];
            if (tset === undefined) {
                continue;
            }
            if (tset.kind !== "resource") {
                continue;
            }
            if (tset.owner !== me) {
                continue;
            }
            if (tset.remaining !== undefined) {
                if (tset.remaining <= 0) {
                    continue;
                }
            }
            var dt2 = myCheb(w.x, w.y, tset.x, tset.y);
            if (dt2 < tgtD) {
                tgtD = dt2;
                tgtId = tset.id;
                tgtX = tset.x;
                tgtY = tset.y;
            }
        }
        if (tgtId === -1) {
            if (w.carrying > 0) {
                if (nbid !== -1) {
                    if (nbd <= 1) {
                        transfer(w.id);
                    }
                    else {
                        moveTo(w.id, nbx, nby);
                    }
                }
                else {
                    var ec2 = -1;
                    var ec2x = 0;
                    var ec2y = 0;
                    var ec2d = 1000000;
                    var eg = 0;
                    for (eg = 0; eg < sites.length; eg += 1) {
                        var gs2 = sites[eg];
                        if (gs2 === undefined) {
                            continue;
                        }
                        if (gs2.owner === me) {
                            continue;
                        }
                        var dg2 = myCheb(w.x, w.y, gs2.x, gs2.y);
                        if (dg2 < ec2d) {
                            ec2d = dg2;
                            ec2 = gs2.id;
                            ec2x = gs2.x;
                            ec2y = gs2.y;
                        }
                    }
                    if (ec2 !== -1) {
                        if (w.x === ec2x) {
                            if (w.y === ec2y) {
                                continue;
                            }
                        }
                        moveTo(w.id, ec2x, ec2y);
                    }
                }
            }
            else {
                var ec3 = -1;
                var ec3x = 0;
                var ec3y = 0;
                var ec3d = 1000000;
                var eg3 = 0;
                for (eg3 = 0; eg3 < sites.length; eg3 += 1) {
                    var gs3 = sites[eg3];
                    if (gs3 === undefined) {
                        continue;
                    }
                    if (gs3.owner === me) {
                        continue;
                    }
                    var dg3 = myCheb(w.x, w.y, gs3.x, gs3.y);
                    if (dg3 < ec3d) {
                        ec3d = dg3;
                        ec3 = gs3.id;
                        ec3x = gs3.x;
                        ec3y = gs3.y;
                    }
                }
                if (ec3 !== -1) {
                    if (w.x === ec3x) {
                        if (w.y === ec3y) {
                            continue;
                        }
                    }
                    moveTo(w.id, ec3x, ec3y);
                }
            }
            continue;
        }
        var stx = tgtX;
        var sty = tgtY;
        var sbest = 1000000;
        var sfd = false;
        var sox = -1;
        for (sox = -1; sox <= 1; sox += 1) {
            var soy = -1;
            for (soy = -1; soy <= 1; soy += 1) {
                if (sox === 0) {
                    if (soy === 0) {
                        continue;
                    }
                }
                var stx0 = tgtX + sox;
                var sty0 = tgtY + soy;
                if (!isPlainAt(stx0, sty0)) {
                    continue;
                }
                var sdd = myCheb(w.x, w.y, stx0, sty0);
                if (sdd < sbest) {
                    sbest = sdd;
                    stx = stx0;
                    sty = sty0;
                    sfd = true;
                }
            }
        }
        if (sfd) {
            if (w.x === stx) {
                if (w.y === sty) {
                    harvest(w.id, tgtId);
                }
                else {
                    moveTo(w.id, stx, sty);
                }
            }
            else {
                moveTo(w.id, stx, sty);
            }
        }
        else {
            if (tgtD <= 1) {
                harvest(w.id, tgtId);
            }
            else {
                moveTo(w.id, tgtX, tgtY);
            }
        }
    }
    var combIds = [];
    var combX = [];
    var combY = [];
    var combT = [];
    var ci = 0;
    for (ci = 0; ci < units.length; ci += 1) {
        var cu2 = units[ci];
        if (cu2 === undefined) {
            continue;
        }
        if (cu2.owner !== me) {
            continue;
        }
        if (cu2.type === "worker") {
            continue;
        }
        combIds.push(cu2.id);
        combX.push(cu2.x);
        combY.push(cu2.y);
        if (cu2.type === "ranged") {
            combT.push(2);
        }
        else {
            combT.push(1);
        }
    }
    var cn = combIds.length;
    var si2 = 0;
    for (si2 = 1; si2 < cn; si2 += 1) {
        var keyI = combIds[si2];
        if (keyI === undefined) {
            continue;
        }
        var keyX = combX[si2];
        if (keyX === undefined) {
            continue;
        }
        var keyY = combY[si2];
        if (keyY === undefined) {
            continue;
        }
        var keyT = combT[si2];
        if (keyT === undefined) {
            continue;
        }
        var jj = si2 - 1;
        while (jj >= 0) {
            var jv = combIds[jj];
            if (jv === undefined) {
                break;
            }
            if (jv <= keyI) {
                break;
            }
            var jx = combX[jj];
            var jy = combY[jj];
            var jt = combT[jj];
            if (jx === undefined) {
                break;
            }
            if (jy === undefined) {
                break;
            }
            if (jt === undefined) {
                break;
            }
            combIds[jj + 1] = jv;
            combX[jj + 1] = jx;
            combY[jj + 1] = jy;
            combT[jj + 1] = jt;
            combIds[jj] = keyI;
            combX[jj] = keyX;
            combY[jj] = keyY;
            combT[jj] = keyT;
            jj -= 1;
        }
    }
    var taken = [];
    var cc = 0;
    for (cc = 0; cc < cn; cc += 1) {
        var cid = combIds[cc];
        if (cid === undefined) {
            continue;
        }
        var cx = combX[cc];
        if (cx === undefined) {
            continue;
        }
        var cyy = combY[cc];
        if (cyy === undefined) {
            continue;
        }
        var atkR = combT[cc];
        if (atkR === undefined) {
            continue;
        }
        var bestF = -1;
        var bestFX = 0;
        var bestFY = 0;
        var bestFD = 1000000;
        var fk = 0;
        for (fk = 0; fk < units.length; fk += 1) {
            var fe = units[fk];
            if (fe === undefined) {
                continue;
            }
            if (fe.owner === me) {
                continue;
            }
            var dfe = myCheb(cx, cyy, fe.x, fe.y);
            if (dfe < bestFD) {
                bestFD = dfe;
                bestF = fe.id;
                bestFX = fe.x;
                bestFY = fe.y;
                if (bestFD <= atkR) {
                    break;
                }
            }
        }
        if (bestF !== -1) {
            if (bestFD <= atkR) {
                attack(cid, bestF);
                continue;
            }
        }
        var capId = -1;
        var capX = 0;
        var capY = 0;
        var capBest = 1000000;
        var gk = 0;
        for (gk = 0; gk < sites.length; gk += 1) {
            var gsite = sites[gk];
            if (gsite === undefined) {
                continue;
            }
            if (gsite.owner === me) {
                continue;
            }
            var already = false;
            var tk2 = 0;
            for (tk2 = 0; tk2 < taken.length; tk2 += 1) {
                if (taken[tk2] === gsite.id) {
                    already = true;
                    break;
                }
            }
            if (already) {
                continue;
            }
            var dg0 = myCheb(cx, cyy, gsite.x, gsite.y);
            var adj0 = dg0;
            if (gsite.kind === "base") {
                adj0 = dg0 - 2;
                if (adj0 < 0) {
                    adj0 = 0;
                }
            }
            if (adj0 < capBest) {
                capBest = adj0;
                capId = gsite.id;
                capX = gsite.x;
                capY = gsite.y;
            }
            else {
                if (adj0 === capBest) {
                    if (gsite.id < capId) {
                        capId = gsite.id;
                        capX = gsite.x;
                        capY = gsite.y;
                    }
                }
            }
        }
        var wantCap = true;
        if (bestF !== -1) {
            if (bestFD <= 6) {
                wantCap = false;
                if (capBest + 3 < bestFD) {
                    wantCap = true;
                }
            }
            else {
                wantCap = true;
            }
        }
        else {
            wantCap = true;
        }
        if (wantCap) {
            if (capId === -1) {
                if (bestF !== -1) {
                    moveTo(cid, bestFX, bestFY);
                }
                continue;
            }
            taken.push(capId);
            if (cx === capX) {
                if (cyy === capY) {
                    continue;
                }
            }
            moveTo(cid, capX, capY);
        }
        else {
            if (bestF !== -1) {
                moveTo(cid, bestFX, bestFY);
            }
            else {
                if (capId !== -1) {
                    taken.push(capId);
                    if (cx === capX) {
                        if (cyy === capY) {
                            continue;
                        }
                    }
                    moveTo(cid, capX, capY);
                }
            }
        }
    }
}
